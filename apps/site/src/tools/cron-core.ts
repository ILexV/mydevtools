/**
 * Cron core shared by cron-parser and cron-generator: strict 5-field cron
 * parsing/validation (ranges, steps, lists, JAN-DEC / SUN-SAT names, `L` last
 * day of month, `?`, weekday 7 = Sunday, @presets), human-readable schedule
 * description (localized building blocks, ru plural forms), next-run
 * calculation (day-by-day scan, Vixie cron day-of-month OR day-of-week rule)
 * and next-run date formatting. Pure module — no DOM; unit-tested in
 * `test/cron-core.test.ts`.
 */
import { formatPlural, formatString } from "../lib/format.ts";

/** Field order of a 5-field expression. */
export const CRON_FIELDS = ["minute", "hour", "day", "month", "weekday"] as const;
export type CronFieldName = (typeof CRON_FIELDS)[number];

/** Inclusive numeric range accepted by each field. */
export const CRON_RANGES: Record<CronFieldName, readonly [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  day: [1, 31],
  month: [1, 12],
  weekday: [0, 6],
};

/** @presets → 5-field expansion (`@reboot` has no time-based schedule). */
export const CRON_PRESETS: Readonly<Record<string, string | null>> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
  "@reboot": null,
};

/** Canonical (crontab) month / weekday names, always accepted regardless of UI language. */
export const CRON_MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
export const CRON_WEEKDAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export type CronErrorCode = "fieldCount" | "unknownPreset" | "invalidField";

/** Validation failure with enough data for a localized message. */
export class CronError extends Error {
  readonly code: CronErrorCode;
  readonly field?: CronFieldName;
  readonly token?: string;
  readonly count?: number;
  constructor(code: CronErrorCode, details: { field?: CronFieldName; token?: string; count?: number } = {}) {
    super(code === "invalidField" ? `invalid ${details.field} value "${details.token}"` : code);
    this.name = "CronError";
    this.code = code;
    this.field = details.field;
    this.token = details.token;
    this.count = details.count;
  }
}

/** One parsed field: matching values, plus `L`/wildcard flags. */
export interface CronFieldSet {
  values: number[];
  /** `L` in day-of-month: last day of the month. */
  last: boolean;
  // Field is `*`, `?` or starts with `*` (e.g. `*/5`): "unrestricted" for the day OR weekday rule.
  wildcard: boolean;
}

export interface CronSchedule {
  minute: CronFieldSet;
  hour: CronFieldSet;
  day: CronFieldSet;
  month: CronFieldSet;
  weekday: CronFieldSet;
}

/** Localized names a user may type besides the canonical ones (legacy accepted UI-language names). */
export interface CronNameAliases {
  months?: readonly string[];
  weekdays?: readonly string[];
}

/** Normalize spacing; returns the expression to parse (preset expanded) or null for @reboot. */
export function expandCronPreset(expression: string): string | null {
  const expr = expression.trim();
  if (!expr.startsWith("@")) return expr;
  const key = expr.toLowerCase();
  if (!(key in CRON_PRESETS)) throw new CronError("unknownPreset");
  return CRON_PRESETS[key];
}

function lookupName(token: string, canonical: readonly string[], aliases: readonly string[] | undefined): number {
  const upper = token.toLocaleUpperCase();
  let idx = canonical.indexOf(upper);
  if (idx < 0 && aliases) idx = aliases.findIndex((n) => n.trim().toLocaleUpperCase() === upper);
  return idx;
}

/** Expand one field (`*`, `n`, `a-b`, `x/s`, lists, names, `L`, `?`); throws CronError on bad input. */
export function parseCronField(raw: string, field: CronFieldName, aliases: CronNameAliases = {}): CronFieldSet {
  const [min, max] = CRON_RANGES[field];
  const fail = (): never => {
    throw new CronError("invalidField", { field, token: raw });
  };
  const text = raw.trim();
  if (!text) fail();

  if (field === "day" && text.toUpperCase() === "L") return { values: [], last: true, wildcard: false };
  if (text === "?") {
    if (field !== "day" && field !== "weekday") fail();
    return { values: range(min, max), last: false, wildcard: true };
  }

  const names = field === "month" ? CRON_MONTH_NAMES : field === "weekday" ? CRON_WEEKDAY_NAMES : null;
  const nameAliases = field === "month" ? aliases.months : field === "weekday" ? aliases.weekdays : undefined;
  // Weekday accepts 7 as Sunday (Vixie cron); months are 1-based names.
  const upper = field === "weekday" ? 7 : max;

  const atom = (tok: string): number => {
    if (/^\d+$/.test(tok)) {
      const n = Number(tok);
      if (n < min || n > upper) fail();
      return n;
    }
    if (!names) fail();
    const idx = lookupName(tok, names as string[], nameAliases);
    if (idx < 0) fail();
    return field === "month" ? idx + 1 : idx;
  };

  const out = new Set<number>();
  for (const part of text.split(",")) {
    if (!part) fail();
    const [rangePart, stepPart, extra] = part.split("/");
    if (extra !== undefined) fail();
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) fail();
      step = Number(stepPart);
      if (step < 1) fail();
    }
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const bounds = rangePart.split("-");
      if (bounds.length !== 2) fail();
      start = atom(bounds[0]);
      end = atom(bounds[1]);
      if (start > end) fail();
    } else {
      start = atom(rangePart);
      // `5/15` = from 5 to the field maximum every 15 (cron extension).
      end = stepPart !== undefined ? max : start;
    }
    for (let v = start; v <= end; v += step) out.add(field === "weekday" && v === 7 ? 0 : v);
  }
  return {
    values: [...out].sort((a, b) => a - b),
    last: false,
    wildcard: text.startsWith("*"),
  };
}

/** Parse a full expression (or preset). Returns null for `@reboot`; throws CronError when invalid. */
export function parseCron(expression: string, aliases: CronNameAliases = {}): CronSchedule | null {
  const expr = expandCronPreset(expression);
  if (expr === null) return null;
  const parts = expr.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) throw new CronError("fieldCount", { count: parts.length });
  const [minute, hour, day, month, weekday] = parts.map((p, i) => parseCronField(p, CRON_FIELDS[i], aliases));
  return { minute, hour, day, month, weekday };
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

function dayMatches(s: CronSchedule, date: Date): boolean {
  const dom = date.getDate();
  const lastDom = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const domOk = s.day.last ? dom === lastDom : s.day.values.includes(dom);
  const dowOk = s.weekday.values.includes(date.getDay());
  // Vixie cron: when both day fields are restricted, a day matches if EITHER matches.
  if (!s.day.wildcard && !s.weekday.wildcard) return domOk || dowOk;
  return domOk && dowOk;
}

/**
 * Next `count` run times strictly after `from` (local time), scanning day by
 * day up to `maxYears` ahead. Returns fewer (possibly zero) when the schedule
 * never fires in that window (e.g. `0 0 30 2 *`).
 */
export function cronNextRuns(schedule: CronSchedule, from: Date, count: number, maxYears = 30): Date[] {
  const runs: Date[] = [];
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const limit = new Date(from.getFullYear() + maxYears, from.getMonth(), from.getDate());
  const fromMs = from.getTime();
  let lastMs = fromMs;
  while (runs.length < count && day < limit) {
    if (schedule.month.values.includes(day.getMonth() + 1) && dayMatches(schedule, day)) {
      for (const h of schedule.hour.values) {
        for (const m of schedule.minute.values) {
          const run = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
          // `> lastMs` drops DST-shifted duplicates and keeps the list ordered.
          if (run.getTime() > lastMs && run.getDate() === day.getDate()) {
            runs.push(run);
            lastMs = run.getTime();
            if (runs.length >= count) return runs;
          }
        }
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return runs;
}

/** Localized description building blocks (+ optional `<key>_<one|few|many|other>` plural variants). */
export interface CronStrings {
  lang: string;
  scheduleReboot: string;
  scheduleYearly: string;
  scheduleMonthly: string;
  scheduleWeekly: string;
  scheduleDaily: string;
  scheduleHourly: string;
  scheduleEveryMinute: string;
  scheduleEveryNMinutes: string;
  scheduleAtMinute: string;
  scheduleAtMinutes: string;
  scheduleEveryHour: string;
  scheduleEveryNHours: string;
  scheduleAtHour: string;
  scheduleAtHours: string;
  scheduleEveryDay: string;
  scheduleOnDay: string;
  scheduleOnDays: string;
  scheduleLastDay: string;
  scheduleOnWeekday: string;
  scheduleOnWeekdays: string;
  scheduleInMonth: string;
  scheduleInMonths: string;
  scheduleDayOrWeekday: string;
  months: string[];
  weekdays: string[];
  [plural: string]: unknown;
}

const PRESET_DESCRIPTION: Record<string, keyof CronStrings> = {
  "@yearly": "scheduleYearly",
  "@annually": "scheduleYearly",
  "@monthly": "scheduleMonthly",
  "@weekly": "scheduleWeekly",
  "@daily": "scheduleDaily",
  "@midnight": "scheduleDaily",
  "@hourly": "scheduleHourly",
  "@reboot": "scheduleReboot",
};

function listPreview(values: Array<string | number>): string {
  return values.slice(0, 5).join(", ") + (values.length > 5 ? "..." : "");
}

// `*` or `*/1` → every unit; `*/n` → every n units; otherwise null.
function everyStep(raw: string): number | null {
  if (raw === "*") return 1;
  const m = raw.match(/^\*\/(\d+)$/);
  return m ? Number(m[1]) : null;
}

/** Human-readable description of a valid expression (throws CronError when invalid). */
export function describeCron(expression: string, str: CronStrings): string {
  const trimmed = expression.trim();
  if (trimmed.startsWith("@")) {
    const key = PRESET_DESCRIPTION[trimmed.toLowerCase()];
    if (!key) throw new CronError("unknownPreset");
    return str[key] as string;
  }
  const schedule = parseCron(trimmed, str);
  if (!schedule) return str.scheduleReboot;
  const [minute, hour, day, month, weekday] = trimmed.split(/\s+/);
  const isAll = (raw: string) => raw === "*" || raw === "?";
  const desc: string[] = [];

  const minuteStep = everyStep(minute);
  if (minuteStep === 1) desc.push(str.scheduleEveryMinute);
  else if (minuteStep !== null) desc.push(formatPlural(str, "scheduleEveryNMinutes", minuteStep, str.lang));
  else if (schedule.minute.values.length === 1) desc.push(formatString(str.scheduleAtMinute, schedule.minute.values[0]));
  else desc.push(formatString(str.scheduleAtMinutes, listPreview(schedule.minute.values)));

  const hourStep = everyStep(hour);
  if (hourStep === 1) desc.push(str.scheduleEveryHour);
  else if (hourStep !== null) desc.push(formatPlural(str, "scheduleEveryNHours", hourStep, str.lang));
  else if (schedule.hour.values.length === 1) desc.push(formatString(str.scheduleAtHour, schedule.hour.values[0]));
  else desc.push(formatString(str.scheduleAtHours, listPreview(schedule.hour.values)));

  const dayText = isAll(day)
    ? null
    : schedule.day.last
      ? str.scheduleLastDay
      : schedule.day.values.length === 1
        ? formatString(str.scheduleOnDay, schedule.day.values[0])
        : formatString(str.scheduleOnDays, listPreview(schedule.day.values));
  const weekdayNames = schedule.weekday.values.map((v) => str.weekdays[v] ?? CRON_WEEKDAY_NAMES[v]);
  const weekdayText = isAll(weekday)
    ? null
    : formatString(weekdayNames.length === 1 ? str.scheduleOnWeekday : str.scheduleOnWeekdays, weekdayNames.join(", "));
  if (dayText && weekdayText) desc.push(formatString(str.scheduleDayOrWeekday, dayText, weekdayText));
  else if (dayText) desc.push(dayText);
  else if (weekdayText) desc.push(weekdayText);
  else desc.push(str.scheduleEveryDay);

  if (!isAll(month) && schedule.month.values.length < 12) {
    const monthNames = schedule.month.values.map((v) => str.months[v - 1] ?? CRON_MONTH_NAMES[v - 1]);
    desc.push(
      monthNames.length === 1
        ? formatString(str.scheduleInMonth, monthNames[0])
        : formatString(str.scheduleInMonths, listPreview(monthNames)),
    );
  }

  // English-only smoothing kept from legacy ("Every minute of every hour every day").
  return desc.join(" ").replace(/of every hour every/g, "every").replace(/at hour every/g, "every");
}

/** Localized error strings for `cronErrorMessage`. */
export interface CronErrorStrings {
  errorInvalidExpression: string;
  errorExpectedFields: string;
  errorUnknownPreset: string;
  /** `{0}` field name, `{1}` offending text, `{2}`–`{3}` allowed range. */
  errorFieldValue: string;
}

/** Localized message for a CronError (field names come from the UI labels). */
export function cronErrorMessage(err: unknown, str: CronErrorStrings, fieldNames: Record<CronFieldName, string>): string {
  if (err instanceof CronError) {
    let detail: string;
    if (err.code === "fieldCount") detail = formatString(str.errorExpectedFields, err.count ?? 0);
    else if (err.code === "unknownPreset") detail = str.errorUnknownPreset;
    else {
      const field = err.field ?? "minute";
      const [min, max] = CRON_RANGES[field];
      detail = formatString(str.errorFieldValue, fieldNames[field], err.token ?? "", min, field === "weekday" ? 7 : max);
    }
    return formatString(str.errorInvalidExpression, detail);
  }
  return formatString(str.errorInvalidExpression, err instanceof Error ? err.message : String(err));
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");

/** ISO 8601 local date-time with UTC offset, e.g. `2026-10-06T09:00:00+06:00`. */
export function toLocalIso(date: Date): string {
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.trunc(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}

/** Next-run date formats offered by the date-format select (persisted as `cron-date-format`). */
export function formatCronDate(date: Date, format: string, lang: string): string {
  const locale = lang === "zh" ? "zh-CN" : lang;
  const time = { hour: "2-digit", minute: "2-digit", second: "2-digit" } as const;
  switch (format) {
    case "iso":
      return toLocalIso(date);
    case "compact":
      return date.toLocaleString(locale, { day: "2-digit", month: "2-digit", year: "numeric", ...time, hour12: false });
    case "american":
      return date.toLocaleString("en-US", { month: "2-digit", day: "2-digit", year: "numeric", ...time, hour12: true });
    case "full-month":
      return date.toLocaleString(locale, { weekday: "short", year: "numeric", month: "long", day: "numeric", ...time, hour12: false });
    case "verbose":
      return date.toLocaleString(locale, { weekday: "long", year: "numeric", month: "long", day: "numeric", ...time, hour12: false });
    case "locale-12h":
      return date.toLocaleString(locale, { weekday: "short", year: "numeric", month: "short", day: "numeric", ...time, hour12: true });
    case "locale":
    default:
      return date.toLocaleString(locale, { weekday: "short", year: "numeric", month: "short", day: "numeric", ...time, hour12: false });
  }
}
