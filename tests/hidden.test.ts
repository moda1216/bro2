/**
 * W1-04 · 隐藏测试执行器验收
 *
 * 关键性质（缺一不可）：
 *  1. fixture 能被完整铺进隔离目录，且不带依赖/缓存目录；
 *  2. 三个 fixture 的**真实缺陷**能被隐藏断言捕获（未修复 → 失败）；
 *  3. 修复后同一断言转绿（证明失败原因是缺陷，而不是命令写错）；
 *  4. 失败原因必须带命令与输出，便于定位。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hiddenReasons, runHiddenTests, stageRepo } from "../src/bench/runner.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = join(ROOT, "data/fixtures/repos");

const CASES = [
  {
    repo: "ts-strkit",
    file: "src/index.ts",
    broken: `  if (text.length <= max) return text;\n  return text.slice(0, max - 3) + "...";`,
    fixed: `  if (text.length <= max) return text;\n  if (max <= 3) return text.slice(0, max);\n  return text.slice(0, max - 3) + "...";`,
    command: `node --experimental-strip-types --no-warnings --input-type=module -e "const m=await import('./src/index.ts');const s=m.truncate('abcdefghij',2);process.exit(s.length<=2?0:1)"`,
  },
  {
    repo: "py-dates",
    file: "dates/__init__.py",
    broken: `    return a_start <= b_end and b_start <= a_end`,
    fixed: `    return a_start < b_end and b_start < a_end`,
    command: `python3 -c "from datetime import date;from dates import overlaps;assert not overlaps(date(2024,1,1),date(2024,1,31),date(2024,1,31),date(2024,2,10))"`,
  },
  {
    repo: "js-cart",
    file: "src/cart.js",
    broken: `  return subtotal(items) * (1 - discountRate);`,
    fixed: `  return Math.round(subtotal(items) * (1 - discountRate) * 100) / 100;`,
    command: `node --input-type=module -e "const m=await import('./src/cart.js');process.exit(m.total([{price:0.1,qty:3}],0)===0.3?0:1)"`,
  },
];

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "bro2-hidden-"));
}

test("stageRepo: 铺开完整仓库，且不复制 node_modules/.git", () => {
  const dir = tmp();
  try {
    const src = join(dir, "src");
    // 造一个带噪声目录的仓库，验证过滤规则而不是碰运气
    cpSync(join(FIXTURES, "ts-strkit"), src, { recursive: true });
    cpSync(join(FIXTURES, "ts-strkit"), join(dir, "dirty"), { recursive: true });
    cpSync(join(FIXTURES, "ts-strkit/src"), join(dir, "dirty/node_modules/x"), { recursive: true });
    cpSync(join(FIXTURES, "ts-strkit/src"), join(dir, "dirty/.git/objects"), { recursive: true });

    stageRepo(dir, "dirty", join(dir, "out"));
    assert.ok(existsSync(join(dir, "out/src/index.ts")), "源文件必须铺开");
    assert.ok(!existsSync(join(dir, "out/node_modules")), "node_modules 不得复制");
    assert.ok(!existsSync(join(dir, "out/.git")), ".git 不得复制");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const c of CASES) {
  test(`隐藏测试: ${c.repo} 未修复判失败，修复后判通过`, async () => {
    const dir = tmp();
    try {
      stageRepo(FIXTURES, c.repo, dir);
      const before = await runHiddenTests(dir, [c.command], 30_000);
      assert.equal(before.length, 1);
      assert.equal(before[0]!.ok, false, `${c.repo} 的缺陷应被捕获`);

      const p = join(dir, c.file);
      const text = readFileSync(p, "utf8");
      assert.ok(text.includes(c.broken), `fixture 源码结构与预期不符: ${c.file}`);
      writeFileSync(p, text.replace(c.broken, c.fixed));

      const after = await runHiddenTests(dir, [c.command], 30_000);
      assert.equal(after[0]!.ok, true, `修复后应通过: ${after[0]!.output}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("hiddenReasons: 只报失败，且带命令与输出", async () => {
  const dir = tmp();
  try {
    stageRepo(FIXTURES, "js-cart", dir);
    const results = await runHiddenTests(dir, ["exit 0", CASES[2]!.command], 30_000);
    const reasons = hiddenReasons(results);
    assert.equal(reasons.length, 1, "通过的断言不得产生噪声");
    assert.match(reasons[0]!, /隐藏测试失败/);
    assert.ok(reasons[0]!.includes("cart.js"), "必须带出失败命令");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runHiddenTests: 超时被强杀并判失败，不挂起", async () => {
  const dir = tmp();
  try {
    const t0 = Date.now();
    const [r] = await runHiddenTests(dir, ["sleep 5"], 300);
    assert.equal(r!.ok, false);
    assert.equal(r!.code, null);
    assert.match(r!.output, /超时/);
    assert.ok(Date.now() - t0 < 4000, "超时后应立即返回");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
