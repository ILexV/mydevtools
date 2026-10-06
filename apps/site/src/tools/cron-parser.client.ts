/**
 * Cron Expression Parser client: wires the input, quick presets, live parse
 * (300ms debounce), copy-description and the persisted date-format select
 * (localStorage `cron-date-format`, shared with cron-generator). Validation,
 * description and next 5 runs come from the pure `cron-core.ts`; field errors
 * are localized and mark the input `aria-invalid`.
 */
import {
  CRON_FIELDS,
  cronErrorMessage,
  cronNextRuns,
  describeCron,
  expandCronPreset,
  parseCron,
  type CronErrorStrings,
  type CronFieldName,
  type CronStrings,
} from "@/tools/cron-core";
import { copyWithFeedback } from "@/scripts/tool-ui";
import { renderNextRuns, restoreDateFormat, saveDateFormat } from "@/tools/cron-ui";

type Strings = CronStrings &
  CronErrorStrings & {
    copy: string;
    copied: string;
    parseToSeeResult: string;
    noUpcomingRuns: string;
    fieldNames: Record<CronFieldName, string>;
  };

const NEXT_RUNS = 5;

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-cronp-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-cronp-tool]");
  if (!root || root.dataset.initialized === "true") return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const inputEl = root.querySelector<HTMLInputElement>("[data-cronp-input]");
  const humanEl = root.querySelector<HTMLElement>("[data-cronp-human]");
  const nextEl = root.querySelector<HTMLElement>("[data-cronp-next]");
  const errorEl = root.querySelector<HTMLElement>("[data-cronp-error]");
  if (!inputEl || !humanEl || !nextEl || !errorEl) return;
  root.dataset.initialized = "true";
  const input = inputEl;
  const humanReadable = humanEl;
  const nextExecutions = nextEl;
  const errorBox = errorEl;

  const dateFormatSelect = root.querySelector<HTMLSelectElement>("[data-cronp-date-format]");
  const parseBtn = root.querySelector<HTMLButtonElement>("[data-cronp-parse]");
  const clearBtn = root.querySelector<HTMLButtonElement>("[data-cronp-clear]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-cronp-copy]");
  const partEls = Object.fromEntries(
    CRON_FIELDS.map((f) => [f, root.querySelector<HTMLElement>(`[data-cronp-part-${f}]`)]),
  ) as Record<CronFieldName, HTMLElement | null>;

  let hasResult = false;

  function setError(msg: string) {
    errorBox.textContent = msg;
    errorBox.hidden = !msg;
    if (msg) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }

  function setParts(expr: string | null) {
    const fields = expr ? expr.split(/\s+/) : [];
    for (const [i, f] of CRON_FIELDS.entries()) {
      const el = partEls[f];
      if (el) el.textContent = fields[i] || "*";
    }
  }

  function resetResults(message: string) {
    hasResult = false;
    humanReadable.textContent = message;
    nextExecutions.replaceChildren();
    setParts(null);
  }

  function parseAction() {
    const expression = input.value.trim();
    if (!expression) {
      setError("");
      resetResults(strings.parseToSeeResult);
      return;
    }

    let schedule;
    let description: string;
    let expanded: string | null;
    try {
      schedule = parseCron(expression, strings);
      description = describeCron(expression, strings);
      expanded = expandCronPreset(expression);
    } catch (e) {
      setError(cronErrorMessage(e, strings, strings.fieldNames));
      resetResults("");
      return;
    }

    setError("");
    hasResult = true;
    humanReadable.textContent = description;
    setParts(expanded);
    const format = dateFormatSelect?.value || "locale";
    if (!schedule) {
      renderNextRuns(nextExecutions, strings.scheduleReboot, format, strings.lang);
      return;
    }
    const runs = cronNextRuns(schedule, new Date(), NEXT_RUNS);
    renderNextRuns(nextExecutions, runs.length ? runs : strings.noUpcomingRuns, format, strings.lang);
  }

  function clearAction() {
    input.value = "";
    setError("");
    resetResults(strings.parseToSeeResult);
    input.focus();
  }

  parseBtn?.addEventListener("click", parseAction);
  clearBtn?.addEventListener("click", clearAction);

  root.querySelectorAll<HTMLButtonElement>("[data-cronp-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      input.value = btn.dataset.cronpPreset || "";
      window.clearTimeout(parseTimeout);
      parseAction();
    });
  });

  let parseTimeout: number | undefined;
  input.addEventListener("input", () => {
    window.clearTimeout(parseTimeout);
    parseTimeout = window.setTimeout(parseAction, 300);
  });

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      window.clearTimeout(parseTimeout);
      parseAction();
    }
  });

  dateFormatSelect?.addEventListener("change", () => {
    saveDateFormat(dateFormatSelect.value);
    if (input.value.trim()) parseAction();
  });

  copyBtn?.addEventListener("click", () => {
    const value = humanReadable.textContent || "";
    if (!hasResult || !value) return;
    void copyWithFeedback(copyBtn, value, strings.copied);
  });

  // Restore saved date format, then parse the default expression.
  restoreDateFormat(dateFormatSelect);
  if (input.value) parseAction();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
