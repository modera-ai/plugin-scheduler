import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSchedule, editSchedule, scheduleFields } from "../src/editor";
import { ScheduleStore, updateJob } from "../src/store";
import { schedulerUi } from "../src/ui";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const target = { projectId: "p", sessionId: "s", selection: { profileId: "profile", model: "model", reasoningEffort: "minimal" as const } };
const input = () => ({ title: "Daily review", prompt: "Summarize progress", at: new Date(Date.now() + 3600000).toISOString(), intervalSeconds: 3600 });
async function setup() { const directory = await mkdtemp(join(tmpdir(), "scheduler-editor-")); dirs.push(directory); const store = new ScheduleStore(join(directory, "jobs.json")); await store.initialize(); return store; }

test("editor validates future time, title and recurring bounds", () => {
  expect(scheduleFields(input()).intervalMs).toBe(3600000);
  for (const invalid of [{ ...input(), at: "yesterday" }, { ...input(), at: new Date(0).toISOString() }, { ...input(), title: " " }, { ...input(), intervalSeconds: 1 }]) expect(() => scheduleFields(invalid)).toThrow();
});
test("immediate creation is due now and manual execution rejects live or uncertain tasks", async () => {
  const store = await setup();
  const before = Date.now();
  const { job } = await createSchedule(store, { title: "Now", prompt: "Run now", immediate: true, intervalSeconds: 60 }, target);
  expect(job.nextAt).toBeGreaterThanOrEqual(before);
  expect(job.nextAt).toBeLessThanOrEqual(Date.now());
  expect(job.intervalMs).toBe(60000);
  await store.update(jobs => { jobs[0]!.status = "completed"; jobs[0]!.nextAt = Date.now() + 3600000; });
  await updateJob(store, "runNow", job.id, "p");
  expect((await store.list())[0]).toMatchObject({ status: "active" });
  expect((await store.list())[0]!.nextAt).toBeLessThanOrEqual(Date.now());
  await store.update(jobs => { jobs[0]!.uncertain = true; });
  await expect(updateJob(store, "runNow", job.id, "p")).rejects.toThrow();
  await store.update(jobs => { delete jobs[0]!.uncertain; jobs[0]!.runId = "live"; });
  await expect(updateJob(store, "runNow", job.id, "p")).rejects.toThrow();
});
test("editing cannot cross projects or change a running/uncertain task", async () => {
  const store = await setup();
  const { job } = await createSchedule(store, input(), target);
  await expect(editSchedule(store, job.id, "other", input())).rejects.toThrow();
  await store.update(jobs => { jobs[0]!.status = "paused"; });
  await editSchedule(store, job.id, "p", { ...input(), title: "Changed" });
  expect((await store.list())[0]).toMatchObject({ title: "Changed", status: "paused" });
  await store.update(jobs => { jobs[0]!.uncertain = true; });
  await expect(editSchedule(store, job.id, "p", input())).rejects.toThrow();
});
test("workbench owns new conversations and shows tasks across project scopes", async () => {
  const store = await setup();
  const capture = vi.fn(async () => ({ ...target, sessionId: "" }));
  const ui = schedulerUi(store, vi.fn(), { target: capture, options: async () => ({ conversations: [{ id: "s", title: "Source" }], models: [] }) } as never)[0]!;
  expect(ui.slot).toBe("workbench"); expect(ui.workbench?.icon).toBe("clock"); expect(ui.launcher).toBeUndefined();
  const context = { projectId: "p", sessionId: "", runId: "ui", signal: new AbortController().signal };
  await ui.act!({ id: "create", value: JSON.stringify({ ...input(), selection: target.selection, newConversationEachRun: true }) }, context, { id: ui.id, sessionId: "", locale: "zh-CN" });
  expect(capture).toHaveBeenCalledWith("independent", "", target.selection, "p");
  expect((await store.list())[0]).toMatchObject({ ownedConversation: true, newConversationEachRun: true, target: { sessionId: "" } });
  const view = await ui.render({ id: ui.id, sessionId: "", locale: "zh-CN" }, context);
  expect((view.data as { jobs: unknown[] }).jobs).toHaveLength(1);
  const other = await ui.render({ id: ui.id, sessionId: "", locale: "en" }, { ...context, projectId: "other" });
  expect((other.data as { jobs: unknown[] }).jobs).toHaveLength(1);
});
