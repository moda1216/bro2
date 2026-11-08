/**
 * bro2 · 远程同步一致性检查（防漏推门禁）
 * ----------------------------------------------------------
 * 每次改进都要推送远程。本脚本只回答一个问题：本地是否已经全部同步？
 * 检查（全部只读，不需要任何凭证）：
 *   1) 本地 HEAD 是否等于远程 main 的 sha；
 *   2) 本地最新 tag 是否已存在于远程；
 *   3) 本地是否存在领先远程的提交（ahead > 0）。
 * 任何一项确认不满足 → 退出码 1，提示先执行 npm run ship。
 *
 * 用法：npm run push:check
 * 设计约束：
 *   - 纯读、零网络写、不触碰凭证；CI 与本地均可运行。
 *   - 网络抖动（Connection reset / GnuTLS / unable to access）会做有限重试；
 *     push 成功后远程 ref 可能有短暂传播延迟，值不一致时复查一次，避免误判漏推。
 *   - 「网络不可达 = 无法复核」是信息项（退出 0），不等于「已同步」，也不等于「漏推」；
 *     只有**确认**未同步才退出 1。ship 的推送步骤在前，网络彻底不可达时 push 早已失败。
 */
import { spawnSync } from "node:child_process";

const LS_REMOTE_RETRIES = 3;

function git(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { encoding: "utf8", timeout: 10_000 });
  return { ok: r.status === 0 && !r.error, out: (r.stdout ?? "").trim() };
}

/** ls-remote 是匿名读，偶发网络抖动很常见；有限重试，不无限等待。 */
function lsRemote(ref: string): { ok: boolean; out: string } {
  let last = { ok: false, out: "" };
  for (let i = 0; i < LS_REMOTE_RETRIES; i += 1) {
    last = git(["ls-remote", "origin", ref]);
    if (last.ok) return last;
  }
  return last;
}

const line = (s = ""): void => { process.stdout.write(s + "\n"); };

const head = git(["rev-parse", "HEAD"]);
const remoteMain = lsRemote("refs/heads/main");

if (!remoteMain.ok || !remoteMain.out) {
  line("⚠ 网络不可达：无法复核远程同步状态（信息项，不阻断发布；推送若已完成不受影响）");
  process.exit(0);
}

let remoteSha = remoteMain.out.split(/\s+/)[0] ?? "";

// push 成功后远程 ref 可能短暂仍指向旧 sha：复查一次再判定，避免把延迟当成漏推
if (head.ok && head.out !== remoteSha) {
  const again = lsRemote("refs/heads/main");
  if (again.ok) remoteSha = again.out.split(/\s+/)[0] ?? remoteSha;
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
  const remoteTag = lsRemote(`refs/tags/${latest}`);
  if (!remoteTag.out.trim()) {
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
