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
} from "./contrast.ts";
export type {
  LiveCandidate, LiveDecision, LiveContrastReport,
} from "./contrast.ts";
export {
  behavioralContrast, failureSignals, proposeProbeCompose,
} from "./contrast.ts";
export type { RunSummary, ContrastResult, ProbeCandidate, ComposeResult } from "./contrast.ts";

// 复利中枢（P2 经验库 + 冻结速度度量 + 编排闭环）：两大设计目标共享的底座
export {
  ExperienceBank, failureSignature, requestSignature, endpointSignature, experiencePath,
} from "./experience.ts";
export type {
  ExperienceDomain, ExperienceOutcome, ExperienceEvent, ExperienceEntry,
  PrioritizeResult, ExperienceStats,
} from "./experience.ts";
export {
  VelocityLedger, MIN_SAMPLES, TREND_EPSILON, velocityPath, velocitySnapshotFrom,
} from "./velocity.ts";
export type { AttemptRecord, VelocitySnapshot, VelocityTrend } from "./velocity.ts";
export { compoundProbe, EXPLORE_SLOTS } from "./contrast.ts";
export type { CompoundOptions, CompoundResult, PendingCandidate } from "./contrast.ts";

// 迭代水位看板（只读投影 + HTML/Markdown 渲染，判定口径仍只有冻结尺子一份）
export {
  buildWatermark, formatWatermark, renderWatermarkHtml, WATERMARK_VERSION,
} from "./watermark.ts";
export type {
  WatermarkPoint, WatermarkReport, WatermarkTotals,
} from "./watermark.ts";

export * from "./types.ts";
