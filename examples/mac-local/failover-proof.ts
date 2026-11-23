/**
 * bro2 · P1 本地自治 · 端点失效降级零污染证明（failover proof）
 * ----------------------------------------------------------------
 * 把 REWRITE-ARCHITECTURE §3#1 / §4 P1 的出口条件「断网跑通 + 8/8 超时零污染」
 * 从口号变成可复跑、可证伪的证据。全部调用真实模块，不 mock 不臆造：
 *
 *  A) 8/8 超时零污染（strict）：ProviderRouter + wrapFlaky(timeout) 连续 8 次全超时，
 *     strict 模式下必须 8/8 抛错、0 个 mock 响应进入成功路径 → 可计入 reward 的 trial = 0。
 *  B) 可证伪对照（non-strict）：同样 8/8 超时但关闭 strict → 必然降级到 mock 并污染。
 *     若 A 与 B 结果相同，则 strict 闸门是哑弹，测试自身判 FAIL（防止假阳性）。
 *  C) 断网跑通闭环：ollama-bridge(native) 仿真无云端、无 key 的本地端点，createAgentOS
 *     严格模式跑一个含原生 tool_calls 的完整任务 → stoppedBy=completed 且 provider=ollama。
 *  D) 证据环防污染（agent 之外）：复现 batch.py 的 polluted 判定，对 A/B/C 每类响应判
 *     「可否计 reward」——mock / provider_error / 全部模型均不可用 一律 error、零 reward。
 *     这是第二道保险：即便 router 失守降级到 mock，证据环仍拒绝计分。
 *
 * 诚实边界：C 为 OpenAI 兼容协议仿真（本沙箱无 Ollama/GPU）；A/B 为进程内故障注入，
 * 证明的是「错误分类与计分闸门正确」，不是能力分数。verdict=not-proven / L4=not-achieved 不变。
 *
 * 运行：node --experimental-strip-types --no-warnings examples/mac-local/failover-proof.ts
 * 输出：data/evidence/failover-proof.json
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProviderRouter, wrapFlaky } from "../../src/models/router.ts";
import { MockProvider } from "../../src/models/mock.ts";
import type { LLMProvider, LLMRequest, LLMResponse } from "../../src/models/base.ts";
import { createAgentOS } from "../../src/index.ts";
import { startOllamaBridge } from "../ollama-bridge.ts";
import type { Bridge } from "../ollama-bridge.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = resolve(ROOT, "data/evidence/failover-proof.json");
const line = (s = ""): void => process.stdout.write(s + "\n");

/**
 * 与 examples/tb21-batch.py L292 同源、并加宽的污染判定：命中任一即 error、零 reward。
 * 加宽点（P1 实测发现）：batch.py 原只匹配 agent 终答里的中文“离线 Mock 模型驱动”，
 * 但该标记只在 agent loop 写出终答时才出现；provider 层的单步响应（泄漏最早发生处）不含它。
 * 故证据环优先认机器可读的 `provider=mock` 字段——更早、更可靠，且不受提示词文案影响。
 */
function polluted(text: string): { blocked: boolean; kind: string } {
  if (/\bprovider=[^\s]*mock\b/i.test(text) || text.includes("离线 Mock 模型驱动")) {
    return { blocked: true, kind: "mock-fallback" };
  }
  if (text.includes("provider_error") || text.includes("全部模型均不可用")) return { blocked: true, kind: "provider-error" };
  return { blocked: false, kind: "clean" };
}

/** 一次 provider 调用 → 一条 trial 记录（成功也算，交由证据环判定可否计分）。 */
function trialOf(res: LLMResponse | null, err: string | null): {
  ok: boolean; provider: string; text: string; countedReward: boolean; kind: string;
} {
  const raw = res ? `provider=${res.provider} content=${res.content}` : `ERROR ${err ?? ""}`;
  const v = polluted(raw);
  // 只有「成功返回 + 未被污染判定拦截」才允许计 reward。
  const countedReward = res !== null && !v.blocked;
  return { ok: res !== null, provider: res?.provider ?? "(none)", text: raw.slice(0, 180), countedReward, kind: v.kind };
}

interface Scenario {
  id: string;
  name: string;
  detail: string;
  pass: boolean;
  evidence: Record<string, unknown>;
}
const scenarios: Scenario[] = [];

const req: LLMRequest = { messages: [{ role: "user", content: "计算 sum([7,8,15])" }] };

// ── A) strict 8/8 超时零污染 ──────────────────────────────────────────────
async function runEight(strict: boolean): Promise<ReturnType<typeof trialOf>[]> {
  const dead: LLMProvider = wrapFlaky(new MockProvider({ strategy: "heuristic" }), {
    kind: "timeout", times: 100, stallMs: 1,
  });
  const router = new ProviderRouter("dead");
  router.register("dead", dead);
  router.register("mock", new MockProvider({ strategy: "heuristic" })); // 降级诱惑
  router.setDefault("dead");
  router.setStrict(strict);
  const trials: ReturnType<typeof trialOf>[] = [];
  for (let i = 0; i < 8; i++) {
    try {
      trials.push(trialOf(await router.complete(req), null));
    } catch (e) {
      trials.push(trialOf(null, e instanceof Error ? e.message : String(e)));
    }
  }
  return trials;
}
// 顶层 await（strip-types 支持 ESM 顶层 await）
const aTrials = await runEight(true);
const aCounted = aTrials.filter((t) => t.countedReward).length;
const aMockInSuccess = aTrials.filter((t) => t.ok && /mock/i.test(t.provider)).length;
scenarios.push({
  id: "A", name: "strict 8/8 超时零污染",
  detail: "strict 模式下连续 8 次全超时：8/8 判 error、0 个 mock 进入成功路径、0 reward 可计",
  pass: aCounted === 0 && aMockInSuccess === 0 && aTrials.every((t) => !t.ok),
  evidence: { total: aTrials.length, countedRewards: aCounted, mockInSuccess: aMockInSuccess, trials: aTrials },
});

// ── B) 可证伪对照：non-strict 应降级到 mock 并被证据环拦下 ──────────────────
const bTrials = await runEight(false);
const bMockInSuccess = bTrials.filter((t) => t.ok && /mock/i.test(t.provider)).length;
const bCountedByRing = bTrials.filter((t) => t.countedReward).length; // 证据环口径
const bRawSuccess = bTrials.filter((t) => t.ok).length; // router 口径（未过证据环）
scenarios.push({
  id: "B", name: "可证伪对照 non-strict",
  detail: "关闭 strict 后超时会降级到 mock：router 出现成功响应，但证据环按 mock 关键词拒绝计分",
  pass: bRawSuccess > 0 && bMockInSuccess > 0 && bCountedByRing === 0 && aCounted === 0,
  evidence: {
    routerRawSuccess: bRawSuccess, mockInSuccess: bMockInSuccess,
    countedRewardsAfterEvidenceRing: bCountedByRing,
    falsification: "若 A 与 B 的 countedRewards 相同（都为0且B无mock成功），则 strict/证据环是哑弹 → FAIL",
    trials: bTrials,
  },
});

// ── C) 断网跑通闭环：本地 bridge，无云端、无 key ────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "bro2-failover-"));
const ws = join(tmp, "ws");
let bridge: Bridge | null = null;
let os: ReturnType<typeof createAgentOS> | null = null;
try {
  bridge = await startOllamaBridge("native");
  process.env.OLLAMA_BASE_URL = bridge.url;
  process.env.OLLAMA_MODEL = bridge.model;
  delete process.env.OLLAMA_API_KEY; // 本地端点无 key

  os = createAgentOS({
    root: ROOT, autoApprove: true, plugins: [],
    config: { storage: { dir: tmp }, permission: { workspace: ws, allowedPaths: [ws] } },
  });
  os.router.setDefault("ollama");
  os.router.setStrict(true); // 断网场景同样禁止静默降级
  const sess = os.createSession("standard");
  const run = await os.run(sess.id, "请计算 sum([7,8,15]) 并说明结果");
  const cOk = run.stoppedBy === "completed" && run.toolCallCount > 0;
  scenarios.push({
    id: "C", name: "断网跑通闭环",
    detail: "无云端/无 key 的本地端点 + strict：完整任务跑通，含原生 tool_calls，provider=ollama 而非 mock",
    pass: cOk,
    evidence: {
      stoppedBy: run.stoppedBy, steps: run.steps, toolCalls: run.toolCallCount,
      answer: run.answer.replace(/\n/g, " ").slice(0, 160),
      requestLog: bridge.records.slice(0, 3).map((r) => ({ stream: r.stream, hasTools: r.hasTools, hasAuth: r.hasAuth })),
      simulationNote: "OpenAI 兼容协议仿真（无 Ollama/GPU），非真机能力分",
    },
  });
} catch (e) {
  scenarios.push({
    id: "C", name: "断网跑通闭环", detail: "本地闭环异常", pass: false,
    evidence: { error: e instanceof Error ? e.message : String(e) },
  });
} finally {
  if (os) await os.shutdown();
  if (bridge) await bridge.close();
  rmSync(tmp, { recursive: true, force: true });
}

// ── D) 证据环判定自洽：三类响应必须按预期分类 ──────────────────────────────
const ringCases = [
  { name: "provider_error 日志", text: "stoppedBy=provider_error", expectBlock: true },
  { name: "全部模型均不可用", text: "Error: 全部模型均不可用 → dead: timeout", expectBlock: true },
  { name: "mock 兜底终答", text: "本次由离线 Mock 模型驱动", expectBlock: true },
  { name: "mock 单步响应(P1发现)", text: "provider=mock content=我先列个计划", expectBlock: true },
  { name: "mock 降级前缀", text: "provider=keyless/mock content=...", expectBlock: true },
  { name: "干净成功响应", text: "provider=ollama/... content=任务完成", expectBlock: false },
].map((c) => ({ ...c, actualBlock: polluted(c.text).blocked, kind: polluted(c.text).kind }));
const dPass = ringCases.every((c) => c.expectBlock === c.actualBlock);
scenarios.push({
  id: "D", name: "证据环防污染判定（agent 之外）",
  detail: "复现 batch.py 判定：provider_error / 全部模型均不可用 / mock 兜底一律拦，干净响应放行",
  pass: dPass,
  evidence: { cases: ringCases },
});

const passed = scenarios.filter((s) => s.pass).length;
const report = {
  generatedAt: new Date().toISOString(),
  version: "p1-failover-proof-v1",
  purpose: "端点失效降级零污染出口条件：8/8 超时零 reward + 断网闭环跑通 + 证据环防污染 + 可证伪对照",
  scenarios,
  summary: { total: scenarios.length, passed, failed: scenarios.length - passed },
  verdict: passed === scenarios.length ? "zero-pollution-proven" : "pollution-or-falsification-failed",
  honest: {
    scope: "进程内故障注入 + OpenAI 兼容协议仿真；证明错误分类与计分闸门正确，非能力分数",
    notProven: ["真机 Ollama/MLX 断网能力", "89×3 全量任务通过率", "量化精度损失"],
    separation: "端点失效（provider_error）= 基础设施问题；数据污染（mock 计分）= 诚实红线。二者分开记录、互不混报（R6）",
    p1Finding: "batch.py 原仅匹配 agent 终答中文标记；证据环加宽为优先认 provider=mock 机器字段（泄漏最早发生处）。建议后续把该字段判据回填 tb21-batch.py，属 P2 轨迹留痕范畴，本版不改评测脚本以免动冻结流程。",
    verdictBoundary: "not-proven", l4: "not-achieved",
  },
};
writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");

line("端点失效降级零污染 · P1 出口条件");
for (const s of scenarios) line(`  ${s.pass ? "✓" : "✗"} ${s.id} ${s.name}  — ${s.detail}`);
line(`  结论 ${report.verdict}  ${passed}/${scenarios.length}`);
line(`  ${OUT}`);
if (passed !== scenarios.length) process.exitCode = 1;
