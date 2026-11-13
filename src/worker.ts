import { getBoss, processJob, queueName } from "./server/jobs";
import { listUserIds, readState } from "./server/store";

let stopped = false;
process.once("SIGINT", () => { stopped = true; });
process.once("SIGTERM", () => { stopped = true; });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const boss = await getBoss().catch(error => { console.error("queue_start_failed", error instanceof Error ? error.message : "unknown"); return null; });
if (boss) await boss.work<{ userId: string; jobId: string }>(queueName, async jobs => {
  for (const job of jobs) await processJob(job.data.userId, job.data.jobId);
});
console.log(`Grammar Loop worker ready (${boss ? "pg-boss + recovery" : "durable polling"})`);
while (!stopped) {
  try {
    const users = await listUserIds();
    const tasks = [];
    for (const userId of users) {
      const state = await readState(userId);
      for (const job of state.jobs) {
        if ((job.status === "queued" && Number(job.payload?.retryAt || 0) <= Date.now()) || (job.status === "processing" && Date.now() - Date.parse(job.updatedAt) > 300000)) tasks.push({ userId, jobId: job.id });
      }
    }
    for (let index = 0; index < tasks.length && !stopped; index += 2) await Promise.all(tasks.slice(index, index + 2).map(task => processJob(task.userId, task.jobId)));
  } catch (error) { console.error("worker_tick_failed", error instanceof Error ? error.message : "unknown"); }
  await pause(1000);
}
if (boss) await boss.stop();
