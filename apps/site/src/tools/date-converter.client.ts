/**
 * Date Converter client. Wires input/type/format selects + custom-format field
 * to live conversion, current-time fill, copy, and error display. All parsing
 * and formatting delegates to `dates.ts`. Below the machine-readable output:
 * the assumed zone for zone-less input, a relative-time line (refreshed once a
 * minute while the page is visible, never announced) and "Same instant" rows
 * from `date-zones.ts`. "Now" captures one instant; it is not a running clock.
 */
import { parse, format, type InputType, type OutputFormat } from "@/tools/dates";
import { assumedZone, relativeUnit, sameInstantZones, utcOffset, zonedDateTime, zoneName } from "@/tools/date-zones";
import {
  bindEmptyState,
  bindLoadExample,
  copyWithFeedback,
  revealOutput,
  setFieldValue,
  syncEmptyState,
} from "@/scripts/tool-ui";

/** Language-neutral example: 2023-11-14T22:13:20Z as Unix seconds (auto-detected). */
const EXAMPLE = "1700000000";

interface Strings {
  lang: string;
  copied: string;
  copyFailed: string;
  errorInvalid: string;
  zoneUtc: string;
  zoneDevice: string;
  relativeLine: string;
  assumedUtc: string;
  assumedLocal: string;
}

/** Replace `{name}` placeholders in a localized template. */
function fill(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => (key in params ? params[key] : m));
}

/** Device IANA zone, or undefined when the engine does not expose one. */
function deviceZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

const RELATIVE_REFRESH_MS = 60_000;

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-date-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init(): void {
  const root = document.querySelector<HTMLElement>("[data-date-tool]");
  if (!root || root.dataset.initialized) return;
  root.dataset.initialized = "1";
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const input = root.querySelector<HTMLTextAreaElement>("[data-date-input]");
  const inputType = root.querySelector<HTMLSelectElement>("[data-date-input-type]");
  const output = root.querySelector<HTMLTextAreaElement>("[data-date-output]");
  const outputFormat = root.querySelector<HTMLSelectElement>("[data-date-output-format]");
  const customWrap = root.querySelector<HTMLElement>("[data-date-custom-wrap]");
  const customInput = root.querySelector<HTMLInputElement>("[data-date-custom]");
  const convertBtn = root.querySelector<HTMLButtonElement>("[data-date-convert]");
  const nowBtn = root.querySelector<HTMLButtonElement>("[data-date-now]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-date-copy]");
  const errorEl = root.querySelector<HTMLElement>("[data-date-error]");
  const inputHost = root.querySelector<HTMLElement>("[data-date-input-host]");
  const outputPanel = root.querySelector<HTMLElement>("[data-date-output-panel]");
  const exampleBtn = root.querySelector<HTMLButtonElement>("[data-date-example]");
  const syncInput = inputHost && input ? bindEmptyState(inputHost, input) : () => {};
  const assumedEl = root.querySelector<HTMLElement>("[data-date-assumed]");
  const relativeEl = root.querySelector<HTMLTimeElement>("[data-date-relative]");
  const zonesEl = root.querySelector<HTMLElement>("[data-date-zones]");
  const rtf = new Intl.RelativeTimeFormat(strings.lang, { numeric: "auto" });
  const device = deviceZone();
  /** Instant currently shown (ms since epoch), null while empty/invalid. */
  let instant: number | null = null;
  let refreshTimer: number | undefined;

  /** Relative-time line ("3 years ago", "in 2 hours") for the shown instant vs. now. */
  function renderRelative(): void {
    if (!relativeEl || instant === null) return;
    const { value, unit } = relativeUnit(instant, Date.now());
    relativeEl.textContent = fill(strings.relativeLine, { relative: rtf.format(value, unit) });
  }

  /** Minute refresh only while something is shown and the page is visible. */
  function scheduleRefresh(): void {
    window.clearInterval(refreshTimer);
    refreshTimer = undefined;
    if (instant === null || document.visibilityState !== "visible") return;
    refreshTimer = window.setInterval(renderRelative, RELATIVE_REFRESH_MS);
  }

  /** "Same instant" rows: one <div><dt>zone</dt><dd><time>…</time> offset</dd></div> per zone. */
  function renderZones(date: Date, iso: string): void {
    if (!zonesEl) return;
    const frag = document.createDocumentFragment();
    for (const row of sameInstantZones(device)) {
      const wrap = document.createElement("div");
      wrap.className = "date-zone-row";
      const dt = document.createElement("dt");
      const name = row.utc ? strings.zoneUtc : zoneName(date, row.zone, strings.lang) || row.zone;
      const nameEl = document.createElement("span");
      nameEl.className = "date-zone-name";
      nameEl.textContent = row.device ? fill(strings.zoneDevice, { zone: name }) : name;
      const idEl = document.createElement("span");
      idEl.className = "date-zone-id";
      idEl.dir = "ltr";
      idEl.textContent = row.zone;
      dt.append(nameEl, idEl);
      const dd = document.createElement("dd");
      const time = document.createElement("time");
      time.className = "date-zone-time";
      time.dateTime = iso;
      time.textContent = zonedDateTime(date, row.zone, strings.lang);
      const offset = document.createElement("span");
      offset.className = "date-zone-offset";
      offset.dir = "ltr";
      offset.textContent = utcOffset(date, row.zone);
      dd.append(time, offset);
      wrap.append(dt, dd);
      frag.append(wrap);
    }
    zonesEl.replaceChildren(frag);
  }

  /** Fill (or clear with null) the assumed-zone note, relative line and zone rows. */
  function renderInstant(date: Date | null, raw = "", type: InputType = "auto"): void {
    instant = date ? date.getTime() : null;
    if (date) {
      const iso = date.toISOString();
      if (relativeEl) relativeEl.dateTime = iso;
      renderRelative();
      renderZones(date, iso);
      const assumed = assumedZone(raw, type);
      if (assumedEl) {
        assumedEl.hidden = assumed === null;
        assumedEl.textContent =
          assumed === "utc" ? strings.assumedUtc : assumed === "local" ? fill(strings.assumedLocal, { zone: device ?? "" }) : "";
      }
    }
    scheduleRefresh();
  }

  /**
   * Write the result and collapse/expand the output panel's empty state. Copy is
   * enabled only while there is a converted result (disabled when empty/cleared/invalid).
   */
  function setOutput(text: string): void {
    if (output) output.value = text;
    if (outputPanel) syncEmptyState(outputPanel, text === "");
    if (copyBtn) copyBtn.disabled = text === "";
  }

  function toggleCustom(): void {
    if (!customWrap || !outputFormat) return;
    customWrap.hidden = outputFormat.value !== "custom";
  }

  function showError(msg: string): void {
    if (!errorEl) return;
    errorEl.hidden = !msg;
    errorEl.textContent = msg;
  }

  function convert(): void {
    if (!input || !inputType || !outputFormat || !output) return;
    toggleCustom();
    const val = input.value;
    if (!val.trim()) {
      setOutput("");
      renderInstant(null);
      showError("");
      input.removeAttribute("aria-invalid");
      return;
    }
    const date = parse(val, inputType.value as InputType);
    if (!date || Number.isNaN(date.getTime())) {
      showError(strings.errorInvalid);
      input.setAttribute("aria-invalid", "true");
      setOutput("");
      renderInstant(null);
      return;
    }
    showError("");
    input.removeAttribute("aria-invalid");
    const custom = customInput ? customInput.value : "";
    const text = format(date, outputFormat.value as OutputFormat, custom, strings.lang) ?? "";
    setOutput(text);
    renderInstant(text ? date : null, val, inputType.value as InputType);
  }

  function currentTime(): void {
    if (!input || !inputType) return;
    const now = new Date();
    const type = inputType.value as InputType;
    if (type === "unix-sec" || type === "auto") {
      input.value = Math.floor(now.getTime() / 1000).toString();
    } else if (type === "unix-ms") {
      input.value = now.getTime().toString();
    } else {
      input.value = now.toISOString();
    }
    syncInput();
    convert();
  }

  async function copy(): Promise<void> {
    if (!output || !copyBtn) return;
    const text = output.value;
    if (!text) return;
    if (!(await copyWithFeedback(copyBtn, text, strings.copied))) showError(strings.copyFailed);
  }

  if (exampleBtn && input) bindLoadExample(exampleBtn, () => setFieldValue(input, EXAMPLE));
  /** Explicit Convert / Now: bring a fresh result into view on phones (never on typing). */
  const revealIfFilled = () => {
    if (output?.value) revealOutput(outputPanel);
  };
  convertBtn?.addEventListener("click", () => {
    convert();
    revealIfFilled();
  });
  nowBtn?.addEventListener("click", () => {
    currentTime();
    revealIfFilled();
  });
  copyBtn?.addEventListener("click", () => void copy());
  input?.addEventListener("input", convert);
  customInput?.addEventListener("input", convert);
  inputType?.addEventListener("change", convert);
  outputFormat?.addEventListener("change", convert);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") renderRelative();
    scheduleRefresh();
  });

  convert();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
