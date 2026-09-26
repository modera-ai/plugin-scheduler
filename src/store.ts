import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ScheduledRunTarget } from "@modera/plugin-sdk";

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
      delete item.error;
      return structuredClone(item);
    });
    if (!job) continue;
    try {
      signal.throwIfAborted();
      const result = await start(job);
      await store.update((jobs) => {
        const item = jobs.find((item) => item.id === job.id);
        if (!item) return;
        item.runId = result.runId;
        item.status = "running";
        item.history = [
          ...item.history,
          { at: now, outcome: "started", runId: result.runId },
        ].slice(-30);
      });
    } catch (error) {
      await store.update((jobs) => {
        const item = jobs.find((item) => item.id === job.id);
        if (!item) return;
        item.status = "error";
        item.error = String(error);
        item.history = [
          ...item.history,
          { at: now, outcome: "dispatch failed" },
        ].slice(-30);
      });
    }
  }
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
      if (job.runId)
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
