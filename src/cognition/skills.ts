/**
 * L4 认知层 · Skills 渐进披露
 *
 * 系统提示里只注入 name + description（摘要）；模型判断需要时调用 skill_load
 * 才把 SKILL.md 全文注入上下文，避免脚手架 token 膨胀。
 */
import { existsSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";

export interface SkillMeta {
  name: string;
  description: string;
  path: string;
  tags: string[];
  loaded: boolean;
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  tags?: string[];
}

function parseFrontmatter(text: string): { meta: SkillFrontmatter; body: string } {
  if (!text.startsWith("---")) return { meta: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: text };
  const head = text.slice(3, end).trim();
  const body = text.slice(end + 4).trim();
  const meta: SkillFrontmatter = {};
  for (const line of head.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k === "name") meta.name = v;
    else if (k === "description") meta.description = v;
    else if (k === "tags") meta.tags = v.split(/[,，\s]+/).filter(Boolean);
  }
  return { meta, body };
}

export class SkillRegistry {
  private readonly dirs: string[];
  private readonly skills = new Map<string, SkillMeta>();
  private readonly bodies = new Map<string, string>();

  constructor(dirs: string[]) {
    this.dirs = dirs;
    for (const d of dirs) mkdirSync(d, { recursive: true });
    this.scan();
  }

  scan(): SkillMeta[] {
    this.skills.clear();
    this.bodies.clear();
    for (const dir of this.dirs) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        const p = join(dir, f, "SKILL.md");
        if (!existsSync(p)) continue;
        try {
          const text = readFileSync(p, "utf8");
          const { meta, body } = parseFrontmatter(text);
          const name = meta.name ?? basename(f);
          this.skills.set(name, {
            name,
            description: meta.description ?? "（无描述）",
            path: p,
            tags: meta.tags ?? [],
            loaded: false,
          });
          this.bodies.set(name, body);
        } catch {
          // 单个技能损坏不影响整体
        }
      }
    }
    return this.list();
  }

  list(): SkillMeta[] {
    return [...this.skills.values()].map((s) => ({ ...s }));
  }

  /** 只注入摘要，控制脚手架 token。 */
  summaries(): string {
    const all = this.list();
    if (all.length === 0) return "";
    return [
      "可用技能（需要时调用 skill_load 加载全文，不要预先假设内容）：",
      ...all.map((s) => `- ${s.name}: ${s.description}`),
    ].join("\n");
  }

  load(name: string): string | undefined {
    const s = this.skills.get(name);
    const body = this.bodies.get(name);
    if (!s || body === undefined) return undefined;
    s.loaded = true;
    return `# 技能: ${s.name}\n\n${body}`;
  }

  get(name: string): SkillMeta | undefined {
    const s = this.skills.get(name);
    return s ? { ...s } : undefined;
  }

  get size(): number {
    return this.skills.size;
  }
}
