import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { newId } from "../kernel/events.ts";
import { withLock } from "./orchestrator.ts";

export type Suite = "visible" | "hidden" | "replay" | "shadow";
export type Verifier = "exact-output-v1" | "agent-output-v1";
export interface MafCase { id: string; input: string; expected: string }
export interface Scenario { id: string; version: number; name: string; domain: string; cases: Record<Suite, MafCase[]>; verifier: Verifier; budget: { maxMs: number; concurrency: number; maxRepairs: number }; permissions: string[]; contractHash: string; createdAt: string }
/** kind=dsl：对输入做确定性字符串变换（exact-output-v1 场景）；kind=agent：携带提示片段/工具白名单，由真实 Agent Loop 执行（agent-output-v1 场景）。 */
export interface Block { id: string; version: string; parentVersion?: string; kind: "dsl" | "agent"; ops: string[]; prompt?: string; tools?: string[]; domain: string; measuredDomain: string[]; status: string; selectionWeight: number; evidenceRefs: string[]; diff: string; createdAt: string }
export interface Genome { blocks: string[]; topology: Array<{ from: string; to: string }>; prompt: string; tools: string[]; skillMemory: string[]; permissions: string[] }
export interface AgentVersion { agentId: string; version: string; parentVersion?: string; scenarioId: string; domain: string; genome: Genome; genomeHash: string; snapshotHash: string; proposalReason: string; status: string; createdAt: string }
export interface RunInput { genome: Genome; blocks: Block[]; scenario: Scenario; input: string; signal: AbortSignal }
/** 真实执行通道：由宿主注入（跑 Agent Loop）。未注入时 agent-output-v1 场景 fail-closed，绝不用 DSL 冒充。 */
export type AgentRunner = (input: RunInput) => Promise<string>;
interface Pair { suite: Suite; caseId: string; baseline: number; candidate: number; status: "ok" | "error"; error?: string }
export interface EvalReport { id: string; agentId: string; version: string; baselineVersion: string; verifier: Verifier; runnerCalls: number; pairs: Pair[]; suites: Record<string, { n: number; baseline: number; candidate: number; regressions: number }>; delta: number; ci95: [number, number]; effect: number; power: string; decision: string; reasons: string[]; elapsedMs: number; createdAt: string }
export interface Audit { seq: number; ts: string; by: number; action: string; actor: string; refs: Record<string, unknown> }
const SUITES: Suite[] = ["visible", "hidden", "replay", "shadow"];
const VERIFIERS: Verifier[] = ["exact-output-v1", "agent-output-v1"];
const DEFAULT_BLOCKS: Array<[string, string[], string]> = [
  ["identity", ["identity"], "原样输出"], ["trim", ["trim"], "清理首尾空白"],
  ["lower", ["lower"], "统一小写"], ["upper", ["upper"], "统一大写"],
  ["spacing", ["collapse-space", "trim"], "合并空白并清理首尾"],
  ["semicolon", ["trim", "ensure-semicolon"], "规范语句末尾分号"],
  ["lines", ["trim", "unique-lines", "sort-lines"], "去重并排序行"],
];
/** 真实 Agent Block：改的是提示片段与工具白名单，效果只能由真实 Agent 跑出来。 */
const AGENT_BLOCKS: Array<[string, string, string[]]> = [
  ["agent-plan-first", "动手前先用 todo_write 列出步骤，再逐步执行；给出最终答案前逐项核对。", []],
  ["agent-verify", "给出最终答案前重新读取题目要求并逐条核对；发现不符先修正再回答。", []],
  ["agent-concise", "最终回答只输出答案本身，不要解释、不要前缀。", []],
  ["agent-files", "需要落盘或修改文件时用文件工具实际完成，不要只在回答里描述。", ["file_read", "file_write", "file_edit", "file_list"]],
];
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function atomic(path: string, value: unknown): void { mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(value, null, 2)); renameSync(tmp, path); }
/** 文件不存在 → fallback；存在但损坏 → 抛错。静默当空集会在下一次写入时把数据永久覆盖掉。 */
function read<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { throw new Error(`MAF 数据文件损坏：${path}，拒绝静默重建，需人工恢复`); }
}
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

function view(s: Scenario): unknown { return { ...s, cases: { visible: s.cases.visible.length, hidden: s.cases.hidden.length, replay: s.cases.replay.length, shadow: s.cases.shadow.length }, hiddenPolicy: "内容仅评测器可读" }; }
export class Foundry {
  readonly dir: string;
  private readonly scenarios = new Map<string, Scenario>();
  private readonly agents = new Map<string, AgentVersion[]>();
  private readonly blocks = new Map<string, Block>();
  private readonly evaluations = new Map<string, EvalReport>();
  private readonly releases = new Map<string, string>();
  private readonly lockDir: string;
  private readonly runner?: AgentRunner;
  private seq = 0;
  constructor(root: string, runner?: AgentRunner) {
    this.dir = join(root, "maf"); mkdirSync(this.dir, { recursive: true }); this.lockDir = join(this.dir, "foundry.lock"); this.runner = runner; this.load();
  }
  /** 每次公开读写前重扫磁盘：多实例下不以陈旧内存为准。 */
  private load(): void {
    this.scenarios.clear(); this.agents.clear(); this.blocks.clear(); this.evaluations.clear(); this.releases.clear();
    for (const [id, ops, diff] of DEFAULT_BLOCKS) this.blocks.set(id, { id, version: "v1", kind: "dsl", ops, domain: "*", measuredDomain: ["programming"], status: "active", selectionWeight: 1, evidenceRefs: [], diff, createdAt: "genesis" });
    for (const [id, prompt, tools] of AGENT_BLOCKS) this.blocks.set(id, { id, version: "v1", kind: "agent", ops: [], prompt, tools, domain: "*", measuredDomain: [], status: "active", selectionWeight: 1, evidenceRefs: [], diff: prompt, createdAt: "genesis" });
    for (const b of read<Block[]>(join(this.dir, "blocks.json"), [])) this.blocks.set(b.id, b);
    for (const f of readdirSync(this.dir)) if (f.startsWith("scenario-")) { const s = read<Scenario | null>(join(this.dir, f), null); if (s) this.scenarios.set(s.id, s); }
    const agentsDir = join(this.dir, "agents");
    if (existsSync(agentsDir)) for (const id of readdirSync(agentsDir)) {
      const versions = readdirSync(join(agentsDir, id)).filter((f) => f.endsWith(".json")).map((f) => read<AgentVersion | null>(join(agentsDir, id, f), null)).filter((x): x is AgentVersion => !!x);
      if (versions.length) this.agents.set(id, versions.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
    }
    for (const r of read<EvalReport[]>(join(this.dir, "evaluations.json"), [])) this.evaluations.set(`${r.agentId}:${r.version}`, r);
    for (const [id, version] of Object.entries(read<Record<string, string>>(join(this.dir, "releases.json"), {}))) this.releases.set(id, version);
  }
  /** 写路径统一进锁：锁内先重读磁盘再改再写，杜绝陈旧内存整文件覆盖；seq 在调用 fn 之前置为行号。 */
  private mutate<T>(fn: () => T): T {
    return withLock(this.lockDir, () => {
      this.load(); const p = join(this.dir, "audit.jsonl"); this.seq = existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).length : 0;
      return fn();
    });
  }
  /** 只能在 mutate 内调用：seq = 行号，由锁保证跨实例唯一。 */
  private audit(action: string, actor: string, refs: Record<string, unknown>): void {
    this.seq += 1;
    appendFileSync(join(this.dir, "audit.jsonl"), `${JSON.stringify({ seq: this.seq, ts: new Date().toISOString(), by: process.pid, action, actor, refs } satisfies Audit)}\n`);
  }
  private saveAgent(a: AgentVersion): void { atomic(join(this.dir, "agents", a.agentId, `${a.version}.json`), a); }
  private saveBlocks(): void { atomic(join(this.dir, "blocks.json"), [...this.blocks.values()].filter((b) => b.id.startsWith("distilled-"))); }
  private saveEvaluations(): void { atomic(join(this.dir, "evaluations.json"), [...this.evaluations.values()]); }
  private saveReleases(): void { atomic(join(this.dir, "releases.json"), Object.fromEntries(this.releases)); }
  private evaluationById(id: string): EvalReport | undefined { return [...this.evaluations.values()].find((r) => r.id === id); }
  private dslOps(a: AgentVersion): string[] { return a.genome.blocks.flatMap((id) => this.blocks.get(id)!.ops); }
  getAgent(id: string, version?: string): AgentVersion | undefined { this.load(); return this.peek(id, version); }
  /** 不重扫磁盘的查找：只能在刚 load() 过的路径（锁内 / 评估开头）使用。 */
  private peek(id: string, version?: string): AgentVersion | undefined { const all = this.agents.get(id) ?? []; return version ? all.find((a) => a.version === version) : all.at(-1); }
  getEvaluation(agentId: string, version: string): EvalReport | undefined { this.load(); return this.evaluations.get(`${agentId}:${version}`); }
  release(agentId: string): string | undefined { this.load(); return this.releases.get(agentId); }
  activeForDomain(domain: string): AgentVersion | undefined { this.load(); return [...this.agents.values()].flat().reverse().find((a) => a.status === "active" && a.domain === domain && this.releases.get(a.agentId) === a.version); }
  scenario(id: string, includeHidden = false): unknown { const s = this.scenarios.get(id); return s ? (includeHidden ? s : view(s)) : undefined; }
  list(): unknown { this.load(); return { scenarios: [...this.scenarios.values()].map(view), agents: [...this.agents.values()].flat().map((a) => ({ ...a, release: this.releases.get(a.agentId) === a.version })), blocks: [...this.blocks.values()], evaluations: [...this.evaluations.values()].map((r) => ({ ...r, pairs: r.pairs.length })), releases: Object.fromEntries(this.releases), auditCount: this.seq }; }
  createScenario(input: { name: string; domain: string; cases: Record<Suite, MafCase[]>; verifier?: Verifier; budget?: Scenario["budget"]; permissions?: string[] }): Scenario {
    return this.mutate(() => {
      if (!input.name?.trim() || !input.domain?.trim()) throw new Error("场景名称与变量域不能为空");
      const verifier = input.verifier ?? "exact-output-v1"; if (!VERIFIERS.includes(verifier)) throw new Error(`未知判分器：${verifier}`);
      if (verifier === "agent-output-v1" && !this.runner) throw new Error("agent-output-v1 场景需要宿主注入真实 Agent runner，拒绝创建无法执行的判分");
      for (const suite of SUITES) if (!input.cases?.[suite]?.length || input.cases[suite].some((c) => !c.id || c.expected === undefined)) throw new Error(`${suite} 判分用例不完整`);
      const partial = { id: newId("scenario"), version: 1, name: input.name, domain: input.domain, cases: input.cases, verifier, budget: input.budget ?? { maxMs: 600000, concurrency: 2, maxRepairs: 3 }, permissions: input.permissions ?? [], createdAt: new Date().toISOString() };
      if (partial.budget.maxMs > 600000 || partial.budget.concurrency > 2 || partial.budget.maxRepairs > 3) throw new Error("超出 v0.1 冻结预算上限");
      const s: Scenario = { ...partial, contractHash: hash(partial) }; this.scenarios.set(s.id, s); atomic(join(this.dir, `scenario-${s.id}.json`), s); this.audit("scenario.create", "human", { scenarioId: s.id, contractHash: s.contractHash, verifier }); return s;
    });
  }
  createAgent(input: { scenarioId: string; agentId?: string; parentVersion?: string; blocks: string[]; prompt?: string; tools?: string[]; skillMemory?: string[]; permissions?: string[]; reason: string; actor?: string }): AgentVersion {
    return this.mutate(() => {
      const s = this.scenarios.get(input.scenarioId); if (!s) throw new Error("场景不存在");
      if (!input.reason?.trim()) throw new Error("变异理由必填"); if (!input.blocks.length || input.blocks.some((b) => !this.blocks.has(b))) throw new Error("Block 白名单校验失败");
      if (s.verifier === "exact-output-v1" && input.blocks.some((id) => this.blocks.get(id)!.kind !== "dsl")) throw new Error("DSL 判分场景只接受 dsl Block：agent Block 的效果无法由字符串变换判出");
      const parent = input.agentId && input.parentVersion ? this.peek(input.agentId, input.parentVersion) : undefined;
      if (input.parentVersion && !parent) throw new Error("父代版本不存在");
      const permissions = input.permissions ?? parent?.genome.permissions ?? s.permissions;
      if (permissions.some((p) => !s.permissions.includes(p)) || (parent && permissions.some((p) => !parent.genome.permissions.includes(p)))) throw new Error("候选不得扩权");
      const genome: Genome = { blocks: [...input.blocks], topology: input.blocks.slice(1).map((b, i) => ({ from: input.blocks[i]!, to: b })), prompt: input.prompt ?? parent?.genome.prompt ?? "按拓扑执行 Block 并满足输出契约", tools: input.tools ?? parent?.genome.tools ?? [], skillMemory: input.skillMemory ?? parent?.genome.skillMemory ?? [], permissions };
      const base = { agentId: input.agentId ?? newId("agent"), scenarioId: s.id, domain: s.domain, genome, proposalReason: input.reason, createdAt: new Date().toISOString() };
      const a: AgentVersion = { ...base, ...(parent ? { parentVersion: parent.version } : {}), genomeHash: hash(genome), snapshotHash: hash({ ...base, scenario: s.contractHash, blocks: genome.blocks.map((id) => this.blocks.get(id)) }), version: "", status: "draft" };
      a.version = `v_${hash({ ...base, parentVersion: parent?.version }).slice(0, 16)}`; this.saveAgent(a); this.audit("agent.propose", input.actor ?? "mother-agent", { agentId: a.agentId, version: a.version, parentVersion: a.parentVersion, reason: a.proposalReason, snapshotHash: a.snapshotHash }); return a;
    });
  }
  /** 配对评测：基线与候选在同一用例上各跑一次。agent-output-v1 走真实 Agent runner（无锁、可并发、受预算约束）；exact-output-v1 走确定性 DSL。 */
  async evaluate(agentId: string, version: string): Promise<EvalReport> {
    this.load();
      const candidate = this.peek(agentId, version); if (!candidate) throw new Error("候选不存在");
      const baseline = candidate.parentVersion ? this.peek(agentId, candidate.parentVersion) : undefined; if (!baseline) throw new Error("根版本只能作基线，不能自比");
    const s = this.scenarios.get(candidate.scenarioId)!, started = Date.now(), jobs = SUITES.flatMap((suite) => s.cases[suite].map((c) => ({ suite, c })));
    const perCallMs = Math.max(50, Math.floor(s.budget.maxMs / Math.max(1, jobs.length * 2)));
    let runnerCalls = 0;
    const score = async (a: AgentVersion, c: MafCase): Promise<{ hit: number; error?: string }> => {
      if (s.verifier === "exact-output-v1") return { hit: runOps(c.input, this.dslOps(a)) === c.expected ? 1 : 0 };
      if (!this.runner) throw new Error("agent-output-v1 场景没有真实 Agent runner：拒绝用 DSL 冒充评测");
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), perCallMs);
      try { runnerCalls += 1; const out = await this.runner({ genome: a.genome, blocks: a.genome.blocks.map((id) => this.blocks.get(id)!), scenario: s, input: c.input, signal: ctrl.signal }); return { hit: runOps(out, this.dslOps(a)) === c.expected ? 1 : 0 }; }
      catch (e) { return { hit: 0, error: e instanceof Error ? e.message : String(e) }; }
      finally { clearTimeout(timer); }
    };
    const results = new Array<Pair | undefined>(jobs.length); const queue = jobs.map((_, i) => i); let budgetBlown = false;
    const worker = async (): Promise<void> => {
      for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
        if (Date.now() - started > s.budget.maxMs) { budgetBlown = true; return; }
        const b = await score(baseline, jobs[i]!.c), a = await score(candidate, jobs[i]!.c);
        results[i] = { suite: jobs[i]!.suite, caseId: jobs[i]!.c.id, baseline: b.hit, candidate: a.hit, status: a.error || b.error ? "error" : "ok", ...(a.error || b.error ? { error: a.error ?? b.error } : {}) };
      }
    };
    await Promise.all(Array.from({ length: Math.min(s.budget.concurrency, jobs.length) }, worker));
    const pairs = Array.from({ length: jobs.length }, (_, i) => results[i] ?? { suite: jobs[i]!.suite, caseId: jobs[i]!.c.id, baseline: 0, candidate: 0, status: "error" as const, error: "超出时间预算，未执行" });
    const suites = Object.fromEntries(SUITES.map((suite) => { const p = pairs.filter((x) => x.suite === suite); return [suite, { n: p.length, baseline: p.reduce((n, x) => n + x.baseline, 0) / p.length, candidate: p.reduce((n, x) => n + x.candidate, 0) / p.length, regressions: p.filter((x) => x.baseline === 1 && x.candidate === 0).length }]; }));
    const delta = pairs.reduce((n, p) => n + p.candidate - p.baseline, 0) / pairs.length, interval = ci95(pairs), reasons: string[] = [];
    for (const [name, r] of Object.entries(suites)) if (r.regressions) reasons.push(`${name} 新增回归 ${r.regressions}`);
    if (delta < 0.05) reasons.push("效应量低于 0.05"); if (interval[0] <= 0) reasons.push("95% 配对 bootstrap 下界未超过 0");
    const power = pairs.length < 64 ? "insufficient" : "sufficient"; if (power === "insufficient") reasons.push("有效配对样本不足 64，不得宣称显著");
    const decision = reasons.some((r) => r.includes("回归") || r.includes("效应量") || r.includes("下界")) ? "rejected" : power === "sufficient" ? "active-eligible" : "shadow-eligible";
    const report: EvalReport = { id: newId("eval"), agentId, version, baselineVersion: baseline.version, verifier: s.verifier, runnerCalls, pairs, suites, delta, ci95: interval, effect: delta, power, decision, reasons, elapsedMs: Date.now() - started, createdAt: new Date().toISOString() };
    if (report.elapsedMs > s.budget.maxMs || budgetBlown) { report.decision = "rejected"; report.reasons.push("超出单候选时间预算"); }
    this.mutate(() => {
      const fresh = this.peek(agentId, version); if (fresh) { fresh.status = report.decision === "rejected" ? "rejected" : "shadow"; this.saveAgent(fresh); }
      this.evaluations.set(`${agentId}:${version}`, report); this.saveEvaluations();
      this.audit("candidate.evaluate", "frozen-verifier", { evalId: report.id, agentId, version, decision: report.decision, power: report.power, delta: report.delta, ci95: report.ci95, verifier: report.verifier, runnerCalls: report.runnerCalls, reasons: report.reasons });
    });
    return report;
  }
  publish(agentId: string, version: string, actor: string, allowLimitedEvidence = false): AgentVersion {
    return this.mutate(() => {
      const a = this.peek(agentId, version), r = this.evaluations.get(`${agentId}:${version}`); if (!a || !r) throw new Error("候选或评测不存在"); if (!actor) throw new Error("发布必须由人类问责");
      if (r.decision !== "active-eligible" && !(allowLimitedEvidence && r.decision === "shadow-eligible")) throw new Error("晋升门禁未通过");
      for (const old of this.agents.get(agentId) ?? []) if (old.status === "active") { old.status = "retired"; this.saveAgent(old); }
      a.status = "active"; this.releases.set(agentId, version); this.saveAgent(a); this.saveReleases();
      this.audit("agent.publish", actor, { agentId, version, snapshotHash: a.snapshotHash, limitedEvidence: r.power === "insufficient" }); return a;
    });
  }
  /** 只能回到「本 agentId 该版本确曾通过发布门禁」且仍可用的版本；用结构化审计判定，不做字符串匹配。 */
  rollback(agentId: string, targetVersion: string, actor: string): AgentVersion {
    return this.mutate(() => {
      const target = this.peek(agentId, targetVersion); if (!target) throw new Error("回滚快照不存在");
      const published = this.auditTrail().some((a) => a.action === "agent.publish" && a.refs.agentId === agentId && a.refs.version === targetVersion);
      if (!published || !["active", "retired"].includes(target.status)) throw new Error("只能回滚到曾通过发布门禁的版本");
      for (const old of this.agents.get(agentId) ?? []) if (old.status === "active") { old.status = "retired"; this.saveAgent(old); }
      target.status = "active"; this.releases.set(agentId, targetVersion); this.saveAgent(target); this.saveReleases();
      this.audit("agent.rollback", actor, { agentId, targetVersion, snapshotHash: target.snapshotHash, restored: ["code", "blocks", "topology", "prompt", "skillMemory", "tools", "data"] }); return target;
    });
  }
  revoke(agentId: string, actor: string): void { this.mutate(() => { for (const a of this.agents.get(agentId) ?? []) if (a.status === "active") { a.status = "revoked"; this.saveAgent(a); } this.releases.delete(agentId); this.saveReleases(); this.audit("agent.revoke", actor, { agentId }); }); }
  distill(agentId: string, version: string, actor: string): Block {
    return this.mutate(() => {
      const a = this.peek(agentId, version), r = this.evaluations.get(`${agentId}:${version}`); if (!a || !r || !["active-eligible", "shadow-eligible"].includes(r.decision)) throw new Error("无有效专家证据，拒绝蒸馏");
      const src = a.genome.blocks.map((id) => this.blocks.get(id)!), ops = src.flatMap((b) => b.ops), prompt = src.map((b) => b.prompt).filter((p): p is string => !!p).join("\n"), tools = [...new Set([...a.genome.tools, ...src.flatMap((b) => b.tools ?? [])])];
      const id = `distilled-${hash({ ops, prompt, tools }).slice(0, 10)}`, agent = !!prompt || !!tools.length;
      const b: Block = { id, version: "v1", kind: agent ? "agent" : "dsl", ops, ...(agent ? { prompt, tools } : {}), domain: a.domain, measuredDomain: [a.domain], status: "shadow", selectionWeight: 0.5, evidenceRefs: [r.id], diff: `蒸馏自 ${a.agentId}@${a.version}`, createdAt: new Date().toISOString() };
      this.blocks.set(id, b); this.saveBlocks(); this.audit("capability.distill", actor, { blockId: id, kind: b.kind, evidenceRefs: b.evidenceRefs, status: b.status, note: "尚需未见任务与全局回归，未自动晋升" }); return b;
    });
  }
  promoteBlock(blockId: string, transferReportId: string, globalReportId: string, actor: string): Block {
    return this.mutate(() => {
      const b = this.blocks.get(blockId); if (!b || b.status !== "shadow") throw new Error("共享能力不存在或已处理");
      const transfer = this.evaluationById(transferReportId), global = this.evaluationById(globalReportId);
      const src = b.evidenceRefs[0] ? this.evaluationById(b.evidenceRefs[0]!) : undefined;
      const independent = transfer && global && transfer !== global && src && transfer.agentId !== src.agentId && global.agentId !== src.agentId;
      const valid = independent && [transfer!, global!].every((r) => r.decision === "active-eligible" && r.power === "sufficient" && r.ci95[0] > 0 && Object.values(r.suites).every((s) => s.regressions === 0));
      b.status = valid ? "active" : "rejected"; b.selectionWeight = valid ? 1 : 0; b.evidenceRefs = [...new Set([...b.evidenceRefs, transferReportId, globalReportId])]; this.saveBlocks();
      this.audit(valid ? "capability.promote" : "capability.reject", actor, { blockId, transferReportId, globalReportId, status: b.status, reason: valid ? "专项迁移+全局回归双门禁" : "独立证据不足或存在回归" }); return b;
    });
  }
  auditTrail(): Audit[] { const p = join(this.dir, "audit.jsonl"); return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Audit) : []; }
}
