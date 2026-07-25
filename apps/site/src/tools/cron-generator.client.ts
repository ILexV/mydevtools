/**
 * Cron Expression Generator client. Reads the five cron field inputs, builds
 * the expression on Generate, validates it, renders the human-readable
 * description and the next 5 execution times (local time, selectable date
 * format persisted in localStorage). Copy button with 1200ms feedback swap.
 * All logic ported from legacy `tools/cron-generator.js` — including the
 * hardcoded English error strings the legacy JS never localized.
 */
import { formatPlural, formatString } from "@/lib/format";

type Strings = {
  lang: string;
  copied: string;
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

// Cron presets (legacy parity; @reboot has no 5-field expansion).
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

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-crong-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

/** Expand one cron field into the sorted set of matching values (or ['L']/['?']). */
function parseCronField(
  field: string,
  min: number,
  max: number,
  names?: string[],
): (number | string)[] {
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

  const values: number[] = [];
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
        [start, end] = range.split("-").map(Number);
      } else {
        start = parseInt(range, 10);
        end = max;
      }

      for (let i = start; i <= end; i += stepVal) {
        values.push(i);
      }
    } else if (part.includes("-")) {
      const [start, end] = part.split("-").map(Number);
      for (let i = start; i <= end; i++) {
        values.push(i);
      }
    } else if (part === "*") {
      for (let i = min; i <= max; i++) {
        values.push(i);
      }
    } else {
      const val = parseInt(part, 10);
      if (!Number.isNaN(val)) {
        values.push(val);
      }
    }
  }

  return [...new Set(values)].sort((a, b) => a - b);
}

function validateCron(
  expression: string,
  str: Strings,
): { valid: boolean; error: string | null } {
  if (expression.startsWith("@")) {
    if (expression === "@reboot") {
      return { valid: true, error: null };
    }
    if (PRESETS[expression]) {
      return { valid: true, error: null };
    }
    return { valid: false, error: "Unknown preset" };
  }

  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { valid: false, error: `Expected 5 fields, got ${parts.length}` };
  }

  const [minute, hour, day, month, weekday] = parts;

  try {
    parseCronField(minute, 0, 59);
    parseCronField(hour, 0, 23);
    parseCronField(day, 1, 31);
    parseCronField(month, 1, 12, str.months);
    parseCronField(weekday, 0, 6, str.weekdays);
  } catch (e) {
    return { valid: false, error: (e as Error).message };
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
    return presetDesc[expression] || "Unknown preset";
  }

  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return "Invalid expression";

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
    const dayNames = weekdayVals.map((v) => str.weekdays[v as number]);
    if (dayNames.length === 1) {
      desc.push(formatString(str.scheduleOnWeekday, dayNames[0]));
    } else {
      desc.push(formatString(str.scheduleOnWeekdays, dayNames.join(", ")));
    }
  }

  if (month !== "*") {
    const monthNames = monthVals.map((v) => str.months[(v as number) - 1]);
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

/** Compute the next `count` execution times (brute-force minute scan, 500ms cap). */
function getNextExecutions(
  expression: string,
  count: number,
  str: Strings,
): (Date | string)[] {
  if (expression === "@reboot") {
    return ["Runs when system restarts"];
  }

  if (expression.startsWith("@") && PRESETS[expression]) {
    expression = PRESETS[expression] as string;
  }

  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return [];

  const [minuteField, hourField, dayField, monthField, weekdayField] = parts;

  // Parse fields once outside the loop
  const minuteVals = parseCronField(minuteField, 0, 59);
  const hourVals = parseCronField(hourField, 0, 23);
  const dayVals = parseCronField(dayField, 1, 31);
  const monthVals = parseCronField(monthField, 1, 12, str.months);
  const weekdayVals = parseCronField(weekdayField, 0, 6, str.weekdays);

  const now = new Date();
  const executions: Date[] = [];

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
  const supported = ["ru", "es", "de", "pt", "zh", "fr", "ja", "ko", "hi"];
  const pathLang = supported.includes(lang) ? lang : "en";
  const locale = pathLang === "zh" ? "zh-CN" : pathLang;
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
  const root = document.querySelector<HTMLElement>("[data-crong-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const minuteInputEl = root.querySelector<HTMLInputElement>("[data-crong-minute]");
  const hourInputEl = root.querySelector<HTMLInputElement>("[data-crong-hour]");
  const dayInputEl = root.querySelector<HTMLInputElement>("[data-crong-day]");
  const monthInputEl = root.querySelector<HTMLInputElement>("[data-crong-month]");
  const weekdayInputEl = root.querySelector<HTMLInputElement>("[data-crong-weekday]");
  const outputInputEl = root.querySelector<HTMLInputElement>("[data-crong-output]");
  const descriptionEl = root.querySelector<HTMLElement>("[data-crong-description]");
  const nextExecutionsEl = root.querySelector<HTMLElement>("[data-crong-next]");
  const dateFormatSelectEl = root.querySelector<HTMLSelectElement>("[data-crong-date-format]");
  const errorEl = root.querySelector<HTMLElement>("[data-crong-error]");
  if (
    !minuteInputEl ||
    !hourInputEl ||
    !dayInputEl ||
    !monthInputEl ||
    !weekdayInputEl ||
    !outputInputEl ||
    !descriptionEl ||
    !nextExecutionsEl ||
    !dateFormatSelectEl ||
    !errorEl
  ) {
    return;
  }
  const minuteInput = minuteInputEl;
  const hourInput = hourInputEl;
  const dayInput = dayInputEl;
  const monthInput = monthInputEl;
  const weekdayInput = weekdayInputEl;
  const outputInput = outputInputEl;
  const description = descriptionEl;
  const nextExecutions = nextExecutionsEl;
  const dateFormatSelect = dateFormatSelectEl;
  const error = errorEl;

  // Optional elements (guarded per-use).
  const generateBtn = root.querySelector<HTMLButtonElement>("[data-crong-generate]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-crong-copy]");

  function setError(msg: string) {
    if (msg) {
      error.textContent = msg;
      error.hidden = false;
    } else {
      error.hidden = true;
    }
  }

  function generateAction() {
    const minute = minuteInput.value.trim() || "*";
    const hour = hourInput.value.trim() || "*";
    const day = dayInput.value.trim() || "*";
    const month = monthInput.value.trim() || "*";
    const weekday = weekdayInput.value.trim() || "*";

    const expression = `${minute} ${hour} ${day} ${month} ${weekday}`;

    const validation = validateCron(expression, strings);
    if (!validation.valid) {
      setError(`Invalid expression: ${validation.error}`);
      outputInput.value = "";
      description.textContent = "";
      nextExecutions.innerHTML = "";
      return;
    }

    setError("");

    outputInput.value = expression;
    description.textContent = getHumanReadable(expression, strings);

    const currentFormat = dateFormatSelect.value || getSavedDateFormat();
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

  generateBtn?.addEventListener("click", generateAction);

  copyBtn?.addEventListener("click", async () => {
    const text = outputInput.value;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const original = copyBtn.innerHTML;
      copyBtn.classList.add("copied");
      copyBtn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7" /></svg>';
      copyBtn.title = strings.copied;
      window.setTimeout(() => {
        copyBtn.innerHTML = original;
        copyBtn.classList.remove("copied");
      }, 1200);
    } catch {
      /* clipboard unavailable */
    }
  });

  dateFormatSelect.addEventListener("change", () => {
    saveDateFormat(dateFormatSelect.value);
    // Re-render dates if we have results
    if (outputInput.value.trim()) {
      generateAction();
    }
  });

  // Restore saved date format
  dateFormatSelect.value = getSavedDateFormat();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}

export {};
