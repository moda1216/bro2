/**
 * live 接入门禁（唯一实现）
 * ----------------------------------------------------------
 * 为什么必须共用：`eval --mode live` 与 `bench:v2 --mode live` 若各写一份预检，
 * 迟早出现「一个入口放行、另一个拒绝」的分叉，评测结果的可信度就没了。
 *
 * 判定口径（与既有 CLI 完全一致）：
 *  - mock / 未注册的 provider：拒绝；
 *  - 组合 provider（hybrid→keyless→上游）递归穿透，**任一**上游 ready 即放行
 *    （故障转移是聚合器的职责，不是评测器的）；
 *  - 没有可探测的 OpenAI 兼容端点：放行但说明原因，不假装验证过。
 */
import type { LLMProvider } from "./base.ts";
import { runPreflight } from "./preflight.ts";
import type { PreflightResult } from "./preflight.ts";
import { probeTargets } from "./resolve.ts";

export interface LiveGate {
  ready: boolean;
  reason: string;
  /** 已探测的上游结果（命中即停，与 CLI 行为一致） */
  results: PreflightResult[];
  /** 是否真的探测过端点；false 表示按配置放行 */
  probed: boolean;
}

export async function liveGate(provider: LLMProvider | undefined, name: string): Promise<LiveGate> {
  if (!provider || name === "mock") {
    return { ready: false, reason: `provider "${name}" 是离线 Mock，live 评测禁止使用 Mock`, results: [], probed: false };
  }
  const targets = probeTargets(provider);
  if (targets.length === 0) {
    return { ready: true, reason: `provider "${name}" 没有可探测的 OpenAI 兼容底层端点`, results: [], probed: false };
  }
  const results: PreflightResult[] = [];
  for (const t of targets) {
    const pf = await runPreflight(t);
    results.push(pf);
    if (pf.ready) return { ready: true, reason: `上游 ${pf.provider} 就绪`, results, probed: true };
  }
  return { ready: false, reason: "所有上游端点均未就绪", results, probed: true };
}
