import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { declaredTools, type PluginModule } from "@modera/plugin-sdk";
import {
  ScheduleStore,
  dispatchDue,
  updateJob,
  recordCompletion,
  reconcileRuns,
  recoverJob,
} from "./store";
import { schedulerUi } from "./ui";
import manifest from "../plugin.json";
import { createSchedule } from "./editor";
import type { Recurrence } from "./recurrence";

export const activate: PluginModule["activate"] = async (host) => {
  if (!host.scheduling)
    throw new Error("Scheduling host capability unavailable");
  const store = new ScheduleStore(join(host.storagePath, "schedules.json"));
  await store.initialize();
  let busy = false;
  let lastSnapshot = JSON.stringify(await store.list());
  const timer = setInterval(() => {
    if (busy || host.signal.aborted) return;
    busy = true;
    void reconcileRuns(store, host.scheduling!.inspect, host.signal)
      .then(() =>
        dispatchDue(
          store,
          async (job) => {
            if (job.ownedConversation || !job.target.sessionId) {
              if (!host.scheduling!.prepare) throw new Error("Independent schedule execution unavailable");
              const target = await host.scheduling!.prepare(job.target, job.title, job.newConversationEachRun === true, { taskId: job.id, workbenchId: "modera.scheduler.workbench" });
              // Commit the exact target before starting, so early completion and recovery can find it.
              await store.update(jobs => { const current = jobs.find(item => item.id === job.id); if (!current || current.status !== "dispatching") throw new Error("Schedule changed before dispatch"); current.target = target; });
              job.target = target;
            }
            return host.scheduling!.start(
              job.target,
              job.prompt,
              host.scopeSignal?.(job.target.authorizationProjectId ?? job.target.projectId) ?? host.signal,
            );
          },
          host.signal,
        ),
      )
      .catch((error) => {
        if (!host.signal.aborted) console.error("Schedule dispatch:", error);
      })
      .finally(async () => {
        try {
          const next = JSON.stringify(await store.list());
          if (next !== lastSnapshot) { lastSnapshot = next; host.invalidateUi?.(); }
        } catch (error) {
          if (!host.signal.aborted) console.error("Schedule refresh:", error);
        } finally {
          busy = false;
        }
      });
  }, 1000);
  timer.unref();
  host.signal.addEventListener("abort", () => clearInterval(timer), {
    once: true,
  });
  return {
    ui: schedulerUi(store, (id, projectId) => recoverJob(store, id, projectId, host.scheduling!.inspect), host.scheduling),
    runCompleted: async (event) => {
      await recordCompletion(store, event);
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
          recurrence?: Recurrence;
        };
        context.signal.throwIfAborted();
        if (input.action === "recover")
          return recoverJob(
            store,
            input.id,
            context.projectId,
            host.scheduling!.inspect,
          );
        if (input.action === "list")
          return {
            jobs: (await store.list()).filter(
              (job) => job.target.projectId === context.projectId,
            ),
          };
        if (input.action === "create") {
          if (input.recurrence) {
            const captured = await host.scheduling!.capture(context);
            if (!host.scheduling!.target) throw new Error("Independent schedule execution unavailable");
            const target = await host.scheduling!.target(captured.projectId, "", captured.selection);
            return createSchedule(store, { title: input.title ?? "", prompt: input.prompt ?? "", recurrence: input.recurrence, ...(input.intervalSeconds !== undefined ? { intervalSeconds: input.intervalSeconds } : {}) }, target);
          }
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
          const captured = await host.scheduling!.capture(context);
          if (!host.scheduling!.target) throw new Error("Independent schedule execution unavailable");
          const target = await host.scheduling!.target(captured.projectId, "", captured.selection);
          const job = {
            id: randomUUID(),
            title: input.title,
            prompt: input.prompt,
            target,
            ownedConversation: true,
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
