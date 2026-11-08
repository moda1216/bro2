/**
 * 远程同步机制的回归测试（v2.2.2）
 * ----------------------------------------------------------
 * 红线：GitHub PAT 凭证绝不进入仓库、绝不回显、绝不硬编码。
 * 本测试验证的是「机制约束」而非推送动作本身——推送需要真实网络与凭证，
 * 由 npm run ship / npm run push:remote 在真实环境完成，测试只守住结构不变量。
 *
 * v2.2.2 修正：初版曾断言「本机私有凭证文件必须存在」，这是**环境事实**而非
 * 仓库不变量，导致 GitHub CI runner 上 npm test 必然 fail 1（本地却 162/162 全绿）。
 * 现在所有断言都与机器无关；凭证文件是否存在由 push-remote.sh 在真实推送时校验。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
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

test("防漏推检查对网络抖动加固，且「不可达」不等于「已同步」", () => {
  const ts = read("scripts/remote-check.ts");
  assert.ok(!SECRET.test(ts), "不得含明文凭证");
  assert.match(ts, /LS_REMOTE_RETRIES/, "ls-remote 必须有有限重试，避免抖动误报");
  assert.match(ts, /复查|again/, "push 后 ref 传播延迟需复查一次，避免把延迟当漏推");
  assert.match(ts, /无法复核/, "网络不可达必须明示「无法复核」，不得冒充已同步");
  assert.match(ts, /process\.exit\(0\)/, "不可达是信息项，不阻断发布");
  // 确认未同步仍必须退出 1：找到 problems 分支的退出码
  assert.match(ts, /process\.exit\(1\)/, "确认漏推仍必须阻断");
});

test("package.json 注册了完整的同步命令，且版本号一致", () => {
  const pkg = JSON.parse(read("package.json"));
  for (const cmd of ["ship", "push:remote", "push:check"]) {
    assert.ok(pkg.scripts[cmd], `缺少 npm run ${cmd}`);
  }
  assert.equal(pkg.version, "2.2.2");
});

test("凭证设计位于仓库外，缺失时明确失败，仓库内零明文", () => {
  const sh = read("scripts/push-remote.sh");
  // 只断言设计约束，不断言本机文件存在（CI runner 没有该文件）
  assert.match(sh, /\$HOME\/\.codebuddy\/credentials/, "默认凭证路径必须位于仓库外的用户主目录");
  assert.match(sh, /\[ ! -r "\$PAT_FILE" \]/, "凭证缺失时必须显式报错退出，而非静默继续");
  // 仓库内不得出现凭证字面量；.git/config 在 CI 上可能不存在，仅存在时校验
  for (const p of ["scripts/push-remote.sh", "scripts/ship.sh"]) {
    assert.ok(!SECRET.test(read(p)), `${p} 不得含明文凭证`);
  }
  const cfg = resolve(ROOT, ".git/config");
  if (existsSync(cfg)) {
    assert.ok(!SECRET.test(readFileSync(cfg, "utf8")), ".git/config 不得内嵌 token");
  }
});

test("CI 可移植性：测试不得依赖本机专属绝对路径（防本地绿/CI 红）", () => {
  // /etc/passwd、/tmp/... 是通用测试夹具，允许；禁止的是用户主目录 / 工作区专属路径
  const MACHINE_ABS = /["'`](\/root\/|\/workspace\/|\/home\/|\/Users\/|[A-Za-z]:\\\\)/;
  const files = readdirSync(resolve(ROOT, "tests")).filter((f) => f.endsWith(".test.ts"));
  assert.ok(files.length >= 15, "应覆盖全部测试文件");
  for (const f of files) {
    const txt = read(`tests/${f}`);
    assert.ok(!MACHINE_ABS.test(txt),
      `tests/${f} 含本机专属绝对路径：CI runner 上不存在，会造成「本地全绿 / CI 失败」`);
  }
});
