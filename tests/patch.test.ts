/**
 * W2-02 · apply_patch 验收
 * 重点不是「能改」，而是失败时的行为：不写半成品、给出可执行的下一步。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPatch, formatPatchResult, parsePatch } from "../src/tools/patch.ts";
import { stageRepo } from "../src/bench/runner.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = join(ROOT, "data/fixtures/repos");

function withRepo(repo: string, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "bro2-patch-"));
  try {
    stageRepo(FIXTURES, repo, dir);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FIX = `--- a/src/index.ts
+++ b/src/index.ts
@@ -21,2 +21,3 @@
   if (text.length <= max) return text;
+  if (max <= 3) return text.slice(0, max);
   return text.slice(0, max - 3) + "...";
`;

test("parsePatch：多文件多块，路径去掉 a/ b/ 前缀", () => {
  const p = parsePatch(`${FIX}--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,2 @@\n # x\n+added\n`);
  assert.deepEqual(p.errors, []);
  assert.equal(p.files.length, 2);
  assert.equal(p.files[0]!.path, "src/index.ts");
  assert.equal(p.files[0]!.hunks[0]!.oldLines.length, 2);
  assert.equal(p.files[0]!.hunks[0]!.newLines.length, 3);
});

test("applyPatch：hunk 行号漂移也能按内容定位", () => {
  withRepo("ts-strkit", (dir) => {
    const drifted = FIX.replace("@@ -21,2 +21,3 @@", "@@ -999,2 +999,3 @@");
    const r = applyPatch(dir, drifted);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.match(readFileSync(join(dir, "src/index.ts"), "utf8"), /if \(max <= 3\)/);
  });
});

test("applyPatch：多文件同时生效", () => {
  withRepo("ts-strkit", (dir) => {
    const patch = `${FIX}--- a/README.md
+++ b/README.md
@@ -1,1 +1,2 @@
 ${readFileSync(join(dir, "README.md"), "utf8").split("\n")[0]}
+patched
`;
    const r = applyPatch(dir, patch);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.applied.length, 2);
    assert.match(readFileSync(join(dir, "README.md"), "utf8"), /patched/);
  });
});

test("applyPatch：任一文件失败 → 全部不写（无半成品）", () => {
  withRepo("ts-strkit", (dir) => {
    const before = readFileSync(join(dir, "src/index.ts"), "utf8");
    const patch = `${FIX}--- a/../escape.ts
+++ b/../escape.ts
@@ -1,1 +1,1 @@
-x
+y
`;
    const r = applyPatch(dir, patch);
    assert.equal(r.ok, false);
    assert.equal(readFileSync(join(dir, "src/index.ts"), "utf8"), before, "合法文件也不得被写入");
    assert.match(formatPatchResult(r, false), /一个字节都不会写|未写入/);
  });
});

test("applyPatch：块未匹配时给出最接近行号", () => {
  withRepo("ts-strkit", (dir) => {
    const bad = `--- a/src/index.ts
+++ b/src/index.ts
@@ -1,1 +1,1 @@
- if (text.length <= max) return text;
+  if (text.length < max) return text;
`;
    const r = applyPatch(dir, bad);
    assert.equal(r.ok, false);
    assert.ok(r.errors[0]!.nearestLine > 0, "应给出最接近的实际行");
    assert.match(formatPatchResult(r, false), /下一步：用 file_read/);
  });
});

test("applyPatch：/dev/null 新建文件", () => {
  withRepo("js-cart", (dir) => {
    const patch = `--- /dev/null
+++ b/src/extra.js
@@ -0,0 +1,2 @@
+export const x = 1;
+export const y = 2;
`;
    const r = applyPatch(dir, patch);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(readFileSync(join(dir, "src/extra.js"), "utf8"), "export const x = 1;\nexport const y = 2;\n");
  });
});

test("applyPatch：dry-run 只校验不落盘", () => {
  withRepo("js-cart", (dir) => {
    const before = readFileSync(join(dir, "src/cart.js"), "utf8");
    const patch = `--- a/src/cart.js
+++ b/src/cart.js
@@ -1,1 +1,2 @@
 /** Shopping cart pricing. All money values are in the currency's major unit. */
+// touched
`;
    const r = applyPatch(dir, patch, { dryRun: true });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(readFileSync(join(dir, "src/cart.js"), "utf8"), before);
    assert.match(formatPatchResult(r, true), /dry-run/);
  });
});
