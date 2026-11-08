/**
 * 双层叠加（免 Key 网状 + 本地协同）单元测试。
 *
 * 验证用户要求的组合：hybrid.remote = keyless，即
 *   HybridProvider(remote=KeylessAggregator(...免 Key 上游), local=local-qwen)
 * 覆盖三个层面：
 *  1) 真实装配：createAgentOS 从 agentos.config.json 组装出 hybrid→keyless 嵌套结构；
 *  2) 端点穿透：src/models/resolve.ts 递归解析到真实端点、远端优先、去重防环；
 *  3) 执行与统计：便宜调用走本地、需推理调用穿透到网状；inferenceStats 暴露网状明细。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentOS } from "../src/index.ts";
import { OpenAICompatProvider } from "../src/models/openai-compat.ts";
import { isMeshProvider, KeylessAggregator, type KeylessBackend } from "../src/models/keyless.ts";
import { HybridProvider, remoteOnlyPolicy } from "../src/models/hybrid.ts";
import { isCompositeProvider, isStatsProvider } from "../src/models/cache.ts";
import { isLocalEndpoint, resolveLeaves, leafEndpoints, probeTargets } from "../src/models/resolve.ts";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/models/base.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const resp = (marker: string): LLMResponse => ({
  content: marker,
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  model: "fake",
  durationMs: 1,
  provider: marker,
});

/** 可控假上游：前 N 次可限流/失败，用尽后成功。 */
class FakeBackend implements LLMProvider {
  name: string;
  calls = 0;
  failTimes: number;
  rateLimit: boolean;
  constructor(name: string, opts: { failTimes?: number; rateLimit?: boolean } = {}) {
    this.name = name;
    this.failTimes = opts.failTimes ?? 0;
    this.rateLimit = opts.rateLimit ?? false;
  }
  async complete(_req: LLMRequest): Promise<LLMResponse> {
    this.calls += 1;
    if (this.failTimes > 0) {
      this.failTimes -= 1;
      throw new Error(this.rateLimit ? "HTTP 429: FreeUsageLimitError" : "HTTP 500: upstream");
    }
    return resp(this.name);
  }
}

const be = (p: LLMProvider, extra: Partial<KeylessBackend> = {}): KeylessBackend => ({ provider: p, ...extra });
const chatReq = (): LLMRequest => ({ messages: [{ role: "user", content: "hi" }] }) as LLMRequest;
const reasoningReq = (): LLMRequest => ({
  messages: [
    { role: "user", content: "plan" },
    { role: "assistant", content: "ok", toolCalls: [{ id: "c1", name: "f", arguments: {} }] },
    { role: "user", content: "a long query that needs reasoning" },
  ],
  tools: [{ name: "f", description: "f", parameters: {} }],
}) as unknown as LLMRequest;

/** 构造一个 configured 的 OpenAICompatProvider（不发网络，仅供 resolve 判定）。 */
const ep = (name: string, baseUrl: string): OpenAICompatProvider =>
  new OpenAICompatProvider({ name, baseUrl, model: "m", apiKey: "", apiKeyOptional: true });

// ---------------------------------------------------------------- 1) 真实装配
test("真实装配：hybrid.remote 指向 keyless 聚合器，形成双层嵌套", async () => {
  const os = createAgentOS({ root: ROOT, plugins: [] });
  try {
    const hybrid = os.providers.get("hybrid")!;
    const keyless = os.providers.get("keyless")!;
    assert.ok(isCompositeProvider(hybrid), "hybrid 应为组合型");
    assert.ok(isMeshProvider(keyless), "keyless 应为网状聚合器");
    const [remote, local] = hybrid.underlying();
    assert.equal(remote, keyless, "hybrid.remote 必须是 keyless（免 Key 网状）");
    assert.equal(local.name, "local-qwen", "hybrid.local 应为本地小模型");
    assert.ok(keyless.underlying().length >= 3, "keyless 应聚合多个免 Key 上游");
    assert.ok(isStatsProvider(hybrid));
  } finally {
    await os.shutdown();
  }
});

// ---------------------------------------------------------------- 2) 端点穿透
test("isLocalEndpoint：正确区分本地与远程", () => {
  assert.equal(isLocalEndpoint("http://127.0.0.1:11434/v1"), true);
  assert.equal(isLocalEndpoint("http://localhost:3080/v1"), true);
  assert.equal(isLocalEndpoint("https://api.kilo.ai/api/gateway/v1"), false);
  assert.equal(isLocalEndpoint("https://text.pollinations.ai/openai/v1"), false);
});

test("resolveLeaves：递归穿透 hybrid→keyless→多上游，去重防环", () => {
  const a = ep("a", "https://a.example/v1");
  const b = ep("b", "https://b.example/v1");
  const local = ep("local", "http://127.0.0.1:11434/v1");
  const mesh: LLMProvider & { underlying(): LLMProvider[] } = {
    name: "mesh",
    async complete(req: LLMRequest) { return a.complete(req); },
    underlying() { return [a, b]; },
  };
  const hybrid: LLMProvider & { underlying(): LLMProvider[] } = {
    name: "hybrid",
    async complete(req: LLMRequest) { return mesh.complete(req); },
    underlying() { return [mesh, local, mesh]; }, // 故意重复 mesh，验证去重
  };
  const leaves = resolveLeaves(hybrid);
  assert.equal(leaves.length, 3, "应展开为 a/b/local 三个叶子，mesh 重复被去重");
  assert.deepEqual(new Set(leaves.map((l) => l.name)), new Set(["a", "b", "local"]));
});

test("probeTargets：远端 configured 上游优先，本地兜底殿后被排除", () => {
  const remote1 = ep("r1", "https://r1.example/v1");
  const remote2 = ep("r2", "https://r2.example/v1");
  const local = ep("local", "http://127.0.0.1:11434/v1");
  const unconfigured = new OpenAICompatProvider({ name: "bad", baseUrl: "", model: "", apiKey: "" });
  const mesh: LLMProvider & { underlying(): LLMProvider[] } = {
    name: "mesh",
    async complete(req: LLMRequest) { return remote1.complete(req); },
    underlying() { return [remote1, remote2, unconfigured]; },
  };
  const hybrid: LLMProvider & { underlying(): LLMProvider[] } = {
    name: "hybrid",
    async complete(req: LLMRequest) { return mesh.complete(req); },
    underlying() { return [mesh, local]; },
  };
  const targets = probeTargets(hybrid);
  assert.deepEqual(targets.map((t) => t.name), ["r1", "r2"], "仅返回两个 configured 远端；排除本地与未配置端点");
});

test("probeTargets：无可用远端时退回本地端点", () => {
  const local = ep("local", "http://127.0.0.1:11434/v1");
  const targets = probeTargets(local);
  assert.equal(targets.length, 1);
  assert.equal(targets[0]!.name, "local");
});

test("leafEndpoints：只返回 OpenAI 兼容叶子，忽略 Mock 等离线 provider", () => {
  const remote = ep("r", "https://r.example/v1");
  const mock: LLMProvider = { name: "mock", async complete() { return resp("mock"); } };
  const composite: LLMProvider & { underlying(): LLMProvider[] } = {
    name: "c",
    async complete(req: LLMRequest) { return remote.complete(req); },
    underlying() { return [remote, mock]; },
  };
  const eps = leafEndpoints(composite);
  assert.deepEqual(eps.map((e) => e.name), ["r"]);
});

// ---------------------------------------------------------------- 3) 执行与统计
test("双层执行：便宜调用走本地；需推理调用穿透到网状（含故障转移）", async () => {
  const limited = new FakeBackend("limited", { failTimes: 1, rateLimit: true });
  const ok = new FakeBackend("ok");
  const local = new FakeBackend("local-qwen");
  const mesh = new KeylessAggregator({
    name: "keyless",
    backends: [be(limited, { priority: 2 }), be(ok, { priority: 1 })],
    rateLimitCooldownMs: 60_000,
  });
  const hybrid = new HybridProvider("hybrid", { remote: mesh, local });

  // 便宜（无工具）→ 本地，网状完全不被触碰
  await hybrid.complete(chatReq());
  assert.equal(local.calls, 1);
  assert.equal(mesh.meshStats().meshAttempts, 0, "本地承接时网状零调用");

  // 需推理（带 tools）→ 网状；首上游限流，智能转移到 ok
  const r = await hybrid.complete(reasoningReq());
  assert.ok(r.provider.includes("ok"), `应来自故障转移后的 ok，实际 ${r.provider}`);
  assert.equal(limited.calls, 1);
  assert.equal(ok.calls, 1);
  assert.equal(mesh.meshStats().rateLimitFailovers, 1);
  assert.equal(local.calls, 1, "推理调用不应再打本地");
});

test("inferenceStats：双层统计暴露 remoteDetail（网状明细）", async () => {
  const a = new FakeBackend("a");
  const local = new FakeBackend("local-qwen");
  const mesh = new KeylessAggregator({ name: "keyless", backends: [be(a, { priority: 1 })] });
  const hybrid = new HybridProvider("hybrid", { remote: mesh, local, policy: remoteOnlyPolicy });

  await hybrid.complete(chatReq());
  await hybrid.complete(chatReq()); // 第二次命中 hybrid 缓存

  const s = hybrid.inferenceStats();
  assert.equal(s.remoteCalls, 1, "两次请求只有一次真正穿透到网状");
  assert.equal(s.cacheHits, 1);
  assert.ok(s.remoteDetail, "远端是聚合器时应暴露网状明细");
  const detail = s.remoteDetail as { backendCount: number; meshAttempts: number };
  assert.equal(detail.backendCount, 1);
  assert.equal(detail.meshAttempts, 1);
});
