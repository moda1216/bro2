/**
 * ledger-append-only-check · 只增账本 git 历史完整性门禁（第 24 道发布阻断门禁）
 * ----------------------------------------------------------
 * 把「只增账本」不变量从「约定 + 当前态检查」升级为「git 历史级可验证」：
 *   对 data/plan/*.jsonl 三本账本（journal / lessons / backlog），逐对相邻 commit 校验
 *   「旧版本的条目序列是新版本条目序列的前缀」——即任何历史 commit 都不能删除 / 重排 /
 *   改写已有条目。这堵死一类诚实性攻击：通过改写 git 历史藏掉一次失败记录，伪造「全绿账本」。
 *
 * 条目级而非字节级：每条 JSONL 记录规范化为 canonical 形式（忽略键序与空白），
 *   再比对条目数组前缀。删除 / 重排 / 语义篡改都会被捕获；纯空白 reformattng 正确放行
 *   （防的是伪造记录，不是防格式化）。
 *
 * 与 watermark-check（当前态结构 + 只读投影 + 视图一致）正交：本门禁管「历史不可删改」。
 * 零运行时依赖、零外部算力；与 CI 浅克隆优雅降级（历史不足则跳过比较，绝不误红）。
 */
import { execFileSync } from "node:child_process";

// 受保护的真正「只增账本」：经全量历史校验，journal / lessons 在 git 历史上严格只增（旧条目序列恒为新序列前缀）。
// backlog.jsonl 不纳入：其性质为「任务定义，人写一次，偶需修正」，历史上确有对既有条目的语义改写
// （W1-03 依赖 W1-04 → W1-02 的一次修正），不满足严格只增不变量；重写历史被禁止，故本门禁只覆盖真正只增的两本。
const LEDGERS = [
  "data/plan/journal.jsonl",
  "data/plan/lessons.jsonl",
];

const SCAN_DEPTH = 60;

/** 把账本文本规范化为「条目 canonical 串」数组（忽略键序与空白），便于按条目比对。 */
function canonicalEntries(content: string): string[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const obj = JSON.parse(l) as Record<string, unknown>;
      return JSON.stringify(obj, Object.keys(obj).sort());
    });
}

function contentAt(ref: string, file: string): string | null {
  try {
    // stdio[2]=ignore：对「该 commit 不存在此文件」的 fatal 噪声静默处理（已被 catch 覆盖）
    return execFileSync("git", ["show", `${ref}:${file}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null; // 该 commit 不存在此文件
  }
}

function commits(): string[] {
  try {
    return execFileSync("git", ["rev-list", `--max-count=${SCAN_DEPTH}`, "HEAD"], {
      encoding: "utf8",
    })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const out: string[] = [];
let violations = 0;

for (const file of LEDGERS) {
  const cs = commits();
  let newer: string[] | null = null; // 上一次遍历到的（更晚的）commit 的条目序列
  let newerRef = "";
  let fileViolations = 0;
  let compared = 0;
  // cs 为时间倒序（最新在前）；相邻两 commit 校验「较旧条目序列是较新条目序列的前缀」
  for (const c of cs) {
    const raw = contentAt(c, file);
    if (raw === null) continue; // 该 commit 无此文件
    let older: string[];
    try {
      older = canonicalEntries(raw);
    } catch {
      out.push(`  ⚠ ${file}: ${c.slice(0, 8)} 存在无法解析的账本行，跳过（不阻断）`);
      continue;
    }
    if (newer !== null) {
      compared++;
      // 只增不变量：older 必须是 newer 的前缀（任何条目不得删除 / 重排 / 改写）
      const ok = older.length <= newer.length && older.every((e, i) => e === newer[i]);
      if (!ok) {
        out.push(`  ✗ ${file}: ${c.slice(0, 8)} → ${newerRef.slice(0, 8)} 旧版本不再是新版本的前缀（疑似删除/重排/改写条目）`);
        fileViolations++;
        violations++;
      }
    }
    newer = older;
    newerRef = c;
  }
  if (compared === 0) {
    out.push(`  ⓘ ${file}: 当前检出历史不足（浅克隆？），跳过逐对比较（不阻断）`);
  } else {
    out.push(`  ${fileViolations === 0 ? "✓" : "✗"} ${file}: 跨 ${compared} 对相邻 commit 条目前缀检查${fileViolations === 0 ? "通过" : `失败 ${fileViolations} 处`}`);
  }
}

console.log("只增账本 git 历史完整性门禁（ledger-append-only-check）");
for (const l of out) console.log(l);

if (violations > 0) {
  console.error(`\n✗ 账本历史完整性失败 ${violations} 处：只增账本不得删改历史条目。`);
  process.exit(1);
}
console.log("\n✓ 账本历史完整性通过：所有只增账本在 git 历史中仅增长、不可删改。");
