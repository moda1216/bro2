#!/usr/bin/env node
/**
 * aci:check · 编辑接口指标实测（W2-05）
 * ----------------------------------------------------------
 * 把「编辑接口好不好用」变成可复跑的数字，而不是感觉：
 *  - 成功率：4 类真实输入变体（精确 / 空白 / 跨行缩进 / 去缩进）是否都能改对；
 *  - 拒绝正确率：多处命中与不存在时是否**拒绝**并给出位置（错改比不改更难发现）；
 *  - 补丁原子性：多文件补丁任一失败时，一个字节都不写。
 *
 * 边界：这是**策略级**指标，不是 L2 任务级编辑成功率。后者必须 live 跑任务，
 * 报告里逐任务的 tools 分布可作归因，不能用本脚本替代。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEdit } from "../src/tools/edit-strategy.ts";
import { applyPatch } from "../src/tools/patch.ts";

interface Row { name: string; ok: boolean; detail: string }
const rows: Row[] = [];
const add = (name: string, ok: boolean, detail: string) => rows.push({ name, ok, detail });

const SRC = `function f() {
    const x = 1;
    return x;
}

function g() {
    const x = 1;
    return x;
}
`;

const exact = applyEdit(SRC, "    const x = 1;\n    return x;\n}\n\nfunction g", "    const x = 2;\n    return x;\n}\n\nfunction g");
add("精确匹配", exact.ok && exact.mode === "exact", exact.ok ? exact.mode : "失败");

const ws = applyEdit(`function f() {\n    const only = 1;\n}`, "const   only = 1;", "const only = 2;");
add("空白归一化", ws.ok && ws.mode === "whitespace" && /only = 2/.test(ws.ok ? ws.text : ""), ws.ok ? ws.mode : "失败");

const multiLine = applyEdit(`function f() {\n    const a = 1;\n    const b = 2;\n}`, "const a = 1;\nconst b = 2;", "const a = 10;\nconst b = 20;");
add(
  "跨行缩进保留",
  multiLine.ok && /^ {4}const a = 10;$/m.test(multiLine.text) && /^ {4}const b = 20;$/m.test(multiLine.text),
  multiLine.ok ? multiLine.mode : "失败",
);

const ambiguous = applyEdit(SRC, "const x = 1;", "const x = 3;");
add("多处命中必须拒绝", !ambiguous.ok && /多次|多处/.test(ambiguous.ok ? "" : ambiguous.reason), ambiguous.ok ? "误改" : ambiguous.reason.slice(0, 30));

const missing = applyEdit(SRC, "    const y = 1;", "    const y = 2;");
add("不存在时给位置", !missing.ok && missing.nearestLine > 0, missing.ok ? "误改" : `line ${missing.nearestLine}`);

const dir = mkdtempSync(join(tmpdir(), "bro2-aci-"));
try {
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  const drifted = `--- a/a.txt
+++ b/a.txt
@@ -99,1 +99,1 @@
-one
+ONE
`;
  const okPatch = applyPatch(dir, drifted);
  add("补丁行号漂移", okPatch.ok && readFileSync(join(dir, "a.txt"), "utf8").includes("ONE"), okPatch.ok ? "已应用" : okPatch.errors[0]?.reason ?? "");

  writeFileSync(join(dir, "b.txt"), "keep\n");
  const atomic = applyPatch(dir, `${drifted}--- a/../escape.txt
+++ b/../escape.txt
@@ -1,1 +1,1 @@
-x
+y
`);
  add(
    "失败时零写入",
    !atomic.ok && readFileSync(join(dir, "a.txt"), "utf8").includes("ONE"),
    atomic.ok ? "误写" : "未写入",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const passed = rows.filter((r) => r.ok).length;
process.stdout.write("ACI 编辑接口指标（策略级）\n");
for (const r of rows) process.stdout.write(`  ${r.ok ? "✓" : "✗"} ${r.name.padEnd(14)} ${r.detail}\n`);
process.stdout.write(`\n结果: ${passed} / ${rows.length} 通过\n`);
if (passed !== rows.length) {
  process.stderr.write("✗ 编辑接口存在明确缺陷：先修策略，不要靠模型多试几次掩盖。\n");
  process.exit(1);
}
process.stdout.write("✓ 编辑接口：能改对、该拒就拒、失败不写半成品。\n");
