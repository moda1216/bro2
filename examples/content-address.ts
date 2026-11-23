/**
 * bro2 · P0 证据环 · 内容寻址 manifest（content-addressed integrity）
 * ----------------------------------------------------------------
 * 目的：把「config / harness / 冻结集 / 账本」从「按文件名引用」升级为「按内容哈希引用」，
 * 使任何篡改（改尺子、改评测集、改提示）都能被哈希漂移检测出来。
 *
 * 关键设计——**裁判外置**：保护清单在本脚本内独立声明（与 src/rsi/guardrails.ts 的
 * PROTECTED_FILES 对齐），不 import 运行时模块。这样自进化无法改运行时清单来放行自己。
 *
 * 两种模式：
 *   node examples/content-address.ts            # 生成/刷新 manifest（基线）
 *   node examples/content-address.ts --verify    # 校验当前文件 vs manifest，漂移则 exit 1
 *
 * 保护面分两类：
 *   - frozen  冻结面：源码尺子 + 评测集，任何改动都是重大事件（verify 应失败）。
 *   - ledger  只增账本：允许增长但不允许删改（此处记录当前哈希快照，历史只增由
 *              ledger-append-only-check.ts 的 git 历史校验负责，二者正交）。
 *
 * 零运行时依赖，只读源文件，仅写 data/evidence/content-manifest.json。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "data/evidence/content-manifest.json");
const VERIFY = process.argv.includes("--verify");

// 与 src/rsi/guardrails.ts PROTECTED_FILES 对齐（独立声明，外置裁判）
const FROZEN = [
  "src/observability/eval.ts", "src/kernel/loop.ts", "src/kernel/events.ts",
  "src/governance/guards.ts", "src/governance/permissions.ts", "src/runtime/policy.ts",
  "src/tools/repair.ts", "src/tools/runtime.ts", "src/rsi/types.ts", "src/rsi/guardrails.ts",
  "src/rsi/miner.ts", "src/rsi/operators.ts", "src/rsi/loop.ts", "src/rsi/meta.ts",
  "src/benchmark/ladder.ts", "src/benchmark/external.ts", "src/benchmark/scoring.ts",
  "data/eval-tasks.jsonl", "data/evolve/train.jsonl", "data/evolve/holdout.jsonl",
  "data/evolve/ood.jsonl",
];
const LEDGERS = [
  "data/rsi/velocity.jsonl", "data/rsi/experience.jsonl",
  "data/evolve/ledger.jsonl", "data/evolve/incidents.jsonl",
];
const CONFIG = ["agentos.config.json"];

const sha = (rel: string): string => {
  const p = resolve(ROOT, rel);
  return existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "MISSING";
};
const hashSet = (files: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const f of files) out[f] = sha(f);
  return out;
};

function build() {
  return {
    generatedAt: new Date().toISOString(),
    version: "p0-content-address-v1",
    note: "frozen=冻结面(改动应触发verify失败); ledger=只增账本当前快照(历史只增由git门禁负责); config=配置",
    frozen: hashSet(FROZEN),
    ledger: hashSet(LEDGERS),
    config: hashSet(CONFIG),
  };
}

if (!VERIFY) {
  const m = build();
  writeFileSync(OUT, JSON.stringify(m, null, 2) + "\n");
  const n = Object.keys(m.frozen).length + Object.keys(m.ledger).length + Object.keys(m.config).length;
  console.log(`内容寻址 manifest 已生成：${n} 个文件（frozen ${FROZEN.length} / ledger ${LEDGERS.length} / config ${CONFIG.length}）`);
  console.log(`写入 ${OUT}`);
} else {
  if (!existsSync(OUT)) {
    console.error("✗ manifest 不存在，请先运行 node examples/content-address.ts 生成基线");
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(OUT, "utf8"));
  const current = build();
  const drifts: string[] = [];
  for (const group of ["frozen", "ledger", "config"] as const) {
    for (const [f, h] of Object.entries(baseline[group] ?? {})) {
      const now = (current[group] as Record<string, string>)[f];
      if (now !== h) drifts.push(`${group}:${f}`);
    }
  }
  if (drifts.length > 0) {
    console.error(`✗ 内容寻址校验失败：${drifts.length} 处哈希漂移`);
    for (const d of drifts) console.error(`   - ${d}`);
    console.error("  frozen 漂移=篡改评测/尺子；ledger 漂移=账本被改写（须核对 git 只增历史）；config 漂移=配置变更");
    process.exit(1);
  }
  console.log(`✓ 内容寻址校验通过：冻结面 ${FROZEN.length} + 账本 ${LEDGERS.length} + 配置 ${CONFIG.length} 个文件哈希全部一致`);
}
