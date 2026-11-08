/**
 * W2-03 · diagnostics 验收
 * 只断言「解析出的结构能指导下一步」，不断言输出格式的细枝末节。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectTestCommand, formatDiagnostics, parseDiagnostics, runDiagnostics } from "../src/tools/diagnostics.ts";
import { stageRepo } from "../src/bench/runner.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = join(ROOT, "data/fixtures/repos");

test("parseDiagnostics：node:test 失败项带测试名与 error 行", () => {
  const out = `not ok 3 - cart.total rounds to cents
  ---
  error: |-
    Expected values to be strictly equal:
    0.30000000000000004 !== 0.3
  ...
# tests 4
# pass 3
# fail 1`;
  const r = parseDiagnostics(out);
  assert.equal(r.total, 4);
  assert.equal(r.failed, 1);
  assert.equal(r.diagnostics[0]!.name, "cart.total rounds to cents");
  assert.match(r.diagnostics[0]!.message, /0\.30000000000000004/);
});

test("parseDiagnostics：unittest 与 tsc 两类格式", () => {
  const py = parseDiagnostics("FAIL: test_overlap (tests.test_dates.TestOverlaps)\nERROR: test_x (tests.test_y.T)");
  assert.equal(py.diagnostics.length, 2);
  assert.equal(py.diagnostics[0]!.kind, "test");
  assert.match(py.diagnostics[0]!.message, /FAIL in tests\.test_dates/);

  const ts = parseDiagnostics("src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.");
  assert.deepEqual(ts.diagnostics[0], {
    kind: "type", name: "TS2322", file: "src/a.ts", line: 12, message: "Type 'string' is not assignable to type 'number'.",
  });
});

test("detectTestCommand：能识别 node 项目，未知目录返回 null", () => {
  assert.match(detectTestCommand(join(FIXTURES, "js-cart"))!, /npm test/);
  assert.match(detectTestCommand(join(FIXTURES, "py-dates"))!, /unittest/);
  const empty = mkdtempSync(join(tmpdir(), "bro2-empty-"));
  try {
    assert.equal(detectTestCommand(empty), null);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("runDiagnostics：真实 fixture 通过时不产生噪声", async () => {
  const r = await runDiagnostics(join(FIXTURES, "js-cart"));
  assert.equal(r.ok, true, r.raw);
  assert.equal(r.diagnostics.length, 0);
  assert.match(formatDiagnostics(r), /诊断通过/);
});

test("runDiagnostics：改坏代码后能定位到具体测试名", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bro2-diag-"));
  try {
    stageRepo(FIXTURES, "js-cart", dir);
    const p = join(dir, "src/cart.js");
    writeFileSync(p, readFileSync(p, "utf8").replace("item.price * item.qty", "item.price + item.qty"));
    const r = await runDiagnostics(dir);
    assert.equal(r.ok, false);
    assert.ok(r.diagnostics.length >= 1, r.raw);
    assert.ok(r.diagnostics.some((d) => /subtotal/.test(d.name)), JSON.stringify(r.diagnostics));
    assert.match(formatDiagnostics(r), /项失败/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
