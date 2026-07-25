/**
 * Cron Expression Parser client. Faithful port of legacy
 * `tools/cron-parser.js`: 5-field cron parsing (plus @presets), validation,
 * human-readable description, next 5 execution times (local time, minute-step
 * scan with a 500ms/1M-attempt budget), per-field breakdown, quick presets,
 * live parse (300ms debounce), and a persisted date-format select
 * (localStorage key `cron-date-format`).
 *
 * Legacy quirks kept for parity:
 * - Month/weekday names are replaced by their 0-based index before parsing
 *   (so JAN→0); the legacy tool behaves the same way.
 * - `L` is only special in the day-of-month field; `?` parses to no values.
 * - An empty input just hides the error and leaves previous results in place.
 */
import { formatPlural, formatString } from "@/lib/format";

type Strings = {
  lang: string;
  copy: string;
  copied: string;
  parseToSeeResult: string;
  errorInvalidExpression: string;
  errorExpectedFields: string;
  errorUnknownPreset: string;
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
  months: string[];
  weekdays: string[];
}

// Cron presets (`@reboot` has no fixed schedule).
const PRESETS: Record<string, string | null> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
  "@reboot": null,
};

const DATE_FORMAT_KEY = "cron-date-format";
const COPY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const CHECK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7" /></svg>';

type FieldValue = number | string;

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-cronp-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}


/** Expand one cron field into the sorted set of matching values. */
function parseCronField(fieldRaw: string, min: number, max: number, names?: string[]): FieldValue[] {
  let field = fieldRaw;
  const values: number[] = [];

  if (names) {
    names.forEach((name, idx) => {
      field = field.replace(new RegExp(name, "gi"), String(idx));
    });
  }

  if (field === "L" && min === 1 && max === 31) {
    return ["L"];
  }

  if (field === "?") {
    return ["?"];
  }

  const parts = field.split(",");

  for (const part of parts) {
    if (part.includes("/")) {
      const [range, step] = part.split("/");
      const stepVal = parseInt(step, 10);
      let start: number;
      let end: number;

      if (range === "*") {
        start = min;
        end = max;
      } else if (range.includes("-")) {
        start = Number(range.split("-")[0]);
        end = Number(range.split("-")[1]);
      } else {
        start = parseInt(range, 10);
        end = max;
      }

      for (let i = start; i <= end; i += stepVal) {
        values.push(i);
      }
    } else if (part.includes("-")) {
      const start = Number(part.split("-")[0]);
      const end = Number(part.split("-")[1]);
      for (let i = start; i <= end; i++) {
        values.push(i);
      }
    } else if (part === "*") {
      for (let i = min; i <= max; i++) {
        values.push(i);
      }
    } else {
      const val = parseInt(part, 10);
      if (!isNaN(val)) {
        values.push(val);
      }
    }
  }

  return [...new Set(values)].sort((a, b) => a - b);
}

function validateCron(expression: string, str: Strings): { valid: boolean; error: string | null } {
  if (expression.startsWith("@")) {
    if (expression === "@reboot") {
      return { valid: true, error: null };
    }
    if (PRESETS[expression]) {
      return { valid: true, error: null };
    }
    return { valid: false, error: str.errorUnknownPreset };
  }

  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { valid: false, error: formatString(str.errorExpectedFields, parts.length) };
  }

  const [minute, hour, day, month, weekday] = parts;

  try {
    parseCronField(minute, 0, 59);
    parseCronField(hour, 0, 23);
    parseCronField(day, 1, 31);
    parseCronField(month, 1, 12, str.months);
    parseCronField(weekday, 0, 6, str.weekdays);
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : String(e) };
  }

  return { valid: true, error: null };
}

function getHumanReadable(expression: string, str: Strings): string {
  if (expression.startsWith("@")) {
    const presetDesc: Record<string, string> = {
      "@yearly": str.scheduleYearly,
      "@annually": str.scheduleYearly,
      "@monthly": str.scheduleMonthly,
      "@weekly": str.scheduleWeekly,
      "@daily": str.scheduleDaily,
      "@midnight": str.scheduleDaily,
      "@hourly": str.scheduleHourly,
      "@reboot": str.scheduleReboot,
    };
    return presetDesc[expression] || str.errorUnknownPreset;
  }

  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return formatString(str.errorInvalidExpression, "").trim();

  const [minute, hour, day, month, weekday] = parts;

  const minuteVals = parseCronField(minute, 0, 59);
  const hourVals = parseCronField(hour, 0, 23);
  const dayVals = parseCronField(day, 1, 31);
  const monthVals = parseCronField(month, 1, 12, str.months);
  const weekdayVals = parseCronField(weekday, 0, 6, str.weekdays);

  const desc: string[] = [];

  if (minute === "*") {
    desc.push(str.scheduleEveryMinute);
  } else if (minute.includes("*/")) {
    const step = minute.split("/")[1];
    desc.push(formatPlural(str, "scheduleEveryNMinutes", Number(step), str.lang));
  } else if (minuteVals.length === 1) {
    desc.push(formatString(str.scheduleAtMinute, minuteVals[0]));
  } else {
    desc.push(
      formatString(
        str.scheduleAtMinutes,
        minuteVals.slice(0, 5).join(", ") + (minuteVals.length > 5 ? "..." : ""),
      ),
    );
  }

  if (hour === "*") {
    desc.push(str.scheduleEveryHour);
  } else if (hour.includes("*/")) {
    const step = hour.split("/")[1];
    desc.push(formatPlural(str, "scheduleEveryNHours", Number(step), str.lang));
  } else if (hourVals.length === 1) {
    desc.push(formatString(str.scheduleAtHour, hourVals[0]));
  } else {
    desc.push(
      formatString(
        str.scheduleAtHours,
        hourVals.slice(0, 5).join(", ") + (hourVals.length > 5 ? "..." : ""),
      ),
    );
  }

  if (day === "*" && weekday === "*") {
    desc.push(str.scheduleEveryDay);
  } else if (day !== "*" && day !== "?" && dayVals.length > 0) {
    if (dayVals.length === 1 && dayVals[0] !== "L") {
      desc.push(formatString(str.scheduleOnDay, dayVals[0]));
    } else if (dayVals[0] === "L") {
      desc.push(str.scheduleLastDay);
    } else {
      desc.push(
        formatString(
          str.scheduleOnDays,
          dayVals.slice(0, 5).join(", ") + (dayVals.length > 5 ? "..." : ""),
        ),
      );
    }
  } else if (weekday !== "*" && weekday !== "?" && weekdayVals.length > 0) {
    const dayNames = weekdayVals.map((v) => str.weekdays[Number(v)]);
    if (dayNames.length === 1) {
      desc.push(formatString(str.scheduleOnWeekday, dayNames[0]));
    } else {
      desc.push(formatString(str.scheduleOnWeekdays, dayNames.join(", ")));
    }
  }

  if (month !== "*") {
    const monthNames = monthVals.map((v) => str.months[Number(v) - 1]);
    if (monthNames.length === 1) {
      desc.push(formatString(str.scheduleInMonth, monthNames[0]));
    } else if (monthNames.length === 12) {
      // All months - no need to mention
    } else {
      desc.push(
        formatString(
          str.scheduleInMonths,
          monthNames.slice(0, 5).join(", ") + (monthNames.length > 5 ? "..." : ""),
        ),
      );
    }
  }

  return desc
    .join(" ")
    .replace(/of every hour every/g, "every")
    .replace(/at hour every/g, "every");
}

/** Next `count` execution times, or a single string for `@reboot`. */
function getNextExecutions(expression: string, count: number, str: Strings): Array<Date | string> {
  if (expression === "@reboot") {
    return [str.scheduleReboot];
  }

  let expr = expression;
  if (expr.startsWith("@") && PRESETS[expr]) {
    expr = PRESETS[expr] as string;
  }

  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return [];

  const [minuteField, hourField, dayField, monthField, weekdayField] = parts;

  // Parse fields once outside the loop
  const minuteVals = parseCronField(minuteField, 0, 59);
  const hourVals = parseCronField(hourField, 0, 23);
  const dayVals = parseCronField(dayField, 1, 31);
  const monthVals = parseCronField(monthField, 1, 12, str.months);
  const weekdayVals = parseCronField(weekdayField, 0, 6, str.weekdays);

  const now = new Date();
  const executions: Array<Date | string> = [];

  const checkDate = new Date(now);
  checkDate.setSeconds(0, 0);

  const maxAttempts = 1000000;
  const maxTimeMs = 500;
  const startTime = Date.now();

  for (let attempts = 0; attempts < maxAttempts && executions.length < count; attempts++) {
    if (Date.now() - startTime > maxTimeMs) break;

    const matchesMinute = minuteVals.includes(checkDate.getMinutes());
    const matchesHour = hourVals.includes(checkDate.getHours());
    const matchesMonth = monthVals.includes(checkDate.getMonth() + 1);
    const matchesWeekday = weekdayVals.includes(checkDate.getDay());

    let matchesDay = false;
    if (dayField === "L") {
      const lastDay = new Date(checkDate.getFullYear(), checkDate.getMonth() + 1, 0).getDate();
      matchesDay = checkDate.getDate() === lastDay;
    } else {
      matchesDay = dayVals.includes(checkDate.getDate());
    }

    if (matchesMinute && matchesHour && matchesDay && matchesMonth && matchesWeekday) {
      if (checkDate > now) {
        executions.push(new Date(checkDate));
      }
    }

    // Increment by 1 minute
    checkDate.setMinutes(checkDate.getMinutes() + 1);
  }

  return executions;
}

function getSavedDateFormat(): string {
  try {
    return localStorage.getItem(DATE_FORMAT_KEY) || "locale";
  } catch {
    return "locale";
  }
}

function saveDateFormat(format: string): void {
  try {
    localStorage.setItem(DATE_FORMAT_KEY, format);
  } catch {
    /* storage unavailable */
  }
}

function formatDate(date: Date, format: string, lang: string): string {
  const locale = lang === "zh" ? "zh-CN" : lang;
  switch (format) {
    case "iso":
      return date.toISOString().slice(0, 19).replace("T", " ");
    case "compact":
      return date.toLocaleString(locale, {
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
      });
    case "american":
      return date.toLocaleString("en-US", {
        month: "2-digit", day: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true,
      });
    case "full-month":
      return date.toLocaleString(locale, {
        weekday: "short", year: "numeric", month: "long", day: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
      });
    case "verbose":
      return date.toLocaleString(locale, {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
      });
    case "locale-12h":
      return date.toLocaleString(locale, {
        weekday: "short", year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true,
      });
    case "locale":
    default:
      return date.toLocaleString(locale, {
        weekday: "short", year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
      });
  }
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-cronp-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const inputEl = root.querySelector<HTMLInputElement>("[data-cronp-input]");
  const humanEl = root.querySelector<HTMLElement>("[data-cronp-human]");
  const nextEl = root.querySelector<HTMLElement>("[data-cronp-next]");
  const errorEl = root.querySelector<HTMLElement>("[data-cronp-error]");
  if (!inputEl || !humanEl || !nextEl || !errorEl) return;
  const input = inputEl;
  const humanReadable = humanEl;
  const nextExecutions = nextEl;
  const errorBox = errorEl;

  const dateFormatSelect = root.querySelector<HTMLSelectElement>("[data-cronp-date-format]");
  const parseBtn = root.querySelector<HTMLButtonElement>("[data-cronp-parse]");
  const clearBtn = root.querySelector<HTMLButtonElement>("[data-cronp-clear]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-cronp-copy]");
  const copyText = root.querySelector<HTMLElement>("[data-cronp-copy-text]");
  const partEls = {
    minute: root.querySelector<HTMLElement>("[data-cronp-part-minute]"),
    hour: root.querySelector<HTMLElement>("[data-cronp-part-hour]"),
    day: root.querySelector<HTMLElement>("[data-cronp-part-day]"),
    month: root.querySelector<HTMLElement>("[data-cronp-part-month]"),
    weekday: root.querySelector<HTMLElement>("[data-cronp-part-weekday]"),
  };

  function setError(msg: string) {
    if (msg) {
      errorBox.textContent = msg;
      errorBox.hidden = false;
    } else {
      errorBox.hidden = true;
    }
  }

  function parseAction() {
    const expression = input.value.trim();
    if (!expression) {
      setError("");
      return;
    }

    const validation = validateCron(expression, strings);
    if (!validation.valid) {
      setError(formatString(strings.errorInvalidExpression, validation.error ?? ""));
      humanReadable.textContent = "";
      nextExecutions.innerHTML = "";
      return;
    }

    setError("");

    humanReadable.textContent = getHumanReadable(expression, strings);

    let parts = expression;
    if (expression.startsWith("@") && PRESETS[expression]) {
      parts = PRESETS[expression] as string;
    }
    const [m, h, d, mo, w] = parts.split(/\s+/);
    if (partEls.minute) partEls.minute.textContent = m || "*";
    if (partEls.hour) partEls.hour.textContent = h || "*";
    if (partEls.day) partEls.day.textContent = d || "*";
    if (partEls.month) partEls.month.textContent = mo || "*";
    if (partEls.weekday) partEls.weekday.textContent = w || "*";

    const currentFormat = dateFormatSelect ? dateFormatSelect.value : getSavedDateFormat();
    const nextExecs = getNextExecutions(expression, 5, strings);
    nextExecutions.innerHTML = nextExecs
      .map((date, idx) => {
        if (typeof date === "string") {
          return `<div class="next-row plain">${date}</div>`;
        }
        return `<div class="next-row">${idx + 1}. ${formatDate(date, currentFormat, strings.lang)}</div>`;
      })
      .join("");
  }

  function clearAction() {
    input.value = "";
    humanReadable.textContent = strings.parseToSeeResult;
    nextExecutions.innerHTML = "";
    setError("");

    if (partEls.minute) partEls.minute.textContent = "*";
    if (partEls.hour) partEls.hour.textContent = "*";
    if (partEls.day) partEls.day.textContent = "*";
    if (partEls.month) partEls.month.textContent = "*";
    if (partEls.weekday) partEls.weekday.textContent = "*";
  }

  parseBtn?.addEventListener("click", parseAction);
  clearBtn?.addEventListener("click", clearAction);

  root.querySelectorAll<HTMLButtonElement>("[data-cronp-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      input.value = btn.getAttribute("data-cronp-preset") || "";
      parseAction();
    });
  });

  let parseTimeout: number | undefined;
  input.addEventListener("input", () => {
    window.clearTimeout(parseTimeout);
    parseTimeout = window.setTimeout(parseAction, 300);
  });

  input.addEventListener("keypress", (ev) => {
    if (ev.key === "Enter") {
      parseAction();
    }
  });

  dateFormatSelect?.addEventListener("change", () => {
    saveDateFormat(dateFormatSelect.value);
    // Re-render dates if we have results
    if (input.value.trim()) {
      parseAction();
    }
  });

  copyBtn?.addEventListener("click", async () => {
    const value = humanReadable.textContent || "";
    if (!value || value === strings.parseToSeeResult) return;
    try {
      await navigator.clipboard.writeText(value);
      copyBtn.classList.add("copied");
      copyBtn.innerHTML = `${CHECK_ICON}<span class="copy-text" data-cronp-copy-text>${strings.copied}</span>`;
      copyBtn.title = strings.copied;
      window.setTimeout(() => {
        copyBtn.classList.remove("copied");
        copyBtn.innerHTML = `${COPY_ICON}<span class="copy-text" data-cronp-copy-text>${strings.copy}</span>`;
        copyBtn.title = strings.copy;
      }, 1200);
    } catch {
      /* clipboard unavailable */
    }
  });

  // Restore saved date format, then parse the default expression.
  if (dateFormatSelect) {
    dateFormatSelect.value = getSavedDateFormat();
  }
  if (input.value) {
    parseAction();
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}

export {};
