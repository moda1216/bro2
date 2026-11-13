/**
 * 逐轨迹诊断（只读）：dump bro2 在指定外部任务上的每一步事件，用于定位失败机理。
 * 不改 harness、不写评分产物、不写 external-results.json。
 *
 *   AGENTOS_LIVE_PROVIDER=kilo node --experimental-strip-types --no-warnings \
 *     examples/traj-diag.ts tb-bank-trans-filter tb-assign-seats
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentOS } from "../src/index.ts";
import { faultConfig, mergeConfigForEval } from "../src/observability/eval-grade.ts";
import type { RuntimeConfig } from "../src/kernel/runtime.ts";
import { loadTasks, instructionOf, prepare, runVerifier, MAX_MODEL_CALLS } from "./external-measure.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const only = process.argv.slice(2);
const provider = process.env.TRAJ_PROVIDER ?? "kilo";
const tasks = loadTasks().filter((t) => only.length === 0 || only.includes(t.id));
const flat = (s: unknown, n = 260): string => String(s ?? "").replace(/\s+/g, " ").slice(0, n);

for (const t of tasks) {
  const tmp = mkdtempSync(join(tmpdir(), "bro2-traj-"));
  const ws = join(tmp, "ws");
  mkdirSync(ws, { recursive: true });
  let os: ReturnType<typeof createAgentOS> | undefined;
  try {
    prepare(t, ws);
    const input = instructionOf(t);
    os = createAgentOS({
      root: ROOT,
      autoApprove: true,
      plugins: [],
      evolvedState: false,
      config: mergeConfigForEval(
        faultConfig({ id: t.id, category: t.category, input }, tmp),
        { budget: { maxSteps: MAX_MODEL_CALLS } } as Partial<RuntimeConfig>,
      ),
    });
    os.router.setDefault(provider);
    os.router.setStrict(true);
    const s = os.createSession("standard");
    const r = await os.run(s.id, input);
    const v = runVerifier(t, ws);
    console.log(`\n===== ${t.id} =====`);
    console.log(`stoppedBy=${r.stoppedBy} steps=${r.steps} tools=${r.toolCallCount} verifier=${v.passed ? "PASS" : "FAIL"}`);
    for (const e of s.trajectory.events()) {
      const p = (e.payload ?? {}) as Record<string, any>;
      if (e.type === "message.assistant") {
        console.log(`  [A] ${flat(p.content, 240)}`);
        for (const c of (p.toolCalls ?? []) as Array<{ name: string; arguments: unknown }>) {
          console.log(`      -> ${c.name}(${flat(JSON.stringify(c.arguments), 320)})`);
        }
      } else if (e.type === "tool.result") {
        const rr = (p.result ?? {}) as { name?: string; ok?: boolean; output?: string; error?: string };
        console.log(`  [R] ${rr.name} ok=${rr.ok} ${flat(rr.output ?? rr.error, 260)}`);
      } else if (["guard", "guard.advisory", "run.end", "error", "grounding.reject", "compaction"].includes(e.type)) {
        console.log(`  [${e.type}] ${flat(JSON.stringify(p), 300)}`);
      }
    }
  } catch (err) {
    console.log(`[ERR] ${t.id}: ${(err as Error).message}`);
  } finally {
    if (os) await os.shutdown();
    rmSync(tmp, { recursive: true, force: true });
  }
}
