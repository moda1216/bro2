/**
 * W2-04 · 编辑降级链验收
 * 核心不变量：**只在唯一命中时降级**；多处命中必须失败并给位置，绝不猜。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { applyEdit, formatEditFailure } from "../src/tools/edit-strategy.ts";

const SRC = `function f() {
    const x = 1;
    return x;
}

function g() {
    const x = 1;
    return x;
}
`;

test("exact：精确匹配优先，mode=exact 且无降级说明", () => {
  const r = applyEdit(SRC, "    const x = 1;\n    return x;\n}\n\nfunction g", "    const x = 1;\n    return x;\n}\n\nfunction G");
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.mode, "exact");
  assert.equal(r.ok && r.note, "");
});

test("whitespace：空白差异被归一化，唯一命中才替换", () => {
  const text = `function f() {\n    const only = 1;\n}`;
  const r = applyEdit(text, "const   only = 1;", "const only = 2;");
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.mode, "whitespace");
  assert.match(r.ok ? r.text : "", /const only = 2;/);
});

test("whitespace：同一片段出现两次 → 拒绝降级", () => {
  const r = applyEdit(SRC, "const   x = 1;", "const x = 2;");
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /多处匹配/);
});

test("block：old_text 整体无缩进时按行匹配，并补回缩进", () => {
  const text = `function f() {\n    const a = 1;\n    const b = 2;\n}`;
  const r = applyEdit(text, "const a = 1;\nconst b = 2;", "const a = 10;\nconst b = 20;");
  assert.equal(r.ok, true);
  assert.ok(r.ok && (r.mode === "block" || r.mode === "whitespace"), "应走模糊匹配");
  assert.match(r.ok ? r.text : "", /^ {4}const a = 10;$/m);
  assert.match(r.ok ? r.text : "", /^ {4}const b = 20;$/m);
});

test("block：去缩进后多处命中 → 拒绝", () => {
  const r = applyEdit(SRC, "const x = 1;\nreturn x;", "const x = 2;\nreturn x;");
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /多处匹配/);
});

test("失败提示：给最接近行号与明确下一步", () => {
  const r = applyEdit(SRC, "    const y = 1;", "    const y = 2;");
  assert.equal(r.ok, false);
  assert.ok(r.ok === false && r.nearestLine > 0, "应指出最接近的行");
  const msg = formatEditFailure(r as never);
  assert.match(msg, /最接近 line \d+/);
  assert.match(msg, /下一步：用 file_read/);
});
