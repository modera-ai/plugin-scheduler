import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { declaredTools, type PluginModule } from "@modera/plugin-sdk";
import { ScheduleStore, dispatchDue, updateJob } from "./store";
import { schedulerUi } from "./ui";
import manifest from "../plugin.json";

export const activate: PluginModule["activate"] = async (host) => {
  if (!host.scheduling)
    throw new Error("Scheduling host capability unavailable");
  const store = new ScheduleStore(join(host.storagePath, "schedules.json"));
  await store.initialize();
  let busy = false;
  const timer = setInterval(() => {
    if (busy || host.signal.aborted) return;
    busy = true;
    void dispatchDue(
      store,
      (job) =>
        host.scheduling!.start(
          job.target,
          job.prompt,
          host.scopeSignal?.(job.target.projectId) ?? host.signal,
        ),
      host.signal,
    )
      .catch((error) => {
        if (!host.signal.aborted) console.error("Schedule dispatch:", error);
      })
      .finally(() => {
        busy = false;
        host.invalidateUi?.();
      });
  }, 1000);
  timer.unref();
  host.signal.addEventListener("abort", () => clearInterval(timer), {
    once: true,
  });
  return {
    ui: schedulerUi(store),
    runCompleted: async (event) => {
      await store.update((jobs) => {
        const job = jobs.find(
          (item) =>
            item.runId === event.runId &&
            item.target.projectId === event.projectId &&
            item.target.sessionId === event.sessionId,
        );
        if (!job) return;
        const now = Date.now();
        job.history = [
          ...job.history,
          {
            at: now,
            outcome: String(event.outcome ?? "completed"),
            runId: event.runId,
          },
        ].slice(-30);
        delete job.runId;
        if (job.status === "paused") return;
        if (job.intervalMs) {
          job.nextAt +=
            (Math.floor(Math.max(0, now - job.nextAt) / job.intervalMs) + 1) *
            job.intervalMs;
          job.status = "active";
        } else job.status = "completed";
      });
      host.invalidateUi?.();
    },
    sessionDeleted: async (event) => {
      await store.update((jobs) => {
        for (let i = jobs.length - 1; i >= 0; i--)
          if (
            jobs[i]!.target.sessionId === event.sessionId &&
            jobs[i]!.target.projectId === event.projectId
          )
            jobs.splice(i, 1);
      });
    },
    tools: declaredTools(manifest).map((definition) => ({
      definition,
      async execute(raw, context) {
        const input = raw as {
          action: string;
          id?: string;
          title?: string;
          prompt?: string;
          at?: string;
          intervalSeconds?: number;
        };
        context.signal.throwIfAborted();
        if (input.action === "list")
          return {
            jobs: (await store.list()).filter(
              (job) => job.target.projectId === context.projectId,
            ),
          };
        if (input.action === "create") {
          if (
            !input.title?.trim() ||
            input.title.length > 200 ||
            !input.prompt?.trim() ||
            input.prompt.length > 100000
          )
            throw new Error("Task title and prompt are required");
          if (
            typeof input.at !== "string" ||
            !/(?:Z|[+-]\d{2}:\d{2})$/.test(input.at)
          )
            throw new Error("Use an ISO date with explicit timezone");
          const nextAt = Date.parse(input.at);
          if (!Number.isFinite(nextAt) || nextAt <= Date.now())
            throw new Error("Schedule must be in the future");
          if (
            input.intervalSeconds !== undefined &&
            (!Number.isInteger(input.intervalSeconds) ||
              input.intervalSeconds < 60 ||
              input.intervalSeconds > 31536000)
          )
            throw new Error("Recurrence must be 60–31536000 seconds");
          const target = await host.scheduling!.capture(context);
          const job = {
            id: randomUUID(),
            title: input.title,
            prompt: input.prompt,
            target,
            nextAt,
            intervalMs: input.intervalSeconds
              ? input.intervalSeconds * 1000
              : undefined,
            status: "active" as const,
            history: [],
          };
          await store.update((jobs) => {
            if (jobs.length >= 200) throw new Error("Schedule limit reached");
            jobs.push(job);
          });
          return { job };
        }
        return updateJob(store, input.action, input.id, context.projectId);
      },
    })),
  };
};
