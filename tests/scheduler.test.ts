import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleStore, dispatchDue, type ScheduledJob } from "../src/store";

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "modera-scheduler-test-")); directories.push(dir);
  const path = join(dir, "jobs.json"); const store = new ScheduleStore(path); await store.initialize();
  const job: ScheduledJob = { id: "one", title: "Task", prompt: "Check", target: { projectId: "p", sessionId: "s", selection: { profileId: "profile", model: "model", reasoningEffort: "medium" } }, nextAt: 1000, intervalMs: 60000, status: "active", history: [] };
  await store.update((jobs) => jobs.push(job)); return { store, path };
}
test("claims a due task durably and never overlaps dispatches", async () => {
  const { store } = await setup(); const start = vi.fn(async () => ({ runId: "run" })); const signal = new AbortController().signal;
  await Promise.all([dispatchDue(store, start, signal, 1000), dispatchDue(store, start, signal, 1000)]);
  expect(start).toHaveBeenCalledTimes(1);
  expect((await store.list())[0]).toMatchObject({ status: "running", runId: "run" });
  await dispatchDue(store, start, signal, 999999); expect(start).toHaveBeenCalledTimes(1);
});
test("restart pauses uncertain executions rather than replaying them", async () => {
  const { store, path } = await setup(); await store.update((jobs) => { jobs[0]!.status = "dispatching"; });
  const reopened = new ScheduleStore(path); await reopened.initialize();
  const start = vi.fn(); await dispatchDue(reopened, start, new AbortController().signal, 5000);
  expect(start).not.toHaveBeenCalled(); expect((await reopened.list())[0]!.status).toBe("paused");
});
test("failed dispatch is persisted and does not retry every tick", async () => {
  const { store } = await setup(); const start = vi.fn().mockRejectedValue(new Error("Disabled")); const signal = new AbortController().signal;
  await dispatchDue(store, start, signal, 1000); await dispatchDue(store, start, signal, 2000);
  expect(start).toHaveBeenCalledTimes(1); expect((await store.list())[0]).toMatchObject({ status: "error", error: "Error: Disabled" });
});
