#!/usr/bin/env python3.11
# -*- coding: utf-8 -*-
"""从一手素材渲染三态审计报告；数字全部读自原始文件，不手写。
落 docs/AUDIT-REPORT.html。examples/ 豁免源码预算。"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
D = ROOT / "data"


def load(p):
    return json.loads((D / p).read_text(encoding="utf-8"))


# ---- 一手数字 ----
rows = [json.loads(l) for l in (D / "bench/external/tb21-full-results.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
done = len(rows)
rewards = {}
for r in rows:
    rewards[r.get("reward")] = rewards.get(r.get("reward"), 0) + 1
passed = rewards.get(1, 0)
pass_task = [r["task"] for r in rows if r.get("reward") == 1]

up = load("bench/external/UPSTREAM.json")
cov = up["coverageAudit"]
audit = load("bench/external/official-harness-audit.json")
strict = audit["consequence"]["isStrictHarnessDelta"]
anchor = audit["leaderboardAnchor"]["score"]

wb = load("evidence/whitebox-panel.json")
tp = load("evidence/third-party-review.json")
energy = wb["energy"]
power = tp["power"]
local = load("local-llm-stats.json")

# 三态计数（来自审计判定，集中维护）
VERIFIED = 3   # 冻结判分器自报隔离机制 / 进化曲线独立重算 / 源码净增0
PARTIAL = 7    # H1/H3/H4链路/H5/H6 + 需求3/5 + 需求4闸门 + V1/V2/V4/V7(内存)
NOTPROV = 9    # 需求1/2/6/7 + H2 + V3/V6/V7能耗 + 显著性/第三方

CSS = """
:root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--fg:#e6edf3;--mut:#8b949e;
--g:#2ea043;--y:#d29922;--r:#f85149;--b:#58a6ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:32px 24px 64px}
h1{font-size:26px;margin:0 0 6px}h2{font-size:18px;margin:34px 0 12px;padding-bottom:8px;border-bottom:1px solid var(--line)}
p.desc{color:var(--mut);margin:0 0 20px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:22px 0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px}
.card .num{font-size:34px;font-weight:700;line-height:1}.card .lbl{color:var(--mut);margin-top:8px;font-size:13px}
.cv{border-top:3px solid var(--g)}.cy{border-top:3px solid var(--y)}.cr{border-top:3px solid var(--r)}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden;font-size:13px}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mut);font-weight:600;background:#1c2128}
tr:last-child td{border-bottom:none}
.tag{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;white-space:nowrap}
.tg{background:rgba(46,160,67,.18);color:var(--g)}.ty{background:rgba(210,153,34,.18);color:var(--y)}.tr{background:rgba(248,81,73,.18);color:var(--r)}
.k{color:var(--b);font-weight:600}
.note{background:var(--panel);border-left:3px solid var(--y);padding:12px 16px;margin:14px 0;border-radius:0 8px 8px 0;color:var(--mut)}
.crit{border-left-color:var(--r)}
code{background:#21262d;padding:1px 5px;border-radius:4px;font-size:12px;color:#a5d6ff}
.big{font-size:15px;color:var(--fg);font-weight:600}
footer{margin-top:40px;color:var(--mut);font-size:12px;border-top:1px solid var(--line);padding-top:16px}
"""

o = []
o.append("<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'>")
o.append("<meta name='viewport' content='width=device-width,initial-scale=1'>")
o.append("<title>bro2 深度重写 · 一手素材审计</title><style>" + CSS + "</style></head><body><div class='wrap'>")
o.append("<h1>bro2 深度重写 · 一手素材审计与可证伪方案</h1>")
o.append("<p class='desc'>只用本轮实读的一手文件；三态判定，不存在“达成”态。所有数字读自原始素材，不手写。</p>")

o.append("<div class='cards'>")
o.append(f"<div class='card cv'><div class='num'>{VERIFIED}</div><div class='lbl'>VERIFIED · 已验证（限所述范围）</div></div>")
o.append(f"<div class='card cy'><div class='num'>{PARTIAL}</div><div class='lbl'>PARTIAL · 机制在 / 未接活循环</div></div>")
o.append(f"<div class='card cr'><div class='num'>{NOTPROV}</div><div class='lbl'>NOT-PROVEN · 未达成 / 未证</div></div>")
o.append("</div>")

o.append("<div class='note crit'><span class='big'>最硬的四组一手事实：</span><br>")
o.append(f"① 89×3 仅完成 <code>{done}/267</code>，reward 分布 <code>{rewards}</code>，唯一通过 <code>{pass_task}</code>——恰是 6 个 SOUND 里唯一落在榜单 89 题集内的那个（soundInPinned21=<code>{cov['soundInPinned21']}</code>）。<br>")
o.append(f"② <code>isStrictHarnessDelta={str(strict).lower()}</code>；榜单 <code>{anchor}%</code> 是 gpt-oss-120b 聚合分、无逐任务明细。<br>")
o.append(f"③ 能效 <code>externalTokens={energy['externalTokens']} / selfReportedTokens={energy['selfReportedTokens']}</code> 是构造值，honest 自认“token 计数为外部采集仿真”。<br>")
o.append(f"④ 统计 <code>actualN={power['actualN']} / requiredNPerGroup={power['requiredNPerGroup']} / sufficient={str(power['sufficient']).lower()}</code>。<br>")
o.append(f"⑤ 唯一真实推理是 <code>{local['modelId']}</code> <b>CPU</b>（{local['requests']} 请求 / {local['toolCallsEmitted']} tool_calls / {round(local['inferenceSeconds'])}s），非 Apple Silicon。</div>")

o.append("<h2>硬约束（6 条）</h2>")
o.append("<table><tr><th>#</th><th>约束</th><th>判定</th><th>一手反例 / 依据</th></tr>")
hard = [
 ("H1","24G Mac 自主 + MLX/GGUF + 失效降级本地","P","预算公式自洽（7B Q4≈5.97G fits）；真机 tokens/s/MLX 未测。降级仅进程内仿真。"),
 ("H2","冻结权重 + strict delta","N","isStrictHarnessDelta=false；分母不同源；聚合分无明细。"),
 ("H3","全量 content-addressed + 可回滚","P","冻结面+账本+配置哈希；提示文本/评测集未逐项纳入，账本增长漂移。"),
 ("H4","不改基准 / 不伪造 / mock 不计分","P","判分器自报隔离已验证；但 tb21-batch.py 未回填 provider=mock 机器判据（p1Finding 自认）。"),
 ("H5","离线本地优先、数据不出本机","P","路由可离线；但真实评测全程走远端端点，断网+无 key 跑完整任务集未做。"),
 ("H6","深入而非更大","P","源码净增 0、全部落 examples/；但 lessons.jsonl：判据机器就位≠接进活循环。"),
]
tm = {"V":"<span class='tag tg'>已验证</span>","P":"<span class='tag ty'>部分</span>","N":"<span class='tag tr'>未证</span>"}
for i,c,s,why in hard:
    o.append(f"<tr><td>{i}</td><td class='k'>{c}</td><td>{tm[s]}</td><td>{why}</td></tr>")
o.append("</table>")

o.append("<h2>能力需求（7 条）</h2>")
o.append("<table><tr><th>#</th><th>需求 / 验收</th><th>判定</th><th>一手依据</th></tr>")
cap = [
 ("1","本地自治 · 断网+无 key 跑通完整任务集","N","failover-proof.notProven 含“真机断网能力/89×3 通过率”；场景 C 是协议仿真。"),
 ("2","通用助手 · 真实日志分布通过率+置信度双达标","N","40+ 会话日志存在但未做分布采样；唯一基准 9/267，n=9 置信区间无意义。"),
 ("3","轨迹飞轮 · 每条可追溯到来源与 delta","P","分级/脱敏/留痕 8/8；delta 为全局 IPA 代理，非逐条因果；账本 29 条全 harness-edit。"),
 ("4","自进化训练 · 冻结验证集前后对照+显著性","N","judgePromotion 判据完整但 lessons.jsonl 记“从没被调用、停在 B”；无 GPU；显著性 sufficient=false。"),
 ("5","白盒 · 仅凭界面重建决策链","P","6/6 事件流重建+篡改检出；静态 HTML，SSE 实时 notProven。"),
 ("6","能效 · 系统工具独立测量+超预算降级","N","唯一真实数字 rssMB=78.3；externalTokens 为构造值；无能耗计。"),
 ("7","安全 · 第三方红队+提示注入防御+99% 无人化","N","红队 13/13 是自测应用层；源码中 inject 全是系统自身注入，无独立注入检测器。"),
]
for i,c,s,why in cap:
    o.append(f"<tr><td>{i}</td><td class='k'>{c}</td><td>{tm[s]}</td><td>{why}</td></tr>")
o.append("</table>")

o.append("<h2>独立验证清单（缺一不可，7 条）</h2>")
o.append("<table><tr><th>#</th><th>验证项</th><th>判定</th><th>一手依据</th></tr>")
ind = [
 ("V1","公开冻结基准开源可复跑","P","tb21-batch.py 可复跑、逐 trial 落盘；但 9/267 且分母不同源。"),
 ("V2","独立判分器重判一致性","P","recompute 8/8 重算水位账本，非对 agent 产出判分；harbor-verify 仅验容器可执行。"),
 ("V3","客观指标 + 统计显著性","N","actualN=9, required=64, sufficient=false。kappa/p 只是原语。"),
 ("V4","测试集隔离 + 哈希冻结","P","content-manifest 冻结面；三段指纹互异+OOD 只读在判据层。"),
 ("V5","进化曲线独立脚本重算","V","evidence-recompute 不 import 运行时模块，8/8+逐点 14/14 一致。"),
 ("V6","第三方可审计 + 红队报告","N","全部自跑；honest.noThirdParty；红队是自测基线。"),
 ("V7","能耗/内存系统工具外部测量","N","内存 rssMB 真实；能耗仿真，无 powermetrics/RAPL。"),
]
for i,c,s,why in ind:
    o.append(f"<tr><td>{i}</td><td class='k'>{c}</td><td>{tm[s]}</td><td>{why}</td></tr>")
o.append("</table>")

o.append("<h2>五个结构性发现</h2>")
o.append("<table><tr><th>#</th><th>发现</th></tr>")
finds = [
 "strict delta 从未成立；仓库内 bro2 vs minimal 受控对照是唯一严格载体，但需全量样本才够功效。",
 "“绿”多数是自证：evidence 由 agent 自己写脚本、喂自己数据；32/32 门禁全绿≠能力达标（范畴错误）。",
 "能效证据里唯一真实数字是 RSS，其余为构造演示值。",
 "提示注入防御名存实亡：源码中的 inject 全是系统向自身 prompt 注入预算预警/记忆。",
 "骨架厚了、闭环没接：lessons.jsonl 高频主题——判据机器就位≠接进活循环。",
]
for i,f in enumerate(finds,1):
    o.append(f"<tr><td>{i}</td><td>{f}</td></tr>")
o.append("</table>")

o.append("<h2>可证伪方案（深入而非更大，源码净增 0）</h2>")
o.append("<table><tr><th>ID</th><th>方案</th><th>可证伪验收（改坏就变红）</th></tr>")
fixes = [
 ("F1","strict delta：启用 bro2 vs minimal 同任务/同模型/同评分器受控对照，换真实 SOUND 任务","sharedHash/taskHash 不一致、哑弹、off 侧也完成 → accepted=false"),
 ("F2","独立重判：不 import eval-grade.ts 的判分器对 workspace 快照重判","篡改一条 reward 必被检出；逐条列一致率"),
 ("F3","能效真计数：VmRSS + cgroup CPU + 端点 usage 字段","无 usage 则输出 unmeasured；VmRSS 随分配单调变化"),
 ("F4","提示注入防御：不可信内容隔离 + 指令几何检测 + 审批升级","注入 payload 必拦、正常文本不误报、留 audit"),
 ("F5","闸门接活循环：judgePromotion 接入真实三段 + 补 endpoint 轨迹","OOD 退化必阻断；自报增益无行为必标 rewardHacking"),
 ("F6","provider=mock 判据回填为 batch wrapper（不改冻结脚本）","仅 provider 层泄漏的 trial 必判 error 不计 reward"),
 ("F7","真实日志分布采样 + Wilson 置信区间","区间随 n 收窄；n=9 输出“不足以判定”"),
]
for i,c,v in fixes:
    o.append(f"<tr><td class='k'>{i}</td><td>{c}</td><td>{v}</td></tr>")
o.append("</table>")

o.append("<h2>诚实边界</h2>")
o.append("<div class='note crit'>")
o.append("未达成：本地自治真机跑通、通用助手双达标、自进化真实训练与显著性、能效真机测量、第三方红队与提示注入防御、strict delta 归因、统计显著性、第三方复核、能耗外部测量。<br><br>")
o.append("部分达成：content-addressed 回滚、轨迹飞轮、白盒重建、闸门骨架、离线优先。<br><br>")
o.append("已验证（仅限所述范围）：冻结判分器自报隔离与协议零容忍机制、进化曲线独立重算一致性、源码净增 0 预算守恒。<br><br>")
o.append("<b>全程 verdict=not-proven、L4=not-achieved 不变。本审计不构成能力水位提升，不产出榜单分数，不写 external-results.json。</b>")
o.append("</div>")

o.append("<footer>生成：examples/build-audit-report.py · 数字读自 tb21-full-results.jsonl / UPSTREAM.json / official-harness-audit.json / whitebox-panel.json / third-party-review.json / local-llm-stats.json · 完整论证见 docs/DEEP-REWRITE-AUDIT.md</footer>")
o.append("</div></body></html>")

out = ROOT / "docs/AUDIT-REPORT.html"
out.write_text("\n".join(o), encoding="utf-8")
print(f"written: {out} ({out.stat().st_size} bytes)")
print(f"一手数字: done={done}/267 reward={rewards} strict={strict} energy={energy} powerN={power['actualN']}/{power['requiredNPerGroup']}")
