/**
 * W1-02 · fixture 仓库快照的完整性与可运行性校验
 *
 *   npm run fixture:check              校验结构 / 体积 / 内容哈希
 *   npm run fixture:check -- --run     额外对每个仓库真实执行一次测试
 *   npm run fixture:check -- --update  重算并写回 manifest 的 files/bytes/hash
 *
 * 为什么钉内容哈希：fixture 一旦被静默改动，所有基于它的任务分数都失去可比性。
 * 哈希不一致时**拒绝通过**，必须显式 --update 并说明原因，避免无声漂移。
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = join(ROOT, "data/fixtures/repos/manifest.json");
const TOTAL_LIMIT = 3 * 1024 * 1024;

interface FixtureRepo {
  name: string;
  language: "ts" | "js" | "py";
  /** 必须存在的项目描述文件 */
  projectFile: string;
  /** 离线测试命令（argv，不经 shell） */
  test: string[];
  hiddenDefect: string;
  files?: number;
  bytes?: number;
  hash?: string;
}
interface Manifest {
  schema: "bro2.fixture/1";
  root: string;
  totalBytesLimit: number;
  repos: FixtureRepo[];
}

const argv = process.argv.slice(2);
const runTests = argv.includes("--run");
const update = argv.includes("--update");

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
const problems: string[] = [];

/**
 * 运行时产物绝不能进指纹：它们随本机解释器/依赖版本变化，
 * 会让「同一快照」在不同环境得出不同哈希（跨环境假红）。
 */
const EXCLUDED_DIRS = new Set(["__pycache__", "node_modules", ".pytest_cache", ".git", ".venv"]);
const EXCLUDED_EXT = [".pyc", ".pyo", ".log"];

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) walk(join(dir, entry.name), acc);
    } else if (entry.isFile()) {
      if (!EXCLUDED_EXT.some((ext) => entry.name.endsWith(ext))) acc.push(join(dir, entry.name));
    }
  }
  return acc;
}

/** 仓库指纹：按路径排序后对 "相对路径\0内容" 求 sha256，路径与内容任一变化都会变。 */
function fingerprint(dir: string, files: string[]): { hash: string; bytes: number } {
  const h = createHash("sha256");
  let bytes = 0;
  for (const f of [...files].sort()) {
    const buf = readFileSync(f);
    bytes += buf.length;
    h.update(relative(dir, f)).update("\0").update(buf);
  }
  return { hash: h.digest("hex").slice(0, 12), bytes };
}

let totalBytes = 0;
const rows: Array<{ name: string; files: number; bytes: number; hash: string; test: string }> = [];

for (const repo of manifest.repos) {
  const dir = join(ROOT, "data/fixtures/repos", repo.name);
  if (!existsSync(dir)) {
    problems.push(`${repo.name}: 目录不存在`);
    continue;
  }
  if (!existsSync(join(dir, repo.projectFile))) {
    problems.push(`${repo.name}: 缺少项目描述文件 ${repo.projectFile}`);
  }

  const files = walk(dir);
  const { hash, bytes } = fingerprint(dir, files);
  totalBytes += bytes;

  if (update) {
    repo.files = files.length;
    repo.bytes = bytes;
    repo.hash = hash;
  } else {
    if (repo.hash && repo.hash !== hash) {
      problems.push(`${repo.name}: 内容哈希不符（manifest ${repo.hash} ≠ 实际 ${hash}）——fixture 被改动，需显式 --update`);
    }
    if (repo.bytes !== undefined && repo.bytes !== bytes) {
      problems.push(`${repo.name}: 字节数不符（manifest ${repo.bytes} ≠ 实际 ${bytes}）`);
    }
  }

  let testLabel = "未执行";
  if (runTests) {
    const [cmd, ...args] = repo.test;
    // 禁止 Python 写 .pyc：跑测试不应污染快照（否则指纹与工作树都会被运行时产物影响）。
    const r = spawnSync(cmd, args, {
      cwd: dir,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
      testLabel = `skip（缺少 ${cmd}）`;
    } else if (r.status === 0) {
      testLabel = "✓ 通过";
    } else {
      testLabel = "✗ 失败";
      problems.push(`${repo.name}: 测试失败（${repo.test.join(" ")}）\n${(r.stdout ?? "") + (r.stderr ?? "")}`.slice(0, 500));
    }
  }

  rows.push({ name: repo.name, files: files.length, bytes, hash, test: testLabel });
}

if (totalBytes > TOTAL_LIMIT) {
  problems.push(`fixture 总体积 ${totalBytes} 字节超出上限 ${TOTAL_LIMIT}（快照应保持精简）`);
}

if (update) {
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`manifest 已更新（${manifest.repos.length} 个仓库，${totalBytes} 字节）`);
} else {
  console.log(`\n仓库        文件   字节     指纹         测试`);
  for (const r of rows) {
    console.log(`${r.name.padEnd(12)}${String(r.files).padEnd(7)}${String(r.bytes).padEnd(9)}${r.hash.padEnd(13)}${r.test}`);
  }
  console.log(`\n合计 ${rows.length} 个仓库 · ${totalBytes} / ${TOTAL_LIMIT} 字节`);
}

if (problems.length > 0) {
  console.error(`\n✗ fixture 校验失败（${problems.length} 项）：`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`\n✓ fixture 校验通过：${rows.length} 个仓库结构完整、体积受控${runTests ? "、测试可跑" : ""}。`);
