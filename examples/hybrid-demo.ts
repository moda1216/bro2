/**
 * 本地 + 远程协同降调用 · 真实演示
 *
 * 用 bro2 真实装配出来的 HybridProvider（remote=kilo 免 Key 强模型，
 * local=本地 qwen2.5:0.5b 小模型），发送一组代表性 LLM 请求，并打印：
 *   - 路由决策（哪些走本地、哪些走远程）
 *   - 推理效率统计（remoteCalls / localCalls / cacheHits / remoteAvoided）
 *
 * 演示要点：agent 循环中大量提示是「重复/近似」的（守卫检查、循环中的相同系统
 * 提示、对相同工具结果的整理）。这些提示命中缓存后远程调用数直接归零，远程模型
 * 的配额/限流压力随之下降——这就是「本地 + 远程协同」对 bro2 的反向优化。
 *
 * 运行：npm run hybrid:demo
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentOS } from "../src/index.ts";
import { isStatsProvider } from "../src/models/cache.ts";
import type { LLMProvider, LLMRequest } from "../src/models/base.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const line = (s = ""): void => process.stdout.write(s + "\n");

const os = createAgentOS({
  root: ROOT,
  autoApprove: true,
  plugins: [],
  config: { storage: { dir: "./data" }, permission: { workspace: "./data/workspace", allowedPaths: ["./data/workspace"] } },
});

const hybrid = os.providers.get("hybrid");
if (!(hybrid && isStatsProvider(hybrid))) {
  line("✗ 未装配 hybrid provider（检查 agentos.config.json 的 hybrid 段）");
  await os.shutdown();
  process.exit(1);
}

// 1) 一组「相同」的工具调用请求（模拟 agent 循环里反复出现的同类提示）
const sameToolReq: LLMRequest = {
  messages: [
    { role: "user", content: "请计算 12+18+25+31+14 的和，使用 calc 工具。" },
  ],
  tools: [{ name: "calc", description: "求和", parameters: { type: "object", properties: { nums: { type: "array" } }, required: ["nums"] } }],
} as LLMRequest;

line("=== 场景 A：发送 5 次「相同」的工具调用请求（缓存优先应只打 1 次远程）===");
for (let i = 0; i < 5; i += 1) {
  const r = await (hybrid as LLMProvider).complete(sameToolReq);
  line(`  #${i + 1} provider=${r.provider}  content=${JSON.stringify(r.content).slice(0, 60)}`);
}

// 2) 一组「无工具」的纯生成请求（启发式策略应路由到本地小模型）
const chatReq: LLMRequest = { messages: [{ role: "user", content: "用一句话解释什么是缓存。" }] } as LLMRequest;
line("");
line("=== 场景 B：发送 2 次「无工具」的纯生成请求（应路由到本地小模型）===");
for (let i = 0; i < 2; i += 1) {
  const r = await (hybrid as LLMProvider).complete(chatReq);
  line(`  #${i + 1} provider=${r.provider}  content=${JSON.stringify(r.content).slice(0, 60)}`);
}

const s = (hybrid as { inferenceStats(): ReturnType<typeof Object> }).inferenceStats();
line("");
line("=== 推理效率统计（HybridProvider.inferenceStats）===");
line(`  remoteCalls (打到远程强模型) : ${s.remoteCalls}`);
line(`  localCalls  (打到本地小模型) : ${s.localCalls}`);
line(`  cacheHits   (缓存命中, 零调用) : ${s.cacheHits}`);
line(`  remoteAvoided (避免的远程调用) : ${s.remoteAvoided}`);
line(`  remoteCallRatio (远程占比)    : ${s.remoteCallRatio}`);
line("");
line(`  → 本演示中 ${s.remoteAvoided} 次远程调用被缓存/本地协同省下（远程占比降至 ${s.remoteCallRatio}）。`);

await os.shutdown();
