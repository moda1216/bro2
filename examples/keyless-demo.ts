/**
 * 无 Key 端点统一聚合器 · 演示
 *
 * 用 bro2 真实装配出来的 KeylessAggregator（从 agentos.config.json 的 `keyless`
 * 段聚合 kilo / pollinations / opencode-zen / keylessai / llm7 等免 Key 上游），
 * 把"一堆各自不稳定、各自限流的远程端点"收敛为一个唯一接口交给 bro2。
 *
 * 演示内容：
 *   1) 真实装配：打印从配置聚合出的网状健康度（哪些上游被纳入、能力、优先级）。
 *   2) 离线故障转移：用可控假上游演示「限流感知 + 智能故障转移 + 应急兜底」，
 *      不消耗任何真实额度、不依赖网络（确定性可复现）。
 *
 * 运行：npm run keyless:demo
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentOS } from "../src/index.ts";
import { isMeshProvider } from "../src/models/keyless.ts";
import { KeylessAggregator, type KeylessBackend } from "../src/models/keyless.ts";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/models/base.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const line = (s = ""): void => process.stdout.write(s + "\n");

const be = (p: LLMProvider, extra: Partial<KeylessBackend> = {}): KeylessBackend => ({ provider: p, ...extra });

const os = createAgentOS({
  root: ROOT,
  autoApprove: true,
  plugins: [],
  config: { storage: { dir: "./data" }, permission: { workspace: "./data/workspace", allowedPaths: ["./data/workspace"] } },
});

// ---------------------------------------------------------------- 1) 真实装配
const keyless = os.providers.get("keyless");
if (!(keyless && isMeshProvider(keyless))) {
  line("✗ 未装配 keyless 聚合器（检查 agentos.config.json 的 keyless 段）");
  await os.shutdown();
  process.exit(1);
}

const ms = keyless.meshStats();
line("════════════════════════════════════════════════════════════════");
line("  无 Key 端点统一聚合器（KeylessAggregator）· 真实装配自配置");
line("════════════════════════════════════════════════════════════════");
line(`  聚合上游数 : ${ms.backendCount}`);
line("  上游明细（优先级 / 工具能力 / 标签）：");
for (const b of ms.backends) {
  line(`    - ${b.name.padEnd(14)} prio=${String(b.priority).padStart(2)} tools=${b.supportsTools ? "✓" : "✗"} [${b.tags.join(",") || "-"}]`);
}
line("");
line("  bro2 调用侧只需：AGENTOS_LIVE_PROVIDER=keyless  npm run eval:live");
line("  无需关心背后是哪家端点；任一上游限流/宕机自动切到其它上游。");
line("");

// ---------------------------------------------------------------- 2) 离线故障转移
line("════════════════════════════════════════════════════════════════");
line("  离线故障转移演示（确定性，不消耗真实额度）");
line("════════════════════════════════════════════════════════════════");

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
    return { content: `answer-from-${this.name}`, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: "fake", durationMs: 1, provider: this.name };
  }
}

const kilo = new FakeBackend("kilo");
const pollinations = new FakeBackend("pollinations", { failTimes: 1, rateLimit: true }); // 第一次限流
const zen = new FakeBackend("opencode-zen");
const local = new FakeBackend("local-qwen"); // 应急兜底

const agg = new KeylessAggregator({
  name: "demo-mesh",
  backends: [
    // pollinations 优先级最高，先被选中并触发限流（429），聚合器应自动切到 kilo/zen
    be(pollinations, { priority: 5 }),
    be(kilo, { priority: 3 }),
    be(zen, { priority: 2 }),
  ] as KeylessBackend[],
  maxAttempts: 5,
  emergencyProvider: local,
});

const req = { messages: [{ role: "user", content: "解释 agent 是什么" }] } as LLMRequest;

line("");
line("场景 A：pollinations 优先级最高，首调用触发限流（429） → 聚合器自动切到其它上游");
const r1 = await agg.complete(req);
line(`  结果 provider=${r1.provider}`);
line(`  pollinations 调用=${pollinations.calls}（1 次触发限流后被冷却跳过）`);
line(`  kilo 调用=${kilo.calls}  zen 调用=${zen.calls}`);
void r1;

line("");
line("场景 B：连续 3 次请求，观察健康评分路由（高优先级 kilo 被持续优选）");
for (let i = 0; i < 3; i += 1) {
  const r = await agg.complete(req);
  line(`  #${i + 1} provider=${r.provider}`);
}
line(`  kilo 累计=${kilo.calls}  zen 累计=${zen.calls}  pollinations 累计=${pollinations.calls}`);

line("");
line("场景 C：全部上游故障 → 应急兜底到本地小模型（不静默失败）");
const allDown = new KeylessAggregator({
  name: "demo-mesh-down",
  backends: [be(new FakeBackend("x", { failTimes: 99 })), be(new FakeBackend("y", { failTimes: 99 }))],
  maxAttempts: 3,
  emergencyProvider: local,
});
const r3 = await allDown.complete(req);
line(`  结果 provider=${r3.provider}（应急兜底生效，本地小模型接住）`);

const finalMs = agg.meshStats();
line("");
line("════════════════════════════════════════════════════════════════");
line("  网状统计（KeylessAggregator.meshStats）");
line("════════════════════════════════════════════════════════════════");
line(`  meshAttempts        : ${finalMs.meshAttempts}`);
line(`  successes           : ${finalMs.successes}`);
line(`  failures            : ${finalMs.failures}`);
line(`  rateLimitFailovers  : ${finalMs.rateLimitFailovers}`);
line("");
line("  → 把 N 家免 Key 端点聚合成唯一接口后，bro2 获得的是「网状韧性」：");
line("    单点限流/宕机不再让整条 agent 链路失败，而是被智能故障转移吸收。");

await os.shutdown();
