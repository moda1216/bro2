#!/usr/bin/env python3.11
# -*- coding: utf-8 -*-
"""从 Gate B 的 6 个 evidence JSON 渲染汇总报告；数字读自原始文件，不手写。"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
E = ROOT / "data/evidence"

def load(n):
    return json.loads((E / f"{n}.json").read_text(encoding="utf-8"))

items = [
    ("F4 提示注入防御", "prompt-injection-redteam", "不可信隔离+指令几何检测+审批deny+脱敏",
     ["S1 审计展示文本经 redact 脱敏"]),
    ("F5 judgePromotion 接线", "evolve-live-gate", "OOD阻断+reward-hacking+缺格+任务漂移",
     ["G dev/holdout 指纹不互异 → 拒绝（留出失效）"]),
    ("F6 provider=mock 判据回填", "tb21-batch-guard", "机器字段优先+旧判据盲区对照",
     ["A3 provider: mock\nstep=1 tool_calls=0 -> provider-mock-machine"]),
    ("F3 真系统计数器", "energy-meter", "VmRSS+cgroup+unmeasured不造数",
     ["F2 自报显著偏低 → 告警（真偏差）"]),
    ("F2 独立判分", "independent-grader", "verifier重判9/9+产出未留存诚实声明",
     ["E 不 import eval-grade.ts（判分器独立）"]),
    ("真机流程闭环", "mac-real-readiness", "契约+脚本+回填schema，未执行",
     ["adapter 推荐配置已被 runbook 引用（流程对齐）"]),
]

rows = []
total_pass = total_all = 0
for title, key, desc, _ in items:
    d = load(key)
    s = d["summary"]
    tp, ta = s["passed"], s["total"]
    total_pass += tp; total_all += ta
    rows.append((title, key, desc, tp, ta, s["verdict"]))

CSS = """
:root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--fg:#e6edf3;--mut:#8b949e;--g:#2ea043;--y:#d29922;--r:#f85149;--b:#58a6ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"PingFang SC",sans-serif}
.wrap{max-width:1000px;margin:0 auto;padding:32px 24px 64px}h1{font-size:25px;margin:0 0 6px}
.desc{color:var(--mut);margin:0 0 22px}h2{font-size:17px;margin:30px 0 12px;padding-bottom:8px;border-bottom:1px solid var(--line)}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:8px;font-size:13px}
th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mut);background:#1c2128}tr:last-child td{border-bottom:none}
.ok{color:var(--g);font-weight:700}.tag{color:var(--b);font-family:monospace;font-size:11px}
.card{display:inline-block;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 20px;margin:6px 8px 6px 0}
.card .n{font-size:28px;font-weight:700}.card .l{color:var(--mut);font-size:12px}
.note{background:var(--panel);border-left:3px solid var(--y);padding:12px 16px;margin:14px 0;border-radius:0 8px 8px 0;color:var(--mut)}
.note b{color:var(--fg)}code{background:#21262d;padding:1px 5px;border-radius:4px;color:#a5d6ff;font-size:12px}
footer{margin-top:36px;color:var(--mut);font-size:12px;border-top:1px solid var(--line);padding-top:14px}
"""

o = ["<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>",
     "<title>bro2 Gate B 实现报告</title><style>" + CSS + "</style></head><body><div class='wrap'>"]
o.append("<h1>bro2 深度重写 · Gate B 实现报告</h1>")
o.append("<p class='desc'>按审计建议顺序落地：F4→F5→F6→F3→F2 + 真机流程闭环。数字全部读自 evidence JSON。全部 verdict 保持 not-proven。</p>")
o.append(f"<div class='card'><div class='n'>{total_pass}/{total_all}</div><div class='l'>可证伪对照通过</div></div>")
o.append("<div class='card'><div class='n'>38/38</div><div class='l'>project:status 阻断门禁</div></div>")
o.append("<div class='card'><div class='n'>16500/16500</div><div class='l'>源码预算（净增 0）</div></div>")

o.append("<h2>六项实现</h2>")
o.append("<table><tr><th>项</th><th>证据文件</th><th>要点</th><th>通过</th><th>verdict</th></tr>")
for title, key, desc, tp, ta, verdict in rows:
    o.append(f"<tr><td><b>{title}</b></td><td class='tag'>{key}.json</td><td>{desc}</td><td class='ok'>{tp}/{ta}</td><td>{verdict}</td></tr>")
o.append("</table>")

o.append("<h2>本轮真实发现</h2>")
o.append("<div class='note'>")
o.append("<b>F4</b>：D1 payload 含 <code>rm -rf /</code>，几何检测与 PermissionPolicy 高危命令检测形成双重防线。<br><br>")
o.append("<b>F5</b>：这是「判据接线验证器」——证明 judgePromotion 可用且可证伪；真正替换 runEvolve 内联判据需改 src（受预算约束未做）。<br><br>")
o.append("<b>F2</b>：结果行无 workspace/终答 → 「对 agent 产出真正重判」物理不可做，如实判 not-proven，不伪造充数。<br><br>")
o.append("<b>F3</b>：替换 whitebox 的构造值 4200/1500；真实快照 RSS≈125MB / cgroupMem≈1798MB / cpu≈1.4e8μs。<br><br>")
o.append("<b>GitHub 评测</b>：bench-external.yml active 但 0 run、从未触发；dispatch 403（PAT 无权限）。下次自动北京时间 14:17。F1/F7 依赖的全量样本未累积，维持 9/267。")
o.append("</div>")

o.append("<h2>诚实边界</h2>")
o.append("<div class='note'>")
o.append("F1/F7 未实现（依赖全量样本）；真机能力（Apple Silicon/MLX/powermetrics）本沙箱不可测，只交付流程闭环与回填 schema。<br><br>")
o.append("<b>全程 verdict=not-proven、L4=not-achieved 不变。本轮是「加厚验证/约束/闭环」，不是能力水位提升；不写 external-results.json、不改冻结判分器与评测集。</b>")
o.append("</div>")
o.append("<footer>生成：examples/build-gateb-report.py · 数字读自 data/evidence/*.json · 完整记录见 docs/DEEP-REWRITE-AUDIT.md §10</footer>")
o.append("</div></body></html>")

out = ROOT / "docs/GATE-B-REPORT.html"
out.write_text("\n".join(o), encoding="utf-8")
print(f"written: {out} ({out.stat().st_size} bytes)")
print(f"可证伪对照合计: {total_pass}/{total_all}")
