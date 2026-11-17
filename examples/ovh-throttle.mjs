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
// 机制：
//   - 相邻 ovhcloud 请求间隔 ≥31s（catalog rate_limit_api_anonymous 为 2 req/min，
//     取 31s 留余量）；
//   - 遇到 429 按同节奏（31s）等待并重试，最多 4 次；
//   - 非 ovhcloud 的请求（如本地 mock / 其它 provider）不节流、原样透传。

const OVH_HOST = "oai.endpoints.kepler.ai.cloud.ovh.net";
const MIN_GAP_MS = 31_000;
const MAX_429_RETRIES = 4;

const rawFetch = globalThis.fetch.bind(globalThis);
let lastOvh = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hostOf(input) {
  try {
    const u = typeof input === "string" ? input : (input && input.url) || "";
    return new URL(u).host;
  } catch {
    return "";
  }
}

async function throttled(input, init) {
  const host = hostOf(input);
  const isOvh = host === OVH_HOST;
  if (isOvh) {
    const gap = MIN_GAP_MS - (Date.now() - lastOvh);
    if (gap > 0) await sleep(gap);
  }
  for (let i = 0; i <= MAX_429_RETRIES; i += 1) {
    const res = await rawFetch(input, init);
    if (res.status !== 429) {
      if (isOvh) lastOvh = Date.now();
      return res;
    }
    if (i === MAX_429_RETRIES) return res;
    await sleep(MIN_GAP_MS);
  }
  return rawFetch(input, init);
}

globalThis.fetch = (input, init) => throttled(input, init);
