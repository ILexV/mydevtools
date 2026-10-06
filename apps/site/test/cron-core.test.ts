// Fixed zone so next-run / ISO assertions are deterministic (Omsk: UTC+6, no DST).
process.env.TZ = "Asia/Omsk";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CronError,
  cronErrorMessage,
  cronNextRuns,
  describeCron,
  expandCronPreset,
  formatCronDate,
  parseCron,
  parseCronField,
  toLocalIso,
  type CronStrings,
} from "../src/tools/cron-core.ts";

/** Client strings exactly as the Astro shell builds them (camelCase keys + plural variants). */
function strings(lang: string, ns = "cron-parser"): CronStrings & Record<string, string> {
  const raw = JSON.parse(
    readFileSync(new URL(`../src/i18n/locales/${lang}/tools/${ns}.json`, import.meta.url), "utf8"),
  ) as Record<string, string>;
  const out: Record<string, unknown> = { lang };
  for (const [k, v] of Object.entries(raw)) out[k.charAt(0).toLowerCase() + k.slice(1)] = v;
  out.months = raw.MonthNames.split(",");
  out.weekdays = raw.WeekdayNames.split(",");
  out.monthsLong = raw.MonthNamesLong.split(",");
  out.weekdaysLong = raw.WeekdayNamesLong.split(",");
  return out as CronStrings & Record<string, string>;
}
const en = strings("en");
const ru = strings("ru");

const fieldNames = { minute: "Minute", hour: "Hour", day: "Day", month: "Month", weekday: "Weekday" };

function errorOf(fn: () => unknown): CronError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof CronError, `expected CronError, got ${String(e)}`);
    return e;
  }
  assert.fail("expected a CronError");
}

test("parseCronField: wildcard, single, range, list, steps", () => {
  assert.equal(parseCronField("*", "minute").values.length, 60);
  assert.deepEqual(parseCronField("5", "minute").values, [5]);
  assert.deepEqual(parseCronField("1-3", "hour").values, [1, 2, 3]);
  assert.deepEqual(parseCronField("3,1,3", "hour").values, [1, 3]);
  assert.deepEqual(parseCronField("*/15", "minute").values, [0, 15, 30, 45]);
  assert.deepEqual(parseCronField("10-20/5", "minute").values, [10, 15, 20]);
  assert.deepEqual(parseCronField("50/5", "minute").values, [50, 55]);
  assert.equal(parseCronField("*/5", "minute").wildcard, true);
  assert.equal(parseCronField("1-5", "weekday").wildcard, false);
});

test("parseCronField: month/weekday names are 1-based months, 0=SUN, case-insensitive", () => {
  assert.deepEqual(parseCronField("JAN", "month").values, [1]);
  assert.deepEqual(parseCronField("jan-mar", "month").values, [1, 2, 3]);
  assert.deepEqual(parseCronField("DEC", "month").values, [12]);
  assert.deepEqual(parseCronField("MON-FRI", "weekday").values, [1, 2, 3, 4, 5]);
  assert.deepEqual(parseCronField("sun,sat", "weekday").values, [0, 6]);
  // 7 is Sunday too (Vixie cron).
  assert.deepEqual(parseCronField("7", "weekday").values, [0]);
  assert.deepEqual(parseCronField("5-7", "weekday").values, [0, 5, 6]);
});

test("parseCronField: localized ru names accepted as aliases, English still works", () => {
  const aliases = { months: ru.months, weekdays: ru.weekdays };
  assert.deepEqual(parseCronField("ПН-ПТ", "weekday", aliases).values, [1, 2, 3, 4, 5]);
  assert.deepEqual(parseCronField("май", "month", aliases).values, [5]);
  assert.deepEqual(parseCronField("MON", "weekday", aliases).values, [1]);
});

test("parseCronField: L and ? only where allowed", () => {
  assert.equal(parseCronField("L", "day").last, true);
  assert.equal(parseCronField("?", "day").wildcard, true);
  assert.equal(parseCronField("?", "weekday").wildcard, true);
  for (const [raw, field] of [
    ["L", "minute"],
    ["?", "hour"],
    ["?", "month"],
  ] as const) {
    assert.equal(errorOf(() => parseCronField(raw, field)).code, "invalidField");
  }
});

test("parseCronField: out-of-range and malformed values are rejected with field + token", () => {
  const bad: Array<[string, Parameters<typeof parseCronField>[1]]> = [
    ["60", "minute"],
    ["24", "hour"],
    ["0", "day"],
    ["32", "day"],
    ["13", "month"],
    ["8", "weekday"],
    ["abc", "minute"],
    ["5-1", "minute"],
    ["*/0", "minute"],
    ["*/x", "minute"],
    ["1/2/3", "minute"],
    ["1,,2", "minute"],
    ["1-2-3", "hour"],
    ["-1", "minute"],
    ["1.5", "minute"],
    ["FOO", "month"],
    ["MON", "month"],
    ["", "minute"],
  ];
  for (const [raw, field] of bad) {
    const err = errorOf(() => parseCronField(raw, field));
    assert.equal(err.code, "invalidField", `${field}=${raw}`);
    assert.equal(err.field, field);
    assert.equal(err.token, raw);
  }
});

test("parseCron: field count and presets", () => {
  assert.equal(errorOf(() => parseCron("* * * *")).count, 4);
  assert.equal(errorOf(() => parseCron("0 * * * * *")).code, "fieldCount");
  assert.equal(errorOf(() => parseCron("@sometimes")).code, "unknownPreset");
  assert.equal(parseCron("@reboot"), null);
  assert.equal(expandCronPreset("  @DAILY "), "0 0 * * *");
  assert.deepEqual(parseCron("@weekly")?.weekday.values, [0]);
  // Extra inner whitespace / tabs are tolerated.
  assert.deepEqual(parseCron(" 0\t9  *  * 1-5 ")?.hour.values, [9]);
});

test("cronNextRuns: known schedules from a fixed instant (Asia/Omsk local time)", () => {
  const from = new Date(2026, 9, 6, 10, 30, 15); // Tue 2026-10-06 10:30:15
  const iso = (expr: string, n = 3) => cronNextRuns(parseCron(expr)!, from, n).map(toLocalIso);

  assert.deepEqual(iso("*/15 * * * *"), [
    "2026-10-06T10:45:00+06:00",
    "2026-10-06T11:00:00+06:00",
    "2026-10-06T11:15:00+06:00",
  ]);
  // Same minute as `from` is in the past (seconds elapsed) → next minute.
  assert.deepEqual(iso("* * * * *", 1), ["2026-10-06T10:31:00+06:00"]);
  assert.deepEqual(iso("0 9 * * 1-5"), [
    "2026-10-07T09:00:00+06:00",
    "2026-10-08T09:00:00+06:00",
    "2026-10-09T09:00:00+06:00",
  ]);
  assert.deepEqual(iso("@monthly", 2), ["2026-11-01T00:00:00+06:00", "2026-12-01T00:00:00+06:00"]);
  assert.deepEqual(iso("0 0 L * *", 3), [
    "2026-10-31T00:00:00+06:00",
    "2026-11-30T00:00:00+06:00",
    "2026-12-31T00:00:00+06:00",
  ]);
  assert.deepEqual(iso("0 0 L 2 *", 2), ["2027-02-28T00:00:00+06:00", "2028-02-29T00:00:00+06:00"]);
  assert.deepEqual(iso("0 12 * JAN,JUL SUN", 1), ["2027-01-03T12:00:00+06:00"]);
});

test("cronNextRuns: day-of-month OR day-of-week when both are restricted", () => {
  const from = new Date(2026, 9, 6, 10, 30);
  const runs = cronNextRuns(parseCron("0 0 13 * FRI")!, from, 3).map(toLocalIso);
  // Fri 9th (weekday), Tue 13th (day of month), Fri 16th — OR semantics, not AND.
  assert.deepEqual(runs, ["2026-10-09T00:00:00+06:00", "2026-10-13T00:00:00+06:00", "2026-10-16T00:00:00+06:00"]);
  // `*/2` day counts as unrestricted → AND with weekday.
  const and = cronNextRuns(parseCron("0 0 */2 * MON")!, from, 2).map(toLocalIso);
  assert.deepEqual(and, ["2026-10-19T00:00:00+06:00", "2026-11-09T00:00:00+06:00"]);
});

test("cronNextRuns: rare and impossible schedules", () => {
  const from = new Date(2026, 9, 6);
  assert.deepEqual(cronNextRuns(parseCron("0 0 29 2 *")!, from, 2).map(toLocalIso), [
    "2028-02-29T00:00:00+06:00",
    "2032-02-29T00:00:00+06:00",
  ]);
  assert.deepEqual(cronNextRuns(parseCron("0 0 30 2 *")!, from, 5), []);
  assert.deepEqual(cronNextRuns(parseCron("0 0 31 4,6,9,11 *")!, from, 5), []);
});

test("describeCron: English descriptions", () => {
  const cases: Array<[string, string]> = [
    ["* * * * *", "Every minute"],
    ["*/1 * * * *", "Every minute"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["0 * * * *", "Every hour on the hour"],
    ["15 * * * *", "Every hour at minute 15"],
    ["0,30 * * * *", "Every hour at minutes 0 and 30"],
    ["0 2 * * *", "Every day at 02:00"],
    ["30 8,12,18 * * *", "Every day at 08:30, 12:30, and 18:30"],
    ["0 9 * * MON-FRI", "At 09:00 Monday through Friday"],
    ["0 10 * * 6,0", "At 10:00 on weekends"],
    ["*/5 9-17 * * 1-5", "Every 5 minutes from 09:00 to 17:55 Monday through Friday"],
    ["0 */6 * * *", "Every 6 hours starting at 00:00"],
    ["0 9-17 * * *", "Every hour from 09:00 to 17:00"],
    ["*/10 0-5,9,12 * * *", "Every 10 minutes during hours 0–5, 9, and 12"],
    ["0 0 L * *", "At 00:00 on the last day of the month"],
    ["0 0 1 JAN *", "At 00:00 on the 1st of the month in January"],
    ["0 0 13 * 5", "At 00:00 on the 13th of the month or on Fridays"],
    ["0 0 2,3,11,22 * *", "At 00:00 on the 2nd, 3rd, 11th, and 22nd of the month"],
    ["0-59/10 * 1-10 * *", "Every hour at minutes 0, 10, 20, 30, 40, and 50 on the 1st–10th of the month"],
    ["0 22 * * 1,3,5", "At 22:00 on Mondays, Wednesdays, and Fridays"],
    ["0 0 1 1,7 *", "At 00:00 on the 1st of the month in January and July"],
  ];
  for (const [expr, want] of cases) assert.equal(describeCron(expr, en), want, expr);
  assert.equal(describeCron("@daily", en), en.scheduleDaily);
  assert.equal(describeCron("@reboot", en), en.scheduleReboot);
});

test("describeCron: natural Russian phrasing (plural forms, cases, lists)", () => {
  const cases: Array<[string, string]> = [
    ["* * * * *", "Каждую минуту"],
    ["*/1 */1 * * *", "Каждую минуту"],
    ["*/2 * * * *", "Каждые 2 минуты"],
    ["*/5 * * * *", "Каждые 5 минут"],
    ["*/21 * * * *", "Каждую 21 минуту"],
    ["0 * * * *", "Каждый час, в начале часа"],
    ["1 * * * *", "Каждый час в 1 минуту"],
    ["22 * * * *", "Каждый час в 22 минуты"],
    ["15 * * * *", "Каждый час в 15 минут"],
    ["0,30 * * * *", "Каждый час в 0 и 30 минут"],
    ["0 */3 * * *", "Каждые 3 часа, начиная с 00:00"],
    ["0 */5 * * *", "Каждые 5 часов, начиная с 00:00"],
    ["0 */21 * * *", "Каждый 21 час, начиная с 00:00"],
    ["0 2 * * *", "Каждый день в 02:00"],
    ["30 8,12,18 * * *", "Каждый день в 08:30, 12:30 и 18:30"],
    ["0 9 * * 1-5", "В 09:00 по будням"],
    ["0 10 * * SAT,SUN", "В 10:00 по выходным"],
    ["0 22 * * 1,3,5", "В 22:00 по понедельникам, средам и пятницам"],
    ["*/5 9-17 * * 1-5", "Каждые 5 минут с 09:00 до 17:55 по будням"],
    ["0 9 * MAY *", "В 09:00 в мае"],
    ["0 0 1 1,7 *", "В 00:00 1-го числа в январе и июле"],
    ["0 0 13 * 5", "В 00:00 13-го числа или по пятницам"],
    ["0 0 L * *", "В 00:00 в последний день месяца"],
    ["0 12 1-10 * *", "В 12:00 с 1-го по 10-го числа"],
    ["0 9 * * ПН", "В 09:00 по понедельникам"],
  ];
  for (const [expr, want] of cases) assert.equal(describeCron(expr, ru), want, expr);
});

test("describeCron: other locales read as one sentence (no glued fragments)", () => {
  assert.equal(describeCron("0 9 * * 1-5", strings("de")), "Um 09:00 montags bis freitags");
  assert.equal(describeCron("0 0 1 * *", strings("fr")), "À 00:00 le 1er du mois");
  assert.equal(describeCron("0 9 * * 1-5", strings("ja")), "平日、09:00に");
  assert.equal(describeCron("*/15 * * * *", strings("ja")), "15分ごと");
  assert.equal(describeCron("30 8,12 * * *", strings("zh")), "每天08:30和12:30");
  assert.equal(describeCron("0 22 * * 1,3", strings("es")), "A las 22:00 los lunes y miércoles");
  for (const lang of ["en", "ru", "es", "de", "pt", "zh", "fr", "ja", "ko", "hi"]) {
    const s = strings(lang);
    for (const expr of ["* * * * *", "*/5 9-17 * * 1-5", "0 0 13 * 5", "0-59/10 * 1-10 * *", "0 */2 * * *", "*/10 0-5,9,12 * 1,7 0,6"]) {
      const d = describeCron(expr, s);
      assert.ok(!/\{\d\}|undefined|  |^[\s,，、]|[\s,，、]$/.test(d), `${lang} ${expr}: ${d}`);
    }
  }
});

test("describeCron: invalid input throws CronError", () => {
  assert.equal(errorOf(() => describeCron("61 * * * *", en)).code, "invalidField");
  assert.equal(errorOf(() => describeCron("@never", en)).code, "unknownPreset");
});

test("cronErrorMessage: localized messages (en, ru)", () => {
  const msg = (lang: CronStrings & Record<string, string>, fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return cronErrorMessage(e, lang as never, fieldNames);
    }
    return "";
  };
  assert.equal(msg(en, () => parseCron("* * *")), "Invalid expression: Expected 5 fields, got 3");
  assert.equal(msg(en, () => parseCron("@x")), "Invalid expression: Unknown preset");
  assert.equal(msg(en, () => parseCron("99 * * * *")), 'Invalid expression: Minute: invalid value "99" (allowed 0–59)');
  assert.equal(msg(en, () => parseCron("0 0 * * 9")), 'Invalid expression: Weekday: invalid value "9" (allowed 0–7)');
  assert.equal(
    msg(ru, () => parseCron("0 25 * * *")),
    "Недопустимое выражение: Hour: недопустимое значение «25» (допустимо 0–23)",
  );
});

test("cron-generator namespace has every key the shared core needs, in all locales", () => {
  for (const lang of ["en", "ru", "es", "de", "pt", "zh", "fr", "ja", "ko", "hi"]) {
    for (const ns of ["cron-parser", "cron-generator"]) {
      const s = strings(lang, ns);
      for (const key of [
        "errorInvalidExpression",
        "errorExpectedFields",
        "errorUnknownPreset",
        "errorFieldValue",
        "noUpcomingRuns",
        "scheduleDayOrWeekday",
        "partMinute",
        "partWeekday",
      ]) {
        assert.equal(typeof s[key], "string", `${lang}/${ns}: ${key}`);
      }
      assert.equal(s.months.length, 12, `${lang}/${ns} months`);
      assert.equal(s.weekdays.length, 7, `${lang}/${ns} weekdays`);
      // Every plural/description template renders without throwing.
      assert.ok(describeCron("*/5 */2 13 1,2 MON", s).length > 0);
    }
  }
});

test("toLocalIso / formatCronDate", () => {
  const d = new Date(2026, 0, 2, 3, 4, 5);
  assert.equal(toLocalIso(d), "2026-01-02T03:04:05+06:00");
  assert.equal(formatCronDate(d, "iso", "ru"), "2026-01-02T03:04:05+06:00");
  assert.equal(formatCronDate(d, "american", "ru"), "01/02/2026, 03:04:05 AM");
  assert.match(formatCronDate(d, "compact", "de"), /^02\.01\.2026, 03:04:05$/);
  assert.match(formatCronDate(d, "locale", "ja"), /2026/);
  assert.match(formatCronDate(d, "unknown-format", "en"), /2026/);
});
