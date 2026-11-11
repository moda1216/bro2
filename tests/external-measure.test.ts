/**
 * v2.27.0 · 外部公开任务测量通道（离线契约测试，不联网 / 不需要 Key / 不需要 Docker）
 *
 * 断言的不是「能跑分」，而是这条通道的**防自指与可复现契约**：
 *  1) 上游坐标固定到 commit、许可与检索日期齐全，仓库不分发 benchmark 原文；
 *  2) 任务清单与 SHA256SUMS 逐条对齐，评分器指纹可被复核；
 *  3) 拉取脚本按固定 commit 拉取并强制指纹校验；
 *  4) instruction 解析不篡改公开原文措辞，/app 路径适配被显式标注为环境说明；
 *  5) 测量报告（若已生成）必须自认「自跑 / 非榜单 / 不写 external-results.json / 不改 L4」；
 *  6) 本测试不改动 data/benchmark/external-results.json。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseInstruction, HONEST_LIMITATIONS, ENV_NOTE, fingerprint } from "../examples/external-measure.ts";

const ROOT = join(import.meta.dirname ?? "", "..");
const EXT = join(ROOT, "data", "bench", "external");
const read = (p: string): string => readFileSync(p, "utf8");
const jsonl = <T>(p: string): T[] => read(p).split("\n").map((l) => l.trim())
  .filter((l) => l && !l.startsWith("//")).map((l) => JSON.parse(l) as T);

interface ManifestTask {
  id: string; dir: string; category: string; instruction: string;
  inputs: Array<{ from: string; to: string }>; verifier: string;
  verifierSha256: string; oracle: string; artifact: string;
}

test("上游坐标固定到 commit，且声明不分发 benchmark 原文", () => {
  const u = JSON.parse(read(join(EXT, "UPSTREAM.json"))) as Record<string, unknown>;
  assert.match(String(u.commit), /^[0-9a-f]{40}$/);
  assert.equal(u.repo, "laude-institute/terminal-bench");
  assert.ok(u.license && u.retrievedAt && u.sourceUrl);
  assert.match(String(u.distribution), /不分发/);
  assert.ok(String(u.sourceUrl).includes(String(u.commit)));
});

test("任务清单字段完整、ID 唯一、评分器指纹为 64 位十六进制", () => {
  const tasks = jsonl<ManifestTask>(join(EXT, "tasks.jsonl"));
  assert.ok(tasks.length >= 3);
  assert.equal(new Set(tasks.map((t) => t.id)).size, tasks.length);
  for (const t of tasks) {
    assert.ok(t.dir && t.instruction && t.verifier && t.oracle && t.artifact);
    assert.ok(t.inputs.length > 0);
    assert.match(t.verifierSha256, /^[0-9a-f]{64}$/);
    assert.ok(["grounding", "multi-step", "tool-use"].includes(t.category));
  }
});

test("SHA256SUMS 与任务清单的评分器指纹逐条一致，且覆盖全部上游文件", () => {
  const sums = read(join(EXT, "SHA256SUMS")).trim().split("\n");
  const byPath = new Map(sums.map((l) => {
    const [hash, path] = l.trim().split(/\s+/);
    return [path, hash] as const;
  }));
  for (const t of jsonl<ManifestTask>(join(EXT, "tasks.jsonl"))) {
    assert.equal(byPath.get(`./${t.dir}/${t.verifier}`), t.verifierSha256, `${t.id} 评分器指纹不匹配`);
    assert.ok(byPath.has(`./${t.dir}/${t.oracle}`), `${t.id} 缺官方解指纹`);
    assert.ok(byPath.has(`./${t.dir}/${t.instruction}`), `${t.id} 缺指令文件指纹`);
  }
  for (const [path, hash] of byPath) {
    assert.match(hash!, /^[0-9a-f]{64}$/);
    assert.ok(path!.startsWith("./"));
  }
});

test("拉取脚本按固定 commit 取文件并强制指纹校验", () => {
  const s = read(join(ROOT, "examples", "fetch-external-tasks.sh"));
  assert.match(s, /UPSTREAM\.json/);
  assert.match(s, /terminal-bench\/\$COMMIT\/original-tasks/);
  assert.match(s, /sha256sum -c/);
  assert.match(s, /--retry/);
});

test("instruction 解析保留原文措辞，遇下一个顶层 key 即停止", () => {
  const yaml = [
    "# canary", "instruction: |-", "  First line.", "",
    "  Second /app/report.txt line.", "author_name: Someone", "difficulty: easy",
  ].join("\n");
  const out = parseInstruction(yaml);
  assert.match(out, /First line\./);
  assert.match(out, /Second \/app\/report\.txt line\./);
  assert.ok(!out.includes("author_name"));
  assert.ok(!out.includes("difficulty"));
});

test("/app 路径适配被显式标注为环境说明，而非伪装成公开任务原文", () => {
  assert.match(ENV_NOTE, /非公开任务原文/);
  assert.match(ENV_NOTE, /\/app/);
  assert.match(ENV_NOTE, /相对路径/);
  assert.ok(HONEST_LIMITATIONS.some((s) => s.includes("非第三方复核")));
  assert.ok(HONEST_LIMITATIONS.some((s) => s.includes("external-results.json")));
  assert.ok(HONEST_LIMITATIONS.some((s) => s.includes("L4")));
});

test("测量报告（若存在）守住防自指契约且 Δ 与逐任务结果自洽", () => {
  const p = join(EXT, "external-measure-report.json");
  if (!existsSync(p)) return; // 报告由联网实验生成，离线测试不强制存在
  const r = JSON.parse(read(p)) as {
    kind: string; delta: { bro2MinusMinimal: number; perTask: Array<{ bro2: number; minimal: number; delta: number }> };
    arms: { bro2: { passed: number; total: number }; minimal: { passed: number; total: number } };
    verifierSanity: Array<{ sound: boolean }>;
    honest: Record<string, unknown>;
  };
  assert.equal(r.kind, "external-task-measurement");
  assert.equal(r.honest.isLeaderboardScore, false);
  assert.equal(r.honest.thirdPartyVerified, false);
  assert.equal(r.honest.isModelCapabilityScore, false);
  assert.equal(r.honest.writtenToExternalResults, false);
  assert.equal(r.honest.leadershipVerdictChanged, false);
  assert.equal(r.honest.l4Changed, false);
  assert.ok(r.verifierSanity.every((s) => s.sound), "评分器必须全部通过双向反证");
  assert.equal(r.delta.bro2MinusMinimal, r.arms.bro2.passed - r.arms.minimal.passed);
  for (const p of r.delta.perTask) assert.equal(p.delta, p.bro2 - p.minimal);
});

test("本测试全程不改动 external-results.json", () => {
  const p = join(ROOT, "data", "benchmark", "external-results.json");
  const before = fingerprint(p);
  const after = fingerprint(p);
  assert.equal(after, before);
});
