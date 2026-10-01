import { useEffect, useMemo, useState, useRef, type CSSProperties } from "react";
import { mountPlugin, frontend, usePluginSnapshot } from "@modera/plugin-sdk/react";
import { Button, Dialog, Input, Tooltip, UiProvider, Combobox, Tabs, TabsList, TabsTrigger, TabsContent, Menu } from "@modera/ui";
import { Clock, Plus, RefreshCw, Search, Repeat, Play, Pause, CheckCircle2, AlertCircle, Trash2, Pencil, MessageSquare, X, ChevronDown } from "lucide-react";
import type { ScheduledJob } from "../src/store";
import type { Recurrence } from "../src/recurrence";
import "@modera/ui/styles.css";
import "./style.css";

type Data = { jobs: ScheduledJob[]; projects?: { id: string; name: string }[]; conversations: { id: string; title: string }[]; models: { profileId: string; name: string; models: string[]; efforts?: Record<string, ScheduledJob["target"]["selection"]["reasoningEffort"][]> }[]; canCreate: boolean; selectedJobId?: string };
const localTime = (time: number) => { const date = new Date(time - new Date(time).getTimezoneOffset() * 60000); return date.toISOString().slice(0, 16); };
const editable = (job: ScheduledJob) => !job.runId && !job.uncertain && !["running", "dispatching"].includes(job.status);

function Scheduler() {
  const { snapshot, error: loadError } = usePluginSnapshot();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false), working = useRef(false);
  const [filter, setFilter] = useState("all"), [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [editor, setEditor] = useState<ScheduledJob | "new" | null>(null), [remove, setRemove] = useState<ScheduledJob | null>(null);
  const zh = !snapshot?.locale.startsWith("en"), t = (cn: string, en: string) => zh ? cn : en;
  const rawData = snapshot?.view.data as Data | undefined;
  const data = rawData && { ...rawData, ...(rawData.projects ? { projects: rawData.projects.map(project => ({ ...project, name: zh && project.id === "default" && project.name === "Default" ? "默认项目" : project.name })) } : {}) };
  const jobs = data?.jobs ?? [];
  useEffect(() => { if (data?.selectedJobId) { setSelected(data.selectedJobId); setFilter("all"); setProjectFilter("all"); setQuery(""); } }, [data?.selectedJobId]);
  const detail = jobs.find(job => job.id === selected);
  const labels: Record<string, string> = { active: t("等待执行", "Scheduled"), paused: t("已暂停", "Paused"), dispatching: t("正在启动", "Starting"), running: t("执行中", "Running"), completed: t("已完成", "Completed"), error: t("需处理", "Needs attention") };
  const status = (job: ScheduledJob) => job.uncertain ? "error" : job.status;
  const date = (time: number) => new Date(time).toLocaleString(snapshot?.locale ?? "zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const cadence = (job: ScheduledJob) => job.recurrence ? `${({ daily: t("每天", "Daily"), weekdays: t("工作日", "Weekdays"), weekly: t("每周", "Weekly"), custom: t("自定义", "Custom") })[job.recurrence.kind]} · ${job.recurrence.time}` : !job.intervalMs ? t("单次任务", "One-time") : job.intervalMs % 3600000 === 0 ? t(`每 ${job.intervalMs / 3600000} 小时`, `Every ${job.intervalMs / 3600000} hours`) : t(`每 ${job.intervalMs / 60000} 分钟`, `Every ${job.intervalMs / 60000} minutes`);
  const filtered = useMemo(() => jobs.filter(job => (projectFilter === "all" || job.target.projectId === projectFilter) && (filter === "all" || (filter === "running" ? ["running", "dispatching"].includes(status(job)) : status(job) === filter)) && `${job.title} ${job.prompt}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => a.nextAt - b.nextAt), [data, filter, query, projectFilter]);
  useEffect(() => { void frontend().ready(); }, []);
  async function act(id: string, value?: string) {
    if (working.current) return false;
    working.current = true; setBusy(true); setError("");
    try { await frontend().action(id, value); return true; }
    catch (cause) { setError(String(cause)); return false; }
    finally { working.current = false; setBusy(false); }
  }
  const style = Object.fromEntries(Object.entries(snapshot?.theme?.colors ?? {}).filter(([, value]) => value !== undefined).map(([key, value]) => [`--mu-${key}`, value])) as CSSProperties;
  const summaryTabs = [["all", t("全部", "All")], ["active", t("待执行", "Scheduled")], ["running", t("执行中", "Running")], ["paused", t("暂停", "Paused")], ["error", t("需处理", "Attention")], ["completed", t("已完成", "Completed")]];
  return <UiProvider theme={snapshot?.theme?.mode ?? "light"} accent={snapshot?.theme?.accent ?? "#e17856"} locale={zh ? "zh-CN" : "en"} style={style} className="scheduler-scope">
    <main className="scheduler-page">
      <div className="scheduler-fixed"><header className="scheduler-header"><div className="scheduler-heading"><span className="scheduler-mark"><Clock size={23} /></span><div><h1>{t("定时任务", "Scheduled tasks")}</h1><p>{t("统一管理项目任务与独立任务", "Manage project and independent tasks")}</p></div></div><div className="scheduler-header-actions"><Tooltip content={t("刷新", "Refresh")}><Button size="icon" variant="quiet" aria-label={t("刷新", "Refresh")} disabled={busy} onClick={() => void act("refresh")}><RefreshCw size={18} /></Button></Tooltip><Button variant="primary" onClick={() => { setError(""); setEditor("new"); }}><Plus size={17} />{t("新建任务", "New task")}</Button></div></header>
      <Combobox size="small" className="scheduler-scope-filter" label={t("归属项目", "Project")} value={projectFilter} onValueChange={setProjectFilter} options={[{ value: "all", label: t("全部项目", "All projects") }, { value: "independent", label: t("未归属项目", "No project") }, ...(data?.projects ?? []).map(item => ({ value: item.id, label: item.name }))]} />
      <Tabs size="small" value={filter} onValueChange={setFilter} variant="segment" className="scheduler-task-tabs"><div className="scheduler-toolbar"><TabsList aria-label={t("任务状态", "Task status")}>{summaryTabs.map(([key, label]) => <TabsTrigger key={key} value={key!} count={key === "all" ? jobs.length : jobs.filter(job => key === "running" ? ["running", "dispatching"].includes(status(job)) : status(job) === key).length}>{label}</TabsTrigger>)}</TabsList><Input label={t("搜索任务", "Search tasks")} hideLabel value={query} onChange={setQuery} placeholder={t("搜索名称或任务内容", "Search title or prompt")} leftIcon={<Search size={15} />} /></div>
      {(error || loadError) && <div className="scheduler-error" role="alert"><AlertCircle size={17} />{error || loadError}</div>}
      <TabsContent value={filter}><div className={`scheduler-body${detail ? " has-detail" : ""}`}>
        <section className="scheduler-cards" aria-label={t("任务列表", "Task list")}>
          {!data ? <p role="status">{t("正在加载…", "Loading…")}</p> : !filtered.length ? <div className="scheduler-empty"><Clock size={40} strokeWidth={1.3} /><h2>{jobs.length ? t("没有匹配的任务", "No matching tasks") : t("把重复的事情交给定时任务", "Let schedules handle recurring work")}</h2><p>{jobs.length ? t("试试其他状态或搜索词。", "Try another status or search.") : t("创建单次或周期计划，也可以直接在对话中描述任务和时间。", "Create a one-time or repeating plan, or describe the task and timing in chat.")}</p>{!jobs.length && <Button variant="outline" onClick={() => setEditor("new")}><Plus size={16} />{t("创建第一个任务", "Create your first task")}</Button>}</div> : filtered.map(job => <article key={job.id} className={`scheduler-card${selected === job.id ? " selected" : ""}`}>
            <button type="button" className="scheduler-card-main" aria-label={t(`查看任务：${job.title}`, `View task: ${job.title}`)} onClick={() => setSelected(job.id)}><div className="scheduler-card-top"><h2>{job.title}</h2><span className={`scheduler-status ${status(job)}`}>{labels[status(job)]}</span></div><p>{job.prompt}</p><div className="scheduler-card-time"><Clock size={14} /><span>{["completed", "error"].includes(status(job)) ? t("计划时间", "Scheduled") : ["running", "dispatching"].includes(job.status) ? t("本次执行", "Current run") : job.status === "paused" ? t("暂停前计划", "Paused schedule") : t("下次执行", "Next run")} · {date(job.nextAt)}</span></div><small>{cadence(job)}</small></button>
          </article>)}
        </section>
        {detail && <ScheduleDetails key={detail.id} job={detail} projects={data?.projects ?? []} zh={zh} locale={snapshot?.locale ?? "zh-CN"} busy={busy} status={status(detail)} label={labels[status(detail)]!} date={date} cadence={cadence} act={act} close={() => setSelected(null)} edit={() => { setError(""); setEditor(detail); }} remove={() => setRemove(detail)} onError={setError} />}
      </div>
    </TabsContent></Tabs></div></main>
    {editor && <ScheduleEditor key={editor === "new" ? "new" : editor.id} job={editor === "new" ? undefined : editor} data={data} zh={zh} busy={busy} error={error} close={() => setEditor(null)} save={async value => { if (await act(editor === "new" ? "create" : "edit", JSON.stringify(value))) setEditor(null); }} />}
    <Dialog open={!!remove} onOpenChange={open => { if (!open) setRemove(null); }} title={t("移除定时任务", "Remove scheduled task")} description={t("仅移除计划，不删除执行对话，也不会中止正在运行的任务。", "Removes the plan only; keeps the conversation and does not cancel an active run.")} footer={<><Button variant="quiet" onClick={() => setRemove(null)}>{t("取消", "Cancel")}</Button><Button variant="primary" disabled={busy} onClick={() => { if (remove) void act("remove", remove.id).then(ok => { if (ok) { setRemove(null); setSelected(null); } }); }}>{t("确认移除", "Remove")}</Button></>}><p>{remove?.title}</p>{error && <p role="alert">{error}</p>}</Dialog>
  </UiProvider>;
}


function ScheduleDetails({ job, projects, zh, locale, busy, status, label, date, cadence, act, close, edit, remove, onError }: {
  job: ScheduledJob; projects: { id: string; name: string }[]; zh: boolean; locale: string; busy: boolean; status: string; label: string;
  date(time: number): string; cadence(job: ScheduledJob): string; act(id: string, value?: string): Promise<boolean>; close(): void; edit(): void; remove(): void; onError(message: string): void;
}) {
  const t = (cn: string, en: string) => zh ? cn : en;
  const [allHistory, setAllHistory] = useState(false);
  const [detailTab, setDetailTab] = useState("info");
  const records = [...job.history].filter(record => record.outcome !== "started" || !job.history.some(item => item.runId === record.runId && item.outcome !== "started")).reverse();
  const effort = zh ? ({ none: "无", minimal: "最小", low: "低", medium: "中", high: "高", xhigh: "极高" } as Record<string, string>)[job.target.selection.reasoningEffort] ?? job.target.selection.reasoningEffort : job.target.selection.reasoningEffort;
  const openConversation = (id: string) => { void frontend().openConversation(id).catch(cause => onError(String(cause))); };
  return <section className="scheduler-detail" aria-label={t("任务详情", "Task details")}>
    <header><h2>{job.title}</h2><span className={`scheduler-status ${status}`}>{label}</span><Tooltip content={t("关闭详情", "Close details")}><Button variant="quiet" size="icon" aria-label={t("关闭详情", "Close details")} onClick={close}><X size={16} /></Button></Tooltip></header>
    <div className="scheduler-plan"><small>{(job.status === "completed" && !job.intervalMs && !job.recurrence) || job.status === "error" ? t("计划时间", "Scheduled time") : job.status === "paused" ? t("计划已暂停", "Schedule paused") : ["running", "dispatching"].includes(job.status) ? t("本次执行", "Current run") : t("下次执行", "Next run")}</small><strong>{date(job.nextAt)}</strong><span><Repeat size={13} />{cadence(job)}</span></div>
    <div className="scheduler-detail-actions">
      {editable(job) && <Button size="small" variant="primary" disabled={busy} onClick={() => void act("runNow", job.id)}><Play size={13} />{t("立即执行", "Run now")}</Button>}
      {["active", "running"].includes(job.status) && !job.uncertain && <Button size="small" variant="outline" disabled={busy} onClick={() => void act("pause", job.id)}><Pause size={13} />{t("暂停计划", "Pause schedule")}</Button>}
      {job.status === "paused" && editable(job) && <Button size="small" variant="outline" disabled={busy} onClick={() => void act("resume", job.id)}><Play size={13} />{t("恢复计划", "Resume schedule")}</Button>}
      <Menu label={t("任务管理", "Task management")} items={[{ label: t("编辑任务", "Edit task"), icon: Pencil, disabled: busy || !editable(job), onSelect: edit }, { label: t("移除任务", "Remove task"), icon: Trash2, danger: true, separatorBefore: true, disabled: busy || job.status === "dispatching", onSelect: remove }]}>{null}</Menu>
    </div>
    {job.error && <div className="scheduler-error"><AlertCircle size={15} />{job.error}</div>}
    {job.uncertain && <Button size="small" variant="outline" disabled={busy} onClick={() => void act("recover", job.id)}>{t("已核对结果，恢复计划", "Reviewed outcome — recover")}</Button>}
    <Tabs size="small" value={detailTab} onValueChange={setDetailTab} variant="underline" className="scheduler-detail-tabs">
      <TabsList aria-label={t("任务详情分类", "Task detail sections")}>
        <TabsTrigger value="info">{t("任务信息", "Task information")}</TabsTrigger>
        <TabsTrigger value="settings">{t("执行配置", "Execution settings")}</TabsTrigger>
        <TabsTrigger value="history" count={records.length}>{t("执行记录", "Run history")}</TabsTrigger>
      </TabsList>
      <TabsContent value="info">    <section className="scheduler-detail-section"><h3>{t("任务内容", "Prompt")}</h3>{job.prompt.length > 220 ? <details className="scheduler-prompt-disclosure"><summary>{job.prompt.slice(0, 100)}… <span>{t("展开全文", "Read more")}</span></summary><p className="scheduler-prompt">{job.prompt}</p></details> : <p className="scheduler-prompt">{job.prompt}</p>}</section>
</TabsContent>
      <TabsContent value="settings">    <section className="scheduler-detail-section"><h3>{t("执行配置", "Execution settings")}</h3><dl>
      <dt>{t("归属项目", "Project")}</dt><dd>{job.target.projectId === "independent" ? t("不在项目中工作", "Work without a project") : projects.find(item => item.id === job.target.projectId)?.name ?? t("项目不可用", "Project unavailable")}</dd>
      <dt>{t("模型", "Model")}</dt><dd>{job.target.selection.model}<span className="scheduler-effort">{t("思考", "Reasoning")} · {effort}</span></dd>
      <dt>{t("对话方式", "Conversation")}</dt><dd>{job.newConversationEachRun ? t("每次新建对话", "New conversation each run") : t("复用任务对话", "Reuse task conversation")}</dd>
    </dl></section>
</TabsContent>
      <TabsContent value="history">    <section className="scheduler-detail-section"><h3>{t("执行记录", "Run history")}<small>{records.length}</small></h3>
      {!records.length ? <p className="scheduler-muted">{t("尚未执行", "No runs yet")}</p> : <ol className="scheduler-history">
        {(allHistory ? records : records.slice(0, 3)).map((record, index) => {
          const failed = ["failed", "dispatch failed", "interrupted"].includes(record.outcome), Icon = failed ? AlertCircle : record.outcome === "completed" ? CheckCircle2 : Clock;
          const outcome = ({ started: t("执行中", "Running"), completed: t("已完成", "Completed"), failed: t("执行失败", "Failed"), "dispatch failed": t("启动失败", "Dispatch failed"), cancelled: t("已取消", "Cancelled"), interrupted: t("已中断", "Interrupted") } as Record<string, string>)[record.outcome] ?? record.outcome;
          return <li key={record.runId ?? `${record.at}-${index}`} className={failed ? "is-failed" : record.outcome === "completed" ? "is-completed" : ""}><details><summary><Icon size={14} /><span className="scheduler-history-state"><strong>{outcome}</strong>{record.sessionId && <Tooltip content={t("打开执行对话", "Open run conversation")}><button type="button" className="scheduler-history-chat" aria-label={t("打开执行对话", "Open run conversation")} onClick={event => { event.preventDefault(); event.stopPropagation(); openConversation(record.sessionId!); }}><MessageSquare size={13} /></button></Tooltip>}</span><time>{date(record.startedAt ?? record.at)}</time><ChevronDown size={12} className="scheduler-history-chevron" /><small>{record.durationMs !== undefined ? `${t("耗时", "Duration")} ${(record.durationMs / 1000).toFixed(1)}${t("秒", "s")}` : t("详情", "Details")}</small></summary><div className="scheduler-history-detail">
            <time>{record.startedAt !== undefined || record.outcome === "started" ? t("开始", "Started") : t("记录时间", "Recorded")} · {new Date(record.startedAt ?? record.at).toLocaleString(locale, { hour12: false })}</time>
            {record.finishedAt !== undefined && <time>{t("结束", "Finished")} · {new Date(record.finishedAt).toLocaleString(locale, { hour12: false })}</time>}
          </div></details></li>;
        })}
      </ol>}
      {records.length > 3 && <button type="button" className="scheduler-history-more" onClick={() => setAllHistory(!allHistory)}>{allHistory ? t("收起记录", "Show less") : t(`查看全部 ${records.length} 次执行`, `View all ${records.length} runs`)}</button>}
    </section></TabsContent>
    </Tabs>
  </section>;
}

function ScheduleEditor({ job, data, zh, busy, error, close, save }: { job?: ScheduledJob; data?: Data; zh: boolean; busy: boolean; error: string; close(): void; save(value: unknown): Promise<void> }) {
  const t = (cn: string, en: string) => zh ? cn : en;
  const [title, setTitle] = useState(job?.title ?? ""), [prompt, setPrompt] = useState(job?.prompt ?? ""), [at, setAt] = useState(localTime(Math.max(job?.nextAt ?? 0, Date.now() + 3600000)));
  const [immediate, setImmediate] = useState(false);
  const [repeatMode, setRepeatMode] = useState(job?.recurrence?.kind ?? (job?.intervalMs ? "interval" : "once"));
  const [minutes, setMinutes] = useState(String((job?.intervalMs ?? 3600000) / 60000));
  const [time, setTime] = useState(job?.recurrence?.time ?? at.slice(11, 16));
  const [days, setDays] = useState<number[]>(job?.recurrence?.days ?? [new Date().getDay()]);
  const [every, setEvery] = useState(String(job?.recurrence?.interval ?? 1));
  const [unit, setUnit] = useState<"day" | "week" | "month">(job?.recurrence?.unit ?? "week");
  const [advanced, setAdvanced] = useState(!!job?.recurrence?.rrule);
  const [rrule, setRrule] = useState(job?.recurrence?.rrule ?? "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0");
  const timezone = job?.recurrence?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const calendar = !["once", "interval"].includes(repeatMode);
  const [projectId, setProjectId] = useState(job?.target.projectId ?? "independent"), [modelIndex, setModelIndex] = useState("0"), [validation, setValidation] = useState("");
  const [newConversationEachRun, setNewConversationEachRun] = useState(job?.newConversationEachRun ?? false);
  const [reasoningEffort, setReasoningEffort] = useState(job?.target.selection.reasoningEffort ?? "medium");
  const choices = (data?.models ?? []).flatMap(profile => profile.models.map(model => ({ profileId: profile.profileId, model, name: `${profile.name} · ${model}` })));
  const choice = choices[Number(modelIndex)];
  const efforts = data?.models.find(item => item.profileId === choice?.profileId)?.efforts?.[choice?.model ?? ""] ?? ["minimal", "low", "medium", "high"];
  useEffect(() => { if (!efforts.includes(reasoningEffort)) setReasoningEffort(efforts[0] ?? "none"); }, [data, modelIndex, reasoningEffort]);
  useEffect(() => { if (job) { const index = choices.findIndex(item => item.profileId === job.target.selection.profileId && item.model === job.target.selection.model); if (index >= 0) setModelIndex(String(index)); } }, [job?.id]);
  const canSave = title.trim() && prompt.trim() && (immediate || at) && data?.canCreate && choices.length;
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }} title={job ? t("编辑任务", "Edit task") : t("新建定时任务", "New scheduled task")} description={t("自动创建任务专属对话。不指定项目时，每个对话使用独立目录。", "Creates a task-owned conversation. Without a project, each conversation gets its own directory.")} size="wide" footer={<><Button variant="quiet" disabled={busy} onClick={close}>{t("取消", "Cancel")}</Button><Button variant="primary" loading={busy} disabled={!canSave} onClick={() => {
    setValidation(""); const timestamp = Date.parse(at), interval = Number(minutes) * 60;
    if (!immediate && !calendar && (!Number.isFinite(timestamp) || timestamp <= Date.now())) { setValidation(t("请选择未来的执行时间。", "Choose a future time.")); return; }
    if (repeatMode === "interval" && (!Number.isInteger(interval) || interval < 60 || interval > 31536000)) { setValidation(t("重复间隔须为 1 分钟至 365 天。", "Interval must be 1 minute to 365 days.")); return; }
    if (calendar && (!time || ((!advanced || repeatMode !== "custom") && (repeatMode === "weekly" || (repeatMode === "custom" && unit === "week")) && !days.length))) { setValidation(t("请选择时间及至少一个星期。", "Choose a time and at least one weekday.")); return; }
    const recurrence: Recurrence | undefined = calendar ? { kind: repeatMode as Recurrence["kind"], time, timezone, anchor: job?.recurrence?.anchor ?? localTime(Date.now()).slice(0, 10), days, interval: Number(every), unit, ...(repeatMode === "custom" && advanced ? { rrule } : {}) } : undefined;
    void save({ ...(job ? { id: job.id } : {}), projectId, selection: { ...choices[Number(modelIndex)], name: undefined, reasoningEffort }, newConversationEachRun, title, prompt, immediate, ...(!immediate && !calendar ? { at: new Date(timestamp).toISOString() } : {}), ...(repeatMode === "interval" ? { intervalSeconds: interval } : {}), ...(recurrence ? { recurrence } : {}) });
  }}>{t("保存任务", "Save task")}</Button></>}>
    <div className="scheduler-form">
      <Input label={t("任务名称", "Task name")} value={title} onChange={setTitle} maxLength={200} />
      <label>{t("任务内容", "Prompt")}<textarea value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={2000} rows={4} /></label>
      <Combobox size="small" label={t("归属项目", "Project")} value={projectId} onValueChange={setProjectId} options={[{ value: "independent", label: t("不在项目中工作", "Work without a project") }, ...(data?.projects ?? []).map(item => ({ value: item.id, label: item.name }))]} />
      <label className="scheduler-repeat"><input type="checkbox" checked={newConversationEachRun} onChange={event => setNewConversationEachRun(event.target.checked)} />{t("每次启用新对话", "Start a new conversation each time")}</label>
      <p className="scheduler-muted">{newConversationEachRun ? t("每次从新上下文执行；不指定项目时也创建新目录。", "Fresh context each run; a new directory too when no project is selected.") : t("首次创建任务专属对话，后续复用其历史与目录。", "Creates a dedicated conversation on the first run and reuses it afterwards.")}</p>
      <Combobox size="small" label={t("执行模型", "Model")} value={modelIndex} onValueChange={setModelIndex} options={choices.map((item, index) => ({ value: String(index), label: item.name }))} />
      <Combobox size="small" label={t("思考强度", "Reasoning effort")} value={reasoningEffort} onValueChange={value => setReasoningEffort(value as typeof reasoningEffort)} options={efforts.map(value => ({ value, label: zh ? ({ none: "无", minimal: "最小", low: "低", medium: "中", high: "高", xhigh: "极高" } as Record<string, string>)[value] ?? value : value }))} />
      <label className="scheduler-repeat"><input type="checkbox" checked={immediate} onChange={event => setImmediate(event.target.checked)} />{t("立即执行", "Run immediately")}</label>
      {immediate && <p className="scheduler-muted">{t("保存后立即启动一次；周期任务后续按所选日程执行。", "Runs once after saving; repeating tasks continue at the selected interval.")}</p>}
      {!immediate && !calendar && <Input label={t("首次执行时间", "First run")} type="datetime-local" value={at} onChange={setAt} hint={t("使用本机时区", "Uses your local time zone")} />}
      <div className="scheduler-recurrence">
        <Combobox size="small" label={t("重复", "Repeat")} value={repeatMode} onValueChange={setRepeatMode} options={[["once", t("不重复", "Once")], ["interval", t("间隔", "Interval")], ["daily", t("每天", "Daily")], ["weekdays", t("工作日", "Weekdays")], ["weekly", t("每周", "Weekly")], ["custom", t("自定义", "Custom")]].map(([value, label]) => ({ value: value!, label: label! }))} />
        {repeatMode === "interval" && <Input label={t("重复间隔", "Interval")} type="number" min={1} max={525600} value={minutes} onChange={setMinutes} unit={t("分钟", "minutes")} />}
        {calendar && <Input label={t("时间", "Time")} type="time" value={time} onChange={setTime} hint={timezone} />}
        {repeatMode === "custom" && !advanced && <div className="scheduler-custom-period"><Input label={t("每隔", "Every")} type="number" min={1} max={365} value={every} onChange={setEvery} /><Combobox size="small" label={t("单位", "Unit")} value={unit} onValueChange={value => setUnit(value as typeof unit)} options={[{ value: "day", label: t("天", "Days") }, { value: "week", label: t("周", "Weeks") }, { value: "month", label: t("月", "Months") }]} /></div>}
        {(repeatMode === "weekly" || (repeatMode === "custom" && unit === "week" && !advanced)) && <div className="scheduler-weekdays" role="group" aria-label={t("执行星期", "Run weekdays")}>{[1, 2, 3, 4, 5, 6, 0].map(day => <button key={day} type="button" aria-pressed={days.includes(day)} onClick={() => setDays(current => current.includes(day) ? current.filter(item => item !== day) : [...current, day])}>{zh ? ["日", "一", "二", "三", "四", "五", "六"][day] : ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"][day]}</button>)}</div>}
        {repeatMode === "custom" && <><label className="scheduler-repeat"><input type="checkbox" checked={advanced} onChange={event => setAdvanced(event.target.checked)} />{t("高级 RRULE", "Advanced RRULE")}</label>{advanced && <Input label="RRULE" value={rrule} onChange={setRrule} hint={t("如 FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0（高级规则优先于时间）", "Example: FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0 (overrides time)")} />}</>}
      </div>
      {!choices.length && <p className="scheduler-muted">{t("请先在设置中配置可用模型，无需提前创建对话。", "Configure an enabled model in Settings; no existing conversation is required.")}</p>}
      {(validation || error) && <p className="scheduler-error" role="alert">{validation || error}</p>}
    </div>
  </Dialog>;
}
mountPlugin(<Scheduler />);
