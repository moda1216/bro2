/**
 * 远程同步机制的回归测试（v2.2.1）
 * ----------------------------------------------------------
 * 红线：GitHub PAT 凭证绝不进入仓库、绝不回显、绝不硬编码。
 * 本测试验证的是「机制约束」而非推送动作本身——推送需要真实网络与凭证，
 * 由 npm run ship / npm run push:remote 在真实环境完成，测试只守住结构不变量。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const SECRET = /github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}|sk-or-v1-[A-Za-z0-9]{20,}/;

test("推送脚本不含任何明文凭证（askpass 只按路径读取）", () => {
  const sh = read("scripts/push-remote.sh");
  assert.ok(!SECRET.test(sh), "push-remote.sh 不得硬编码任何 token");
  assert.match(sh, /BRO2_GITHUB_PAT_FILE/, "凭证路径必须可由环境变量覆盖");
  assert.match(sh, /GIT_ASKPASS/, "必须通过一次性 askpass 传递凭证");
  assert.match(sh, /GIT_CONFIG_GLOBAL=\/dev\/null/, "必须屏蔽系统 credential helper，避免误用 App 令牌");
  assert.match(sh, /trap .*rm -f/, "askpass 临时文件必须在退出时清除");
});

test("ship 闭环：提交与推送分离，推送只走唯一通道", () => {
  const sh = read("scripts/ship.sh");
  assert.ok(!SECRET.test(sh), "ship.sh 不得含明文凭证");
  assert.match(sh, /sh scripts\/push-remote\.sh/, "必须复用唯一推送通道");
  assert.match(sh, /remote-check\.ts/, "推送后必须做同步自检，漏推就地暴露");
  assert.match(sh, /git restore/, "提交前还原运行时噪声，避免时间戳混进提交");
  assert.match(sh, /git add -A/, "提交全部改进");
});

test("防漏推检查为纯只读，不含写操作与凭证", () => {
  const ts = read("scripts/remote-check.ts");
  assert.ok(!SECRET.test(ts), "remote-check.ts 不得含明文凭证");
  // 提取所有 git([...]) 调用的首参数，逐一断言为只读子命令
  const subs = [...ts.matchAll(/git\(\[\s*"([a-z-]+)"/g)].map((m) => m[1]!);
  assert.ok(subs.length >= 3, "应存在多次 git 只读调用");
  const WRITE = new Set(["push", "commit", "tag", "config", "remote", "add", "reset", "restore", "checkout"]);
  // tag 的只读形式 `git tag --list|--sort` 例外：出现时确保不带 -a/-d
  for (const sub of subs) {
    if (WRITE.has(sub)) {
      assert.equal(sub, "tag", `不允许写子命令 git ${sub}`);
      assert.doesNotMatch(ts, /git\(\[\s*"tag",\s*"-[ad]"/, "tag 调用不得为创建/删除");
    }
  }
  assert.ok(subs.includes("ls-remote"), "用只读 ls-remote 核对远程");
  assert.ok(subs.includes("rev-list"), "检测本地领先远程的提交数");
  assert.match(ts, /refs\/tags/, "检测最新 tag 是否已推送");
});

test("package.json 注册了完整的同步命令，且版本号一致", () => {
  const pkg = JSON.parse(read("package.json"));
  for (const cmd of ["ship", "push:remote", "push:check"]) {
    assert.ok(pkg.scripts[cmd], `缺少 npm run ${cmd}`);
  }
  assert.equal(pkg.version, "2.2.1");
});

test("凭证文件位于仓库外，仓库内不存在任何凭证残留", () => {
  const cred = "/root/.codebuddy/credentials/bro2-github-pat";
  assert.ok(existsSync(cred), "复用之前持久化的 PAT 凭证文件");
  // 仓库内不得出现凭证文件；.git/config 不得内嵌 token
  for (const p of [".git/config", "scripts/push-remote.sh", "scripts/ship.sh"]) {
    const txt = read(p);
    assert.ok(!SECRET.test(txt), `${p} 不得含明文凭证`);
  }
});
