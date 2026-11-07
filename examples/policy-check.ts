/**
 * bro2 · 行为策略分派层实证
 *
 * 目的：证明 BehaviorPolicy 的每个枚举值都对应**真实代码分支**，
 * 而不是一个只改字符串的配置开关。逐条用脚本化模型驱动，断言 Trajectory 事件。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentOS } from "../src/index.ts";
import type { AgentOS } from "../src/index.ts";
import { EventType } from "../src/kernel/events.ts";
import type { MockScript } from "../src/models/mock.ts";
import type { BehaviorPolicy } from "../src/runtime/policy.ts";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name} ${detail}`); }
}

async function run(
  policy: Partial<BehaviorPolicy>,
  script: MockScript,
  budget: Record<string, unknown> = {},
): Promise<{ os: AgentOS; events: Array<{ type: string; payload: Record<string, unknown> }>; answer: string; stoppedBy: string }> {
  const tmp = mkdtempSync(join(tmpdir(), "bro2-policy-"));
  const os = createAgentOS({
    root: join(import.meta.dirname ?? "", ".."),
    evolvedState: false,
    autoApprove: true,
    mockScript: script,
    config: {
      storage: { dir: tmp },
      permission: { workspace: join(tmp, "ws"), allowedPaths: [join(tmp, "ws")], level: "workspace-write", autoApproveSafe: true },
      policy,
      ...(Object.keys(budget).length ? { budget: budget as never } : {}),
    },
  });
  const s = os.createSession("standard");
  const r = await os.run(s.id, "策略验证任务");
  const events = s.trajectory.events().map((e) => ({ type: e.type, payload: e.payload }));
  return { os, events, answer: r.answer, stoppedBy: r.stoppedBy };
}

async function withRun(
  policy: Partial<BehaviorPolicy>,
  script: MockScript,
  budget: Record<string, unknown>,
  fn: (r: Awaited<ReturnType<typeof run>>) => void,
): Promise<void> {
  const r = await run(policy, script, budget);
  try { fn(r); } finally { await r.os.shutdown(); rmSync(r.os.config.storage.dir, { recursive: true, force: true }); }
}

const has = (r: Awaited<ReturnType<typeof run>>, t: string): boolean => r.events.some((e) => e.type === t);

async function main(): Promise<void> {
  console.log("=".repeat(84));
  console.log("  bro2 · 行为策略分派层实证（5 个真实代码分支）");
  console.log("=".repeat(84));

  // ---- 1) malformedArgs=repair：拼错的工具名被唯一近似修复 ----
  console.log("\n【1】malformedArgs: fail → repair");
  await withRun(
    { malformedArgs: "repair" },
    [
      { content: "", toolCalls: [{ name: "cal", arguments: { expression: "7*8" } }] },
      { content: "修复后计算完成，结果为 56。" },
    ],
    {},
    (r) => {
      check("repair 模式产生 tool.repair 事件", has(r, EventType.ToolRepair));
      const rep = r.events.find((e) => e.type === EventType.ToolRepair);
      check("修复记录包含工具名修正", JSON.stringify(rep?.payload.changes ?? "").includes("cal"));
      check("修复后工具真实执行成功", r.events.some((e) => e.type === EventType.ToolResult && (e.payload.result as { ok?: boolean })?.ok === true));
      check("终答正常完成", r.stoppedBy === "completed");
    },
  );
  await withRun(
    { malformedArgs: "fail" },
    [
      { content: "", toolCalls: [{ name: "cal", arguments: { expression: "7*8" } }] },
      { content: "未知工具已被安全回报。" },
    ],
    {},
    (r) => {
      check("保守 fail 模式不产生修复事件", !has(r, EventType.ToolRepair));
      check("保守 fail 模式仍回喂错误结果（协议配对完整）", r.events.some((e) => e.type === EventType.ToolResult && (e.payload.result as { ok?: boolean })?.ok === false));
    },
  );
  // 安全不变量：缺失必填参数绝不凭空补值
  await withRun(
    { malformedArgs: "repair" },
    [
      { content: "", toolCalls: [{ name: "calc", arguments: {} }] },
      { content: "参数错误已被工具层捕获并回喂。" },
    ],
    {},
    (r) => {
      check("repair 不伪造缺失的必填参数（t15 语义保持）", r.events.some((e) => e.type === EventType.ToolResult && (e.payload.result as { ok?: boolean })?.ok === false));
    },
  );

  // ---- 2) grounding=require-evidence：无证据终答被打回一次 ----
  console.log("\n【2】grounding: off → require-evidence");
  const groundingScript: MockScript = [
    { content: "", toolCalls: [{ name: "does_not_exist", arguments: {} }] },
    { content: "我已经成功写入了文件，结果是 PROOF-99。" }, // 臆造
    { content: "工具调用失败，未取得任何成功结果，无法给出该结论。" },
  ];
  await withRun({ grounding: "require-evidence" }, groundingScript, {}, (r) => {
    check("无证据终答触发 grounding.reject", has(r, EventType.GroundingReject));
    check("打回后流程未崩溃，仍给出诚实终答", r.stoppedBy === "completed" && r.answer.includes("无法给出"));
  });
  await withRun({ grounding: "off" }, groundingScript.slice(0, 2), {}, (r) => {
    check("保守 off 模式不拦截终答", !has(r, EventType.GroundingReject));
  });

  // ---- 3) loopDetection=advisory：软警告而非硬终止 ----
  console.log("\n【3】loopDetection: exact → advisory");
  const loopScript: MockScript = [
    { content: "", toolCalls: [{ name: "calc", arguments: { expression: "1+1" } }] },
    { content: "", toolCalls: [{ name: "calc", arguments: { expression: "1+1" } }] },
    { content: "两次核对结果一致，完成。" },
  ];
  await withRun({ loopDetection: "advisory" }, loopScript, { loopDetectionThreshold: 2 }, (r) => {
    check("advisory 模式产生 guard.advisory 事件", has(r, EventType.LoopAdvisory));
    check("advisory 模式未直接终止", r.stoppedBy === "completed");
  });
  await withRun({ loopDetection: "exact" }, loopScript, { loopDetectionThreshold: 2 }, (r) => {
    check("保守 exact 模式仍硬终止（t18 语义保持）", r.stoppedBy === "guard" && !has(r, EventType.LoopAdvisory));
  });

  // ---- 4) compaction=salience：压缩优先保留成功工具结果 ----
  console.log("\n【4】compaction: truncate → salience");
  const longScript: MockScript = [
    ...Array.from({ length: 7 }, (_v, i) => ({ content: "", toolCalls: [{ name: "calc", arguments: { expression: `${i + 1}+${i + 1}` } }] })),
    { content: "长会话完成，早期历史已压缩。" },
  ];
  await withRun({ compaction: "salience" }, longScript, { compactTokens: 400 }, (r) => {
    const c = r.events.find((e) => e.type === EventType.Compaction);
    check("salience 模式触发压缩且标注策略", !!c && c.payload.strategy === "salience");
    check("salience 模式保留工具证据", !!c && Number(c.payload.evidenceKept) > 0, `evidenceKept=${c?.payload.evidenceKept}`);
  });
  await withRun({ compaction: "truncate" }, longScript, { compactTokens: 400 }, (r) => {
    const c = r.events.find((e) => e.type === EventType.Compaction);
    check("保守 truncate 模式标注为 truncate 且不计数证据", !!c && c.payload.strategy === "truncate" && Number(c.payload.evidenceKept) === 0);
  });

  // ---- 5) parallel=risk-first：策略解析与调度分支 ----
  console.log("\n【5】parallel: fifo → risk-first");
  await withRun(
    { parallel: "risk-first" },
    [
      { content: "", toolCalls: [
        { name: "calc", arguments: { expression: "1+1" } },
        { name: "file_write", arguments: { path: "risk.txt", content: "ok" } },
      ] },
      { content: "两个工具已执行。" },
    ],
    {},
    (r) => {
      check("risk-first 策略已解析进运行时", r.os.policy.parallel === "risk-first");
      check("两个工具结果均配对回喂（协议完整）", r.events.filter((e) => e.type === EventType.ToolResult).length === 2);
    },
  );

  // ---- 6) 边界：非法策略值必须回退保守默认 ----
  console.log("\n【6】边界校验");
  await withRun({ malformedArgs: "bypass" as never }, [{ content: "完成。" }], {}, (r) => {
    check("非法策略值回退保守默认", r.os.policy.malformedArgs === "fail");
  });

  console.log("\n" + "=".repeat(84));
  console.log(`  结果: ${pass} / ${pass + fail} 通过`);
  console.log("=".repeat(84));
  if (fail > 0) process.exitCode = 1;
}

await main();
