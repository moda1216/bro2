/** bro2 · 有界可验证自我改进模块统一出口 */
export { runEvolve, formatEvolveReport } from "./loop.ts";
export {
  runMetaEvolve, formatMetaReport, checkMetaPatch, applyMetaPatch,
  proposeMetaCandidates, metaPaths, loadMeta, saveMeta,
} from "./meta.ts";
export type { MetaOptions, MetaReport, MetaPatch, MetaCheck, MetaRoundRecord } from "./meta.ts";
export type { EvolveOptions } from "./loop.ts";
export { Ledger, IncidentLog, metaPatch, genesisPatch } from "./ledger.ts";
export type { OperatorStats } from "./ledger.ts";
export {
  computeIntegrity, diffIntegrity, checkPatch, extractHoldoutAnswers, PROTECTED_FILES,
} from "./guardrails.ts";
export type { CheckContext, CheckResult } from "./guardrails.ts";
export { mineFailures } from "./miner.ts";
export {
  OPERATORS, proposePatches, applyPatch, noteRejected, updateStrategyWeights,
} from "./operators.ts";
export {
  evolvePaths, loadState, loadStrategy, saveState, saveStrategy,
  makeShadowRoot, freshDefaultState, freshDefaultStrategy,
} from "./shadow.ts";
export {
  toRunSummary, baselineFromRuns, evaluateLiveCandidates,
  LiveContrastVerifier, failureSignals as contrastFailureSignals,
} from "./live-contrast.ts";
export type {
  LiveCandidate, LiveDecision, LiveContrastReport,
} from "./live-contrast.ts";
export {
  behavioralContrast, failureSignals, proposeProbeCompose,
} from "./contrast.ts";
export type { RunSummary, ContrastResult, ProbeCandidate, ComposeResult } from "./contrast.ts";
export * from "./types.ts";
