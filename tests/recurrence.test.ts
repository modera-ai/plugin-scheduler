import { expect, test } from "vitest";
import { nextOccurrence, validateRecurrence, recurrenceRule, type Recurrence } from "../src/recurrence";
import { scheduleFields } from "../src/editor";

const daily: Recurrence = { kind: "daily", time: "09:00", timezone: "Asia/Shanghai", anchor: "2026-10-01" };
test("daily uses saved timezone; weekdays skip weekends", () => {
  expect(nextOccurrence(daily, Date.parse("2026-10-01T02:00:00Z"))).toBe(Date.parse("2026-10-02T01:00:00Z"));
  expect(nextOccurrence({ ...daily, kind: "weekdays" }, Date.parse("2026-10-02T02:00:00Z"))).toBe(Date.parse("2026-10-05T01:00:00Z"));
});
test("weekly and custom every two weeks preserve calendar anchor", () => {
  const weekly = { ...daily, kind: "weekly" as const, days: [1, 3] };
  expect(nextOccurrence(weekly, Date.parse("2026-10-01T02:00:00Z"))).toBe(Date.parse("2026-10-05T01:00:00Z"));
  expect(recurrenceRule({ ...weekly, kind: "custom", unit: "week", interval: 2 })).toContain("INTERVAL=2");
});
test("daily follows daylight saving time instead of fixed 24h", () => {
  const rule = { ...daily, timezone: "America/New_York", anchor: "2026-10-30" };
  expect(nextOccurrence(rule, Date.parse("2026-10-31T14:00:00Z"))).toBe(Date.parse("2026-11-01T14:00:00Z"));
});
test("advanced monthly RRULE and finite rules", () => {
  const rule = validateRecurrence({ ...daily, kind: "custom", rrule: "FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0" });
  expect(nextOccurrence(rule, Date.parse("2026-10-02T00:00:00Z"))).toBe(Date.parse("2026-11-01T01:00:00Z"));
  expect(nextOccurrence({ ...rule, rrule: "FREQ=DAILY;COUNT=1" }, Date.parse("2026-10-02T00:00:00Z"))).toBeUndefined();
  expect(nextOccurrence({ ...rule, rrule: "FREQ=DAILY;UNTIL=20261001T003000Z" }, Date.parse("2026-10-01T00:00:00Z"))).toBeUndefined();
});
test("reject invalid days, dates, intervals and sub-minute frequency", () => {
  expect(() => validateRecurrence({ ...daily, kind: "weekly", days: [] })).toThrow();
  expect(() => validateRecurrence({ ...daily, anchor: "2026-02-30" })).toThrow();
  expect(() => validateRecurrence({ ...daily, kind: "custom", unit: "week", interval: 0 })).toThrow();
  expect(() => validateRecurrence({ ...daily, rrule: "FREQ=SECONDLY" })).toThrow();
  expect(() => scheduleFields({ title: "Test", prompt: "Test", immediate: true, recurrence: daily, intervalSeconds: 60 })).toThrow();
});
