/**
 * v2.29.0 · P0-02 跨 agent 对照模板 · 离线契约测试（不联网 / 不需要 Key）
 *
 * 断言对照框架的诚实契约：bro2 自跑数已填、公开 agent 为 thirdPartyToFill 槽位（不可伪造）、
 * minimal scaffold 明确不等于公开基线、防自指护栏守住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname ?? "", "..");
const r = JSON.parse(readFileSync(join(ROOT, "data", "bench", "external", "agent-comparison.json"), "utf8")) as {
  agents: Record<string, { selfRun?: boolean; thirdPartyToFill?: boolean; passed: number | null; total: number; passRate: number | null; perTask?: Record<string, unknown> }>;
  internalBaselineNote: { warning: string; minimalScaffold: { passed: number; total: number }; deltaBro2MinusMinimal: number };
  honest: Record<string, unknown>;
};

test("bro2 自跑数已填（kilo k=3：6/9，Δ 自洽）", () => {
  const b = r.agents.bro2!;
  assert.equal(b.selfRun, true);
  assert.equal(b.passed, 6);
  assert.equal(b.total, 9);
  assert.equal(b.passRate, 0.667);
  assert.equal((b.perTask!["tb-analyze-access-logs"] as { passes: number }).passes, 3);
  assert.equal((b.perTask!["tb-bank-trans-filter"] as { passes: number }).passes, 3);
  assert.equal((b.perTask!["tb-assign-seats"] as { passes: number }).passes, 0);
});

test("mini-swe-agent / Terminus-2 为第三方填空槽位（不可伪造）", () => {
  for (const name of ["mini-swe-agent", "terminus-2"]) {
    const a = r.agents[name]!;
    assert.equal(a.thirdPartyToFill, true, `${name} 必须是第三方填空槽位`);
    assert.equal(a.passed, null, `${name} 的 passed 必须为 null（不得伪造）`);
    assert.equal(a.passRate, null);
    assert.ok(a.reproCommand && a.reproCommand.includes("harbor run"), `${name} 须给出可复现命令`);
  }
});

test("minimal scaffold 明确不等于公开基线，且 Δ 自洽", () => {
  assert.match(r.internalBaselineNote.warning, /不等于公开/);
  assert.equal(r.internalBaselineNote.minimalScaffold.passed, 2);
  assert.equal(r.internalBaselineNote.minimalScaffold.total, 9);
  assert.equal(
    r.internalBaselineNote.deltaBro2MinusMinimal,
    r.agents.bro2!.passed! - r.internalBaselineNote.minimalScaffold.passed,
  );
});

test("防自指护栏守住（不写 external-results / 不改 L4-verdict）", () => {
  assert.equal(r.honest.writtenToExternalResults, false);
  assert.equal(r.honest.leadershipVerdictChanged, false);
  assert.equal(r.honest.l4Changed, false);
  assert.equal(r.honest.thirdPartyVerified, false);
  assert.ok((r.honest.limitations as string[]).some((s) => s.includes("不得伪造")));
});
