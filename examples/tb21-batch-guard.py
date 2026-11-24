#!/usr/bin/env python3.11
# -*- coding: utf-8 -*-
"""
bro2 · F6 provider=mock 判据回填（wrapper，不改冻结的 tb21-batch.py）
--------------------------------------------------------------------
审计发现（failover-proof.json.p1Finding）：
  tb21-batch.py 原仅匹配 agent 终答里的中文标记「离线 Mock 模型驱动」，
  但泄漏最早发生在 provider 单步响应（provider=mock），那时还没写终答。
  provider 层的机器可读字段是更早、更可靠的污染信号。

本工具提供一个可复用的判定函数 + CLI：
  - is_polluted(log_text) -> (blocked, kind)：
      优先认机器字段（provider=mock / "provider":"mock" / provider: mock），
      其次 provider_error / 全部模型均不可用，最后才是旧的中文终答标记。
  - 不改 tb21-batch.py 本体；以 wrapper / 判据库形式供评测流水线引用。
  - 输出 data/evidence/tb21-batch-guard.json 作为可证伪证据。

可证伪对照：
  A 仅 provider 层泄漏（无终答中文标记）→ 必须判 blocked（这是旧判据的盲区）；
  B 旧中文标记 → 仍判 blocked（向后兼容）；
  C provider_error / 全部模型不可用 → blocked；
  D 干净成功日志 → 不拦（零误报）；
  E 真实历史日志样本 → 按其实际内容判定，不臆造。

用法：
  python3.11 examples/tb21-batch-guard.py            # 跑对照 + 写 evidence
  python3.11 examples/tb21-batch-guard.py <logfile>  # 判单个日志文件
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data/evidence/tb21-batch-guard.json"

# 机器可读字段判据（最早、最可靠）：优先于终答文本标记
MACHINE_PATTERNS = [
    re.compile(r'\bprovider\s*=\s*["\']?mock\b', re.I),
    re.compile(r'"provider"\s*:\s*"mock"', re.I),
    re.compile(r"\bprovider\s*:\s*['\"]?mock\b", re.I),
]
PROVIDER_ERROR_PATTERNS = [
    re.compile(r"provider_error", re.I),
    re.compile(r"全部模型均不可用"),
]
OLD_TEXT_PATTERNS = [
    re.compile(r"离线\s*Mock\s*模型驱动"),
    re.compile(r"离线\s*mock\s*模型", re.I),
]


def is_polluted(log_text: str):
    """返回 (blocked: bool, kind: str)。判据优先级：机器字段 > provider_error > 终答文本。"""
    for p in MACHINE_PATTERNS:
        if p.search(log_text):
            return True, "provider-mock-machine"
    for p in PROVIDER_ERROR_PATTERNS:
        if p.search(log_text):
            return True, "provider-error"
    for p in OLD_TEXT_PATTERNS:
        if p.search(log_text):
            return True, "mock-fallback-legacy"
    return False, "clean"


CASES = [
    # 旧判据盲区：只有机器字段，无中文终答标记
    ("A1", "inject", 'assistant provider=mock content=我先列个计划', "provider-mock-machine"),
    ("A2", "inject", '{"provider":"mock","content":"done"}', "provider-mock-machine"),
    ("A3", "inject", "provider: mock\nstep=1 tool_calls=0", "provider-mock-machine"),
    # 旧判据仍兼容
    ("B1", "inject", "本次由离线 Mock 模型驱动，任务完成", "mock-fallback-legacy"),
    # provider 错误
    ("C1", "inject", "stoppedBy=provider_error after 8 retries", "provider-error"),
    ("C2", "inject", "Error: 全部模型均不可用 → dead: timeout", "provider-error"),
    # 干净
    ("D1", "clean", "provider=ollama/qwen2.5 content=任务完成 steps=5", "clean"),
    ("D2", "clean", "provider=kilo-auto tool_calls=2 reward=1", "clean"),
]


def main() -> int:
    if len(sys.argv) > 1:
        text = Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
        blocked, kind = is_polluted(text)
        print(json.dumps({"blocked": blocked, "kind": kind}, ensure_ascii=False))
        return 0

    checks = []
    for cid, kind_expected, text, expect_kind in CASES:
        blocked, kind = is_polluted(text)
        should_block = kind_expected == "inject"
        ok = (blocked == should_block) and (kind == expect_kind)
        checks.append({
            "id": cid,
            "text": text[:100],
            "expect_block": should_block,
            "actual_block": blocked,
            "expect_kind": expect_kind,
            "actual_kind": kind,
            "pass": ok,
        })

    # E 真实历史日志样本：按实际内容判定（不臆造预期，只记录判定 + 是否含机器字段）
    real = []
    logdir = ROOT / ".." / "tmp" / "tb21-logs"
    if logdir.exists():
        for lp in sorted(logdir.glob("*.log"))[:5]:
            text = lp.read_text(encoding="utf-8", errors="replace")
            blocked, kind = is_polluted(text)
            real.append({"file": lp.name, "bytes": len(text), "blocked": blocked, "kind": kind})

    passed = sum(1 for c in checks if c["pass"])
    report = {
        "generatedAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "purpose": "F6：provider=mock 机器字段判据回填（wrapper，不改冻结 tb21-batch.py）",
        "finding": "旧判据只匹配终答中文标记；机器字段 provider=mock 在 provider 单步响应即出现，是更早信号",
        "priority": ["provider=mock 机器字段", "provider_error / 全部模型不可用", "旧中文终答标记"],
        "checks": checks,
        "realLogs": real,
        "summary": {"total": len(checks), "passed": passed, "failed": len(checks) - passed,
                    "verdict": "guard-green" if passed == len(checks) else "guard-red"},
        "honest": {
            "scope": "判定函数机器字段优先 + 兼容旧标记；真实日志样本按实际内容判定",
            "notProven": ["tb21-batch.py 本体已替换判据（本工具是 wrapper/判据库，未改冻结脚本）",
                          "全量 89×3 结果是否受旧判据污染（需逐条重扫，样本有限）"],
            "note": "回填路径：评测流水线在判定前调用 is_polluted()，机器字段命中即判 error 不计 reward。本沙箱不改冻结脚本以免动评测口径。",
            "verdictBoundary": "not-proven", "l4": "not-achieved",
        },
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"F6 provider=mock 判据回填：{passed}/{len(checks)} {report['summary']['verdict']}")
    for c in checks:
        print(f"  {'✓' if c['pass'] else '✗'} {c['id']} {c['text'][:50]} -> {c['actual_kind']}")
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
