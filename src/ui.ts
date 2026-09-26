import type { PluginUiContribution, PluginUiNode } from "@modera/plugin-sdk";
import { type ScheduleStore, updateJob } from "./store";

export function schedulerUi(store: ScheduleStore): PluginUiContribution[] {
  return [
    {
      id: "modera.scheduler.panel",
      slot: "panel",
      launcher: {
        title: "定时任务 / Scheduled tasks",
        description: "查看计划、执行记录，暂停或恢复任务",
        icon: "box",
      },
      requiredPermissions: ["storage.read", "storage.write", "runs.schedule"],
      actions: ["refresh", "pause", "resume", "remove"],
      async act(action, context) {
        if (action.id !== "refresh")
          await updateJob(store, action.id, action.value, context.projectId);
      },
      async render(request, context) {
        const zh = request.locale.startsWith("zh");
        const jobs = (await store.list()).filter(
          (job) => job.target.projectId === context.projectId,
        );
        const labels: Record<string, string> = {
          active: "等待执行",
          paused: "已暂停",
          dispatching: "正在启动",
          running: "执行中",
          completed: "已完成",
          error: "启动失败",
        };
        const children: PluginUiNode[] = [
          {
            type: "text",
            text: zh
              ? "在对话中描述任务和时间即可创建计划。Modera 打开时执行，错过的周期合并为一次。"
              : "Create schedules in chat. Tasks run while Modera is open; missed occurrences are coalesced.",
          },
          { type: "button", label: zh ? "刷新" : "Refresh", action: "refresh" },
        ];
        for (const job of jobs.slice(0, 20)) {
          children.push({
            type: "document",
            label: job.title,
            text: job.prompt.slice(0, 16000),
            meta: `${zh ? labels[job.status] : job.status} · ${new Date(job.nextAt).toLocaleString(request.locale)}${job.intervalMs ? ` · ${job.intervalMs / 1000}s` : ""}`,
          });
          if (job.error)
            children.push({
              type: "document",
              label: zh ? "需要处理" : "Needs attention",
              text: job.error.slice(0, 4000),
            });
          children.push({
            type: "conversation-link",
            label: zh ? "查看执行对话" : "Open conversation",
            sessionId: job.target.sessionId,
          });
          if (job.history.length)
            children.push({
              type: "table",
              columns: zh ? ["时间", "结果"] : ["Time", "Outcome"],
              rows: job.history
                .slice(-5)
                .reverse()
                .map((record) => [
                  new Date(record.at).toLocaleString(request.locale),
                  record.outcome.slice(0, 2000),
                ]),
            });
          if (job.status !== "dispatching") {
            const actions: PluginUiNode[] = [];
            if (["active", "running"].includes(job.status))
              actions.push({
                type: "button",
                action: "pause",
                value: job.id,
                label: zh ? "暂停后续执行" : "Pause future runs",
              });
            else if (!job.runId)
              actions.push({
                type: "button",
                action: "resume",
                value: job.id,
                label: zh ? "恢复" : "Resume",
              });
            actions.push({
              type: "button",
              action: "remove",
              value: job.id,
              label: zh ? "移除计划" : "Remove schedule",
              quiet: true,
            });
            children.push({ type: "row", children: actions });
          }
        }
        if (!jobs.length)
          children.push({
            type: "text",
            text: zh ? "暂无定时任务" : "No scheduled tasks",
          });
        if (jobs.length > 20)
          children.push({
            type: "text",
            text: zh
              ? "仅显示前 20 项，可在对话中查看全部任务。"
              : "Showing 20 tasks; ask in chat for all tasks.",
          });
        return {
          title: zh ? "定时任务" : "Scheduled tasks",
          scroll: true,
          live: true,
          children,
        };
      },
    },
  ];
}
