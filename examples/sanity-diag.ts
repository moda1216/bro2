import { loadTasks, sanity } from "./external-measure.ts";

const only = process.argv.slice(2);
const tasks = loadTasks().filter((t) => only.length === 0 || only.includes(t.id));
for (const t of tasks) {
  try {
    const r: any = sanity(t);
    console.log(`[${r.sound ? "SOUND" : "BAD"}] ${t.id} empty=${r.emptyWorkspace} oracle=${r.oracleSolution}`);
    if (!r.sound) console.log("    oracleOutput:", String(r.oracleOutput).replace(/\n/g, " | ").slice(0, 300));
  } catch (e) {
    console.log(`[ERR] ${t.id}: ${(e as Error).message.slice(0, 120)}`);
  }
}
