import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ScheduledRunTarget,
  PluginSchedulingApi,
  CompletedRunObservation,
} from "@modera/plugin-sdk";

export interface ScheduledJob {
  id: string;
  title: string;
  prompt: string;
  target: ScheduledRunTarget;
  nextAt: number;
  intervalMs?: number;
  status:
    "active" | "paused" | "dispatching" | "running" | "completed" | "error";
  runId?: string;
  error?: string;
  uncertain?: boolean;
  earlyCompletions?: { runId: string; outcome: string; at: number }[];
  history: { at: number; outcome: string; runId?: string }[];
}
export class ScheduleStore {
  private jobs: ScheduledJob[] = [];
  private queue = Promise.resolve();
  constructor(private readonly path: string) {}
  async initialize() {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      this.jobs = JSON.parse(await readFile(this.path, "utf8"));
      if (!Array.isArray(this.jobs))
        throw new Error("Invalid schedule storage");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.update((jobs) => {
      for (const job of jobs)
        if (["running", "dispatching"].includes(job.status)) {
          job.status = "paused";
          job.uncertain = true;
          job.error =
            "Previous execution outcome is uncertain; inspect the conversation before resuming";
        }
    });
  }
  async list() {
    await this.queue;
    return structuredClone(this.jobs);
  }
  update<T>(change: (jobs: ScheduledJob[]) => T): Promise<T> {
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.jobs);
      const result = change(next);
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next), "utf8");
      await rename(temporary, this.path);
      this.jobs = next;
      return result;
    });
    this.queue = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
}

export async function dispatchDue(
  store: ScheduleStore,
  start: (job: ScheduledJob) => Promise<{ runId: string }>,
  signal: AbortSignal,
  now = Date.now(),
) {
  for (const snapshot of await store.list()) {
    signal.throwIfAborted();
    if (snapshot.status !== "active" || snapshot.nextAt > now) continue;
    const job = await store.update((jobs) => {
      const item = jobs.find((job) => job.id === snapshot.id);
      if (!item || item.status !== "active" || item.nextAt > now) return;
      item.status = "dispatching";
      item.earlyCompletions = [];
      delete item.error;
      return structuredClone(item);
    });
    if (!job) continue;
    let dispatchedRunId: string | undefined;
    try {
      signal.throwIfAborted();
      const result = await start(job);
      dispatchedRunId = result.runId;
      await store.update((jobs) => {
        const item = jobs.find((item) => item.id === job.id);
        if (!item) return;
        item.runId = result.runId;
        item.status = "running";
        item.history = [
          ...item.history,
          { at: now, outcome: "started", runId: result.runId },
        ].slice(-30);
        const early = item.earlyCompletions?.find(
          (event) => event.runId === result.runId,
        );
        delete item.earlyCompletions;
        if (early) finishJob(item, early.outcome, early.at);
      });
    } catch (error) {
      await store.update((jobs) => {
        const item = jobs.find((item) => item.id === job.id);
        if (!item) return;
        item.status = "error";
        if (dispatchedRunId) {
          item.runId = dispatchedRunId;
          item.uncertain = true;
        }
        item.error = String(error);
        item.history = [
          ...item.history,
          { at: now, outcome: "dispatch failed" },
        ].slice(-30);
      });
    }
  }
}

function finishJob(job: ScheduledJob, outcome: string, now: number) {
  const keepPaused = job.status === "paused" && !job.uncertain;
  job.history = [...job.history, { at: now, outcome, runId: job.runId }].slice(
    -30,
  );
  delete job.runId;
  delete job.uncertain;
  delete job.earlyCompletions;
  delete job.error;
  if (job.intervalMs)
    job.nextAt +=
      (Math.floor(Math.max(0, now - job.nextAt) / job.intervalMs) + 1) *
      job.intervalMs;
  if (keepPaused) return;
  job.status = job.intervalMs
    ? "active"
    : outcome === "completed"
      ? "completed"
      : "error";
  if (job.status === "error") job.error = `Run ${outcome}`;
}

export async function recordCompletion(
  store: ScheduleStore,
  event: Pick<
    CompletedRunObservation,
    "projectId" | "sessionId" | "runId" | "outcome"
  >,
  now = Date.now(),
) {
  const matches = (job: ScheduledJob) =>
    job.target.projectId === event.projectId &&
    job.target.sessionId === event.sessionId;
  const snapshot = await store.list();
  if (
    !snapshot.some(
      (job) =>
        matches(job) &&
        (job.runId === event.runId || job.status === "dispatching"),
    )
  )
    return;
  await store.update((jobs) => {
    const job = jobs.find((job) => matches(job) && job.runId === event.runId);
    if (job) {
      finishJob(job, event.outcome ?? "completed", now);
      return;
    }
    const pending = jobs.find(
      (job) => matches(job) && job.status === "dispatching",
    );
    if (pending)
      pending.earlyCompletions = [
        ...(pending.earlyCompletions ?? []),
        { runId: event.runId, outcome: event.outcome ?? "completed", at: now },
      ].slice(-8);
  });
}

export async function reconcileRuns(
  store: ScheduleStore,
  inspect: PluginSchedulingApi["inspect"],
  signal: AbortSignal,
) {
  for (const snapshot of await store.list()) {
    if (!snapshot.runId) continue;
    signal.throwIfAborted();
    let state: Awaited<ReturnType<PluginSchedulingApi["inspect"]>>;
    try {
      state = await inspect(snapshot.target, snapshot.runId);
    } catch {
      continue; /* Disabled/deleted scope cannot authorize a retry. */
    }
    if (["completed", "failed", "cancelled"].includes(state.outcome)) {
      await store.update((jobs) => {
        const job = jobs.find(
          (job) => job.id === snapshot.id && job.runId === snapshot.runId,
        );
        if (job) finishJob(job, state.outcome, Date.now());
      });
    } else if (
      !state.busy &&
      state.outcome !== "running" &&
      !snapshot.uncertain
    ) {
      await store.update((jobs) => {
        const job = jobs.find(
          (job) => job.id === snapshot.id && job.runId === snapshot.runId,
        );
        if (job) {
          job.status = "paused";
          job.uncertain = true;
          job.error =
            "Previous run was interrupted or its outcome is unknown; review before recovering";
        }
      });
    }
  }
}

export async function recoverJob(
  store: ScheduleStore,
  id: string | undefined,
  projectId: string | undefined,
  inspect: PluginSchedulingApi["inspect"],
) {
  const before = (await store.list()).find(
    (job) => job.id === id && job.target.projectId === projectId,
  );
  if (!before || !before.uncertain)
    throw new Error("Task does not need recovery");
  const state = await inspect(before.target, before.runId);
  if (state.busy || state.outcome === "running")
    throw new Error(
      "Conversation still has a live run; recover after it finishes",
    );
  return store.update((jobs) => {
    const job = jobs.find(
      (job) => job.id === id && job.target.projectId === projectId,
    );
    if (
      !job ||
      job.runId !== before.runId ||
      job.status !== before.status ||
      !job.uncertain
    )
      throw new Error("Task changed during recovery; refresh");
    job.history = [
      ...job.history,
      { at: Date.now(), outcome: "Recovery acknowledged", runId: job.runId },
    ].slice(-30);
    delete job.runId;
    delete job.uncertain;
    delete job.error;
    delete job.earlyCompletions;
    job.status = "active";
    job.nextAt = Math.max(job.nextAt, Date.now());
    return { job };
  });
}

export function updateJob(
  store: ScheduleStore,
  action: string,
  id: string | undefined,
  projectId: string | undefined,
) {
  return store.update((jobs) => {
    const job = jobs.find(
      (job) => job.id === id && job.target.projectId === projectId,
    );
    if (!job) throw new Error("Scheduled task not found");
    if (job.status === "dispatching")
      throw new Error("Dispatch is in progress; retry shortly");
    if (action === "remove") {
      jobs.splice(jobs.indexOf(job), 1);
      return { removed: job.id };
    }
    if (action === "pause") {
      job.status = "paused";
      return { job };
    }
    if (action === "resume") {
      if (job.runId || job.uncertain)
        throw new Error(
          "Review the previous run before resuming; create a new task if its outcome is unknown",
        );
      job.status = "active";
      delete job.error;
      job.nextAt = Math.max(job.nextAt, Date.now());
      return { job };
    }
    throw new Error("Unknown schedule action");
  });
}
