/**
 * Cron Expression Parser client: wires the input, quick presets, live parse
 * (300ms debounce), copy-description and the persisted date-format select
 * (localStorage `cron-date-format`, shared with cron-generator). Validation,
 * description and next runs come from the pure `cron-core.ts`; the timeline and
 * field capsules are rendered by the shared `cron-ui.ts`. Field errors are
 * localized and mark the input `aria-invalid`. Explicit submissions (button,
 * Enter, preset) announce "Schedule updated" once; while the input differs
 * from the evaluated expression the results are marked stale.
 */
import {
  cronErrorMessage,
  describeCron,
  expandCronPreset,
  parseCron,
  type CronErrorStrings,
  type CronFieldName,
  type CronStrings,
} from "@/tools/cron-core";
import { copyWithFeedback, revealOutput, syncEmptyState } from "@/scripts/tool-ui";
import { startToolOperation } from "@/scripts/analytics/instrumentation";
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
    copy: string;
    copied: string;
    copyFailed?: string;
    parseToSeeResult: string;
    fieldNames: Record<CronFieldName, string>;
  };

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
  const outputPanel = root.querySelector<HTMLElement>("[data-cronp-output-panel]");
  const capsList = root.querySelector<HTMLElement>("[data-cronp-caps]");
  const timeline = createCronTimeline(nextExecutions, strings, restoreDateFormat(dateFormatSelect));

  let hasResult = false;
  /** Expression the visible results belong to (null = none). */
  let evaluated: string | null = null;

  function setError(msg: string) {
    errorBox.textContent = msg;
    errorBox.hidden = !msg;
    if (msg) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }

  /** Results no longer match the input (typing before the debounced parse). */
  function syncStale() {
    outputPanel?.classList.toggle("is-stale", hasResult && evaluated !== input.value.trim());
  }

  /** Toggle the results placeholder (shown while there is no valid expression). */
  function setHasResult(value: boolean) {
    hasResult = value;
    if (outputPanel) syncEmptyState(outputPanel, !value);
  }

  function resetResults() {
    setHasResult(false);
    humanReadable.textContent = "";
    timeline.clear();
    setFieldCapsules(capsList, null);
    evaluated = null;
    syncStale();
  }

  /** Evaluate the input; returns true when a valid schedule was rendered. */
  function parseAction(trackOperation = false): boolean {
    const expression = input.value.trim();
    if (!expression) {
      setError("");
      resetResults();
      return false;
    }

    let schedule;
    try {
      schedule = parseCron(expression, strings);
    } catch (e) {
      setError(cronErrorMessage(e, strings, strings.fieldNames));
      resetResults();
      return false;
    }

    const operation = trackOperation ? startToolOperation("cron-parser") : null;
    try {
      const description = describeCron(expression, strings);
      const expanded = expandCronPreset(expression);
      setError("");
      setHasResult(true);
      humanReadable.textContent = description;
      setFieldCapsules(capsList, expanded);
      timeline.show({ schedule });
      evaluated = expression;
      syncStale();
      operation?.complete();
      return true;
    } catch (e) {
      operation?.fail();
      setError(cronErrorMessage(e, strings, strings.fieldNames));
      resetResults();
      return false;
    }
  }

  function clearAction() {
    input.value = "";
    setError("");
    resetResults();
    input.focus();
  }

  /** Explicit parse (button, preset, Enter): bring a fresh result into view on phones. */
  function parseAndReveal() {
    if (parseAction(true)) timeline.announceUpdate();
    if (outputPanel && !outputPanel.classList.contains("is-empty")) revealOutput(outputPanel);
  }

  parseBtn?.addEventListener("click", parseAndReveal);
  clearBtn?.addEventListener("click", clearAction);

  root.querySelectorAll<HTMLButtonElement>("[data-cronp-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      input.value = btn.dataset.cronpPreset || "";
      window.clearTimeout(parseTimeout);
      parseAndReveal();
    });
  });

  let parseTimeout: number | undefined;
  input.addEventListener("input", () => {
    syncStale();
    window.clearTimeout(parseTimeout);
    parseTimeout = window.setTimeout(parseAction, 300);
  });

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      window.clearTimeout(parseTimeout);
      if (parseAction(true)) timeline.announceUpdate();
    }
  });

  dateFormatSelect?.addEventListener("change", () => {
    saveDateFormat(dateFormatSelect.value);
    // Presentation only: re-render the same snapshot, no re-evaluation.
    timeline.setFormat(dateFormatSelect.value);
  });

  copyBtn?.addEventListener("click", () => {
    const value = humanReadable.textContent || "";
    if (!hasResult || !value) return;
    void copyWithFeedback(copyBtn, value, strings.copied, undefined, { failedLabel: strings.copyFailed });
  });

  // Date format was restored above; parse the default expression silently.
  if (input.value) parseAction();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
