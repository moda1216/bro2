/**
 * bro2 · 远程同步一致性检查（防漏推门禁）
 * ----------------------------------------------------------
 * 每次改进都要推送远程。本脚本只回答一个问题：本地是否已经全部同步？
 * 检查（全部只读，不需要任何凭证）：
 *   1) 本地 HEAD 是否等于远程 main 的 sha；
 *   2) 本地最新 tag 是否已存在于远程；
 *   3) 本地是否存在领先远程的提交（ahead > 0）。
 * 任何一项不满足 → 退出码 1，提示先执行 npm run ship。
 *
 * 用法：npm run push:check
 * 设计约束：纯读、零网络写、不触碰凭证；CI 与本地均可运行。
 */
import { spawnSync } from "node:child_process";

function git(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { encoding: "utf8", timeout: 30_000 });
  return { ok: r.status === 0 && !r.error, out: (r.stdout ?? "").trim() };
}

const line = (s = ""): void => { process.stdout.write(s + "\n"); };

const head = git(["rev-parse", "HEAD"]);
const remoteMain = git(["ls-remote", "origin", "refs/heads/main"]);
const remoteSha = remoteMain.ok ? (remoteMain.out.split(/\s+/)[0] ?? "") : "";

if (!remoteMain.ok || !remoteSha) {
  line("✗ 无法读取远程 main（网络不可达或 remote 未配置），无法确认同步状态");
  process.exit(1);
}

const problems: string[] = [];
if (head.ok && head.out !== remoteSha) {
  const ahead = git(["rev-list", "--count", `${remoteSha}..HEAD`]);
  const n = ahead.ok ? ahead.out : "?";
  problems.push(`本地 main 领先远程 ${n} 个提交（本地 ${head.out.slice(0, 7)} / 远程 ${remoteSha.slice(0, 7)}）`);
}

// 本地最新 tag 是否已在远程（只校验最新版本，避免历史 tag 噪声）
const localTag = git(["tag", "--sort=-v:refname"]);
const latest = localTag.ok ? (localTag.out.split("\n")[0]?.trim() ?? "") : "";
if (latest) {
  const remoteTag = git(["ls-remote", "origin", `refs/tags/${latest}`]);
  if (!remoteTag.ok || !remoteTag.out.trim()) {
    problems.push(`本地最新 tag ${latest} 尚未推送到远程`);
  }
}

if (problems.length === 0) {
  line(`✓ 远程已同步：main = ${remoteSha.slice(0, 7)}${latest ? `，最新 tag ${latest} 已在远程` : ""}`);
  process.exit(0);
}

line("✗ 检测到未同步的改进：");
for (const p of problems) line(`    - ${p}`);
line("  → 请先执行 npm run ship（提交 + 推送，复用仓库外 PAT 凭证）");
process.exit(1);
