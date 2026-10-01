import { rrulestr } from "rrule";

export type Recurrence = {
  kind: "daily" | "weekdays" | "weekly" | "custom";
  time: string;
  timezone: string;
  anchor: string;
  days?: number[];
  interval?: number;
  unit?: "day" | "week" | "month";
  rrule?: string;
};
const weekdays = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

export function recurrenceRule(value: Recurrence): string {
  if (value.rrule) return value.rrule.replace(/^RRULE:/i, "").toUpperCase();
  const [hour, minute] = value.time.split(":").map(Number);
  const frequency = value.kind === "weekly" || (value.kind === "custom" && value.unit === "week") ? "WEEKLY" : value.kind === "custom" && value.unit === "month" ? "MONTHLY" : "DAILY";
  const days = value.kind === "weekdays" ? [1, 2, 3, 4, 5] : value.kind === "weekly" || (value.kind === "custom" && value.unit === "week") ? value.days : undefined;
  return `FREQ=${frequency};INTERVAL=${value.kind === "custom" ? value.interval ?? 1 : 1};BYHOUR=${hour};BYMINUTE=${minute};BYSECOND=0${days?.length ? ";BYDAY=" + days.map(day => weekdays[day]).join(",") : ""}`;
}

export function validateRecurrence(input: unknown): Recurrence {
  if (!input || typeof input !== "object") throw Error("Invalid recurrence");
  const value = input as Recurrence;
  if (!["daily", "weekdays", "weekly", "custom"].includes(value.kind) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time) || !/^\d{4}-\d{2}-\d{2}$/.test(value.anchor)) throw Error("Invalid recurrence time");
  // Validate the calendar date, not just its format.
  const date = new Date(value.anchor + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.anchor) throw Error("Invalid recurrence date");
  if (typeof value.timezone !== "string" || !value.timezone.trim()) throw Error("Timezone required");
  new Intl.DateTimeFormat("en", { timeZone: value.timezone }).format(date);
  if (value.days && (!Array.isArray(value.days) || value.days.some(day => !Number.isInteger(day) || day < 0 || day > 6))) throw Error("Invalid weekdays");
  if ((value.kind === "weekly" || (value.kind === "custom" && value.unit === "week")) && !value.rrule && !value.days?.length) throw Error("Select at least one weekday");
  if (value.kind === "custom" && !value.rrule && (!["day", "week", "month"].includes(value.unit ?? "") || !Number.isInteger(value.interval) || value.interval! < 1 || value.interval! > 365)) throw Error("Invalid custom interval");
  if (value.rrule) {
    if (typeof value.rrule !== "string" || value.rrule.length > 500 || /[\r\n]/.test(value.rrule)) throw Error("Use a single RRULE");
    const rule = recurrenceRule(value);
    if (!/^FREQ=(?:DAILY|WEEKLY|MONTHLY|YEARLY)(?:;|$)/.test(rule)) throw Error("Use interval mode for sub-day recurrence");
    if (rule.split(";").some(part => !/^(FREQ|INTERVAL|BYDAY|BYMONTHDAY|BYMONTH|BYHOUR|BYMINUTE|BYSECOND|BYSETPOS|WKST|COUNT|UNTIL)=/.test(part))) throw Error("Unsupported recurrence field");
    if (/BYSECOND=(?!0(?:;|$))/.test(rule)) throw Error("Second-level recurrence is not supported");
    for (const name of ["COUNT", "INTERVAL"]) {
      const match = rule.match(new RegExp("(?:^|;)" + name + "=([^;]+)"));
      if (match && (!/^[1-9][0-9]*$/.test(match[1]!) || Number(match[1]) > 10000)) throw Error("Invalid recurrence " + name);
    }
  }
  const clean = { ...value };
  ruleFor(clean);
  return clean;
}

function ruleFor(value: Recurrence) {
  const start = value.anchor.replaceAll("-", "") + "T" + value.time.replace(":", "") + "00";
  // Keep RRULE dates floating; its TZID conversion depends on the process timezone.
  const rule = recurrenceRule(value).replace(/UNTIL=(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, (_match, year, month, day, hour, minute, second) => {
    const instant = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
    return "UNTIL=" + new Date(floatingTime(instant, value.timezone)).toISOString().replaceAll("-", "").replaceAll(":", "").replace(".000", "");
  });
  return rrulestr(`DTSTART:${start}Z\nRRULE:${rule}`);
}

function floatingTime(instant: number, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
}
/** RRULE calculates calendar occurrences in the saved timezone, not elapsed 24-hour blocks. */
export function nextOccurrence(value: Recurrence, after: number, inclusive = false): number | undefined {
  const floating = (instant: number) => floatingTime(instant, value.timezone);
  const rule = ruleFor(value);
  let candidate = rule.after(new Date(floating(after)), inclusive);
  for (let attempts = 0; candidate && attempts < 100; attempts++) {
    const wall = candidate.getTime();
    let instant = wall;
    for (let i = 0; i < 4; i++) instant += wall - floating(instant);
    // Nonexistent local times during a DST jump are skipped.
    if (floating(instant) === wall && (instant > after || (inclusive && instant === after))) return instant;
    candidate = rule.after(candidate);
  }
  return undefined;
}
