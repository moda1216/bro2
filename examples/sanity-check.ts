import { loadTasks, sanity } from "./external-measure.ts";

const tasks = loadTasks();
console.log(`Sanity check on ${tasks.length} tasks (empty ws must fail, oracle must pass):`);
let allSound = true;
for (const t of tasks) {
  try {
    const r: any = sanity(t);
    const ok = r.sound;
    if (!ok) allSound = false;
    console.log(`  ${ok ? "✓" : "✗"} ${t.id.padEnd(34)} empty=${r.emptyWorkspace} oracle=${r.oracleSolution} vSha=${r.verifierSha256.slice(0,8)}`);
  } catch (e) {
    allSound = false;
    console.log(`  ✗ ${t.id.padEnd(34)} ERROR ${(e as Error).message}`);
    console.log((e as Error).stack?.split("\n").slice(0, 4).join("\n"));
  }
}
console.log(allSound ? "\nALL SOUND" : "\nSOME FAILED");
process.exit(allSound ? 0 : 1);
