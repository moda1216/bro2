/**
 * W1 · 分层任务装载器
 *
 * 单一事实源原则：l1 直接读既有 `data/eval-tasks.jsonl`，**不复制**成 v2 文件。
 * 旧文件经 `upgradeLegacy()` 就地升格，因此「迁移」零成本、零漂移；
 * l2 才是 v2 原生格式的新任务集。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { EvalTask } from "../observability/eval.ts";
import { toEvalTask, upgradeLegacy, validateTaskV2, type TaskLayer, type TaskV2 } from "./schema.ts";

/** 层 → 任务文件（相对项目根）。 */
export const LAYER_FILES: Record<TaskLayer, string> = {
  l1: "data/eval-tasks.jsonl",        // 旧集：单一事实源
  l2: "data/tasks/v2/l2.jsonl",       // 真实工程任务（W1-03 填充）
  l3: "data/tasks/v2/l3.jsonl",       // 长程任务（预留）
};

export const FIXTURE_ROOT = "data/fixtures/repos";

export interface LoadedLayer {
  layer: TaskLayer;
  /** 绝对路径；文件不存在时为空字符串 */
  source: string;
  exists: boolean;
  v2: TaskV2[];
  tasks: EvalTask[];
  /** 结构 / 引用类问题，非空即视为装载失败 */
  problems: string[];
  /** 任务集内容指纹（sha256 前 12 位），用于与报告里的 taskSetHash 对照 */
  hash: string;
}

function readJsonl(path: string, problems: string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((line, i) => {
    const s = line.trim();
    if (!s || s.startsWith("//") || s.startsWith("#")) return;
    try {
      const obj = JSON.parse(s);
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        problems.push(`第 ${i + 1} 行: 不是 JSON 对象`);
        return;
      }
      out.push(obj as Record<string, unknown>);
    } catch (e) {
      problems.push(`第 ${i + 1} 行: JSON 解析失败 (${(e as Error).message})`);
    }
  });
  return out;
}

/** 装载单层：解析 → 升格 → 校验 → 去重 → fixture 引用检查。 */
export function loadLayer(root: string, layer: TaskLayer): LoadedLayer {
  const rel = LAYER_FILES[layer];
  const source = join(resolve(root), rel);
  const problems: string[] = [];
  const exists = existsSync(source);
  if (!exists) return { layer, source: "", exists, v2: [], tasks: [], problems, hash: "" };

  const raw = readJsonl(source, problems);
  const v2: TaskV2[] = [];
  const seen = new Map<string, number>();

  raw.forEach((r, idx) => {
    const t = upgradeLegacy(r, layer);
    problems.push(...validateTaskV2(t));
    if (t.layer !== layer) problems.push(`id=${t.id}: layer 声明 "${t.layer}" 与所在层 "${layer}" 不符`);
    const prev = seen.get(t.id);
    if (prev !== undefined) problems.push(`id=${t.id}: 与第 ${prev + 1} 条重复`);
    else seen.set(t.id, idx);
    if (t.repo) {
      const dir = isAbsolute(t.repo) ? t.repo : join(resolve(root), FIXTURE_ROOT, t.repo);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        problems.push(`id=${t.id}: fixture 仓库不存在 ${join(FIXTURE_ROOT, t.repo)}`);
      }
    }
    v2.push(t);
  });

  // 压平转换在这里发生：执行层永远只看到 EvalTask。
  const tasks = v2.map(toEvalTask);
  // 指纹必须与 runEval 同口径（sha1(JSON.stringify(tasks))），否则「指纹一致」毫无意义。
  // 复用同一算法才能证明 v2 装载器交给评测器的是同一份任务，而不是另一份改写版。
  const hash = createHash("sha1").update(JSON.stringify(tasks)).digest("hex").slice(0, 12);
  return { layer, source, exists, v2, tasks, problems, hash };
}

/** 跨层装载：返回合并后的 EvalTask 列表与逐层明细；层内问题会带上层名前缀。 */
export function loadLayers(root: string, layers: readonly TaskLayer[]): {
  layers: LoadedLayer[];
  tasks: EvalTask[];
  problems: string[];
} {
  const loaded = layers.map((l) => loadLayer(root, l));
  const problems = loaded.flatMap((l) => l.problems.map((p) => `[${l.layer}] ${p}`));
  const ids = new Map<string, TaskLayer>();
  for (const l of loaded) {
    for (const t of l.v2) {
      const dup = ids.get(t.id);
      if (dup) problems.push(`跨层重复 id=${t.id}: ${dup} 与 ${l.layer}`);
      else ids.set(t.id, l.layer);
    }
  }
  return { layers: loaded, tasks: loaded.flatMap((l) => l.tasks), problems };
}
