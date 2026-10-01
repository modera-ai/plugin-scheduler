import type { PluginUiContribution, PluginSchedulingApi, ScheduledRunTarget } from "@modera/plugin-sdk";
import { type ScheduleStore, updateJob } from "./store";
import { createSchedule, editSchedule, type ScheduleInput } from "./editor";

export function schedulerUi(store: ScheduleStore, recover: (id: string | undefined, projectId: string | undefined) => Promise<unknown>, scheduling?: PluginSchedulingApi): PluginUiContribution[] {
  return [{
    id: "modera.scheduler.workbench", slot: "workbench", frontend: "workbench",
    workbench: { title: "Scheduled tasks", icon: "clock", order: -100, locales: { "zh-CN": { title: "定时任务" } } },
    requiredPermissions: ["storage.read", "storage.write", "runs.schedule"],
    actions: ["refresh", "pause", "resume", "runNow", "remove", "recover", "create", "edit"],
    async act(action, context) {
      if (action.id === "refresh") return;
      if (!context.projectId) throw new Error("Project required");
      const existing = (await store.list()).find(job => job.id === (action.id === "edit" ? JSON.parse(action.value ?? "{}").id : action.value));
      const scope = existing?.target.projectId ?? context.projectId;
      // Stopping/removing a plan must remain possible after its execution grant is revoked.
      if (existing && ["resume", "recover", "runNow"].includes(action.id) && scheduling?.options) await scheduling.options(existing.target.authorizationProjectId ?? scope);
      if (action.id === "recover") { await recover(action.value, scope); return; }
      if (action.id === "create" || action.id === "edit") {
        const input = JSON.parse(action.value ?? "{}") as ScheduleInput & { id: string; projectId?: string; selection: ScheduledRunTarget["selection"] };
        if (!scheduling?.target) throw new Error("Schedule editor unavailable");
        const target = await scheduling.target(input.projectId || "independent", "", input.selection, existing?.target.authorizationProjectId ?? context.projectId);
        if (action.id === "edit") { await editSchedule(store, input.id, scope, input, target); return; }
        await createSchedule(store, input, target);
        return;
      }
      await updateJob(store, action.id, action.value, scope);
    },
    async render(request, context) {
      const jobs = await store.list();
      const options = scheduling?.options && context.projectId ? await scheduling.options(context.projectId) : { conversations: [], models: [] };
      return { title: request.locale.startsWith("zh") ? "定时任务" : "Scheduled tasks", data: { jobs, ...options, selectedJobId: request.resource, canCreate: !!scheduling?.target }, children: [] };
    },
  }];
}
