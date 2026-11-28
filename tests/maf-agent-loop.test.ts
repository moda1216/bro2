import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentOS } from "../src/index.ts";
import { MockProvider } from "../src/models/mock.ts";
import type { LLMRequest } from "../src/models/types.ts";

const ROOT = join(import.meta.dirname, "..");
const cases = (n: number) => Object.fromEntries(["visible", "hidden", "replay", "shadow"].map((s) => [s, Array.from({ length: n }, (_, i) => ({ id: `${s}-${i}`, input: `q${i}`, expected: "A" }))]));

test("agent-output-v1 经真实 AgentLoop 执行：runner 计数来自真实推理调用，提示片段真注入，工具白名单真拦截", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "maf-loop-")), ws = join(tmp, "ws");
  let providerCalls = 0;
  const seen: Array<{ injected: boolean; planPrompt: boolean; rejected: boolean }> = [];
  const provider = new MockProvider({ strategy: "scripted", script: (req: LLMRequest) => {
    providerCalls += 1;
    const text = JSON.stringify(req.messages);
    seen.push({ injected: text.includes("你是被评测的候选 Agent"), planPrompt: text.includes("todo_write"), rejected: text.includes("基因组未授权此工具") });
    const hasToolResult = req.messages.some((m) => m.role === "tool");
    return hasToolResult ? { content: "A" } : { toolCalls: [{ name: "calc", arguments: { expression: "1+1" } }] };
  } });
  const os = createAgentOS({ root: ROOT, autoApprove: true, plugins: [], providerOverride: provider, config: { storage: { dir: tmp }, permission: { workspace: ws, allowedPaths: [ws] } } as never });
  t.after(async () => { await os.shutdown(); rmSync(tmp, { recursive: true, force: true }); });
  const s = os.maf.createScenario({ name: "真实 Agent 闭环", domain: "support", verifier: "agent-output-v1", cases: cases(2), permissions: ["read"] });
  const base = os.maf.createAgent({ scenarioId: s.id, blocks: ["identity"], reason: "基线：无白名单，calc 可用" });
  const cand = os.maf.createAgent({ scenarioId: s.id, agentId: base.agentId, parentVersion: base.version, blocks: ["agent-plan-first"], tools: ["file_read"], reason: "规划提示 + 只许 file_read" });
  assert.equal(os.maf.getAgent(base.agentId, cand.version)!.status, "draft");
  const r = await os.maf.evaluate(base.agentId, cand.version);
  assert.equal(r.verifier, "agent-output-v1"); assert.equal(r.runnerCalls, 16);
  assert.ok(providerCalls >= 16, `真实推理调用 ${providerCalls} 次 ≥ runner 16 次`);
  assert.ok(seen.some((x) => x.injected), "候选身份与提示通过 extraInject 真进入模型请求");
  assert.ok(seen.some((x) => x.planPrompt), "agent Block 的提示片段真进入模型请求");
  assert.ok(seen.some((x) => x.rejected), "白名单外的 calc 被真实 Loop 拦截并回报给模型");
  assert.equal(r.decision, "rejected", "基线与候选都答对 → 效应量为 0，诚实拒绝，不因'跑了真模型'而放行");
  assert.ok(r.reasons.some((x) => x.includes("效应量")));
  assert.ok(os.maf.auditTrail().some((a) => a.action === "candidate.evaluate" && a.refs.verifier === "agent-output-v1" && a.refs.runnerCalls === 16));
  assert.equal(os.maf.getAgent(base.agentId, cand.version)!.status, "rejected");
});
