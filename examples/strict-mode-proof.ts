/**
 * strict 机制 bug 修复的确定性对照证明（离线可复算，不依赖真实端点）。
 *
 * 背景：bin/agentos.ts run --task 原先不启用 strict，router 在非 strict 下
 * order()=[current, ...所有其他 provider]，任何 provider 失败都会静默降级到 mock，
 * 产出「本次由离线 Mock 模型驱动」的假终答 —— 评测证据因此被污染。
 *
 * 本脚本注入一个「总是抛错」的 provider 并设为默认，做两臂对照：
 *   A 臂 strict=false：失败 → 降级 mock → stoppedBy=completed + mock 终答（复现 bug）
 *   B 臂 strict=true ：失败 → 不降级   → stoppedBy=provider_error（证明修复）
 * 断言两臂行为不同，且 B 臂不含 mock 终答标记。
 */
import { createAgentOS } from "../src/index.ts";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/models/base.ts";

const MOCK_MARK = "离线 Mock 模型驱动";

const failingProvider: LLMProvider = {
  name: "always-fail",
  async complete(_req: LLMRequest): Promise<LLMResponse> {
    throw new Error("injected provider failure (deterministic)");
  },
};

async function arm(strict: boolean): Promise<{ strict: boolean; stoppedBy: string; isMock: boolean; answerHead: string }> {
  const os = createAgentOS({ root: process.cwd(), evolvedState: false, autoApprove: true, plugins: [] });
  os.router.register(failingProvider.name, failingProvider);
  os.router.setDefault(failingProvider.name);
  os.router.setStrict(strict);
  const session = os.createSession("standard");
  const r = await os.run(session.id, "Do anything.", {});
  const result = {
    strict,
    stoppedBy: r.stoppedBy,
    isMock: r.answer.includes(MOCK_MARK),
    answerHead: r.answer.slice(0, 80).replace(/\n/g, " "),
  };
  await os.shutdown();
  return result;
}

const a = await arm(false);
const b = await arm(true);
console.log("A 臂(strict=false):", JSON.stringify(a));
console.log("B 臂(strict=true) :", JSON.stringify(b));

const pass = a.isMock === true && a.stoppedBy === "completed" && b.isMock === false && b.stoppedBy === "provider_error";
if (!pass) {
  console.error("FAIL: strict 机制对照未达预期");
  process.exitCode = 1;
} else {
  console.log("PASS: strict 关闭时静默降级 mock（bug 复现）；strict 开启时明确 provider_error（bug 已修复）");
}
