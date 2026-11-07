/**
 * L4 认知层 · Preset / Agent Manifest（声明式组装）
 *
 * 一个 Agent = 一份 Preset：系统提示、可见工具、技能、模型、权限、预算、子智能体。
 * 会话一旦有内容即锁定 Preset，否则历史里的工具调用无法解释。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PermissionLevel } from "../governance/permissions.ts";

export interface AgentPreset {
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
  tools: string[];
  skills?: string[];
  permissionLevel: PermissionLevel;
  maxSteps?: number;
  maxTokens?: number;
  allowSubAgents?: boolean;
}

export const BUILTIN_PRESETS: readonly AgentPreset[] = [
  {
    name: "standard",
    description: "默认通用助手：全量工具 + 规划 + 技能 + 子 Agent",
    systemPrompt:
      "你是 bro2，一个运行在通用 Agent 运行时上的通用 Agent。先理解任务，必要时用 todo_write 拆解计划，再调用工具逐步执行，最后基于真实工具结果给出结论。不要臆造未执行的结果。可用工具以系统提供的 schema 为准。",
    tools: ["*"],
    permissionLevel: "workspace-write",
    allowSubAgents: true,
    maxSteps: 30,
  },
  {
    name: "minimal",
    description: "极简模式：仅 Shell 与文件读写，低 token、适合基准与教学",
    systemPrompt: "你是极简 Agent。只使用提供的少量工具，直接执行并给出简短结论，不做规划、不加载技能。",
    tools: ["shell", "file_read", "file_write", "file_list", "calc"],
    permissionLevel: "workspace-write",
    allowSubAgents: false,
    maxSteps: 12,
  },
  {
    name: "researcher",
    description: "研究助手：搜索/HTTP/文件优先，可并行派生子 Agent",
    systemPrompt:
      "你是研究助手。优先检索与核对信息，结论需标注来源；复杂问题可派生子 Agent 并行处理多个子问题，再汇总。",
    tools: ["*"],
    permissionLevel: "read-only",
    allowSubAgents: true,
    maxSteps: 40,
  },
  {
    name: "creator",
    description: "创造模式：标准能力 + 运行时自省与插件热插拔",
    systemPrompt:
      "你是创造模式 Agent。除完成任务外，可以检查运行时状态、安装/卸载插件、查看工具与轨迹，并据此扩展自身能力。",
    tools: ["*"],
    permissionLevel: "danger-full-access",
    allowSubAgents: true,
    maxSteps: 40,
  },
];

export class PresetRegistry {
  private readonly presets = new Map<string, AgentPreset>();

  constructor(dir?: string) {
    for (const p of BUILTIN_PRESETS) this.presets.set(p.name, { ...p, tools: [...p.tools] });
    if (dir && existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const p = JSON.parse(readFileSync(join(dir, f), "utf8")) as AgentPreset;
          if (p.name && p.systemPrompt && Array.isArray(p.tools)) this.presets.set(p.name, p);
        } catch {
          // 忽略损坏的预设文件
        }
      }
    }
  }

  get(name: string): AgentPreset | undefined {
    const p = this.presets.get(name);
    return p ? { ...p, tools: [...p.tools] } : undefined;
  }

  resolve(name: string): AgentPreset {
    return this.get(name) ?? this.get("standard")!;
  }

  list(): Array<{ name: string; description: string; tools: string[]; permissionLevel: PermissionLevel }> {
    return [...this.presets.values()].map((p) => ({
      name: p.name,
      description: p.description,
      tools: p.tools,
      permissionLevel: p.permissionLevel,
    }));
  }

  register(preset: AgentPreset): () => void {
    this.presets.set(preset.name, preset);
    return () => this.presets.delete(preset.name);
  }
}
