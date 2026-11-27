import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { newId } from "../kernel/events.ts";

export type Suite = "visible" | "hidden" | "replay" | "shadow";
export interface MafCase { id: string; input: string; expected: string }
export interface Scenario { id: string; version: number; name: string; domain: string; cases: Record<Suite, MafCase[]>; verifier: string; budget: { maxMs: number; concurrency: number; maxRepairs: number }; permissions: string[]; contractHash: string; createdAt: string }
export interface Block { id: string; version: string; parentVersion?: string; ops: string[]; domain: string; measuredDomain: string[]; status: string; selectionWeight: number; evidenceRefs: string[]; diff: string; createdAt: string }
export interface Genome { blocks: string[]; topology: Array<{ from: string; to: string }>; prompt: string; tools: string[]; skillMemory: string[]; permissions: string[] }
export interface AgentVersion { agentId: string; version: string; parentVersion?: string; scenarioId: string; domain: string; genome: Genome; genomeHash: string; snapshotHash: string; proposalReason: string; status: string; createdAt: string }
interface Pair { suite: Suite; caseId: string; baseline: number; candidate: number; status: "ok" }
export interface EvalReport { id: string; agentId: string; version: string; baselineVersion: string; pairs: Pair[]; suites: Record<string, { n: number; baseline: number; candidate: number; regressions: number }>; delta: number; ci95: [number, number]; effect: number; power: string; decision: string; reasons: string[]; elapsedMs: number; createdAt: string }
interface Audit { seq: number; ts: string; action: string; actor: string; refs: Record<string, unknown> }
const SUITES: Suite[] = ["visible", "hidden", "replay", "shadow"];
const DEFAULT_BLOCKS: Array<[string, string[], string]> = [
  ["identity", ["identity"], "原样输出"], ["trim", ["trim"], "清理首尾空白"],
  ["lower", ["lower"], "统一小写"], ["upper", ["upper"], "统一大写"],
  ["spacing", ["collapse-space", "trim"], "合并空白并清理首尾"],
  ["semicolon", ["trim", "ensure-semicolon"], "规范语句末尾分号"],
  ["lines", ["trim", "unique-lines", "sort-lines"], "去重并排序行"],
];
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function atomic(path: string, value: unknown): void { mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.tmp`; writeFileSync(tmp, JSON.stringify(value, null, 2)); renameSync(tmp, path); }
function read<T>(path: string, fallback: T): T { try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return fallback; } }
function runOps(input: string, ops: string[]): string {
  let out = input;
  for (const op of ops) {
    if (op === "identity") continue;
    if (op === "trim") out = out.trim();
    else if (op === "lower") out = out.toLowerCase();
    else if (op === "upper") out = out.toUpperCase();
    else if (op === "collapse-space") out = out.replace(/\s+/g, " ");
    else if (op === "ensure-semicolon") out = out.endsWith(";") ? out : `${out};`;
    else if (op === "unique-lines") out = [...new Set(out.split("\n"))].join("\n");
    else if (op === "sort-lines") out = out.split("\n").sort().join("\n");
    else throw new Error(`未批准的 Block 操作: ${op}`);
  }
  return out;
}
function ci95(pairs: Pair[]): [number, number] {
  if (!pairs.length) return [0, 0];
  const deltas = pairs.map((p) => p.candidate - p.baseline), means: number[] = [];
  let seed = 0x6d6166;
  const random = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let b = 0; b < 512; b += 1) { let sum = 0; for (let i = 0; i < deltas.length; i += 1) sum += deltas[Math.floor(random() * deltas.length)]!; means.push(sum / deltas.length); }
  means.sort((a, b) => a - b);
  return [means[Math.floor(means.length * 0.025)]!, means[Math.floor(means.length * 0.975)]!];
}

export class Foundry {
  readonly dir: string;
  private readonly scenarios = new Map<string, Scenario>();
  private readonly agents = new Map<string, AgentVersion[]>();
  private readonly blocks = new Map<string, Block>();
  private readonly evaluations = new Map<string, EvalReport>();
  private readonly releases = new Map<string, string>();
  private seq = 0;
  constructor(root: string) {
    this.dir = join(root, "data", "maf"); mkdirSync(this.dir, { recursive: true });
    for (const [id, ops, diff] of DEFAULT_BLOCKS) this.blocks.set(id, { id, version: "v1", ops, domain: "*", measuredDomain: ["programming"], status: "active", selectionWeight: 1, evidenceRefs: [], diff, createdAt: "genesis" });
    for (const b of read<Block[]>(join(this.dir, "blocks.json"), [])) this.blocks.set(b.id, b);
    for (const f of readdirSync(this.dir)) {
      if (f.startsWith("scenario-")) { const s = read<Scenario | null>(join(this.dir, f), null); if (s) this.scenarios.set(s.id, s); }
    }
    const agentsDir = join(this.dir, "agents");
    if (existsSync(agentsDir)) for (const id of readdirSync(agentsDir)) {
      const versions = readdirSync(join(agentsDir, id)).filter((f) => f.endsWith(".json")).map((f) => read<AgentVersion>(join(agentsDir, id, f), null as never)).filter(Boolean);
      if (versions.length) this.agents.set(id, versions);
    }
    for (const r of read<EvalReport[]>(join(this.dir, "evaluations.json"), [])) this.evaluations.set(`${r.agentId}:${r.version}`, r);
    for (const [id, version] of Object.entries(read<Record<string, string>>(join(this.dir, "releases.json"), {}))) this.releases.set(id, version);
    this.seq = existsSync(join(this.dir, "audit.jsonl")) ? readFileSync(join(this.dir, "audit.jsonl"), "utf8").split("\n").filter(Boolean).length : 0;
  }
  private audit(action: string, actor: string, refs: Record<string, unknown>): void {
    const row: Audit = { seq: ++this.seq, ts: new Date().toISOString(), action, actor, refs };
    appendFileSync(join(this.dir, "audit.jsonl"), JSON.stringify(row) + "\n");
  }
  private saveAgent(a: AgentVersion): void { const all = this.agents.get(a.agentId) ?? [], i = all.findIndex((x) => x.version === a.version); if (i >= 0) all[i] = a; else all.push(a); this.agents.set(a.agentId, all); atomic(join(this.dir, "agents", a.agentId, `${a.version}.json`), a); }
  private saveBlocks(): void { atomic(join(this.dir, "blocks.json"), [...this.blocks.values()].filter((b) => b.id.startsWith("distilled-"))); }
  private evaluationById(id: string): EvalReport | undefined { return [...this.evaluations.values()].find((r) => r.id === id); }
  getAgent(id: string, version?: string): AgentVersion | undefined { const all = this.agents.get(id) ?? []; return version ? all.find((a) => a.version === version) : all.at(-1); }
  getEvaluation(agentId: string, version: string): EvalReport | undefined { return this.evaluations.get(`${agentId}:${version}`); }
  release(agentId: string): string | undefined { return this.releases.get(agentId); }
  activeForDomain(domain: string): AgentVersion | undefined { return [...this.agents.values()].flat().reverse().find((a) => a.status === "active" && a.domain === domain && this.releases.get(a.agentId) === a.version); }
  scenario(id: string, includeHidden = false): unknown { const s = this.scenarios.get(id); if (!s) return undefined; return includeHidden ? s : { ...s, cases: { visible: s.cases.visible.length, hidden: s.cases.hidden.length, replay: s.cases.replay.length, shadow: s.cases.shadow.length }, hiddenPolicy: "内容仅评测器可读" }; }
  list(): unknown { return { scenarios: [...this.scenarios.keys()].map((id) => this.scenario(id)), agents: [...this.agents.values()].flat().map((a) => ({ ...a, release: this.releases.get(a.agentId) === a.version })), blocks: [...this.blocks.values()], evaluations: [...this.evaluations.values()].map((r) => ({ ...r, pairs: r.pairs.length })), releases: Object.fromEntries(this.releases), auditCount: this.seq }; }
  createScenario(input: { name: string; domain: string; cases: Record<Suite, MafCase[]>; budget?: Scenario["budget"]; permissions?: string[] }): Scenario {
    if (!input.name?.trim() || !input.domain?.trim()) throw new Error("场景名称与变量域不能为空");
    for (const suite of SUITES) if (!input.cases?.[suite]?.length || input.cases[suite].some((c) => !c.id || c.expected === undefined)) throw new Error(`${suite} 判分用例不完整`);
    const partial = { id: newId("scenario"), version: 1, name: input.name, domain: input.domain, cases: input.cases, verifier: "exact-output-v1", budget: input.budget ?? { maxMs: 600000, concurrency: 2, maxRepairs: 3 }, permissions: input.permissions ?? [], createdAt: new Date().toISOString() };
    if (partial.budget.maxMs > 600000 || partial.budget.concurrency > 2 || partial.budget.maxRepairs > 3) throw new Error("超出 v0.1 冻结预算上限");
    const s: Scenario = { ...partial, contractHash: hash(partial) }; this.scenarios.set(s.id, s); atomic(join(this.dir, `scenario-${s.id}.json`), s); this.audit("scenario.create", "human", { scenarioId: s.id, contractHash: s.contractHash }); return s;
  }
  createAgent(input: { scenarioId: string; agentId?: string; parentVersion?: string; blocks: string[]; prompt?: string; tools?: string[]; skillMemory?: string[]; permissions?: string[]; reason: string; actor?: string }): AgentVersion {
    const s = this.scenarios.get(input.scenarioId); if (!s) throw new Error("场景不存在");
    if (!input.reason?.trim()) throw new Error("变异理由必填"); if (!input.blocks.length || input.blocks.some((b) => !this.blocks.has(b))) throw new Error("Block 白名单校验失败");
    const parent = input.agentId && input.parentVersion ? this.getAgent(input.agentId, input.parentVersion) : undefined;
    if (input.parentVersion && !parent) throw new Error("父代版本不存在");
    const permissions = input.permissions ?? parent?.genome.permissions ?? s.permissions;
    if (permissions.some((p) => !s.permissions.includes(p)) || (parent && permissions.some((p) => !parent.genome.permissions.includes(p)))) throw new Error("候选不得扩权");
    const genome: Genome = { blocks: [...input.blocks], topology: input.blocks.slice(1).map((b, i) => ({ from: input.blocks[i]!, to: b })), prompt: input.prompt ?? parent?.genome.prompt ?? "按拓扑执行 Block 并满足输出契约", tools: input.tools ?? parent?.genome.tools ?? [], skillMemory: input.skillMemory ?? parent?.genome.skillMemory ?? [], permissions };
    const base = { agentId: input.agentId ?? newId("agent"), scenarioId: s.id, domain: s.domain, genome, proposalReason: input.reason, createdAt: new Date().toISOString() };
    const a: AgentVersion = { ...base, ...(parent ? { parentVersion: parent.version } : {}), genomeHash: hash(genome), snapshotHash: hash({ ...base, scenario: s.contractHash, blocks: genome.blocks.map((id) => this.blocks.get(id)) }), version: "", status: "draft" };
    a.version = `v_${hash({ ...base, parentVersion: parent?.version }).slice(0, 16)}`; this.saveAgent(a); this.audit("agent.propose", input.actor ?? "mother-agent", { agentId: a.agentId, version: a.version, parentVersion: a.parentVersion, reason: a.proposalReason, snapshotHash: a.snapshotHash }); return a;
  }
  evaluate(agentId: string, version: string): EvalReport {
    const candidate = this.getAgent(agentId, version); if (!candidate) throw new Error("候选不存在");
    const baseline = candidate.parentVersion ? this.getAgent(agentId, candidate.parentVersion) : undefined; if (!baseline) throw new Error("根版本只能作基线，不能自比");
    const s = this.scenarios.get(candidate.scenarioId)!, started = Date.now(), pairs: Pair[] = [];
    const opsFor = (a: AgentVersion): string[] => a.genome.blocks.flatMap((id) => this.blocks.get(id)!.ops);
    const before = opsFor(baseline), after = opsFor(candidate);
    for (const suite of SUITES) for (const c of s.cases[suite]) {
      const b = runOps(c.input, before) === c.expected ? 1 : 0, a = runOps(c.input, after) === c.expected ? 1 : 0;
      pairs.push({ suite, caseId: c.id, baseline: b, candidate: a, status: "ok" });
    }
    const suites = Object.fromEntries(SUITES.map((suite) => { const p = pairs.filter((x) => x.suite === suite); return [suite, { n: p.length, baseline: p.reduce((n, x) => n + x.baseline, 0) / p.length, candidate: p.reduce((n, x) => n + x.candidate, 0) / p.length, regressions: p.filter((x) => x.baseline === 1 && x.candidate === 0).length }]; }));
    const delta = pairs.reduce((n, p) => n + p.candidate - p.baseline, 0) / pairs.length, interval = ci95(pairs), reasons: string[] = [];
    for (const [name, r] of Object.entries(suites)) if (r.regressions) reasons.push(`${name} 新增回归 ${r.regressions}`);
    if (delta < 0.05) reasons.push("效应量低于 0.05"); if (interval[0] <= 0) reasons.push("95% 配对 bootstrap 下界未超过 0");
    const power = pairs.length < 64 ? "insufficient" : "sufficient"; if (power === "insufficient") reasons.push("有效配对样本不足 64，不得宣称显著");
    const decision = reasons.some((r) => r.includes("回归") || r.includes("效应量") || r.includes("下界")) ? "rejected" : power === "sufficient" ? "active-eligible" : "shadow-eligible";
    const report: EvalReport = { id: newId("eval"), agentId, version, baselineVersion: baseline.version, pairs, suites, delta, ci95: interval, effect: delta, power, decision, reasons, elapsedMs: Date.now() - started, createdAt: new Date().toISOString() };
    if (report.elapsedMs > s.budget.maxMs) { report.decision = "rejected"; report.reasons.push("超出单候选时间预算"); }
    candidate.status = decision === "rejected" ? "rejected" : "shadow"; this.saveAgent(candidate); this.evaluations.set(`${agentId}:${version}`, report);
    atomic(join(this.dir, "evaluations.json"), [...this.evaluations.values()]); this.audit("candidate.evaluate", "frozen-verifier", { evalId: report.id, agentId, version, decision, power, delta, ci95: interval, reasons }); return report;
  }
  publish(agentId: string, version: string, actor: string, allowLimitedEvidence = false): AgentVersion {
    const a = this.getAgent(agentId, version), r = this.evaluations.get(`${agentId}:${version}`); if (!a || !r) throw new Error("候选或评测不存在"); if (!actor) throw new Error("发布必须由人类问责");
    if (r.decision !== "active-eligible" && !(allowLimitedEvidence && r.decision === "shadow-eligible")) throw new Error("晋升门禁未通过");
    for (const old of this.agents.get(agentId) ?? []) if (old.status === "active") old.status = "retired";
    a.status = "active"; this.releases.set(agentId, version); this.saveAgent(a); atomic(join(this.dir, "releases.json"), Object.fromEntries(this.releases));
    this.audit("agent.publish", actor, { agentId, version, snapshotHash: a.snapshotHash, limitedEvidence: r.power === "insufficient" }); return a;
  }
  rollback(agentId: string, targetVersion: string, actor: string): AgentVersion {
    const target = this.getAgent(agentId, targetVersion); if (!target) throw new Error("回滚快照不存在");
    const prior = readFileSync(join(this.dir, "audit.jsonl"), "utf8").includes(`"action":"agent.publish"`) && readFileSync(join(this.dir, "audit.jsonl"), "utf8").includes(`"version":"${targetVersion}"`);
    if (!prior) throw new Error("只能回滚到曾通过发布门禁的版本"); this.releases.set(agentId, targetVersion); atomic(join(this.dir, "releases.json"), Object.fromEntries(this.releases));
    this.audit("agent.rollback", actor, { agentId, targetVersion, snapshotHash: target.snapshotHash, restored: ["code", "blocks", "topology", "prompt", "skillMemory", "tools", "data"] }); return target;
  }
  revoke(agentId: string, actor: string): void { for (const a of this.agents.get(agentId) ?? []) if (a.status === "active") { a.status = "revoked"; this.saveAgent(a); } this.releases.delete(agentId); atomic(join(this.dir, "releases.json"), Object.fromEntries(this.releases)); this.audit("agent.revoke", actor, { agentId }); }
  distill(agentId: string, version: string, actor: string): Block {
    const a = this.getAgent(agentId, version), r = this.evaluations.get(`${agentId}:${version}`); if (!a || !r || !["active-eligible", "shadow-eligible"].includes(r.decision)) throw new Error("无有效专家证据，拒绝蒸馏");
    const ops = a.genome.blocks.flatMap((id) => this.blocks.get(id)!.ops), id = `distilled-${hash(ops).slice(0, 10)}`;
    const b: Block = { id, version: "v1", ops, domain: a.domain, measuredDomain: [a.domain], status: "shadow", selectionWeight: 0.5, evidenceRefs: [r.id], diff: `蒸馏自 ${a.agentId}@${a.version}`, createdAt: new Date().toISOString() };
    this.blocks.set(id, b); this.saveBlocks(); this.audit("capability.distill", actor, { blockId: id, evidenceRefs: b.evidenceRefs, status: b.status, note: "尚需未见任务与全局回归，未自动晋升" }); return b;
  }
  promoteBlock(blockId: string, transferReportId: string, globalReportId: string, actor: string): Block {
    const b = this.blocks.get(blockId); if (!b || b.status !== "shadow") throw new Error("共享能力不存在或已处理");
    const transfer = this.evaluationById(transferReportId), global = this.evaluationById(globalReportId);
    const src = b.evidenceRefs[0] ? this.evaluationById(b.evidenceRefs[0]!) : undefined;
    const independent = transfer && global && transfer !== global && src && transfer.agentId !== src.agentId && global.agentId !== src.agentId;
    const valid = independent && [transfer!, global!].every((r) => r.decision === "active-eligible" && r.power === "sufficient" && r.ci95[0] > 0 && Object.values(r.suites).every((s) => s.regressions === 0));
    b.status = valid ? "active" : "rejected"; b.selectionWeight = valid ? 1 : 0; b.evidenceRefs = [...new Set([...b.evidenceRefs, transferReportId, globalReportId])]; this.saveBlocks();
    this.audit(valid ? "capability.promote" : "capability.reject", actor, { blockId, transferReportId, globalReportId, status: b.status, reason: valid ? "专项迁移+全局回归双门禁" : "独立证据不足或存在回归" }); return b;
  }
  auditTrail(): Audit[] { return existsSync(join(this.dir, "audit.jsonl")) ? readFileSync(join(this.dir, "audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Audit) : []; }
}
