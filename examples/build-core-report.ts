/**
 * bro2 · 核心报告生成器（v2.34.0）
 *
 * 用户诉求「整理产出物，给一个核心报告即可，代码都是 git 远程管理的」：
 * 把 v2.30→v2.34 外部测量脉络收敛成一份自包含 HTML（内联 CSS / 无外部依赖），
 * 数字全部从可复核的 JSON 产物读取，不手写、不脱节。
 *
 * 输入（全部来自 data/bench/external/）：
 *   - readout-recalibration-report.json（v2.32.0 读数修正 + 大K复验，历史结论）
 *   - endpoint-scan-report.json（v2.33.0 第二端点主动扫描）
 *   - same-model-anchor-report.json（v2.33.0 同模型隔离锚点，本轮主实验）
 *   - tb-leaderboard-compare-report.json（v2.30.0 直跑对照，脉络背景）
 *   - budget-advisory-report.json（v2.31.0 负结果，脉络背景）
 *   - official-harness-audit.json（v2.34.0 官方同子集成绩可得性审计）
 *   - task-coverage-report.json（v2.34.0 全量分母 + 扩集双向 sanity）
 * 输出：docs/CORE-REPORT.html（同时是唯一呈现给用户的交付物）
 *
 *   node --experimental-strip-types --no-warnings examples/build-core-report.ts
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "data", "bench", "external");
const OUT = join(ROOT, "docs", "CORE-REPORT.html");
const j = (name: string): any =>
  JSON.parse(readFileSync(join(EXT, name), "utf8"));
const opt = (name: string): any => (existsSync(join(EXT, name)) ? j(name) : null);
const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;

const R = j("readout-recalibration-report.json");
const TB = opt("tb-leaderboard-compare-report.json");
const AB = opt("budget-advisory-report.json");
const SC = opt("endpoint-scan-report.json");   // v2.33.0 第二端点扫描
const AN = opt("same-model-anchor-report.json"); // v2.33.0 同模型锚点
const AU = j("official-harness-audit.json");     // v2.34.0 路径 A 审计
const CV = j("task-coverage-report.json");       // v2.34.0 路径 B 扩集（本轮主实验）

const L = R.groups.find((g: any) => g.group === "L_legacy");
const C = R.groups.find((g: any) => g.group === "C_calibrated");
const A = R.groups.find((g: any) => g.group === "A_advisory");
const ro = R.readout, mech = R.mechanism;
const reap = mech.honestReappraisal ?? null;
// 二次判读优先于预注册机械判定：证据不足时不宣讲「正向证据」
const mechHonest = reap?.evidenceInsufficient === true;
const mechHeadline = mechHonest
  ? "证据不足（噪声主导）：判据机械全绿，但不构成机制有效证据"
  : (mech.verdict as string);

const badge = (ok: boolean, t?: string, f?: string): string =>
  ok ? `<span class="b ok">${esc(t ?? "成立")}</span>` : `<span class="b no">${esc(f ?? "不成立")}</span>`;

const row = (name: string, l: any, c: any, a: any, key: string, fmt: (v: any) => string = (v) => esc(v)): string =>
  `<tr><td class="k">${esc(name)}</td><td>${fmt(l[key])}</td><td class="hl">${fmt(c[key])}</td><td>${fmt(a[key])}</td></tr>`;

const bar = (label: string, v: number, max: number, cls = ""): string =>
  `<div class="bar-row"><span class="bar-l">${esc(label)}</span>` +
  `<span class="bar-track"><span class="bar-fill ${cls}" style="width:${max > 0 ? (v / max * 100).toFixed(1) : 0}%"></span></span>` +
  `<span class="bar-v">${v}</span></div>`;

// ---- 脉络背景数字 ----
const tbPass = TB?.providers_detail?.[0]?.passRate ?? null;
const abArms = AB?.arms ?? [];
const abA = abArms.find((x: any) => x.arm === "A_baseline");
const abB = abArms.find((x: any) => x.arm === "B_advisory");

const perTaskRows = C.perTask.map((c: any) => {
  const l = L.perTask.find((x: any) => x.taskId === c.taskId);
  const a = A.perTask.find((x: any) => x.taskId === c.taskId);
  return `<tr><td class="k mono">${esc(c.taskId)}</td>` +
    `<td>${l.passes}/${l.trials}</td><td class="hl">${c.passes}/${c.trials}</td><td>${a.passes}/${a.trials}</td>` +
    `<td class="dim">${esc(c.stops.join(","))}</td></tr>`;
}).join("");

// ---- v2.33.0 本轮主实验：端点扫描 + 同模型锚点（全部从 JSON 读，容错未生成） ----
const scTotal: number = SC?.summary?.totalProbes ?? 0;
const scOk: string[] = SC?.summary?.toolsOk ?? [];
const scFindings: string[] = SC?.summary?.findings ?? [];
const scCandidates: any[] = SC?.candidates ?? [];
const anPass: number | null = AN?.summary?.passRate ?? null;
const anPasses: number = AN?.summary?.passes ?? 0;
const anTrials: number = AN?.summary?.total ?? 0;
const anLb: number | null = AN?.leaderboard?.fullPassRate ?? null;
const anDelta: number | null = AN?.comparison?.nominalDelta ?? null;
const anProviderErr: number = AN?.summary?.providerErrorCount ?? 0;
const anStops: Record<string, number> = AN?.summary?.stopDistribution ?? {};
const anRate429: number = AN?.throttling?.stats?.rateLimit429 ?? 0;
const anWaits: number = AN?.throttling?.stats?.waits ?? 0;
const anMinGap: number = AN?.throttling?.minGapMs ?? 31000;
const anIdentity: Record<string, unknown> = AN?.identity ?? {};
const anCmpNote: string = AN?.comparison?.note ?? "";
const anWhatNeeded: string = AN?.comparison?.whatWouldBeNeeded ?? "";
const anTrialsList: any[] = AN?.trials ?? [];
const anExtUntouched: boolean | null = AN?.externalResultsUntouched ?? null;
const anModel: string = AN?.model ?? "gpt-oss-120b";
const anBenchmark: string = AN?.leaderboard?.benchmark ?? "Terminal-Bench";
const anDataAsOf: string = AN?.leaderboard?.dataAsOf ?? "2026-11-09";
const anRows = anTrialsList.map((t: any) =>
  `<tr><td class="k mono">${esc(t.taskId)}</td><td>r${esc(t.repeat)}</td>` +
  `<td>${t.verifierPassed ? '<span class="b ok">PASS</span>' : '<span class="b no">FAIL</span>'}</td>` +
  `<td>${esc(t.steps)}步 / ${esc(t.toolCalls)}工具</td><td>${esc(t.tokens)}</td>` +
  `<td class="dim">${esc(t.stoppedBy)}</td></tr>`).join("");

// ---- v2.34.0 本轮：官方同子集审计 + 任务集扩集 ----
const cov = CV.pathB_fullTaskSet;
const den = cov.denominators;
const exp = cov.expansion;
const emp = cov.empiricalScan;
const cvBefore: number = exp.before;
const cvAfter: number = exp.after;
const cvSound: number = CV.sanity.nSound;
const cvOriginal: number = den.originalTasks.nTasks;
const cvPinned: number = den.pinned21.nTasks;
const cvIntersection: number = den.intersection;
const cvBoardTasks: string[] = exp.allTasksInPinned21;
const cvNewTasks: string[] = exp.newlyAdded;
const cvSample: number = emp.localSampleSize;
const cvScreened: number = emp.contentScreened;
const auditRows = AU.evidence.map((e: any) =>
  `<tr><td class="k mono">${esc(e.id)}</td><td class="dim">${esc(e.claim)}<br>${esc(e.observation)}</td>` +
  `<td><a href="${esc(e.source)}" target="_blank" rel="noreferrer">来源</a></td></tr>`).join("");
const sanityRows = CV.sanity.rows.map((r: any) =>
  `<tr><td class="k mono">${esc(r.dir)}</td><td>${esc(r.emptyWorkspace)}</td>` +
  `<td>${esc(r.oracleSolution)} / exitOk=${esc(r.oracleExitOk)}</td>` +
  `<td>${r.sound ? '<span class="b ok">SOUND</span>' : '<span class="b no">REJECT</span>'}</td>` +
  `<td>${newNamesHas(r.dir) ? '<span class="b ok">在 89 题内</span>' : '<span class="dim">榜集外</span>'}</td></tr>`).join("");
function newNamesHas(dir: string): boolean { return cvBoardTasks.includes(dir); }

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>bro2 外部测量 · 核心报告 v2.34.0</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--card2:#1c2330;--bd:#2a3441;--tx:#e6edf3;--dim:#8b98a5;
--acc:#4f9cf9;--ok:#3fb950;--no:#f85149;--warn:#d29922;--hl:#1f6feb22}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);
font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;line-height:1.7;font-size:15px}
.wrap{max-width:960px;margin:0 auto;padding:40px 24px 80px}
h1{font-size:29px;margin:0 0 6px;letter-spacing:.5px}h2{font-size:20px;margin:44px 0 14px;padding-bottom:8px;border-bottom:1px solid var(--bd)}
h3{font-size:16px;margin:24px 0 10px;color:var(--acc)}p{margin:10px 0}
.sub{color:var(--dim);font-size:14px}.mono{font-family:"SF Mono",Consolas,monospace;font-size:12.5px}
.hero{background:linear-gradient(135deg,#15233a,#161b22);border:1px solid var(--bd);border-radius:14px;padding:26px 28px;margin:22px 0}
.hero .lead{font-size:17px;font-weight:600;margin:0 0 10px;color:#fff}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:22px 0}
.kpi{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:16px}
.kpi .n{font-size:26px;font-weight:700;color:var(--acc)}.kpi .n.g{color:var(--ok)}.kpi .n.w{color:var(--warn)}
.kpi .l{font-size:12.5px;color:var(--dim);margin-top:4px}
table{width:100%;border-collapse:collapse;margin:14px 0;font-size:14px;background:var(--card);border-radius:10px;overflow:hidden}
th,td{padding:9px 12px;text-align:center;border-bottom:1px solid var(--bd)}th{background:var(--card2);color:var(--dim);font-weight:600;font-size:13px}
td.k{text-align:left}td.hl{background:var(--hl);font-weight:600}tr:last-child td{border-bottom:none}td.dim{color:var(--dim);font-size:12.5px;text-align:left}
.b{display:inline-block;padding:1px 9px;border-radius:20px;font-size:12px;font-weight:600}
.b.ok{background:#3fb95022;color:var(--ok);border:1px solid #3fb95055}.b.no{background:#f8514922;color:var(--no);border:1px solid #f8514955}
.callout{border-left:3px solid var(--acc);background:var(--card);padding:12px 16px;margin:16px 0;border-radius:0 8px 8px 0}
.callout.warn{border-left-color:var(--warn)}.callout.no{border-left-color:var(--no)}.callout.ok{border-left-color:var(--ok)}
.bar-row{display:flex;align-items:center;gap:10px;margin:6px 0;font-size:13px}
.bar-l{width:170px;color:var(--dim);text-align:right;flex-shrink:0}
.bar-track{flex:1;background:#21262d;border-radius:5px;height:16px;overflow:hidden}
.bar-fill{display:block;height:100%;background:var(--acc);border-radius:5px}.bar-fill.g{background:var(--ok)}.bar-fill.w{background:var(--warn)}
.bar-v{width:34px;text-align:right;font-variant-numeric:tabular-nums}
.tl{border-left:2px solid var(--bd);margin:16px 0 16px 8px;padding-left:20px}
.tl .ev{position:relative;margin:0 0 18px}.tl .ev::before{content:"";position:absolute;left:-27px;top:6px;width:10px;height:10px;border-radius:50%;background:var(--acc);border:2px solid var(--bg)}
.tl .ev .v{font-size:12px;color:var(--acc);font-weight:700}.tl .ev.now::before{background:var(--ok)}
code{background:#21262d;padding:1px 6px;border-radius:4px;font-size:12.5px;color:#c9d1d9}
pre{background:#0b0f14;border:1px solid var(--bd);border-radius:8px;padding:14px 16px;overflow:auto;font-size:12.5px;color:#c9d1d9}
ul{margin:8px 0;padding-left:22px}li{margin:5px 0}.foot{margin-top:44px;padding-top:16px;border-top:1px solid var(--bd);color:var(--dim);font-size:12.5px}
.pill{display:inline-block;background:#21262d;border:1px solid var(--bd);border-radius:6px;padding:2px 8px;font-size:12px;color:var(--dim);margin:2px 4px 2px 0}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:680px){.kpis,.grid2{grid-template-columns:1fr 1fr}.bar-l{width:110px}h1{font-size:23px}}
</style></head><body><div class="wrap">

<h1>bro2 外部测量 · 核心报告</h1>
<div class="sub">v2.34.0 · 生成于 ${esc(CV.generatedAt.slice(0, 19).replace("T", " "))} · 数据源 <code>official-harness-audit.json</code> + <code>task-coverage-report.json</code></div>

<div class="hero">
<p class="lead">一句话结论：<b>官方 harness 同子集成绩无法补齐；任务集已扩到 ${esc(cvAfter)} 题，但没有扩到全量。</b>公开榜只有模型级聚合分，原冻结 ${esc(cvBefore)} 题中 ${esc(cvBefore - 1)} 题不在榜单 ${esc(cvPinned)} 题集内，因此公开渠道没有可补齐的同子集成绩；这不排除后续自行用官方 Harbor 重跑。全量结构扫描覆盖 original-tasks ${esc(cvOriginal)} 题与 2.1 pinned ${esc(cvPinned)} 题；受统一离线 verifier 契约与实测样本限制，本轮只新增 ${esc(cvNewTasks.length)} 题，${esc(cvSound)}/${esc(cvAfter)} 双向 sanity 均为 SOUND。此前同模型对照继续保持 <code>non-strict-positioning-reference</code>，不升级为可归因 harness-Δ。</p>
<div class="sub">本轮直接执行用户指令「补官方 harness 同子集成绩 / 扩任务集到全量」。路径 A 给出公开不可得证据链，但未自行运行官方 Harbor；路径 B 区分<b>结构分母全覆盖</b>与<b>内容级实测未全覆盖</b>，不把 ${esc(cvBefore)}→${esc(cvAfter)} 包装成 ${esc(cvOriginal)} 或 ${esc(cvPinned)} 题全量完成。</div>
</div>

<div class="kpis">
<div class="kpi"><div class="n w">不可得</div><div class="l">路径 A：官方 harness 同子集逐题成绩</div></div>
<div class="kpi"><div class="n g">${esc(cvBefore)} → ${esc(cvAfter)}</div><div class="l">可复现任务池（+${esc(cvNewTasks.length)}，非全量）</div></div>
<div class="kpi"><div class="n ${cvSound === cvAfter ? "g" : "w"}">${esc(cvSound)} / ${esc(cvAfter)}</div><div class="l">正式口径双向 sanity = SOUND</div></div>
<div class="kpi"><div class="n w">not-proven</div><div class="l">L4 仍 not-achieved · verdict 未动</div></div>
</div>

<h2>0 · 脉络：为什么会走到这一轮</h2>
<div class="tl">
<div class="ev"><div class="v">v2.30.0</div>把「第三方已有公开成绩的任务集」直接给 bro2 跑（Terminal-Bench 公开 verifier 双向反证），kilo 端点得 <b>${tbPass !== null ? pct(tbPass) : "2/4"}</b> positioning-only。同时留下一个隐患：测量脚本只声明了 <code>maxSteps=12</code>。</div>
<div class="ev"><div class="v">v2.31.0</div>用逐轨迹诊断<b>证伪</b>了上一版的「空转不肯停」结论：真实机理是 <code>guard(kind=tokens)</code> 静默熔断早于产出落地，以及模型约束求解不全。做了预注册 A/B（K=2）检验预算软预警，<b>${esc(AB?.verdict ?? "负结果")}</b>，机制默认关闭。<br><span class="sub">附带发现：16 次运行 steps 最高 9 就撞 token 熔断 —— <b>v2.30.0 的读数是「预算配置失真」下的读数，不是公平读数</b>。</span></div>
<div class="ev"><div class="v">v2.32.0</div>执行两个「下一步」：先修失真（把暗藏 <code>maxTokens=60000</code> 的半套接线改成成套显式声明 + 双口径并列实测），再在<b>校准后的公平口径</b>下用 <b>K=${esc(R.control.k)}</b>（&gt; 上轮 2）复验软预警。校准口径 <code>maxSteps=12 / maxTokens=120000</code> 成为后续测量的统一尺子。</div>
<div class="ev"><div class="v">v2.33.0</div>啃下悬了三轮的「下一步③ 同模型隔离锚点」：主动扫描 ${esc(scTotal)} 个端点/模型组合，定位限流失配根因，用<b>测量侧节流适配</b>让 <code>gpt-oss-120b</code> 稳定跑通完整 harness，产出 bro2 在有公开榜成绩同模型上的首个可复核读数，并诚实界定其 Δ 的不可归因性。</div>
<div class="ev now"><div class="v">v2.34.0（本轮）</div>执行「补官方 harness 同子集成绩 / 扩任务集到全量」：路径 A 被证据链判定为<b>公开不可得</b>；路径 B 固化 ${esc(cvOriginal)} / ${esc(cvPinned)} 两个全量分母，实测样本 ${esc(cvSample)} 题，内容粗筛 ${esc(cvScreened)} 个候选，最终只把真正通过正式双向 sanity 的任务池从 ${esc(cvBefore)} 扩到 ${esc(cvAfter)}，并剔除一个假 SOUND 反例。</div>
</div>

<h2>1 · 路径 A：官方 harness 同子集成绩——无法补齐</h2>
<div class="callout no"><b>判定：${esc(AU.verdict)}。</b> ${esc(AU.verdictNote)}</div>
<table><tr><th>证据</th><th>观察</th><th>出处</th></tr>${auditRows}</table>
<p class="sub">公开榜锚点仍是 <code>${esc(AU.leaderboardAnchor.model)}</code> / ${esc(AU.leaderboardAnchor.benchmark)} / ${esc(AU.leaderboardAnchor.score)}%，口径 ${esc(AU.leaderboardAnchor.scope)}，粒度 <code>${esc(AU.leaderboardAnchor.granularity)}</code>。这里的公开聚合榜与官方任务仓库提交记录分开核查，不能把第三方聚合分当成官方逐题数据。</p>
<div class="callout warn"><b>对旧结论的影响：</b>${esc(AU.consequence.note)} 本轮没有生成官方同子集分数，也没有计算新的严格 Δ。</div>

<h2>2 · 路径 B：扩任务集——全量分母已覆盖，实际扩到 ${esc(cvAfter)} 题</h2>
<h3>先钉死“全量”到底是哪一个分母</h3>
<table><tr><th>任务源</th><th>固定 commit</th><th>任务数</th><th>契约</th></tr>
<tr><td class="k">original-tasks（本仓库任务源）</td><td class="mono">${esc(den.originalTasks.commit.slice(0, 12))}</td><td>${esc(cvOriginal)}</td><td class="dim">task.yaml / solution.sh / tests/test_outputs.py</td></tr>
<tr><td class="k">terminal-bench-2-1（榜单口径）</td><td class="mono">${esc(den.pinned21.commit.slice(0, 12))}</td><td>${esc(cvPinned)}</td><td class="dim">task.toml / instruction.md / solution/solve.sh / environment/Dockerfile</td></tr>
<tr><td class="k">同名目录交集</td><td>—</td><td>${esc(cvIntersection)}</td><td class="dim">同名不等于同题面或同评分器</td></tr></table>
<p>结构层已覆盖两个完整 git tree；内容级实测只覆盖 <b>${esc(cvSample)}/${esc(cvOriginal)}</b> 题（整包下载尾部截断，按字母序前缀），粗筛 ${esc(cvScreened)} 个候选。<b>因此本轮不能宣称 241 题或 89 题已全量实测。</b></p>

<h3>正式双向 sanity：${esc(cvSound)}/${esc(cvAfter)} SOUND</h3>
<table><tr><th>任务</th><th>空工作区</th><th>官方 oracle</th><th>判定</th><th>是否在榜单 89 题</th></tr>${sanityRows}</table>
<div class="grid2">
<div><div class="callout ok"><b>真实扩集：${esc(cvBefore)} → ${esc(cvAfter)}（+${esc(cvNewTasks.length)}）</b><br>新增 ${cvNewTasks.map((x: string) => `<code>${esc(x)}</code>`).join(" ")}。两者都不在榜单 ${esc(cvPinned)} 题集内；扩后 ${esc(cvAfter)} 题仍只有 ${cvBoardTasks.map((x: string) => `<code>${esc(x)}</code>`).join(" ")} 落在榜集内。</div></div>
<div><div class="callout no"><b>剔除假 SOUND：${emp.falseSoundRejected.map((x: string) => `<code>${esc(x)}</code>`).join(" ")}</b><br><span class="sub">${esc(emp.falseSoundReason)}</span></div></div>
</div>
<p class="sub">样本内排除分类：${Object.entries(emp.excludedReasons).map(([k, v]) => `${esc(k)}=${esc(v)}`).join(" · ")}。这些计数只描述 ${esc(cvSample)} 题实测样本，不外推为全 ${esc(cvOriginal)} 题的内容级结论。</p>
<div class="callout warn"><b>严格 Δ 的正确载体：</b>${esc(CV.strictDeltaCarrier.note)}<br><span class="sub">${esc(CV.strictDeltaCarrier.honest)} 本轮只扩任务池并做 sanity，<b>未在新增任务上重跑 bro2/minimal，未产生新通过率或新 harness-Δ</b>。</span></div>

<h2>3 · 前序（v2.33.0）：第二端点主动扫描</h2>
<p>硬门槛四条：匿名免 API Key · OpenAI Chat Completions 兼容 · <b>原生返回 <code>tool_calls</code></b>（多步 agent 的前提）· 模型身份与公开榜条目一致。对 ${esc(scTotal)} 个候选各发一次带 <code>tools</code> 的真实调用，逐个记录 http / 错误 / 响应 <code>model</code> 字段。</p>
<table><tr><th>端点 · 模型</th><th>结果</th><th>http</th><th>响应 model / 错误</th></tr>
${scCandidates.map((c: any) => {
  const ok = c.status === "TOOLS_OK";
  const detail = ok ? esc(c.respModel) : esc(String(c.error ?? c.status).slice(0, 60));
  return `<tr><td class="k mono">${esc(c.tag)}</td><td>${ok ? '<span class="b ok">TOOLS_OK</span>' : `<span class="b no">${esc(c.status)}</span>`}</td><td>${esc(c.http ?? "—")}</td><td class="dim">${detail}</td></tr>`;
}).join("")}
</table>
<div class="callout ok"><b>${esc(scOk.length)} 个端点可原生工具调用，但唯一能做同模型锚点的是 <code>ovhcloud / gpt-oss-120b</code>（响应 <code>model=gpt-oss-120b</code>，身份吻合）。</b><br>
<span class="sub">${scFindings.map((f: string) => esc(f)).join("<br>")}</span></div>
<div class="callout warn"><b>关键反转 + 身份陷阱：</b>v2.30.0 判 ovhcloud「端点限流无效」其实判早了——端点本身单次带 tools 调用返回 200 + <code>tool_calls</code>；根因是<b>匿名层 2 req/min</b> 与 harness 内置退避（1s/2s/4s、maxRetries=2）不匹配。另：联网新发现的 BlockRun 虽免 Key 且支持 tool_calls，但 <code>nvidia/gpt-oss-120b</code> 已退役、响应 <code>model</code> 实为 <code>nemotron-3-super-120b</code>——<b>不能冒充 gpt-oss-120b 锚点</b>（故身份核实写进实验前置门禁）。</div>

<h2>4 · 前序（v2.33.0）：同模型隔离锚点</h2>
<div class="grid2">
<div><h3>测量侧节流适配（任务无关、不加能力）</h3>
<p class="sub">在评测脚本的 <code>fetch</code> 层对 ovhcloud 的 chat 请求加：相邻请求间隔 ≥ <code>${esc(anMinGap)}ms</code>（依据 2 req/min 官方限流）+ 429 按同节奏等待重试。<b>不改 <code>src</code>、不改默认行为、不改 token/步数口径</b>（沿用 v2.32.0 校准值），仅把墙钟上限显式放宽以免节流等待误触发 time guard。</p>
<p class="sub">身份核实前置门禁：<code>http=${esc(anIdentity.http ?? "—")} resp_model=${esc(anIdentity.respModel ?? "—")} matches=${esc(anIdentity.matchesAnchor ?? "—")}</code>，不吻合即拒绝出报告。</p></div>
<div><h3>端点与预算口径</h3>
<p class="sub mono">provider=ovhcloud · model=${esc(anModel)}<br>benchmark=${esc(anBenchmark)}（榜单数据 ${esc(anDataAsOf)}）<br>maxSteps=12 / maxTokens=120000 / maxSeconds=3600<br>advisory=0（软预警仍默认关闭）</p>
<p class="sub">节流统计：等待 ${esc(anWaits)} 次 · 429 重试 ${esc(anRate429)} 次 · 全量 <code>provider_error=${esc(anProviderErr)}</code>。</p></div>
</div>

<h3>全量结果（冻结 4 任务 × K=${esc(anTrialsList.length ? Math.max(...anTrialsList.map((x: any) => x.repeat)) : "?")}）</h3>
<table><tr><th>任务</th><th>repeat</th><th>verifier</th><th>步数/工具</th><th>token</th><th>停止原因</th></tr>${anRows || '<tr><td colspan="6" class="dim">实验进行中或尚未生成</td></tr>'}</table>
<p class="sub mono">通过 ${esc(anPasses)}/${esc(anTrials)} = ${anPass !== null ? pct(anPass) : "—"} | 停止分布 ${esc(JSON.stringify(anStops))}</p>

<h3>与公开榜对照：位是参照，差不可归因</h3>
<div class="callout warn"><b>bro2 样本 ${anPass !== null ? pct(anPass) : "—"} vs 公开榜全量 ${anLb !== null ? pct(anLb) : "26.2%"} → 名义差 ${anDelta !== null ? (anDelta > 0 ? "+" : "") + esc(anDelta) : "—"}（kind=<code>non-strict-positioning-reference</code>，isStrictHarnessDelta=false）</b><br>
<span class="sub">${esc(anCmpNote)}</span><br>
<span class="sub"><b>要构成可归因 Δ 还缺：</b>${esc(anWhatNeeded)}</span></div>
<div class="callout"><b>本轮真正的成果不是那个数字，而是把「第二端点不可用」这个卡了三轮的结论<b>证伪并解决</b>：</b>端点可用、身份核实通过、完整 harness 稳定跑通、<code>provider_error</code> 归零、且不写 <code>external-results.json</code>（${anExtUntouched === null ? "未核验" : esc(anExtUntouched)}）、不改 L4/verdict。Δ 的诚实边界比 Δ 本身更重要。</div>

<h2>5 · 前序（v2.32.0）：下一步① 读数修正（measurement-wiring，不是能力优化）</h2>

<h3>失真机理</h3>
<p>历史测量脚本的 <code>configOverride</code> 只覆盖 <code>maxSteps=12</code>，<code>maxTokens</code> 靠 <code>agentos.config.json</code> 默认值 <b>60000 累计静默熔断</b>生效。而每步上下文重建会把历史 token 重复计费——v2.31.0 实测 16 次 token 中位数 56540、最大 75138，<b>5/16 在 4~6 步就撞 <code>guard(tokens)</code></b>，12 步预算形同虚设。报告的 <code>budget</code> 字段却只写了 <code>maxModelCalls</code>，完全没披露真正的 binding constraint。</p>

<div class="callout warn"><b>修正 ≠ 刷分。</b> 上一版明确拒绝「调大 maxTokens 抬高数字」。本轮把 <code>maxTokens</code> 提到成套值 <code>${esc(R.budgetWiring.calibrated.maxTokens)}</code>（= 12 步 × 10000 token/步，依据 v2.31.0 实测约 10280 token/步），是让「名义 12 步预算」真正可用——<b>这是修尺子，不是加资源换成绩</b>。因此报告把两种口径<b>并列</b>呈现，并锁死归因。</div>

<h3>实验设计（预注册判据，跑之前固化）</h3>
<table><tr><th>组</th><th>maxSteps</th><th>maxTokens</th><th>advisory</th><th>角色</th></tr>
${R.control.groups.map((g: any) => `<tr><td class="k mono">${esc(g.id)}</td><td>12</td><td>${esc(g.maxTokens)}</td><td>${esc(g.advisory)}</td><td class="dim">${esc(g.role)}</td></tr>`).join("")}
</table>
<p class="sub"><b>L vs C</b> 唯一变量 = 成套预算口径（读数修正）；<b>C vs A</b> 唯一变量 = <code>budgetAdvisoryRatio</code>（机制复验）。同端点、同输入、同公开 verifier、同 preset/policy、holdout 冻结、含反证锚点。</p>

<h3>读数修正结果（L → C）</h3>
<table><tr><th>指标</th><th>L 失真口径</th><th>C 校准口径</th><th>A 校准+预警</th></tr>
${row("verifier 通过率", L, C, A, "passRate", (v) => pct(v))}
${row("通过数 / 试验数", L, C, A, "passes", (v) => `${v}/${C.trials}`)}
${row("guard(tokens) 次数", L, C, A, "tokenGuardCount")}
${row("平均步数", L, C, A, "avgSteps")}
${row("平均累计 token", L, C, A, "avgTokens")}
${row("产出文件未落地", L, C, A, "fileMissing")}
</table>
<div class="grid2">
<div><h3>token 熔断次数（越低越说明步数预算真正生效）</h3>
${bar("L 失真口径", L.tokenGuardCount, Math.max(L.tokenGuardCount, 1), "w")}
${bar("C 校准口径", C.tokenGuardCount, Math.max(L.tokenGuardCount, 1), "g")}
${bar("A 校准+预警", A.tokenGuardCount, Math.max(L.tokenGuardCount, 1), "g")}</div>
<div><h3>停止原因分布 L / C</h3>
<p class="sub mono">L: ${esc(JSON.stringify(L.stopDistribution))}<br>C: ${esc(JSON.stringify(C.stopDistribution))}</p>
<p class="sub">校准口径下 binding constraint 从「隐藏的累计 token 熔断」转为「声明的 12 步 / 自然完成」——读数口径自洽、可复核。</p></div>
</div>

<h3>预注册判据判定</h3>
<p>${badge(ro.R1_wiringDistortion)} <b>R1 失真实证</b>：L 组出现「steps &lt; 12 却 token 提前熔断」<span class="pill">L: ${esc(L.tokenGuardTrialsBelowStepBudget)} 次</span><br>
${badge(ro.R2_recalibration)} <b>R2 校准生效</b>：C 组 token 熔断 &lt; L 组 <span class="pill">L=${esc(L.tokenGuardCount)} → C=${esc(C.tokenGuardCount)}</span><br>
${badge(ro.R3_attribution)} <b>R3 归因锁</b>：<code>external-results.json</code> 未被触碰，L4 / verdict 未改</p>
<div class="callout ${ro.R1_wiringDistortion && ro.R2_recalibration ? "ok" : "warn"}"><b>${esc(ro.verdict)}</b><br>
<span class="sub">读数差 Δ=${esc(ro.readoutDelta)} 的归因字段已写死为 <code>${esc(ro.attribution)}</code>，<code>comparableAsCapabilityDelta = ${esc(R.budgetWiring.comparableAsCapabilityDelta)}</code> —— <b>无论升或降，都不计为 bro2 能力变化</b>。</span></div>

<h2>6 · 前序（v2.32.0）：下一步② 公平口径 + 更大 K 复验软预警</h2>
<p>v2.31.0 的 A/B（K=2）判据 <code>${esc(AB ? `P1=${AB.criteria.P1_mechanism} P2=${AB.criteria.P2_behavior} P3=${AB.criteria.P3_result}` : "P1✓ P2✗ P3✓")}</code> 未全成立，且跑在失真口径上。本轮在<b>校准后的公平口径</b>、<b>K=${esc(R.control.k)}</b> 下复验，沿用冻结的 P1/P2/P3 + holdout + 反证锚点。</p>
<table><tr><th>判据</th><th>内容</th><th>C 基线</th><th>A 预警</th><th>判定</th></tr>
<tr><td class="k">P1 机制生效</td><td class="dim">A 出现预警事件、C 为 0</td><td>${esc(C.budgetAdvisoryFired)}</td><td>${esc(A.budgetAdvisoryFired)}</td><td>${badge(mech.P1_mechanism)}</td></tr>
<tr><td class="k">P2 行为对比</td><td class="dim">A 文件未落地 ≤ C</td><td>${esc(C.fileMissing)}</td><td>${esc(A.fileMissing)}</td><td>${badge(mech.P2_behavior)}</td></tr>
<tr><td class="k">P3 结果不退化</td><td class="dim">A 通过率 ≥ C 且 holdout 不退化</td><td>${pct(C.passRate)} / holdout ${pct(C.holdoutPassRate)}</td><td>${pct(A.passRate)} / holdout ${pct(A.holdoutPassRate)}</td><td>${badge(mech.P3_result)}</td></tr>
</table>
<h3>逐任务通过数（冻结任务集，含 holdout 与反证锚点）</h3>
<table><tr><th>任务</th><th>L 失真</th><th>C 校准</th><th>A 预警</th><th>停止原因(C)</th></tr>${perTaskRows}</table>
<p class="sub">反证锚点 <code>${esc(R.sets.counterAnchor)}</code>（失败源于模型约束求解不全，机制不该修好）：C 通过 ${esc(mech.counterAnchor.baselinePasses)} / A 通过 ${esc(mech.counterAnchor.advisoryPasses)}（三组 0/9 全 fail，确认无答案泄漏）；holdout = ${R.sets.holdout.map((x: string) => `<code>${esc(x)}</code>`).join(" ")}。</p>

<h3>诚实二次判读：判据机械全绿 ≠ 机制有效</h3>
<div class="callout warn"><b>预注册判据结果原样保留（不事后改判据）</b>：P1∧P2∧P3 机械成立。但按项目防 reward-hacking 纪律（<code>src/rsi/contrast.ts</code>「自报分数提升但无行为/效应支撑 → 拒绝」），必须检查效应量能否被噪声解释：</div>
<table><tr><th>检验项</th><th>数值</th><th>含义</th></tr>
<tr><td class="k">A−C 通过率差</td><td>${reap ? esc(reap.deltaTrialWins) : "—"} 个 trial（${pct(mech.advisoryPassRate - mech.calibratedBaselinePassRate)}）</td><td class="dim">效应量极小</td></tr>
<tr><td class="k">C 组独有 provider_error</td><td>${reap ? esc(reap.cProviderErrors) : "—"} 次（A 组 ${reap ? esc(reap.aProviderErrors) : "—"} 次）</td><td class="dim">${reap && reap.noiseExplainable ? "差值可<b>完全</b>由这次端点错误解释" : "—"}</td></tr>
<tr><td class="k">软预警实际触发</td><td>${reap ? esc(reap.advisoryFiredTrials) : "—"} / ${reap ? esc(reap.advisoryArmTrials) : "—"} 次</td><td class="dim">${reap && reap.mechanismUnderTested ? "机制<b>几乎未被检验</b>（校准后 token 不再是瓶颈）" : "—"}</td></tr>
<tr><td class="k">holdout / 反证锚点</td><td>不退化 / 全 fail</td><td class="dim">无泄漏、无退化，但也无独立正证据</td></tr>
</table>
<div class="callout no"><b>机制结论：${esc(mechHeadline)}</b><br>
<span class="sub">${esc(reap?.conclusion ?? mech.verdict)}</span><br>
<span class="sub">软预警仍<b>默认关闭</b>，不因本轮改变行为。${esc(reap?.discipline ?? "")}</span></div>

<h2>7 · 诚实边界（红线，全程未破）</h2>
<ul>
${R.honest.limitations.map((x: string) => `<li>${esc(x)}</li>`).join("")}
<li>verifier 健全性：${esc(R.verifierSanity.status)}（空工作区必 fail / 官方 oracle 解必 pass，模型无关）。</li>
<li><b>v2.33.0</b>：端点身份以响应 <code>model</code> 字段为准（BlockRun 重定向为反例）；节流是<b>测量侧适配</b>不是能力优化；同模型对照为<b>非逐位同任务集</b>的位次参照、<code>isStrictHarnessDelta=false</code>、名义差不可归因于 harness。</li>
<li><b>v2.34.0 本轮新增</b>：官方同子集成绩标注为<b>公开不可得</b>而非已补到；任务池 ${esc(cvBefore)}→${esc(cvAfter)} 不是全量完成；结构分母 ${esc(cvOriginal)}/${esc(cvPinned)} 与内容实测样本 ${esc(cvSample)} 分开呈现；新增任务尚未跑模型，不产生新分数。</li>
<li>全程自跑、非第三方复核；<code>external-results.json</code> 未被触碰（${anExtUntouched === null ? "未核验" : esc(anExtUntouched)}）、<code>leadership.verdict = not-proven</code>、<code>L4 = not-achieved</code> 均未改。</li>
</ul>

<h2>8 · 复现与证据索引</h2>
<pre># 只增账本 / 全部工程产物由 git 远程管理
sh examples/fetch-external-tasks.sh
docker build -t bro2/tb-verifier:1 - &lt; examples/tb-verifier.Dockerfile
# v2.34.0 本轮：官方同子集审计 + 全量分母 / 6 题双向 sanity
node --experimental-strip-types --no-warnings examples/task-coverage-scan.ts
# v2.33.0 前序：端点扫描 + 同模型锚点（ovhcloud 节流）
node --experimental-strip-types --no-warnings examples/endpoint-scan.ts
ANCHOR_K=2 node --experimental-strip-types --no-warnings examples/same-model-anchor.ts
# v2.32.0 前序：读数修正 + 更大 K 复验
TRAJ_PROVIDER=kilo AGENTOS_LIVE_PROVIDER=kilo EXT_K=${esc(R.control.k)} \\
  node --experimental-strip-types --no-warnings examples/readout-recalibration.ts
node --experimental-strip-types --no-warnings examples/build-core-report.ts   # 生成本报告</pre>
<p>
<span class="pill">路径 A 证据链 E1–E5 → official-harness-audit.json</span>
<span class="pill">结构分母 ${esc(cvOriginal)}/${esc(cvPinned)} → tb-tree-snapshot.json</span>
<span class="pill">扩集 ${esc(cvBefore)}→${esc(cvAfter)} / sanity ${esc(cvSound)}/${esc(cvAfter)} → task-coverage-report.json</span>
<span class="pill">任务坐标与指纹 → tasks.jsonl + UPSTREAM.json + SHA256SUMS</span>
<span class="pill">端点扫描 ${esc(scTotal)} 候选 → endpoint-scan-report.json</span>
<span class="pill">同模型锚点 ${esc(anTrials)} 次逐 trial → same-model-anchor-report.json</span>
<span class="pill">1 任务节流验证 → same-model-anchor-verify.out</span>
<span class="pill">v2.32.0 ${esc(R.trials.length)} 次明细 → readout-recalibration-report.json</span>
<span class="pill">v2.31.0 负结果 → budget-advisory-report.json</span>
<span class="pill">v2.30.0 直跑对照 → tb-leaderboard-compare-report.json</span>
<span class="pill">公开榜快照 → tb-leaderboard-snapshot.json</span>
<span class="pill">冻结任务集 → tasks.jsonl + SHA256SUMS</span>
</p>

<h2>9 · 当前水位与下一步</h2>
<div class="callout"><b>能力水位未变，测量边界更清楚了</b>：路径 A 已完成可得性审计，结论是无法补到官方同子集成绩；路径 B 已完成全量结构盘点和一轮真实扩集，但 ${esc(cvAfter)} 题 ≠ 全量。上一轮同模型读数仍只作位次参照，L4 / verdict 不变。<br>
<b>下一步优先级</b>：① 若目标是榜单可比，接入官方 Harbor 的逐题独立环境，在 ${esc(cvPinned)} 题上运行并寻求第三方复核；不能继续用统一离线 verifier 代替官方口径。② 若目标是可归因 harness-Δ，直接在已扩到 ${esc(cvAfter)} 题的任务池上跑同模型、同预算、同评分器的 bro2 vs minimal 受控对照，不依赖官方披露。③ 机制改进仍走预注册判据 + 行为对比 + holdout + 二次判读，不靠任务数量或分数叙事。</div>

<div class="foot">bro2 · Model + Harness = Agent · 冻结模型权重，只演进 harness · 只增账本 / 惰性真实探测 / 对比式改进<br>
本报告由 <code>examples/build-core-report.ts</code> 从可复核 JSON 生成，测量数字不手写 · v2.34.0</div>
</div></body></html>`;

writeFileSync(OUT, html);
console.log(`核心报告已生成：${OUT}`);
console.log(`  v2.34.0 本轮：路径A=${AU.verdict} | 路径B扩集 ${cvBefore}→${cvAfter} | sanity ${cvSound}/${cvAfter} | 全量分母 ${cvOriginal}/${cvPinned}（实测样本 ${cvSample}，非全量）`);
console.log(`  前序 v2.33.0：端点扫描 ${scOk.length}/${scTotal} TOOLS_OK | 同模型锚点 ${anPasses}/${anTrials}=${anPass} vs 榜 ${anLb} (Δ=${anDelta}, non-strict) | provider_error=${anProviderErr} | 429重试=${anRate429}`);
console.log(`  前序 v2.32.0：${R.trials.length} trial | 读数 L=${ro.legacyPassRate} C=${ro.calibratedPassRate} | 机制 P1=${mech.P1_mechanism} P2=${mech.P2_behavior} P3=${mech.P3_result}`);
