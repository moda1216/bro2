/**
 * 双层叠加 · 演示：免 Key 网状（KeylessAggregator）+ 本地协同（HybridProvider）
 *
 * 用户要求的组合：hybrid.remote = keyless。两层正交：
 *   - 内层 KeylessAggregator：把一堆各自限流/不稳定的免 Key 远程端点聚合成唯一接口，
 *     健康评分选优 + 限流感知故障转移 + 应急兜底。
 *   - 外层 HybridProvider：便宜/重复调用留给本地小模型、缓存命中零调用、远程限流降级，
 *     把打到「远程网状」的调用次数降到最低。
 *
 * 全程离线确定性：用可控假上游，不消耗任何真实额度、不依赖网络。
 * 另附一段「真实装配」打印，展示 agentos.config.json 里 hybrid→keyless 的嵌套关系。
 *
 * 运行：npm run hybrid:keyless:demo
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentOS } from "../src/index.ts";
import { HybridProvider } from "../src/models/hybrid.ts";
import { KeylessAggregator, isMeshProvider, type KeylessBackend } from "../src/models/keyless.ts";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/models/base.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const line = (s = ""): void => process.stdout.write(s + "\n");
const hr = (t: string): void => line("\n" + "─".repeat(70) + `\n  ${t}\n` + "─".repeat(70));

const be = (p: LLMProvider, extra: Partial<KeylessBackend> = {}): KeylessBackend => ({ provider: p, ...extra });

const resp = (marker: string): LLMResponse => ({
  content: marker, toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  model: "fake", durationMs: 1, provider: marker,
});

/** 可控假上游：前 failTimes 次抛错（可模拟限流），之后成功。 */
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

const chat = (text: string): LLMRequest => ({ messages: [{ role: "user", content: text }] }) as LLMRequest;
const reasoning = (): LLMRequest => ({
  messages: [
    { role: "user", content: "plan" },
    { role: "assistant", content: "ok", toolCalls: [{ id: "c1", name: "f", arguments: {} }] },
    { role: "user", content: "a long query that needs reasoning" },
  ],
  tools: [{ name: "f", description: "f", parameters: {} }],
}) as unknown as LLMRequest;

// ---------------------------------------------------------------- 真实装配
const os = createAgentOS({
  root: ROOT, autoApprove: true, plugins: [],
  config: { storage: { dir: "./data" }, permission: { workspace: "./data/workspace", allowedPaths: ["./data/workspace"] } },
});
hr("真实装配：agentos.config.json 的双层嵌套");
const realHybrid = os.providers.get("hybrid");
const realKeyless = os.providers.get("keyless");
const remoteIsMesh = realHybrid && "underlying" in realHybrid && isMeshProvider((realHybrid as { underlying(): LLMProvider[] }).underlying()[0]);
line(`  hybrid.underlying : [${(realHybrid as { underlying(): LLMProvider[] }).underlying().map((p) => p.name).join(", ")}]`);
line(`  hybrid.remote 是 keyless 聚合器 : ${remoteIsMesh ? "✓" : "✗"}`);
if (isMeshProvider(realKeyless)) {
  line(`  keyless 上游 : [${realKeyless.underlying().map((p) => p.name).join(", ")}]`);
}
line("  内层管「远程可用性」，外层管「远程开销」——两层正交叠加。");
await os.shutdown();

// ---------------------------------------------------------------- 离线执行
hr("离线执行：双层协同，把远程网状调用降到最低");
const kilo = new FakeBackend("kilo", { failTimes: 1, rateLimit: true }); // 首个高优上游先限流
const pollinations = new FakeBackend("pollinations");
const zen = new FakeBackend("opencode-zen");
const local = new FakeBackend("local-qwen");

const mesh = new KeylessAggregator({
  name: "keyless",
  backends: [be(kilo, { priority: 3 }), be(pollinations, { priority: 2 }), be(zen, { priority: 1 })],
  rateLimitCooldownMs: 60_000,
  emergencyProvider: local, // 网状全挂时兜底到本地
});
const hybrid = new HybridProvider("hybrid", { remote: mesh, local });

// 场景 1：两次「便宜」调用（无工具）→ 全部本地承接（本地零成本/无限流，无需缓存）
line("\n  场景 1｜两次便宜调用（无工具）：全部本地承接，远程网状零调用");
await hybrid.complete(chat("摘要这段文字"));
await hybrid.complete(chat("再摘要另一段"));
line(`    local-qwen 调用=${local.calls}  网状调用=${mesh.meshStats().meshAttempts}`);

// 场景 2：一次「需推理」调用（带工具）→ 穿透到网状；kilo 限流→智能转移到其它上游
line("\n  场景 2｜需推理调用（带工具）：穿透到网状，首个上游限流自动故障转移");
const r = await hybrid.complete(reasoning());
const ms = mesh.meshStats();
line(`    结果来自 provider=${r.provider}`);
line(`    kilo(限流)=${kilo.calls}  pollinations=${pollinations.calls}  zen=${zen.calls}  限流转移次数=${ms.rateLimitFailovers}`);

// 场景 3：重复完全相同的「需推理」调用 → hybrid 缓存命中，零新增远程网状调用
line("\n  场景 3｜重复相同的需推理调用：hybrid 缓存命中，零新增远程");
const attemptsBefore = mesh.meshStats().meshAttempts;
await hybrid.complete(reasoning());
line(`    网状新增尝试=${mesh.meshStats().meshAttempts - attemptsBefore}（应为 0）`);

const s = hybrid.inferenceStats();
const detail = s.remoteDetail as { backendCount: number; meshAttempts: number } | undefined;
hr("效率统计（eval 报告的 inference 字段）");
line(`  remoteCalls=${s.remoteCalls}  localCalls=${s.localCalls}  cacheHits=${s.cacheHits}  remoteAvoided=${s.remoteAvoided}`);
line(`  remoteCallRatio=${s.remoteCallRatio.toFixed(3)}   ← ${s.remoteCalls + s.localCalls + s.cacheHits} 次任务仅 ${s.remoteCalls} 次穿透到远程网状`);
line(`  remoteDetail: 网状上游数=${detail?.backendCount ?? "-"}  网状实际尝试=${detail?.meshAttempts ?? "-"}（含 1 次限流转移）`);
line("\n  结论：外层 hybrid 把「便宜」调用拦在本地、「重复」调用拦在缓存，内层 keyless 把「单点限流」吸收为故障转移；");
line("        bro2 调用侧只见一个 hybrid 接口，既省远程开销，又不惧任一免 Key 端点抖动。\n");
