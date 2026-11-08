/**
 * W1-02 · fixture 仓库快照清单测试
 *
 * 只断言**可复现的结构事实**（不含本机路径、不跑子进程）：
 * 清单与装载器指向同一目录、每个仓库声明完整、指纹已钉住、总体积受控。
 * 「快照真的能跑测试」由 `npm run fixture:check -- --run` 在门禁里实证。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE_ROOT } from "../src/bench/loader.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

interface Manifest {
  schema: string;
  root: string;
  totalBytesLimit: number;
  repos: Array<{
    name: string; language: string; projectFile: string; test: string[];
    hiddenDefect: string; files?: number; bytes?: number; hash?: string;
  }>;
}

const manifest = JSON.parse(
  readFileSync(join(ROOT, "data/fixtures/repos/manifest.json"), "utf8"),
) as Manifest;

test("manifest 的根路径与装载器的 FIXTURE_ROOT 一致", () => {
  assert.equal(manifest.schema, "bro2.fixture/1");
  assert.equal(manifest.root, FIXTURE_ROOT, "两处路径必须同源，否则装载器找不到 fixture");
});

test("每个 fixture 仓库声明完整，且目录与项目文件真实存在", () => {
  assert.ok(manifest.repos.length >= 3, "W1-02 要求至少 3 个快照");
  for (const r of manifest.repos) {
    assert.ok(r.name, "仓库必须有 name");
    assert.ok(["ts", "js", "py"].includes(r.language), `${r.name}: language 非法`);
    assert.ok(r.test.length > 0, `${r.name}: 必须给出可离线执行的测试命令`);
    assert.ok(r.hiddenDefect.trim().length > 10, `${r.name}: 必须描述埋入的缺陷（否则任务无区分度）`);
    const dir = join(ROOT, manifest.root, r.name);
    assert.ok(existsSync(dir), `${r.name}: 目录不存在`);
    assert.ok(existsSync(join(dir, r.projectFile)), `${r.name}: 缺少 ${r.projectFile}`);
  }
});

test("指纹已钉住且格式合法，总体积在上限内", () => {
  let total = 0;
  for (const r of manifest.repos) {
    assert.match(r.hash ?? "", /^[0-9a-f]{12}$/, `${r.name}: 指纹未钉住或格式非法（先跑 fixture:check --update）`);
    assert.ok((r.files ?? 0) > 0, `${r.name}: 文件数未记录`);
    total += r.bytes ?? 0;
  }
  assert.ok(total <= manifest.totalBytesLimit, `总体积 ${total} 超出上限 ${manifest.totalBytesLimit}`);
});

test("fixture 不携带运行时产物（pyc / node_modules 等不应计入快照）", () => {
  for (const r of manifest.repos) {
    const dir = join(ROOT, manifest.root, r.name);
    for (const noise of ["__pycache__", "node_modules"]) {
      assert.ok(!existsSync(join(dir, noise)), `${r.name}: 快照被运行时产物污染（${noise}）`);
    }
  }
});
