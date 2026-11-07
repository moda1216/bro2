import { createAgentOS } from "../src/index.ts";

const os = createAgentOS({ autoApprove: true });
const s = os.createSession("standard");
console.log("tools:", os.registry.size, "presets:", os.presets.list().length, "skills:", os.skills.size);
const r = await os.run(s.id, "帮我计算 sum([1,2,3]) 并把结果写入 notes.md", {
  onChunk: () => undefined,
});
console.log("stoppedBy:", r.stoppedBy, "steps:", r.steps, "toolCalls:", r.toolCallCount);
console.log("answer:", r.answer.slice(0, 260));
console.log("trajectory events:", s.trajectory.events().length);
await os.shutdown();
