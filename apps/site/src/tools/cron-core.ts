/**
 * Cron core shared by cron-parser and cron-generator: strict 5-field cron
 * parsing/validation (ranges, steps, lists, JAN-DEC / SUN-SAT names, `L` last
 * day of month, `?`, weekday 7 = Sunday, @presets), human-readable schedule
 * description (localized templates, Intl.PluralRules plural/ordinal forms,
 * Intl.ListFormat lists, clock times, workdays/weekends), next-run
 * calculation (day-by-day scan, Vixie cron day-of-month OR day-of-week rule)
 * and next-run date formatting. Pure module — no DOM; unit-tested in
 * `test/cron-core.test.ts`.
 */
import { formatPlural, formatString, pluralSuffix } from "../lib/format.ts";

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

/** Search horizon of `cronNextRuns` in years: schedules with no run inside it show "no runs". */
export const CRON_SEARCH_YEARS = 30;

/**
 * Next `count` run times strictly after `from` (local time), scanning day by
 * day up to `maxYears` ahead. Returns fewer (possibly zero) when the schedule
 * never fires in that window (e.g. `0 0 30 2 *`).
 */
export function cronNextRuns(schedule: CronSchedule, from: Date, count: number, maxYears = CRON_SEARCH_YEARS): Date[] {
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

/**
 * Localized description templates (camelCased locale keys; `<key>_<category>`
 * plural variants come from `pluralVariants()`). Placeholders: `{0}`, `{1}`, ….
 * Lists are joined with `Intl.ListFormat`, counts pick a form via
 * `Intl.PluralRules`, day numbers via ordinal PluralRules (`scheduleDayOrdinal_one` …).
 */
export interface CronStrings {
  lang: string;
  scheduleReboot: string;
  scheduleYearly: string;
  scheduleMonthly: string;
  scheduleWeekly: string;
  scheduleDaily: string;
  scheduleHourly: string;
  /** "every minute" */
  scheduleEveryMinute: string;
  /** "every {0} minutes" (plural on {0}) */
  scheduleEveryNMinutes: string;
  /** "at minute {0}" (plural on {0}) */
  scheduleAtMinute: string;
  /** "at minutes {0}" (list; plural on the last number) */
  scheduleAtMinutes: string;
  /** "every hour at minute {0}" (plural on {0}) */
  scheduleHourlyAtMinute: string;
  /** "every hour at minutes {0}" (list; plural on the last number) */
  scheduleHourlyAtMinutes: string;
  /** "every hour on the hour" (`0 * * * *`) */
  scheduleHourlyOnTheHour: string;
  /** "every hour from {0} to {1}" (times) */
  scheduleHourlyBetween: string;
  /** "every {0} hours starting at {1}" (plural on {0}) */
  scheduleEveryNHoursFrom: string;
  /** "{0} from {1} to {2}" — minute phrase inside an hour window */
  scheduleWindow: string;
  /** "{0} during hours {1}" — minute phrase + hour list */
  scheduleDuringHours: string;
  /** "at {0}" (list of HH:MM) */
  scheduleAtTimes: string;
  /** "every day at {0}" (list of HH:MM) */
  scheduleDailyAt: string;
  /** "on the {0} of the month" (list of ordinal days) */
  scheduleOnDay: string;
  /** Run of days "{0}–{1}" (ru «с {0} по {1}»). */
  scheduleDayRange?: string;
  /** Ordinal day number "{0}th" (+ `_one`/`_two`/`_few`… ordinal variants). */
  scheduleDayOrdinal: string;
  scheduleLastDay: string;
  /** "on {0}" (list of `weekdaysLong`) */
  scheduleOnWeekdays: string;
  /** Monday–Friday */
  scheduleWorkdays: string;
  /** Saturday + Sunday */
  scheduleWeekends: string;
  /** "in {0}" (list of `monthsLong`) */
  scheduleInMonths: string;
  /** "{0} or {1}" — day-of-month OR weekday (Vixie rule) */
  scheduleDayOrWeekday: string;
  /** Sentence order "{0} {1} {2}" = time, days, months. */
  scheduleSentence: string;
  /** Short names (aliases accepted in input). */
  months: string[];
  weekdays: string[];
  /** Names in the grammatical form the templates need (ru: «в январе», «по понедельникам»). */
  monthsLong: string[];
  weekdaysLong: string[];
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

/** Max explicit times ("at 09:00, 13:00 and 17:00") before switching to a window/list phrase. */
const MAX_TIMES = 6;

const listFormatCache = new Map<string, Intl.ListFormat>();
function joinList(lang: string, items: string[]): string {
  let lf = listFormatCache.get(lang);
  if (!lf) {
    lf = new Intl.ListFormat(lang, { type: "conjunction", style: "long" });
    listFormatCache.set(lang, lf);
  }
  return lf.format(items);
}

/** Collapse consecutive numbers into runs: [1,2,3,5] → [[1,3],[5,5]]. */
function runs(values: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const v of values) {
    const last = out.at(-1);
    if (last && v === last[1] + 1) last[1] = v;
    else out.push([v, v]);
  }
  return out;
}

/** Numbers as list items; runs of 3+ become "a–b" (or `rangeTpl` "{0}…{1}"). */
function runItems(values: number[], fmt: (n: number) => string = String, rangeTpl = "{0}–{1}"): string[] {
  return runs(values).flatMap(([a, b]) =>
    b - a >= 2 ? [formatString(rangeTpl, fmt(a), fmt(b))] : a === b ? [fmt(a)] : [fmt(a), fmt(b)],
  );
}

/** Template picked by the plural form of `n`, filled with `values` (not `n`) — for list phrases. */
function pluralList(str: CronStrings, key: string, n: number, ...values: string[]): string {
  const raw = str[`${key}_${pluralSuffix(str.lang, n)}`] ?? str[key];
  return formatString(typeof raw === "string" ? raw : key, ...values);
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const hhmm = (h: number, m: number) => `${pad2(h)}:${pad2(m)}`;

// `*` / `?` / `*/1` → every unit; `*/n` → every n units; otherwise null.
function everyStep(raw: string): number | null {
  if (raw === "*" || raw === "?") return 1;
  const m = raw.match(/^\*\/(\d+)$/);
  return m ? Number(m[1]) : null;
}

const ordinalRulesCache = new Map<string, Intl.PluralRules>();
function dayOrdinal(str: CronStrings, n: number): string {
  let pr = ordinalRulesCache.get(str.lang);
  if (!pr) {
    pr = new Intl.PluralRules(str.lang, { type: "ordinal" });
    ordinalRulesCache.set(str.lang, pr);
  }
  const raw = str[`scheduleDayOrdinal_${pr.select(n)}`] ?? str.scheduleDayOrdinal;
  return formatString(typeof raw === "string" ? raw : "{0}", n);
}

/** Time-of-day clause from the minute and hour fields. */
function describeTime(str: CronStrings, s: CronSchedule, minuteRaw: string, hourRaw: string, allDays: boolean): string {
  const lang = str.lang;
  const mins = s.minute.values;
  const hours = s.hour.values;
  const minuteStep = everyStep(minuteRaw);
  const hourStep = everyStep(hourRaw);
  const lastMinute = mins[mins.length - 1];

  // Single minute + a handful of hours → explicit clock times.
  if (mins.length === 1 && hourStep === null && hours.length <= MAX_TIMES) {
    const times = joinList(lang, hours.map((h) => hhmm(h, mins[0])));
    return formatString(allDays ? str.scheduleDailyAt : str.scheduleAtTimes, times);
  }

  const minutePhrase =
    minuteStep === 1
      ? str.scheduleEveryMinute
      : minuteStep !== null
        ? formatPlural(str, "scheduleEveryNMinutes", minuteStep, lang)
        : mins.length === 1
          ? formatPlural(str, "scheduleAtMinute", mins[0], lang)
          : pluralList(str, "scheduleAtMinutes", lastMinute, joinList(lang, runItems(mins)));

  if (hourStep === 1) {
    if (minuteStep !== null) return minutePhrase;
    if (mins.length === 1 && mins[0] === 0) return str.scheduleHourlyOnTheHour;
    return mins.length === 1
      ? formatPlural(str, "scheduleHourlyAtMinute", mins[0], lang)
      : pluralList(str, "scheduleHourlyAtMinutes", lastMinute, joinList(lang, runItems(mins)));
  }
  if (hourStep !== null && mins.length === 1) {
    return formatPlural(str, "scheduleEveryNHoursFrom", hourStep, lang, hhmm(hours[0], mins[0]));
  }
  const hourRuns = runs(hours);
  if (hourRuns.length === 1) {
    const [a, b] = hourRuns[0];
    if (mins.length === 1) return formatString(str.scheduleHourlyBetween, hhmm(a, mins[0]), hhmm(b, mins[0]));
    return formatString(str.scheduleWindow, minutePhrase, hhmm(a, mins[0]), hhmm(b, lastMinute));
  }
  return formatString(str.scheduleDuringHours, minutePhrase, joinList(lang, runItems(hours)));
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
  const [minute, hour] = trimmed.split(/\s+/);
  const lang = str.lang;
  const full = (f: CronFieldSet, name: CronFieldName) =>
    !f.last && f.values.length === CRON_RANGES[name][1] - CRON_RANGES[name][0] + 1;

  const dayAll = full(schedule.day, "day");
  const weekdayAll = full(schedule.weekday, "weekday");
  const monthAll = full(schedule.month, "month");

  const dayText = dayAll
    ? null
    : schedule.day.last
      ? str.scheduleLastDay
      : formatString(
          str.scheduleOnDay,
          joinList(lang, runItems(schedule.day.values, (n) => dayOrdinal(str, n), str.scheduleDayRange ?? "{0}–{1}")),
        );
  const wd = schedule.weekday.values;
  const weekdayText = weekdayAll
    ? null
    : wd.join() === "1,2,3,4,5"
      ? str.scheduleWorkdays
      : wd.join() === "0,6"
        ? str.scheduleWeekends
        : formatString(str.scheduleOnWeekdays, joinList(lang, wd.map((v) => str.weekdaysLong?.[v] ?? CRON_WEEKDAY_NAMES[v])));
  // Vixie cron: day-of-month OR weekday when both are restricted (`*/n` counts as unrestricted).
  const daysText =
    dayText && weekdayText
      ? !schedule.day.wildcard && !schedule.weekday.wildcard
        ? formatString(str.scheduleDayOrWeekday, dayText, weekdayText)
        : `${dayText} ${weekdayText}`
      : (dayText ?? weekdayText ?? "");
  const monthText = monthAll
    ? ""
    : formatString(str.scheduleInMonths, joinList(lang, schedule.month.values.map((v) => str.monthsLong?.[v - 1] ?? CRON_MONTH_NAMES[v - 1])));

  const timeText = describeTime(str, schedule, minute, hour, !daysText && !monthText);
  const sentence = formatString(str.scheduleSentence ?? "{0} {1} {2}", timeText, daysText, monthText)
    .replace(/\s+/g, " ")
    .replace(/\s+([,，、])/g, "$1")
    .replace(/^[\s,，、]+|[\s,，、]+$/g, "");
  return sentence.charAt(0).toLocaleUpperCase(lang) + sentence.slice(1);
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

const DATE_TIME = { hour: "2-digit", minute: "2-digit", second: "2-digit" } as const;

/** Intl options per next-run date format (`iso` is built by `toLocalIso`). */
const CRON_DATE_FORMATS: Record<string, Intl.DateTimeFormatOptions & { fixedLocale?: string }> = {
  compact: { day: "2-digit", month: "2-digit", year: "numeric", ...DATE_TIME, hour12: false },
  american: { month: "2-digit", day: "2-digit", year: "numeric", ...DATE_TIME, hour12: true, fixedLocale: "en-US" },
  "full-month": { weekday: "short", year: "numeric", month: "long", day: "numeric", ...DATE_TIME, hour12: false },
  verbose: { weekday: "long", year: "numeric", month: "long", day: "numeric", ...DATE_TIME, hour12: false },
  "locale-12h": { weekday: "short", year: "numeric", month: "short", day: "numeric", ...DATE_TIME, hour12: true },
  locale: { weekday: "short", year: "numeric", month: "short", day: "numeric", ...DATE_TIME, hour12: false },
};

const dateFormatCache = new Map<string, Intl.DateTimeFormat>();

/**
 * Next-run date formats offered by the date-format select (persisted as
 * `cron-date-format`). Presentation only: the runs themselves are always
 * computed in the browser's local time zone. Formatters are cached per locale.
 */
export function formatCronDate(date: Date, format: string, lang: string): string {
  if (format === "iso") return toLocalIso(date);
  const key = format in CRON_DATE_FORMATS ? format : "locale";
  const { fixedLocale, ...options } = CRON_DATE_FORMATS[key];
  const locale = fixedLocale ?? (lang === "zh" ? "zh-CN" : lang);
  const cacheKey = `${locale}|${key}`;
  let fmt = dateFormatCache.get(cacheKey);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, options);
    dateFormatCache.set(cacheKey, fmt);
  }
  return fmt.format(date);
}
