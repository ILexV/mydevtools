/**
 * Cron Expression Generator client: reads the five field inputs, builds the
 * expression on Generate (or Enter in a field), validates it with the shared
 * `cron-core.ts`, renders the description and next 5 runs (persisted date
 * format, shared with cron-parser). Invalid fields get a localized error and
 * `aria-invalid`; copy uses the shared `.is-copied` feedback.
 */
import {
  CRON_FIELDS,
  CronError,
  cronErrorMessage,
  cronNextRuns,
  describeCron,
  parseCron,
  type CronErrorStrings,
  type CronFieldName,
  type CronStrings,
} from "@/tools/cron-core";
import { copyWithFeedback } from "@/scripts/tool-ui";
import { renderNextRuns, restoreDateFormat, saveDateFormat } from "@/tools/cron-ui";

type Strings = CronStrings &
  CronErrorStrings & {
    copied: string;
    noUpcomingRuns: string;
    fieldNames: Record<CronFieldName, string>;
  };

const NEXT_RUNS = 5;

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-crong-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-crong-tool]");
  if (!root || root.dataset.initialized === "true") return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const inputs = Object.fromEntries(
    CRON_FIELDS.map((f) => [f, root.querySelector<HTMLInputElement>(`[data-crong-${f}]`)]),
  ) as Record<CronFieldName, HTMLInputElement | null>;
  const outputEl = root.querySelector<HTMLInputElement>("[data-crong-output]");
  const descriptionEl = root.querySelector<HTMLElement>("[data-crong-description]");
  const nextEl = root.querySelector<HTMLElement>("[data-crong-next]");
  const selectEl = root.querySelector<HTMLSelectElement>("[data-crong-date-format]");
  const errorEl = root.querySelector<HTMLElement>("[data-crong-error]");
  if (!outputEl || !descriptionEl || !nextEl || !selectEl || !errorEl) return;
  if (CRON_FIELDS.some((f) => !inputs[f])) return;
  root.dataset.initialized = "true";
  const output = outputEl;
  const description = descriptionEl;
  const nextExecutions = nextEl;
  const dateFormatSelect = selectEl;
  const error = errorEl;

  const generateBtn = root.querySelector<HTMLButtonElement>("[data-crong-generate]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-crong-copy]");

  function setError(msg: string, field?: CronFieldName) {
    error.textContent = msg;
    error.hidden = !msg;
    for (const f of CRON_FIELDS) {
      const el = inputs[f];
      if (!el) continue;
      if (msg && (field === undefined || field === f)) el.setAttribute("aria-invalid", "true");
      else el.removeAttribute("aria-invalid");
    }
  }

  function generateAction() {
    const expression = CRON_FIELDS.map((f) => inputs[f]?.value.trim() || "*").join(" ");

    let schedule;
    let text: string;
    try {
      schedule = parseCron(expression, strings);
      text = describeCron(expression, strings);
    } catch (e) {
      setError(cronErrorMessage(e, strings, strings.fieldNames), e instanceof CronError ? e.field : undefined);
      output.value = "";
      description.textContent = "";
      nextExecutions.replaceChildren();
      return;
    }

    setError("");
    output.value = expression;
    description.textContent = text;
    const format = dateFormatSelect.value || "locale";
    if (!schedule) {
      renderNextRuns(nextExecutions, strings.scheduleReboot, format, strings.lang);
      return;
    }
    const runs = cronNextRuns(schedule, new Date(), NEXT_RUNS);
    renderNextRuns(nextExecutions, runs.length ? runs : strings.noUpcomingRuns, format, strings.lang);
  }

  generateBtn?.addEventListener("click", generateAction);
  for (const f of CRON_FIELDS) {
    inputs[f]?.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") generateAction();
    });
  }

  copyBtn?.addEventListener("click", () => {
    if (!output.value) return;
    void copyWithFeedback(copyBtn, output.value, strings.copied);
  });

  dateFormatSelect.addEventListener("change", () => {
    saveDateFormat(dateFormatSelect.value);
    if (output.value.trim()) generateAction();
  });

  restoreDateFormat(dateFormatSelect);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
