/**
 * budget:check · 代码预算门禁
 * ----------------------------------------------------------
 * 把「代码量要少、工程质量要高」变成阻断门禁，而不是口号。
 * 四项硬指标（阈值见 data/plan/budget.json）：
 *   1. 源代码总行数   2. 源文件数
 *   3. 单文件最大行数 4. 测试/源行数比
 * 外加运行时第三方依赖必须为 0。
 *
 * 阈值只允许在 docs/BENCH-v2.md 记录理由后上调；下调随时允许。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const COUNTED = ["src", "bin", "scripts"];

interface Budget {
  limits: { sourceFiles: number; sourceLines: number; maxFileLines: number; minTestToSourceRatio: number };
  runtimeDependencies: number;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const sourceFiles = COUNTED.flatMap((d) => walk(join(ROOT, d)));
const testFiles = walk(join(ROOT, "tests"));
const lines = (f: string) => readFileSync(f, "utf8").split("\n").length - 1;

const perFile = sourceFiles.map((f) => ({ path: relative(ROOT, f), lines: lines(f) }));
const sourceLines = perFile.reduce((s, f) => s + f.lines, 0);
const testLines = testFiles.reduce((s, f) => s + lines(f), 0);
const biggest = perFile.sort((a, b) => b.lines - a.lines)[0];
const ratio = sourceLines === 0 ? 0 : testLines / sourceLines;

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
const deps = Object.keys(pkg.dependencies ?? {}).length;
const budget = JSON.parse(readFileSync(join(ROOT, "data", "plan", "budget.json"), "utf8")) as Budget;

const checks = [
  { name: "源代码行", value: sourceLines, limit: budget.limits.sourceLines, ok: sourceLines <= budget.limits.sourceLines, fmt: (v: number) => v.toLocaleString("en-US") },
  { name: "源文件数", value: sourceFiles.length, limit: budget.limits.sourceFiles, ok: sourceFiles.length <= budget.limits.sourceFiles, fmt: (v: number) => String(v) },
  { name: "单文件最大", value: biggest.lines, limit: budget.limits.maxFileLines, ok: biggest.lines <= budget.limits.maxFileLines, fmt: (v: number) => String(v) },
  { name: "运行时依赖", value: deps, limit: budget.runtimeDependencies, ok: deps <= budget.runtimeDependencies, fmt: (v: number) => String(v) },
];

console.log("代码预算（data/plan/budget.json）");
for (const c of checks) {
  const pct = c.limit === 0 ? (c.ok ? 100 : 0) : Math.round((c.value / c.limit) * 100);
  console.log(`  ${c.ok ? "✓" : "✗"} ${c.name.padEnd(7, "　")} ${c.fmt(c.value).padStart(7)} / ${c.fmt(c.limit).padStart(7)}  ${String(pct).padStart(3)}%`);
}
console.log(`  ${ratio >= budget.limits.minTestToSourceRatio ? "✓" : "✗"} 测试/源  ${ratio.toFixed(2)} / ≥${budget.limits.minTestToSourceRatio}`);
console.log(`  最大文件：${biggest.path}`);

const failed = checks.filter((c) => !c.ok).length + (ratio >= budget.limits.minTestToSourceRatio ? 0 : 1);
if (failed > 0) {
  console.error(`\n✗ 代码预算超限 ${failed} 项：先删除或合并，不要上调阈值（上调需在 docs/BENCH-v2.md 记录理由）。`);
  process.exit(1);
}
console.log("\n✓ 代码预算通过：体积受控，删优先于加。");
