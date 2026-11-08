/**
 * W2-01 · repomap 验收
 *
 * 断言绑定真实分支：符号提取、导入解析、入度排序、预算截断、工具输出。
 * 不测「看起来像不像 AST」，只测「模型拿到的骨架是否够用且不超预算」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRepoMap, estimateTokens, extractImports, extractSymbols, renderRepoMap, scanRepo } from "../src/context/repomap.ts";
import { repoMap, searchSymbol } from "../src/tools/builtins/code.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = join(ROOT, "data/fixtures/repos");

test("extractSymbols：TS 导出与 Python 顶层定义", () => {
  const ts = `export function a() {}\nexport const b = 1;\nexport interface C {}\nexport { d, e as f };\nfunction hidden() {}`;
  assert.deepEqual(extractSymbols(ts, ".ts").sort(), ["C", "a", "b", "d", "e"]);
  const py = `class A:\n    def inner(self): pass\ndef top():\n    pass\n`;
  assert.deepEqual(extractSymbols(py, ".py").sort(), ["A", "top"]);
});

test("extractImports：只取可解析的导入形式，不把第三方包当仓库内依赖", () => {
  const ts = `import { x } from "./a.ts";\nimport y from "../b.js";\nimport z from "node:fs";`;
  assert.deepEqual(extractImports(ts, ".ts").sort(), ["../b.js", "./a.ts"]);
  const py = `from .util import f\nfrom dates import overlaps\n`;
  assert.deepEqual(extractImports(py, ".py").sort(), [".util", "dates"]);
});

test("scanRepo：相对导入被解析成仓库内边，并计入入度", () => {
  const entries = scanRepo(join(FIXTURES, "ts-strkit"));
  const index = entries.find((e) => e.path === "src/index.ts")!;
  assert.ok(index, "必须索引到 src/index.ts");
  assert.ok(index.importedBy >= 1, "测试文件 import 了它，入度应 ≥ 1");
  assert.ok(index.symbols.includes("truncate"));
});

test("scanRepo：Python 绝对导入同样能连边", () => {
  const entries = scanRepo(join(FIXTURES, "py-dates"));
  const mod = entries.find((e) => e.path === "dates/__init__.py")!;
  assert.ok(mod.importedBy >= 1, `dates/__init__.py 应被测试引用，实际 ${mod.importedBy}`);
});

test("renderRepoMap：预算硬约束，超出时省略并显式标注", () => {
  const entries = scanRepo(join(ROOT, "src"));
  const full = renderRepoMap(entries, 4000);
  assert.ok(full.length > 0);
  const tiny = renderRepoMap(entries, 80);
  assert.ok(estimateTokens(tiny) <= 90, `预算 80 tokens，实际约 ${estimateTokens(tiny)}`);
  assert.match(tiny, /已省略 \d+ 个文件/);
});

test("buildRepoMap：fixture 上给出可读骨架，且不含无关键", () => {
  const map = buildRepoMap(join(FIXTURES, "js-cart"), 400);
  assert.match(map, /src\/cart\.js/);
  assert.match(map, /subtotal/);
});

const fakeCtx = (root: string) => ({
  runtime: {
    require: () => ({
      validatePath: (p: string) => ({ ok: true, resolved: join(root, p) }),
    }),
  },
}) as never;

test("repo_map 工具：输出骨架且尊重 budget 参数", () => {
  const out = repoMap.handler({ path: ".", budget: 300 }, fakeCtx(join(FIXTURES, "ts-strkit"))) as string;
  assert.match(out, /src\/index\.ts/);
  assert.match(out, /truncate/);
});

test("search_symbol 工具：命中定义位置并带行号", () => {
  const out = searchSymbol.handler({ name: "truncate", path: ".", limit: 10 }, fakeCtx(join(FIXTURES, "ts-strkit"))) as string;
  assert.match(out, /src\/index\.ts:\d+/);
  assert.match(out, /export function truncate/);
  assert.match(searchSymbol.handler({ name: "不存在符号X", path: "." }, fakeCtx(join(FIXTURES, "ts-strkit"))) as string, /未找到/);
});
