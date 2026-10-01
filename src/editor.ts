import { randomUUID } from "node:crypto";
import type { ScheduledRunTarget } from "@modera/plugin-sdk";
import { ScheduleStore } from "./store";
import { nextOccurrence, validateRecurrence, type Recurrence } from "./recurrence";

export interface ScheduleInput { title: string; prompt: string; at?: string; immediate?: boolean; intervalSeconds?: number; recurrence?: Recurrence; newConversationEachRun?: boolean }
export function scheduleFields(input: ScheduleInput) {
  if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 200 || typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 100000) throw new Error("Task title and prompt are required");
  const recurrence = input.recurrence ? validateRecurrence(input.recurrence) : undefined;
  if (recurrence && input.intervalSeconds !== undefined) throw Error("Choose calendar or interval recurrence, not both");
  if (!recurrence && input.immediate !== true && (typeof input.at !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(input.at))) throw new Error("Use an ISO date with explicit timezone");
  const nextAt = input.immediate === true ? Date.now() : recurrence ? nextOccurrence(recurrence, Date.now()) ?? NaN : Date.parse(input.at!);
  if (input.immediate !== true && (!Number.isFinite(nextAt) || nextAt <= Date.now())) throw new Error("Schedule must be in the future");
  if (input.intervalSeconds !== undefined && (!Number.isInteger(input.intervalSeconds) || input.intervalSeconds < 60 || input.intervalSeconds > 31536000)) throw new Error("Recurrence must be 60–31536000 seconds");
  return { title: input.title.trim(), prompt: input.prompt.trim(), nextAt, recurrence, intervalMs: input.intervalSeconds ? input.intervalSeconds * 1000 : undefined };
}
export async function createSchedule(store: ScheduleStore, input: ScheduleInput, target: ScheduledRunTarget) {
  const fields = scheduleFields(input);
  const job = { ...fields, id: randomUUID(), target, ownedConversation: !target.sessionId, newConversationEachRun: input.newConversationEachRun === true, status: "active" as const, history: [] };
  await store.update(jobs => { if (jobs.length >= 200) throw new Error("Schedule limit reached"); jobs.push(job); });
  return { job };
}
export function editSchedule(store: ScheduleStore, id: string, projectId: string, input: ScheduleInput, target?: ScheduledRunTarget) {
  const fields = scheduleFields(input);
  return store.update(jobs => {
    const job = jobs.find(item => item.id === id && item.target.projectId === projectId);
    if (!job) throw new Error("Scheduled task not found");
    if (job.runId || job.uncertain || ["dispatching", "running"].includes(job.status)) throw new Error("Review or finish the current execution before editing");
    Object.assign(job, fields);
    job.newConversationEachRun = input.newConversationEachRun === true;
    if (target) {
      job.target = { ...target, sessionId: target.projectId === job.target.projectId && job.ownedConversation ? job.target.sessionId : "" };
      job.ownedConversation = true;
    }
    if (job.status !== "paused" || input.immediate === true) job.status = "active";
    delete job.error;
    return { job };
  });
}
