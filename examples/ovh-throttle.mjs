// bro2 · ovhcloud 测量侧 fetch 节流（v2.34.0, 路径①）
//
// 用途：在「bro2 跑 2.1 公开任务集 / 官方 verifier」时，让 bro2 对 ovhcloud 的
// chat/completions 请求遵守匿名层 2 req/min 限速。纯测量侧适配——不改 src、不改默认
// 行为、不改预算口径（除墙钟），与 v2.33.0 same-model-anchor.ts 同源同策略。
//
// 用法（容器内）：
//   NODE_OPTIONS="--import /bro2/ovh-throttle.mjs" \
//   AGENTOS_LIVE_PROVIDER=ovhcloud \
//   node --experimental-strip-types bin/agentos.ts run --task "..." --preset standard
//
// 版本标记：改动此值时，tb21-batch.py 会检测到 wrapper 镜像内版本不一致并重建。
// v2：遵守 Retry-After、429/5xx 均纳入节流节奏、重试耗尽仍返回原始响应。
export const OVH_THROTTLE_VERSION = "v2";

// 机制：
//   - 相邻 ovhcloud 请求间隔 ≥31s（catalog rate_limit_api_anonymous 为 2 req/min，
//     取 31s 留余量）；
//   - 遇到 429 遵守 Retry-After（秒或 HTTP 日期），无头则按 31s 节奏等待，最多 6 次；
//     每次尝试（含 429/5xx）都刷新 lastOvh，确保节奏不被打乱；
//   - 5xx 视为一次消耗的配额，同样按节奏退避重试，最多 3 次；
//   - 网络层瞬时错误（fetch failed / UND_ERR_SOCKET 等，匿名层偶发）按节奏重试，最多 5 次；
//   - 重试耗尽返回原始响应/抛出原错误，由上层 harness 明确判失败（不伪造成功，不静默降级）；
//   - 非 ovhcloud 的请求（如本地 mock / 其它 provider）不节流、原样透传。

const OVH_HOST = "oai.endpoints.kepler.ai.cloud.ovh.net";
const MIN_GAP_MS = 31_000;
const MAX_429_RETRIES = 6;
const MAX_5XX_RETRIES = 3;
const MAX_NET_RETRIES = 5;

const rawFetch = globalThis.fetch.bind(globalThis);
let lastOvh = 0;
let last429At = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hostOf(input) {
  try {
    const u = typeof input === "string" ? input : (input && input.url) || "";
    return new URL(u).host;
  } catch {
    return "";
  }
}

function retryAfterMs(res) {
  const h = res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null;
  if (!h) return 0;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const asDate = Date.parse(h);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return 0;
}

async function paceGap() {
  if (!lastOvh) return;
  const gap = MIN_GAP_MS - (Date.now() - lastOvh);
  if (gap > 0) await sleep(gap);
}

async function throttled(input, init) {
  const host = hostOf(input);
  const isOvh = host === OVH_HOST;
  if (isOvh) await paceGap();

  let retried429 = 0;
  let retried5xx = 0;
  let retriedNet = 0;
  for (;;) {
    let res;
    try {
      res = await rawFetch(input, init);
    } catch (err) {
      // 网络层瞬时错误（socket/连接复位）——失败的连接不消耗 API 配额，无需 31s 限速节奏，
      // 用短指数退避（2s→4s→8s→16s→32s，合计 ~62s）快速重试，避免拖垮每次调用。
      if (isOvh && retriedNet < MAX_NET_RETRIES) {
        retriedNet += 1;
        await sleep(Math.min(2000 * 2 ** (retriedNet - 1), 32_000));
        continue;
      }
      throw err; // 耗尽后抛原错误，harness 判 provider_error（绝不伪造 mock 成功）
    }
    if (!isOvh) return res;

    // 每次请求都刷新节奏基准——配额已被消耗，无论响应状态。
    lastOvh = Date.now();

    if (res.status === 429) {
      if (retried429 >= MAX_429_RETRIES) return res;
      retried429 += 1;
      last429At = Date.now();
      const wait = Math.max(retryAfterMs(res), MIN_GAP_MS, MIN_GAP_MS * retried429);
      await sleep(wait);
      continue;
    }
    if (res.status >= 500) {
      if (retried5xx >= MAX_5XX_RETRIES) return res;
      retried5xx += 1;
      await sleep(MIN_GAP_MS * retried5xx);
      continue;
    }
    return res;
  }
}

globalThis.fetch = (input, init) => throttled(input, init);
