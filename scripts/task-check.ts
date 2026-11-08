#!/usr/bin/env node
/**
 * task:check · 任务双态校准（W1-05 的前置）
 * ----------------------------------------------------------
 * 一个任务只有同时满足下面两条才算「真任务」：
 *   1. 在 fixture 原始快照上**必须失败**——否则不修也能过，等于白送分；
 *   2. 应用参考解后**必须通过**——否则谁也做不出来，等于不可解。
 *
 * 只读任务文件与 fixture，所有改写都发生在临时目录，用完即删。
 * 参考解只存在于任务 JSON，不下发到被测工作区。
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLayer, FIXTURE_ROOT } from "../src/bench/loader.ts";
import { hiddenReasons, runHiddenTests, stageRepo } from "../src/bench/runner.ts";
import { LAYERS, type TaskReference, type TaskV2 } from "../src/bench/schema.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const json = argv.includes("--json");
const quiet = argv.includes("--quiet") || json;
const layerArg = flag("layer") ?? "l2";
const only = flag("only");
const layers = layerArg === "all" ? LAYERS : LAYERS.filter((l) => l === layerArg);

if (layers.length === 0) {
  process.stderr.write(`未知层 "${layerArg}"，可选：${LAYERS.join(" / ")} / all\n`);
  process.exit(2);
}

function applyRefs(dir: string, refs: readonly TaskReference[]): string[] {
  const problems: string[] = [];
  for (const r of refs) {
    const p = join(dir, r.file);
    let text: string;
    try {
      text = readFileSync(p, "utf8");
    } catch {
      problems.push(`参考解目标文件不存在: ${r.file}`);
      continue;
    }
    if (r.append !== undefined) {
      writeFileSync(p, text + r.append);
      continue;
    }
    if (!text.includes(r.find!)) {
      problems.push(`参考解锚点未命中: ${r.file} ← ${JSON.stringify(r.find!.slice(0, 60))}`);
      continue;
    }
    writeFileSync(p, text.replace(r.find!, r.replace!));
  }
  return problems;
}

interface Row {
  id: string;
  layer: string;
  repo: string;
  brokenCaught: boolean;
  fixedPasses: boolean;
  problems: string[];
}

const rows: Row[] = [];
const skipped: string[] = [];

for (const layer of layers) {
  const loaded = loadLayer(ROOT, layer);
  for (const problem of loaded.problems) process.stderr.write(`✗ ${problem}\n`);
  for (const t of loaded.v2) {
    if (!t.repo || !t.hiddenTests?.length) continue;
    if (only && t.id !== only) continue;
    if (!t.reference?.length) {
      skipped.push(`${t.id}: 无参考解，无法证明「可解且非白送」`);
      continue;
    }
    rows.push(await checkTask(t));
  }
}

async function checkTask(t: TaskV2): Promise<Row> {
  const dir = mkdtempSync(join(tmpdir(), "bro2-task-"));
  const problems: string[] = [];
  try {
    stageRepo(join(ROOT, FIXTURE_ROOT), t.repo!, dir);
    const before = await runHiddenTests(dir, t.hiddenTests!);
    const brokenCaught = before.every((r) => !r.ok);
    if (!brokenCaught) {
      const passing = before.filter((r) => r.ok).map((r) => r.command);
      problems.push(`原始快照未被判失败（白送分）: ${passing.join(" | ")}`);
    }
    problems.push(...applyRefs(dir, t.reference!));
    const after = await runHiddenTests(dir, t.hiddenTests!);
    const fixedPasses = after.every((r) => r.ok);
    if (!fixedPasses) problems.push(...hiddenReasons(after));
    return { id: t.id, layer: t.layer, repo: t.repo!, brokenCaught, fixedPasses, problems };
  } catch (err) {
    return { id: t.id, layer: t.layer, repo: t.repo ?? "-", brokenCaught: false, fixedPasses: false, problems: [`执行异常: ${(err as Error).message}`] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const failed = rows.filter((r) => !r.brokenCaught || !r.fixedPasses || r.problems.length > 0);

if (json) {
  process.stdout.write(JSON.stringify({ rows, skipped, failed: failed.length }, null, 2) + "\n");
} else {
  process.stdout.write("任务双态校准（原始快照必失败 / 参考解必通过）\n");
  process.stdout.write("ID".padEnd(16) + "层".padEnd(5) + "快照".padEnd(8) + "参考解".padEnd(9) + "仓库\n");
  for (const r of rows) {
    const b = r.brokenCaught ? "✓失败" : "✗通过";
    const f = r.fixedPasses ? "✓通过" : "✗失败";
    process.stdout.write(r.id.padEnd(16) + r.layer.padEnd(5) + b.padEnd(8) + f.padEnd(9) + r.repo + "\n");
  }
  if (!quiet) for (const r of failed) for (const p of r.problems) process.stdout.write(`  ✗ ${r.id}: ${p}\n`);
  for (const s of skipped) process.stdout.write(`  ⚠ ${s}\n`);
  process.stdout.write(`\n合计 ${rows.length} 个任务，失败 ${failed.length} 个，跳过 ${skipped.length} 个\n`);
}

process.exit(failed.length > 0 ? 1 : 0);
