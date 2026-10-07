/**
 * Cron Expression Generator client: reads the five field inputs, builds the
 * expression on Generate (or Enter in a field), validates it with the shared
 * `cron-core.ts`, renders field capsules, the description and the shared
 * next-run timeline (`cron-ui.ts`; persisted date format, shared with
 * cron-parser). A successful Generate announces "Schedule updated" once;
 * editing a field afterwards marks the result stale (muted + visible hint)
 * until the fields match the generated expression again. Invalid fields get a
 * localized error and `aria-invalid`; copy uses the shared `.is-copied`
 * feedback. The default fields are generated once on load (silently); the
 * result panel shows a compact placeholder only while the fields are invalid.
 */
import {
  CRON_FIELDS,
  CronError,
  cronErrorMessage,
  describeCron,
  parseCron,
  type CronErrorStrings,
  type CronFieldName,
  type CronStrings,
} from "@/tools/cron-core";
import { copyWithFeedback, revealOutput, syncEmptyState } from "@/scripts/tool-ui";
import {
  createCronTimeline,
  restoreDateFormat,
  saveDateFormat,
  setFieldCapsules,
  type CronTimelineStrings,
} from "@/tools/cron-ui";

type Strings = CronStrings &
  CronErrorStrings &
  CronTimelineStrings & {
    copied: string;
    copyFailed?: string;
    fieldNames: Record<CronFieldName, string>;
  };

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
  const outputEl = root.querySelector<HTMLOutputElement>("[data-crong-output]");
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
  const outputPanel = root.querySelector<HTMLElement>("[data-crong-output-panel]");
  const capsList = root.querySelector<HTMLElement>("[data-crong-caps]");
  const staleHint = root.querySelector<HTMLElement>("[data-crong-stale]");
  const timeline = createCronTimeline(nextExecutions, strings, restoreDateFormat(dateFormatSelect));
  const setFilled = (filled: boolean) => {
    if (outputPanel) syncEmptyState(outputPanel, !filled);
  };
  const currentExpression = () => CRON_FIELDS.map((f) => inputs[f]?.value.trim() || "*").join(" ");

  /** Result no longer matches the fields: mute it and show the "generate again" hint. */
  function syncStale() {
    const stale = !!output.value && currentExpression() !== output.value;
    outputPanel?.classList.toggle("is-stale", stale);
    if (staleHint) staleHint.hidden = !stale;
  }

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

  /** Build + evaluate the expression; returns true when a valid schedule was rendered. */
  function generateAction(): boolean {
    const expression = currentExpression();

    let schedule;
    let text: string;
    try {
      schedule = parseCron(expression, strings);
      text = describeCron(expression, strings);
    } catch (e) {
      setError(cronErrorMessage(e, strings, strings.fieldNames), e instanceof CronError ? e.field : undefined);
      output.value = "";
      description.textContent = "";
      timeline.clear();
      setFieldCapsules(capsList, null);
      setFilled(false);
      syncStale();
      return false;
    }

    setError("");
    output.value = expression;
    description.textContent = text;
    setFieldCapsules(capsList, expression);
    timeline.show({ schedule });
    setFilled(true);
    syncStale();
    return true;
  }

  generateBtn?.addEventListener("click", () => {
    if (generateAction()) timeline.announceUpdate();
    if (outputPanel && !outputPanel.classList.contains("is-empty")) revealOutput(outputPanel);
  });
  for (const f of CRON_FIELDS) {
    inputs[f]?.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && generateAction()) timeline.announceUpdate();
    });
    inputs[f]?.addEventListener("input", syncStale);
  }

  copyBtn?.addEventListener("click", () => {
    if (!output.value) return;
    void copyWithFeedback(copyBtn, output.value, strings.copied, undefined, { failedLabel: strings.copyFailed });
  });

  dateFormatSelect.addEventListener("change", () => {
    saveDateFormat(dateFormatSelect.value);
    // Presentation only: re-render the same snapshot, no re-evaluation.
    timeline.setFormat(dateFormatSelect.value);
  });

  // Like cron-parser: render the valid default fields once on load, silently
  // (no "Schedule updated" announcement, no scroll); invalid defaults stay empty.
  generateAction();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
