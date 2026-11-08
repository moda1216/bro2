/**
 * L1 模型层 · 组合/网状 provider 的端点穿透解析
 *
 * provider 可以层层嵌套：hybrid(remote=keyless(local=emergency), local=local-qwen)
 * → keyless → 多个免 Key 上游（各自是 OpenAICompatProvider）。门禁（preflight /
 * eval:live）需要对「真实端点」做探针，因此需要一个与 provider 具体类型无关的
 * 递归解析器：一路沿 CompositeProvider.underlying() 下钻到叶子端点。
 *
 * 从 bin/agentos.ts 抽出为独立模块，好处：
 *  - CLI 的 preflight 与 eval 门禁共用同一套判定，避免两处漂移；
 *  - 可被单元测试直接验证（无需执行 CLI / 发网络请求）。
 */
import type { LLMProvider } from "./base.ts";
import { OpenAICompatProvider } from "./openai-compat.ts";
import { isCompositeProvider } from "./cache.ts";

/** 是否指向本机端点（localhost / 127.0.0.1 / ::1）。 */
export const isLocalEndpoint = (e: string): boolean =>
  /^(https?:\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)/i.test(e);

/**
 * 递归收集 provider 树下的所有「叶子」provider（去重，防环）。
 * 叶子 = 非组合型 provider，或组合型但 underlying() 为空。
 */
export function resolveLeaves(p: LLMProvider, seen = new Set<LLMProvider>()): LLMProvider[] {
  if (seen.has(p)) return [];
  seen.add(p);
  if (!isCompositeProvider(p)) return [p];
  const children = p.underlying();
  if (children.length === 0) return [p];
  return children.flatMap((c) => resolveLeaves(c, seen));
}

/** 递归收集所有叶子里的 OpenAI 兼容端点（门禁只能对这类端点发 probe）。 */
export function leafEndpoints(p: LLMProvider): OpenAICompatProvider[] {
  return resolveLeaves(p).filter((l): l is OpenAICompatProvider => l instanceof OpenAICompatProvider);
}

/**
 * 为门禁选出应探测的端点：
 *  - 远端（免 Key 网状上游）优先，且必须 configured（有 baseUrl/model/认证）；
 *  - 仅当没有可用远端时，才退回本地端点；
 *  - 本地兜底殿后，避免「本机没起 Ollama」误判整个免 Key 网状不可用。
 */
export function probeTargets(p: LLMProvider): OpenAICompatProvider[] {
  const leaves = leafEndpoints(p);
  const remote = leaves.filter((e) => !isLocalEndpoint(e.endpoint) && e.configured);
  if (remote.length > 0) return remote;
  return leaves.filter((e) => e.configured);
}
