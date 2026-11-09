/**
 * v2.12.0 · 跨会话端点经验接线的确定性闭环门禁（第 20 道）
 *
 * 缺口：`KeylessAggregator` 健康态是进程内内存态、重启清零；ExperienceBank 的
 * endpoint 域经验「只写不读」。本门禁证明「越用越稳」的闭环真的接上了：
 *
 *  1) 经验折叠：历史多次失败的端点 → 负先验；多次成功 → 正先验；rate=0.5 → 0。
 *  2) 冷启动注入：新聚合器（模拟新进程）加载历史经验后，历史失败端点
 *     **不再被首选**（同优先级下让位给历史健康端点），无需重新全网探测。
 *  3) 幅度封顶：先验 ±2 不足以压过冷却(-4)/限流(-8)硬过滤——被冷却的
 *     端点即便有正先验也不会复活；经验只影响排序，不绕过故障转移。
 *  4) 回写闭环：聚合器每次 complete 的成败经 onEndpointOutcome 写回账本，
 *     新 ExperienceBank 实例可读到 → 跨会话累积成立。
 *  5) 失效回退：invalidate 后先验归零，回退完整探测（绝不硬信经验）。
 *  6) 冷启动保护：样本 < minSamples 的端点给 0 分，不贸然压分。
 *
 * 全程离线、无网络、无凭据；只写临时目录，不污染仓库账本、不携带本机状态。
 * 断言不成立即非零退出。诚实边界：这是结构闭环证据，不是能力分数，
 * 不改变 leadership.verdict。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExperienceBank, endpointSignature } from "../src/rsi/experience.ts";
import { endpointPriorFromExperience } from "../src/models/route-experience.ts";
import { KeylessAggregator, type KeylessBackend } from "../src/models/keyless.ts";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/models/base.ts";

const dir = mkdtempSync(join(tmpdir(), "bro2-endpoint-exp-"));
const bankPath = join(dir, "experience.jsonl");
const line = (s = ""): void => { process.stdout.write(s + "\n"); };
const hr = (s: string): void => line(`\n─── ${s} ${"─".repeat(Math.max(0, 56 - s.length))}`);
const checks: Array<[string, boolean]> = [];
const check = (label: string, ok: boolean): void => { checks.push([label, ok]); line(`  ${ok ? "✓" : "✗"} ${label}`); };

/** 可控假上游：记录被选中次数；failTimes>0 时前 N 次抛错。 */
class Fake implements LLMProvider {
  name: string;
  calls = 0;
  failTimes: number;
  rateLimit = false;
  constructor(name: string, failTimes = 0, rateLimit = false) {
    this.name = name; this.failTimes = failTimes; this.rateLimit = rateLimit;
  }
  async complete(_req: LLMRequest): Promise<LLMResponse> {
    this.calls += 1;
    if (this.failTimes > 0) {
      this.failTimes -= 1;
      throw new Error(this.rateLimit ? "HTTP 429: FreeUsageLimitError" : "HTTP 500: upstream");
    }
    return {
      content: "ok", toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      model: "fake", durationMs: 1, provider: this.name,
    };
  }
}
const req = { messages: [{ role: "user", content: "hi" }] } as LLMRequest;
const be = (p: LLMProvider): KeylessBackend => ({ provider: p, priority: 0 });

/** 往账本写 n 次某端点的成败（只增事件）。 */
const seed = (bank: ExperienceBank, name: string, ok: boolean, n: number): void => {
  for (let i = 0; i < n; i += 1) {
    bank.observeOutcome("endpoint", endpointSignature(name), name, ok ? "success" : "failure", {
      applicableTo: [`上游 ${name}`], source: "endpoint-experience-check.seed",
    });
  }
};
/**
 * 冷启动：从账本折叠先验、构造一个新聚合器（模拟新进程）。
 * writePath 显式传入才带回写钩子——步骤 2/3 只验证排序/过滤，不写账本（避免污染折叠断言）；
 * 步骤 4 用独立账本专门验证回写闭环，关注点分离。
 */
const freshMesh = (
  entries: ReturnType<ExperienceBank["fold"]>,
  a: Fake, b: Fake, writePath?: string,
) => new KeylessAggregator({
  name: "mesh",
  backends: [be(a), be(b)],
  endpointPrior: endpointPriorFromExperience(entries),
  ...(writePath
    ? { onEndpointOutcome: (endpoint: string, ok: boolean) => seed(new ExperienceBank(writePath), endpoint, ok, 1) }
    : {}),
  rateLimitCooldownMs: 60_000,
});

try {
  const bank = new ExperienceBank(bankPath);
  // 历史：dead 端点 4 次全失败、live 端点 4 次全成功、mid 端点 2 次各半、cold 端点仅 1 次失败。
  seed(bank, "dead", false, 4);
  seed(bank, "live", true, 4);
  seed(bank, "mid", true, 2);
  seed(bank, "mid", false, 2);
  seed(bank, "cold", false, 1);

  // ─────────────────────────────── 1) 经验折叠
  hr("1｜经验折叠（跨会话，只增账本 → 先验分）");
  const prior = endpointPriorFromExperience(bank.fold());
  line(`  dead=${prior.dead}  live=${prior.live}  mid=${prior.mid}  cold=${prior.cold}`);
  check("历史失败端点得负先验", prior.dead === -2);
  check("历史健康端点得正先验", prior.live === 2);
  check("rate=0.5 端点先验为 0", prior.mid === 0);
  check("样本不足端点冷启动保护（0 分）", prior.cold === 0);

  // ─────────────────────────────── 2) 冷启动注入：历史失败端点不再被首选
  hr("2｜冷启动注入：同优先级下历史失败端点让位");
  const a = new Fake("dead");
  const b = new Fake("live");
  const mesh = freshMesh(bank.fold(), a, b);
  const r = await mesh.complete(req);
  line(`  首次请求 → ${r.provider}（dead.calls=${a.calls}, live.calls=${b.calls}）`);
  check("历史失败端点 dead 未被首选", a.calls === 0);
  check("历史健康端点 live 被首选", b.calls === 1);
  const ms = mesh.meshStats();
  const deadPrior = ms.backends.find((x) => x.name === "dead")!.endpointPrior;
  const livePrior = ms.backends.find((x) => x.name === "live")!.endpointPrior;
  check("meshStats 露出跨会话先验（可复核）", deadPrior === -2 && livePrior === 2);

  // ─────────────────────────────── 3) 幅度封顶：先验不压过硬过滤
  hr("3｜先验只影响排序，不绕过限流/冷却硬过滤");
  // 让 live 端点先触发一次 429 进入冷却；随后 dead 虽有历史负先验、live 有正先验，
  // 但 live 已被限流冷却 → 必须从 available 中排除，回退到 dead（完整探测）。
  const c = new Fake("dead");
  const d = new Fake("live", 1, true); // 首次调用抛 429
  const mesh2 = freshMesh(bank.fold(), c, d);
  await mesh2.complete(req); // 首次选 live(+2) → 429 冷却 → 故障转移到 dead
  const beforeCooldown = d.calls;
  const r2 = await mesh2.complete(req); // 第二次：live 仍限流冷却，应跳过
  line(`  第二次请求 → ${r2.provider}（live 冷却中被跳过：calls 保持 ${d.calls}=${beforeCooldown}）`);
  check("限流冷却中的端点即便有正先验也不复活", d.calls === beforeCooldown);
  check("故障转移到历史失败端点（完整探测）", c.calls >= 1);

  // ─────────────────────────────── 4) 回写闭环：成败写回账本，新实例可读
  hr("4｜回写闭环：聚合器成败 → 账本 → 新实例可读");
  // 用独立账本，避免与步骤 1/5 的折叠断言互相污染（关注点分离）。
  const writePath = join(dir, "writes.jsonl");
  const eventsBefore = new ExperienceBank(writePath).events().length;
  const e = new Fake("dead");
  const f = new Fake("live");
  const mesh3 = freshMesh(bank.fold(), e, f, writePath);
  await mesh3.complete(req); // live 成功 → 回写一条 endpoint/live 成败
  const eventsAfter = new ExperienceBank(writePath).events().length;
  line(`  账本事件：${eventsBefore} → ${eventsAfter}（+${eventsAfter - eventsBefore} 条，由 onEndpointOutcome 回写）`);
  check("complete 成败回写账本（跨会话可累积）", eventsAfter === eventsBefore + 1);
  const folded = new ExperienceBank(writePath).fold();
  check("新 ExperienceBank 实例读到回写结果（重启不清零）", folded.some((x) => x.domain === "endpoint"));

  // ─────────────────────────────── 5) 失效回退完整探测
  hr("5｜失效回退：invalidate 后先验归零");
  bank.invalidate("endpoint", endpointSignature("dead"), "dead", "端点体检口径变化：OOD 退化");
  const afterInvalidate = endpointPriorFromExperience(new ExperienceBank(bankPath).fold());
  line(`  dead 先验：${prior.dead} → ${afterInvalidate.dead}（经验失效）`);
  check("失效经验归零（回退完整探测，不硬信经验）", afterInvalidate.dead === 0);
  check("未失效经验仍生效（选择性失效）", afterInvalidate.live === 2);

  // ─────────────────────────────── 结论
  hr("结论与诚实边界");
  line("  ✓ 越用越稳：进程内健康态重启清零的缺口，由跨会话只增经验层补上。");
  line("  · 边界：这是结构闭环证据（离线确定性），不是能力分数；leadership.verdict 仍为 not-proven。");
  line("  · 边界：经验只影响 score() 排序先验，绝不绕过冷却/限流/能力过滤与故障转移；失效/样本不足自动回退。");
  line("  · 边界：运行时接线为 opt-in（useEndpointExperience），账本是运行时快照，不进 CI 断言、不制造假 diff。\n");

  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length > 0) {
    line(`  ✗ 门禁失败：${failed.map(([l]) => l).join(" / ")}`);
    process.exitCode = 1;
  } else {
    line(`  ✓ 端点经验门禁：${checks.length}/${checks.length} 项断言通过`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
