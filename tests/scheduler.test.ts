import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ScheduleStore,
  dispatchDue,
  type ScheduledJob,
  recordCompletion,
  reconcileRuns,
  recoverJob,
  updateJob,
} from "../src/store";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "modera-scheduler-test-"));
  directories.push(dir);
  const path = join(dir, "jobs.json");
  const store = new ScheduleStore(path);
  await store.initialize();
  const job: ScheduledJob = {
    id: "one",
    title: "Task",
    prompt: "Check",
    target: {
      projectId: "p",
      sessionId: "s",
      selection: {
        profileId: "profile",
        model: "model",
        reasoningEffort: "medium",
      },
    },
    nextAt: 1000,
    intervalMs: 60000,
    status: "active",
    history: [],
  };
  await store.update((jobs) => jobs.push(job));
  return { store, path };
}
test("claims a due task durably and never overlaps dispatches", async () => {
  const { store } = await setup();
  const start = vi.fn(async () => ({ runId: "run" }));
  const signal = new AbortController().signal;
  await Promise.all([
    dispatchDue(store, start, signal, 1000),
    dispatchDue(store, start, signal, 1000),
  ]);
  expect(start).toHaveBeenCalledTimes(1);
  expect((await store.list())[0]).toMatchObject({
    status: "running",
    runId: "run",
  });
  await dispatchDue(store, start, signal, 999999);
  expect(start).toHaveBeenCalledTimes(1);
});
test("records start, finish, duration and execution conversation", async () => {
  const { store } = await setup();
  await dispatchDue(store, async () => ({ runId: "timed-run" }), new AbortController().signal, 1000);
  await recordCompletion(store, { projectId: "p", sessionId: "s", runId: "timed-run", outcome: "completed" }, 4500);
  expect((await store.list())[0]!.history.at(-1)).toMatchObject({ startedAt: 1000, finishedAt: 4500, durationMs: 3500, sessionId: "s" });
});
test("restart pauses uncertain executions rather than replaying them", async () => {
  const { store, path } = await setup();
  await store.update((jobs) => {
    jobs[0]!.status = "dispatching";
  });
  const reopened = new ScheduleStore(path);
  await reopened.initialize();
  const start = vi.fn();
  await dispatchDue(reopened, start, new AbortController().signal, 5000);
  expect(start).not.toHaveBeenCalled();
  expect((await reopened.list())[0]!.status).toBe("paused");
});
test("failed dispatch is persisted and does not retry every tick", async () => {
  const { store } = await setup();
  const start = vi.fn().mockRejectedValue(new Error("Disabled"));
  const signal = new AbortController().signal;
  await dispatchDue(store, start, signal, 1000);
  await dispatchDue(store, start, signal, 2000);
  expect(start).toHaveBeenCalledTimes(1);
  expect((await store.list())[0]).toMatchObject({
    status: "error",
    error: "Error: Disabled",
  });
});
test("completion arriving before start returns is retained and replay is idempotent", async () => {
  const { store } = await setup();
  const signal = new AbortController().signal;
  await dispatchDue(
    store,
    async () => {
      await recordCompletion(
        store,
        {
          projectId: "p",
          sessionId: "s",
          runId: "fast-run",
          outcome: "completed",
        },
        1001,
      );
      return { runId: "fast-run" };
    },
    signal,
    1000,
  );
  const job = (await store.list())[0]!;
  expect(job).toMatchObject({ status: "active", nextAt: 61000 });
  expect(job.runId).toBeUndefined();
  expect(job.history.map((item) => item.outcome)).toEqual([
    "started",
    "completed",
  ]);
  await recordCompletion(
    store,
    { projectId: "p", sessionId: "s", runId: "fast-run", outcome: "completed" },
    1002,
  );
  expect((await store.list())[0]!.history).toEqual(job.history);
});
test("restart reconciles a verified terminal outcome without replaying the run", async () => {
  const { store, path } = await setup();
  const signal = new AbortController().signal;
  await dispatchDue(
    store,
    async () => ({ runId: "completed-run" }),
    signal,
    1000,
  );
  const restarted = new ScheduleStore(path);
  await restarted.initialize();
  await reconcileRuns(
    restarted,
    async () => ({ busy: false, outcome: "completed" }),
    signal,
  );
  const job = (await restarted.list())[0]!;
  expect(job.status).toBe("active");
  expect(job.nextAt).toBeGreaterThan(Date.now() - 10);
  expect(job.runId).toBeUndefined();
});
test("recovery rejects live runs and cross-project access, then acknowledges unknown outcome", async () => {
  const { store, path } = await setup();
  const signal = new AbortController().signal;
  await dispatchDue(
    store,
    async () => ({ runId: "unknown-run" }),
    signal,
    1000,
  );
  const restarted = new ScheduleStore(path);
  await restarted.initialize();
  await expect(updateJob(restarted, "resume", "one", "p")).rejects.toThrow();
  await expect(
    recoverJob(restarted, "one", "other", async () => ({
      busy: false,
      outcome: "unknown",
    })),
  ).rejects.toThrow();
  await expect(
    recoverJob(restarted, "one", "p", async () => ({
      busy: true,
      outcome: "running",
    })),
  ).rejects.toThrow("live run");
  await recoverJob(restarted, "one", "p", async () => ({
    busy: false,
    outcome: "unknown",
  }));
  expect((await restarted.list())[0]).toMatchObject({ status: "active" });
  expect((await restarted.list())[0]!.runId).toBeUndefined();
});
test("completion preserves a manual pause and records a failed one-shot accurately", async () => {
  const { store } = await setup();
  const signal = new AbortController().signal;
  await dispatchDue(store, async () => ({ runId: "paused-run" }), signal, 1000);
  await updateJob(store, "pause", "one", "p");
  await recordCompletion(
    store,
    {
      projectId: "p",
      sessionId: "s",
      runId: "paused-run",
      outcome: "completed",
    },
    1001,
  );
  expect((await store.list())[0]!.status).toBe("paused");
  await store.update((jobs) => {
    jobs[0]!.status = "active";
    jobs[0]!.nextAt = 1000;
    delete jobs[0]!.intervalMs;
  });
  await dispatchDue(store, async () => ({ runId: "failed-run" }), signal, 1000);
  await recordCompletion(store, {
    projectId: "p",
    sessionId: "s",
    runId: "failed-run",
    outcome: "failed",
  });
  expect((await store.list())[0]).toMatchObject({
    status: "error",
    error: "Run failed",
  });
});
