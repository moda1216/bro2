/**
 * L0 内核 · ★ Agent Loop 状态机 ★
 *
 * 一个 Step = 一次模型请求 + 它发起的若干工具调用；一个 Turn = 从任务到完成。
 * 每一步都经过 Hooks → Guards → Context/Budget → LLM → Permission/Approval
 * → ToolRuntime → 回喂，全部事件写入只增不改的 Trajectory。
 */
import { EventType, Role } from "./events.ts";
import type { Event, EventDraft, Message, ToolCall, ToolResult, Usage } from "./events.ts";
import { HookPoint, HookAction } from "./hooks.ts";
import type { HookManager } from "./hooks.ts";
import type { Runtime } from "./runtime.ts";
import type { Session } from "./session.ts";
import type { ToolRegistry, ToolContext } from "../tools/registry.ts";
import type { ToolRuntime } from "../tools/runtime.ts";
import type { PermissionPolicy } from "../governance/permissions.ts";
import { ApprovalDecision } from "../governance/approval.ts";
import type { ApprovalManager } from "../governance/approval.ts";
import { Guards, newGuardState } from "../governance/guards.ts";
import type { GuardState } from "../governance/guards.ts";
import type { PresetRegistry } from "../cognition/preset.ts";
import type { AgentPreset } from "../cognition/preset.ts";
import type { SkillRegistry } from "../cognition/skills.ts";
import type { PlanManager } from "../cognition/plan.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { ContextBuilder } from "../context/builder.ts";
import type { BudgetManager, CompactResult } from "../context/budget.ts";
import type { LLMProvider, StreamChunk } from "../models/base.ts";
import type { ToolSchema } from "../tools/schema.ts";
import type { BehaviorPolicy } from "../runtime/policy.ts";

export type StopReason =
  | "completed"
  | "guard"
  | "cancelled"
  | "error"
  | "hook_blocked"
  | "provider_error";

export interface LoopDeps {
  runtime: Runtime;
  hooks: HookManager;
  provider: LLMProvider;
  registry: ToolRegistry;
  toolRuntime: ToolRuntime;
  permissions: PermissionPolicy;
  approvals: ApprovalManager;
  guards: Guards;
  presets: PresetRegistry;
  skills: SkillRegistry;
  plans: PlanManager;
  memory: MemoryStore;
  contextBuilder: ContextBuilder;
  budget: BudgetManager;
  policy: BehaviorPolicy;
}

export interface RunOptions {
  session: Session;
  text: string;
  signal?: AbortSignal;
  onChunk?: (chunk: StreamChunk) => void;
  onEvent?: (event: Event) => void;
  presetName?: string;
  depth?: number;
  /** 额外上下文注入（子 Agent / Hook 使用）。 */
  extraInject?: string;
}

export interface RunResult {
  answer: string;
  steps: number;
  usage: Usage;
  stoppedBy: StopReason;
  reason: string;
  sessionId: string;
  toolCallCount: number;
  compactionCount: number;
}

const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

export class AgentLoop {
  private readonly deps: LoopDeps;

  constructor(deps: LoopDeps) {
    this.deps = deps;
  }

  private record(opts: RunOptions, draft: EventDraft): Event {
    const event = opts.session.trajectory.append(draft);
    void this.deps.runtime.publish(event);
    opts.onEvent?.(event);
    return event;
  }

  async run(opts: RunOptions): Promise<RunResult> {
    const { session } = opts;
    const depth = opts.depth ?? 0;
    const preset = this.deps.presets.resolve(opts.presetName ?? session.preset);
    const turn = session.meta.turns + 1;
    const state = newGuardState(turn);
    const { controller, cleanup } = this.deps.guards.controller(opts.signal);
    let steps = 0;
    let toolCallCount = 0;
    let compactionCount = 0;
    let answer = "";
    let stoppedBy: StopReason = "completed";
    let reason = "模型给出最终回答";
    let totalUsage: Usage = { ...EMPTY_USAGE };
    // 策略层状态：接地校验与软警告都通过"下一步注入"影响模型，而不是硬编码分支。
    let pendingInject = "";
    let hadToolCalls = false;
    let hadSuccess = false;
    let groundingRetries = 0;

    session.autoTitle(opts.text);
    session.touch("active", turn);
    this.record(opts, {
      sessionId: session.id, turn, step: 0, type: EventType.RunStart,
      payload: { task: opts.text.slice(0, 500), preset: preset.name, depth, model: this.deps.runtime.config.model.default },
    });
    this.record(opts, {
      sessionId: session.id, turn, step: 0, type: EventType.UserMessage,
      payload: { content: opts.text },
    });

    const preRun = await this.deps.hooks.fire({
      point: HookPoint.PreRun, sessionId: session.id, turn, step: 0,
      data: { task: opts.text, preset: preset.name },
      ...(controller.signal ? { signal: controller.signal } : {}),
    });
    if (preRun.blocked) {
      return this.finalize(opts, { answer: "任务被 Hook 阻断", steps, usage: totalUsage, stoppedBy: "hook_blocked", reason: String(preRun.data.reason ?? "无理由"), sessionId: session.id, toolCallCount, compactionCount }, turn, cleanup);
    }

    try {
      for (let step = 0; ; step += 1) {
        steps = step;

        // 1) Guards 硬检查
        const verdict = this.deps.guards.check(state, controller.signal);
        if (!verdict.ok) {
          stoppedBy = verdict.kind === "cancelled" ? "cancelled" : "guard";
          reason = verdict.reason;
          this.record(opts, {
            sessionId: session.id, turn, step, type: EventType.Guard,
            payload: { kind: verdict.kind, reason: verdict.reason },
          });
          answer = `任务终止：${verdict.reason}`;
          break;
        }

        // 2) PRE_STEP Hook（可阻断 / 可注入上下文）
        const preStep = await this.deps.hooks.fire({
          point: HookPoint.PreStep, sessionId: session.id, turn, step,
          data: { messagesCount: session.messages().length },
          ...(controller.signal ? { signal: controller.signal } : {}),
        });
        if (preStep.blocked) {
          stoppedBy = "hook_blocked";
          reason = `PRE_STEP 阻断: ${preStep.fired.map((f) => f.reason ?? "").filter(Boolean).join("; ")}`;
          answer = `任务被 Hook 阻断：${reason}`;
          break;
        }

        // 3) 上下文组装 + 预算压缩（每步从 Trajectory 重建，单一数据源）
        const allowed = preset.tools;
        const tools: ToolSchema[] = this.deps.registry.schemas(allowed);
        const injectForStep = pendingInject;
        pendingInject = "";
        const extra = [opts.extraInject, injectForStep, preStep.data.inject ? String(preStep.data.inject) : ""].filter(Boolean).join("\n");
        const built = this.deps.contextBuilder.build({
          preset,
          skills: this.deps.skills,
          memory: this.deps.memory,
          plans: this.deps.plans,
          session,
          toolNames: tools.map((t) => t.name),
          query: opts.text,
          permissionLevel: this.deps.permissions.currentLevel,
          workspace: this.deps.permissions.root,
          ...(extra ? { extraInject: extra } : {}),
          ...(depth ? { depth } : {}),
        });
        const compacted: CompactResult = this.deps.budget.compact(built.history, tools, built.system);
        if (compacted.compacted) {
          compactionCount += 1;
          this.record(opts, {
            sessionId: session.id, turn, step, type: EventType.Compaction,
            payload: {
              removed: compacted.removed,
              estimatedTokens: compacted.estimatedTokens,
              strategy: compacted.strategy,
              evidenceKept: compacted.evidenceKept,
            },
          });
        }
        const requestMessages: Message[] = [
          { role: Role.System, content: built.system },
          ...(compacted.summary ? [{ role: Role.System, content: compacted.summary } as Message] : []),
          ...compacted.messages,
        ];

        // 4) 模型请求（流式 + 可取消）
        let response;
        try {
          response = await this.deps.provider.complete({
            messages: requestMessages,
            tools,
            signal: controller.signal,
            onChunk: opts.onChunk,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          stoppedBy = controller.signal.aborted ? "cancelled" : "provider_error";
          reason = msg;
          this.record(opts, {
            sessionId: session.id, turn, step, type: EventType.Error,
            payload: { phase: "llm", error: msg },
          });
          await this.deps.hooks.fire({
            point: HookPoint.OnError, sessionId: session.id, turn, step,
            data: { phase: "llm", error: msg },
          });
          answer = `模型调用失败：${msg}`;
          break;
        }

        totalUsage = {
          inputTokens: totalUsage.inputTokens + response.usage.inputTokens,
          outputTokens: totalUsage.outputTokens + response.usage.outputTokens,
          totalTokens: totalUsage.totalTokens + response.usage.totalTokens,
        };
        this.deps.guards.addTokens(state, response.usage.totalTokens);
        this.record(opts, {
          sessionId: session.id, turn, step, type: EventType.AssistantMessage,
          payload: {
            content: response.content,
            ...(response.reasoning ? { reasoning: response.reasoning } : {}),
            ...(response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
            model: response.model,
            provider: response.provider,
          },
          usage: response.usage,
        });
        if (response.reasoning) {
          this.record(opts, {
            sessionId: session.id, turn, step, type: EventType.Thinking,
            payload: { content: response.reasoning.slice(0, 2000) },
          });
        }

        // 5) 无工具调用 → 终答（接地策略在此拦截臆造）
        if (response.toolCalls.length === 0) {
          const noEvidence = hadToolCalls && !hadSuccess;
          if (
            this.deps.policy.grounding === "require-evidence" &&
            noEvidence &&
            groundingRetries < 1
          ) {
            groundingRetries += 1;
            state.steps += 1; // 打回也算一步，防止不计步的空转
            this.record(opts, {
              sessionId: session.id, turn, step, type: EventType.GroundingReject,
              payload: {
                reason: "本轮工具调用全部失败且无成功证据，终答被打回一次",
                draft: response.content.slice(0, 300),
              },
            });
            pendingInject =
              "[接地校验] 你此前发起的工具调用全部失败，没有任何成功的工具结果可依据。" +
              "请明确说明失败原因，或改用可用工具取得证据后再回答；不要描述未发生的执行结果。";
            continue;
          }
          answer = response.content;
          break;
        }

        hadToolCalls = true;

        // 6) 死循环检测（advisory 策略：软警告 + 注入纠错提示，不直接终止）
        const loopVerdict = this.deps.guards.recordToolCalls(state, response.toolCalls);
        if (!loopVerdict.ok) {
          this.record(opts, {
            sessionId: session.id, turn, step, type: EventType.Guard,
            payload: { kind: "loop", reason: loopVerdict.reason },
          });
          stoppedBy = "guard";
          reason = loopVerdict.reason;
          answer = `任务终止：${loopVerdict.reason}。请调整指令后重试。`;
          break;
        }
        if (loopVerdict.advisory) {
          this.record(opts, {
            sessionId: session.id, turn, step, type: EventType.LoopAdvisory,
            payload: { reason: loopVerdict.reason },
          });
          pendingInject =
            "[死循环软警告] 你连续多次发起了完全相同的工具调用。" +
            "若这是有意的重复核对，请复用已得到的结果并直接给出结论；否则请更换参数或工具。";
        }

        this.record(opts, {
          sessionId: session.id, turn, step, type: EventType.ToolCall,
          payload: { calls: response.toolCalls },
        });

        // 7) 权限检查 + HITL 审批
        const permitted: ToolCall[] = [];
        for (const call of response.toolCalls) {
          const def = this.deps.registry.get(call.name);
          if (!def) {
            permitted.push(call); // 交给 ToolRuntime 回报"未知工具"
            continue;
          }
          const check = this.deps.permissions.check(def, call.arguments);
          if (check.decision === "deny") {
            this.recordToolResult(opts, turn, step, {
              callId: call.id, name: call.name, ok: false, elapsedMs: 0,
              error: `权限拒绝: ${check.reason}`,
            });
            continue;
          }
          if (check.decision === "ask") {
            const decision = await this.deps.approvals.request({
              sessionId: session.id, turn, step,
              toolName: call.name, arguments: call.arguments, reason: check.reason,
            });
            if (decision === ApprovalDecision.Deny) {
              this.recordToolResult(opts, turn, step, {
                callId: call.id, name: call.name, ok: false, elapsedMs: 0,
                error: `用户拒绝了此次调用: ${check.reason}`,
              });
              continue;
            }
          }
          permitted.push(call);
        }

        // 8) 工具执行（并发上限 + 超时 + 结果归一，结果由 ToolRuntime 记录）
        if (permitted.length > 0) {
          toolCallCount += permitted.length;
          const ctx: Omit<ToolContext, "callId"> = {
            runtime: this.deps.runtime,
            session,
            turn,
            step,
            ...(controller.signal ? { signal: controller.signal } : {}),
            ...(depth > 0 ? { nested: true } : {}),
          };
          const results = await this.deps.toolRuntime.executeBatch(
            permitted,
            ctx,
            this.deps.runtime.config.budget.maxConcurrentTools,
          );
          if (results.some((r) => r.ok)) hadSuccess = true;
          if (controller.signal.aborted) {
            stoppedBy = "cancelled";
            reason = "任务在工具执行阶段被取消";
            answer = reason;
            break;
          }
        }

        // 9) POST_STEP
        await this.deps.hooks.fire({
          point: HookPoint.PostStep, sessionId: session.id, turn, step,
          data: { toolCalls: response.toolCalls.length, tokens: totalUsage.totalTokens },
        });
        state.steps += 1;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stoppedBy = "error";
      reason = msg;
      answer = `执行异常：${msg}`;
      this.record(opts, {
        sessionId: session.id, turn, step: steps, type: EventType.Error,
        payload: { phase: "loop", error: msg },
      });
      await this.deps.hooks.fire({
        point: HookPoint.OnError, sessionId: session.id, turn, step: steps,
        data: { error: msg },
      });
    }

    this.record(opts, {
      sessionId: session.id, turn, step: steps, type: EventType.RunEnd,
      payload: { stoppedBy, reason, steps, toolCalls: toolCallCount },
      usage: totalUsage,
    });
    await this.deps.hooks.fire({
      point: HookPoint.PostRun, sessionId: session.id, turn, step: steps,
      data: { answer: answer.slice(0, 500), stoppedBy },
    });
    return this.finalize(
      opts,
      { answer, steps, usage: totalUsage, stoppedBy, reason, sessionId: session.id, toolCallCount, compactionCount },
      turn,
      cleanup,
    );
  }

  private recordToolResult(opts: RunOptions, turn: number, step: number, result: ToolResult): void {
    const event = this.record(opts, {
      sessionId: opts.session.id, turn, step, type: EventType.ToolResult,
      payload: { result },
    });
    void event;
  }

  private finalize(opts: RunOptions, result: RunResult, turn: number, cleanup: () => void): RunResult {
    cleanup();
    opts.session.touch(result.stoppedBy === "completed" ? "done" : "error", turn);
    return result;
  }
}

export { HookAction };
