/**
 * Regex Tester client. Live regex testing via the Rust regex WASM engine
 * (`regex-client`): 150ms debounce on pattern/text input, immediate on flag
 * change. Match highlighting via a backdrop layer under the transparent
 * textarea (scroll-synced): subdued whole-match shading plus capture groups
 * in six recurring spectrum colours (inner group = fill, enclosing group =
 * underline). A group legend (toggle buttons) emphasizes one group in the
 * text and in the per-match details (value / empty string / not matched,
 * UTF-16 range). Match list render limit 50 (legacy parity); capture colours
 * for the first 1,000 matches only. The match count is announced once, after
 * typing settles. Quick examples table, and saved patterns persisted in
 * localStorage under `mydevtools_regex_saved` (legacy key + entry shape) —
 * only on explicit "Save pattern" (the sample text is stored with it).
 * Match positions from WASM are UTF-16 offsets (see wasm/regex_tool).
 */
import { regexTest } from "@/scripts/wasm/regex-client";
import { announce, bindEmptyState, bindLoadExample, syncEmptyState, withPreparing } from "@/scripts/tool-ui";
import {
  applyGlobalFlag,
  buildHighlightHtml,
  buildRustPattern,
  captureHue,
  captureLabel,
  captureState,
  escapeHtml,
  parseSavedPatterns,
  truncateText,
  type CaptureSpan,
  type SavedPattern,
} from "@/tools/regex-tester-core";

interface Strings {
  noMatches: string;
  loadButton: string;
  deleteButton: string;
  deleteConfirm: string;
  matchNumber: string;
  moreMatches: string;
  engineError: string;
  storageError: string;
  preparing: string;
  /** Group 0 label suffix, e.g. "whole match" → "0 · whole match". */
  wholeMatch: string;
  notMatched: string;
  emptyString: string;
  /** "Capture groups ({count})" — per-match details toggle. */
  groupsSummary: string;
  /** "Capture colours are shown for the first {count} matches." */
  captureLimit: string;
  /** "Matches found: {count}" — polite announcement once typing settles. */
  announceMatches: string;
}

/** WASM `test_regex` result JSON (wasm/regex_tool/src/lib.rs); every group 1..n per match. */
interface RegexMatch {
  text: string;
  start: number;
  end: number;
  captures: CaptureSpan[];
}
interface RegexResult {
  matches: RegexMatch[];
  error: string | null;
  truncated?: boolean;
  /** Names of groups 1..n (null/undefined = unnamed). */
  groups?: Array<string | null | undefined>;
}

const STORAGE_KEY = "mydevtools_regex_saved";
const DEBOUNCE_MS = 150;
const RENDER_LIMIT = 50;
/** Matches whose capture groups are coloured in the backdrop (DOM budget for huge match counts). */
const CAPTURE_HIGHLIGHT_LIMIT = 1000;
/** Quiet period after the last result before the match count is announced. */
const ANNOUNCE_DELAY_MS = 1200;

/** Legacy COMMON_REGEXES (1:1). */
const COMMON_REGEXES: Array<{ name: string; pattern: string; sample: string }> = [
  { name: "Email", pattern: "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}", sample: "test@example.com\ninvalid-email\nuser.name+tag@mail.co.uk" },
  { name: "IPv4 Address", pattern: "\\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\b", sample: "192.168.1.1\n10.0.0.1\n256.0.0.1 (invalid)" },
  { name: "Date (YYYY-MM-DD)", pattern: "\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])", sample: "2023-12-31\n2024-02-29\n2023-13-01 (invalid)" },
  { name: "Hex Color", pattern: "#?([a-fA-F0-9]{6}|[a-fA-F0-9]{3})", sample: "#FFF\n#000000\n#555555" },
  { name: "URL (Simple)", pattern: "https?:\\/\\/[\\w\\-\\.]+(?::\\d+)?(?:\\/[\\w\\-._~:/?#[\\]@!$&'()*+,;=]*)?", sample: "https://www.google.com\nhttp://localhost:8080/api/v1" },
];

const LOAD_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="16" height="16" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" /></svg>';
const DELETE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="16" height="16" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>';

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-rx-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function getSavedPatterns(): SavedPattern[] {
  try {
    return parseSavedPatterns(localStorage.getItem(STORAGE_KEY));
  } catch {
    return []; // storage blocked (privacy mode / sandbox)
  }
}

/** Persist saved patterns; false when storage is unavailable or full. */
function setSavedPatterns(list: SavedPattern[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

function init(): void {
  const root = document.querySelector<HTMLElement>("[data-rx-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const patternEl = root.querySelector<HTMLInputElement>("[data-rx-pattern]");
  const textEl = root.querySelector<HTMLTextAreaElement>("[data-rx-text]");
  const backdropEl = root.querySelector<HTMLElement>("[data-rx-backdrop]");
  const resultsEl = root.querySelector<HTMLElement>("[data-rx-results]");
  const countEl = root.querySelector<HTMLElement>("[data-rx-count]");
  const errorBoxEl = root.querySelector<HTMLElement>("[data-rx-error]");
  const examplesBodyEl = root.querySelector<HTMLElement>("[data-rx-examples-body]");
  const savedBodyEl = root.querySelector<HTMLElement>("[data-rx-saved-body]");
  const savedEmptyEl = root.querySelector<HTMLElement>("[data-rx-saved]");
  const dialogEl = root.querySelector<HTMLDialogElement>("[data-rx-dialog]");
  const saveNameEl = root.querySelector<HTMLInputElement>("[data-rx-save-name]");
  const cheatsheetEl = root.querySelector<HTMLElement>("[data-rx-cheatsheet]");
  const cheatsheetToggleEl = root.querySelector<HTMLButtonElement>("[data-rx-cheatsheet-toggle]");
  const textHost = root.querySelector<HTMLElement>("[data-rx-text-host]");
  const matchesPanel = root.querySelector<HTMLElement>("[data-rx-matches]");
  const exampleBtn = root.querySelector<HTMLButtonElement>("[data-rx-example]");
  const flagEls = Array.from(root.querySelectorAll<HTMLInputElement>("[data-rx-flag]"));
  const legendEl = root.querySelector<HTMLElement>("[data-rx-legend]");
  const legendListEl = root.querySelector<HTMLElement>("[data-rx-legend-list]");

  if (!patternEl || !textEl || !backdropEl || !resultsEl || !countEl || !examplesBodyEl || !savedBodyEl || !savedEmptyEl || !dialogEl || !saveNameEl || !errorBoxEl) return;
  const errorBox: HTMLElement = errorBoxEl;
  const pattern: HTMLInputElement = patternEl;
  const text: HTMLTextAreaElement = textEl;
  const backdrop: HTMLElement = backdropEl;
  const results: HTMLElement = resultsEl;
  const countBadge: HTMLElement = countEl;
  const examplesBody: HTMLElement = examplesBodyEl;
  const savedBody: HTMLElement = savedBodyEl;
  const savedEmpty: HTMLElement = savedEmptyEl;
  const dialog: HTMLDialogElement = dialogEl;
  const saveName: HTMLInputElement = saveNameEl;
  const flags: HTMLInputElement[] = flagEls;

  const syncText = textHost ? bindEmptyState(textHost, text) : () => {};
  /** Matches panel shows its empty state until there is a pattern to test. */
  const syncMatches = () => {
    if (matchesPanel) syncEmptyState(matchesPanel, pattern.value === "");
  };

  let debounceTimer = 0;
  let runSeq = 0;
  let announceTimer = 0;
  let lastAnnounced = "";
  /** Last successful run, kept so legend selection can re-colour without re-running WASM. */
  let lastText = "";
  let lastMatches: RegexMatch[] = [];
  /** Group names 1..n of the current pattern (legend source). */
  let groupNames: Array<string | null> = [];
  /** Emphasized capture group (1-based) or null. */
  let selectedGroup: number | null = null;

  function syncScroll(): void {
    backdrop.scrollTop = text.scrollTop;
    backdrop.scrollLeft = text.scrollLeft;
  }

  /** `patternInvalid` = false for non-pattern errors (storage) so the field isn't flagged. */
  function setError(message: string | null, patternInvalid = true): void {
    errorBox.textContent = message ?? "";
    errorBox.hidden = message === null;
    if (message === null || !patternInvalid) pattern.removeAttribute("aria-invalid");
    else pattern.setAttribute("aria-invalid", "true");
  }

  /** Announce the match count once the user pauses (never per keystroke, never twice in a row). */
  function scheduleAnnounce(message: string): void {
    window.clearTimeout(announceTimer);
    announceTimer = window.setTimeout(() => {
      if (message === lastAnnounced) return;
      lastAnnounced = message;
      announce(message);
    }, ANNOUNCE_DELAY_MS);
  }

  /** Repaint the highlight backdrop from the last result (selection changes reuse it). */
  function paintBackdrop(): void {
    backdrop.innerHTML = buildHighlightHtml(lastText, lastMatches, {
      selected: selectedGroup,
      captureLimit: CAPTURE_HIGHLIGHT_LIMIT,
    });
    syncScroll();
  }

  /** Legend buttons `1`, `2 · name`… (aria-pressed toggles); rebuilt only when the group set changes. */
  function renderLegend(names: Array<string | null>): void {
    const same = names.length === groupNames.length && names.every((n, i) => n === groupNames[i]);
    groupNames = names;
    if (selectedGroup !== null && selectedGroup > names.length) selectedGroup = null;
    if (!legendEl || !legendListEl) return;
    legendEl.hidden = names.length === 0;
    if (same && legendListEl.childElementCount === names.length) return;
    legendListEl.innerHTML = names
      .map((name, i) => {
        const index = i + 1;
        const pressed = index === selectedGroup;
        return `<button type="button" class="ds-chip-btn rx-legend-item rx-c${captureHue(index)}" data-rx-group="${index}" aria-pressed="${pressed}"><span class="rx-swatch" aria-hidden="true"></span><span class="rx-legend-text">${escapeHtml(captureLabel(index, name))}</span></button>`;
      })
      .join("");
  }

  /** Reflect the selected group on legend buttons and detail rows (no re-render, keeps open <details>). */
  function applySelection(): void {
    legendListEl?.querySelectorAll<HTMLElement>("[data-rx-group]").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(Number(btn.dataset.rxGroup) === selectedGroup));
    });
    results.classList.toggle("has-selection", selectedGroup !== null);
    results.querySelectorAll<HTMLElement>("[data-rx-group-row]").forEach((row) => {
      row.classList.toggle("is-sel", Number(row.dataset.rxGroupRow) === selectedGroup);
    });
  }

  function clearResultState(): void {
    lastText = text.value;
    lastMatches = [];
    paintBackdrop();
  }

  function showNoMatches(): void {
    setError(null);
    results.innerHTML = `<p class="ds-empty">${escapeHtml(strings.noMatches)}</p>`;
    countBadge.textContent = "0";
  }

  function showError(message: string): void {
    setError(message);
    results.innerHTML = "";
    countBadge.textContent = "—";
    renderLegend([]);
    clearResultState();
    window.clearTimeout(announceTimer); // the error itself is a role=alert
  }

  /** One details row: group label (+ colour swatch), exact value or state, UTF-16 range. */
  function groupRowHtml(index: number, label: string, c: CaptureSpan | null, value: string, start: number, end: number): string {
    const state = c ? captureState(c) : end > start ? "value" : "empty";
    const hue = index > 0 ? ` rx-c${captureHue(index)}` : " rx-g0";
    const sel = index > 0 && index === selectedGroup ? " is-sel" : "";
    let valueHtml: string;
    if (state === "unmatched") valueHtml = `<em class="rx-group-state">${escapeHtml(strings.notMatched)}</em>`;
    else if (state === "empty") valueHtml = `<em class="rx-group-state">${escapeHtml(strings.emptyString)}</em>`;
    else valueHtml = `<span class="rx-group-text">${escapeHtml(truncateText(value))}</span>`;
    const pos = state === "unmatched" ? "—" : `[${start}–${end}]`;
    return `<div class="rx-group${hue}${sel}"${index > 0 ? ` data-rx-group-row="${index}"` : ""}>
      <span class="rx-group-name">${index > 0 ? '<span class="rx-swatch" aria-hidden="true"></span>' : ""}${escapeHtml(label)}</span>
      ${valueHtml}
      <span class="rx-group-pos">${pos}</span>
    </div>`;
  }

  function renderMatchDetails(matches: RegexMatch[], truncated: boolean): void {
    setError(null);
    countBadge.textContent = truncated ? `${matches.length}+` : String(matches.length);

    if (matches.length === 0) {
      results.innerHTML = `<p class="ds-empty">${escapeHtml(strings.noMatches)}</p>`;
      return;
    }

    const visible = matches.slice(0, RENDER_LIMIT);
    let html = "";
    visible.forEach((m, idx) => {
      const head = `
          <span class="rx-match-title">${escapeHtml(strings.matchNumber.replace("{n}", String(idx + 1)))}</span>
          <span class="rx-pos">[${m.start}–${m.end}]</span>`;
      const caps = m.captures ?? [];
      if (caps.length === 0) {
        html += `
        <div class="rx-match">
          <div class="rx-match-head">${head}</div>
          <div class="rx-match-text">${escapeHtml(truncateText(m.text || ""))}</div>
        </div>`;
        return;
      }
      let rows = groupRowHtml(0, `0 · ${strings.wholeMatch}`, null, m.text || "", m.start, m.end);
      for (const c of caps) {
        rows += groupRowHtml(c.index, captureLabel(c.index, c.name), c, c.text ?? "", c.start ?? 0, c.end ?? 0);
      }
      html += `
        <div class="rx-match">
          <div class="rx-match-head">${head}</div>
          <div class="rx-match-text">${escapeHtml(truncateText(m.text || ""))}</div>
          <details class="rx-groups"${idx === 0 ? " open" : ""}>
            <summary class="rx-groups-toggle">${escapeHtml(strings.groupsSummary.replace("{count}", String(caps.length)))}</summary>
            <div class="rx-groups-body">${rows}</div>
          </details>
        </div>`;
    });

    if (matches.length > RENDER_LIMIT) {
      const more = `${matches.length - RENDER_LIMIT}${truncated ? "+" : ""}`;
      html += `<div class="rx-more">${escapeHtml(strings.moreMatches.replace("{count}", more))}</div>`;
    }
    if (groupNames.length > 0 && matches.length > CAPTURE_HIGHLIGHT_LIMIT) {
      html += `<div class="rx-more">${escapeHtml(strings.captureLimit.replace("{count}", CAPTURE_HIGHLIGHT_LIMIT.toLocaleString(document.documentElement.lang || undefined)))}</div>`;
    }

    results.innerHTML = html;
    applySelection();
  }

  async function runTest(): Promise<void> {
    const seq = ++runSeq;
    const patternValue = pattern.value;
    const textValue = text.value;

    syncScroll();

    syncMatches();
    if (!patternValue) {
      renderLegend([]);
      clearResultState();
      showNoMatches();
      window.clearTimeout(announceTimer);
      return;
    }

    try {
      const activeFlags = flags.filter((f) => f.checked).map((f) => f.value);
      // Live run: first-use WASM load shows "Preparing…" in the matches panel if slow.
      const result = (await withPreparing("regex", regexTest(buildRustPattern(patternValue, activeFlags), textValue), {
        host: matchesPanel,
        label: strings.preparing,
      })) as RegexResult;
      if (seq !== runSeq) return; // stale — a newer run already applied

      if (result.error) {
        showError(result.error);
        return;
      }

      const global = activeFlags.includes("g");
      const matches = applyGlobalFlag(result.matches, global);
      renderLegend((result.groups ?? []).map((n) => n ?? null));
      lastText = textValue;
      lastMatches = matches;
      paintBackdrop();
      const truncated = global && result.truncated === true;
      renderMatchDetails(matches, truncated);
      scheduleAnnounce(strings.announceMatches.replace("{count}", truncated ? `${matches.length}+` : String(matches.length)));
    } catch (err) {
      if (seq !== runSeq) return;
      const message = err instanceof Error ? err.message : String(err);
      showError(strings.engineError.replace("{message}", message));
    }
  }

  function scheduleTest(): void {
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => void runTest(), DEBOUNCE_MS);
  }

  // ── Saved patterns ──

  function renderSavedPatterns(): void {
    const saved = getSavedPatterns();
    savedBody.innerHTML = "";

    syncEmptyState(savedEmpty, saved.length === 0);
    if (saved.length === 0) return;

    saved.forEach((item, idx) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="rx-cell-name">${escapeHtml(item.name)}</td>
        <td><code class="rx-cell-pattern">${escapeHtml(item.pattern)}</code></td>
        <td>
          <div class="rx-cell-actions">
            <button type="button" class="ds-icon-btn" data-rx-load-saved="${idx}" title="${escapeHtml(strings.loadButton)}" aria-label="${escapeHtml(`${strings.loadButton}: ${item.name}`)}">${LOAD_ICON}</button>
            <button type="button" class="ds-icon-btn" data-rx-delete-saved="${idx}" title="${escapeHtml(strings.deleteButton)}" aria-label="${escapeHtml(`${strings.deleteButton}: ${item.name}`)}">${DELETE_ICON}</button>
          </div>
        </td>`;
      savedBody.appendChild(tr);
    });
  }

  function saveCurrentPattern(): void {
    const name = saveName.value.trim();
    if (!name) {
      saveName.setAttribute("aria-invalid", "true");
      saveName.focus();
      return;
    }
    saveName.removeAttribute("aria-invalid");
    if (!pattern.value) {
      dialog.close();
      pattern.focus();
      return;
    }

    const saved = getSavedPatterns();
    saved.push({
      name,
      pattern: pattern.value,
      sample: text.value,
      flags: flags.filter((f) => f.checked).map((f) => f.value),
    });
    dialog.close();
    if (!setSavedPatterns(saved)) {
      setError(strings.storageError, false);
      return;
    }
    saveName.value = "";
    renderSavedPatterns();
  }

  function loadPattern(data: SavedPattern): void {
    pattern.value = data.pattern;
    text.value = data.sample || "";
    syncText();
    if (data.flags && Array.isArray(data.flags)) {
      for (const f of flags) f.checked = data.flags.includes(f.value);
    }
    void runTest();
  }

  // ── Events ──

  pattern.addEventListener("input", scheduleTest);
  text.addEventListener("input", () => {
    syncScroll();
    scheduleTest();
  });
  text.addEventListener("scroll", syncScroll);
  for (const f of flags) f.addEventListener("change", () => void runTest());

  if (cheatsheetToggleEl && cheatsheetEl) {
    const toggle: HTMLButtonElement = cheatsheetToggleEl;
    const panel: HTMLElement = cheatsheetEl;
    toggle.addEventListener("click", () => {
      const open = panel.hidden;
      panel.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
    });
  }

  // Enter in the name field submits the <form method="dialog">.
  root.querySelector<HTMLFormElement>("[data-rx-save-form]")?.addEventListener("submit", (e) => {
    e.preventDefault();
    saveCurrentPattern();
  });
  saveName.addEventListener("input", () => saveName.removeAttribute("aria-invalid"));

  root.addEventListener("click", (e: MouseEvent) => {
    const target = e.target as HTMLElement;

    const legendBtn = target.closest<HTMLElement>("[data-rx-group]");
    if (legendBtn) {
      const index = Number(legendBtn.dataset.rxGroup);
      selectedGroup = selectedGroup === index ? null : index;
      applySelection();
      paintBackdrop();
      return;
    }

    if (target.closest("[data-rx-save-open]")) {
      e.preventDefault();
      if (!pattern.value) {
        pattern.focus(); // nothing to save yet
        return;
      }
      saveName.removeAttribute("aria-invalid");
      dialog.showModal();
      saveName.focus();
      return;
    }
    if (target.closest("[data-rx-save-cancel]")) {
      e.preventDefault();
      dialog.close();
      return;
    }

    const loadExampleBtn = target.closest<HTMLElement>("[data-rx-load-example]");
    if (loadExampleBtn) {
      e.preventDefault();
      const idx = parseInt(loadExampleBtn.dataset.rxLoadExample || "", 10);
      const ex = COMMON_REGEXES[idx];
      if (ex) loadPattern({ name: ex.name, pattern: ex.pattern, sample: ex.sample, flags: ["g"] });
      return;
    }

    const loadSavedBtn = target.closest<HTMLElement>("[data-rx-load-saved]");
    if (loadSavedBtn) {
      e.preventDefault();
      const idx = parseInt(loadSavedBtn.dataset.rxLoadSaved || "", 10);
      const saved = getSavedPatterns();
      if (saved[idx]) loadPattern(saved[idx]);
      return;
    }

    const deleteSavedBtn = target.closest<HTMLElement>("[data-rx-delete-saved]");
    if (deleteSavedBtn) {
      e.preventDefault();
      const idx = parseInt(deleteSavedBtn.dataset.rxDeleteSaved || "", 10);
      if (window.confirm(strings.deleteConfirm)) {
        const saved = getSavedPatterns();
        saved.splice(idx, 1);
        if (!setSavedPatterns(saved)) setError(strings.storageError, false);
        renderSavedPatterns();
      }
    }
  });

  // "Load example" in the empty test-string field = the first quick example (Email).
  if (exampleBtn) {
    bindLoadExample(exampleBtn, () => {
      const ex = COMMON_REGEXES[0];
      loadPattern({ name: ex.name, pattern: ex.pattern, sample: ex.sample, flags: ["g"] });
    }, text);
  }

  // ── Init ──

  COMMON_REGEXES.forEach((ex, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="rx-cell-name">${escapeHtml(ex.name)}</td>
      <td><code class="rx-cell-pattern">${escapeHtml(ex.pattern)}</code></td>
      <td>
        <div class="rx-cell-actions">
          <button type="button" class="ds-icon-btn" data-rx-load-example="${idx}" title="${escapeHtml(strings.loadButton)}" aria-label="${escapeHtml(`${strings.loadButton}: ${ex.name}`)}">${LOAD_ICON}</button>
        </div>
      </td>`;
    examplesBody.appendChild(tr);
  });

  renderSavedPatterns();
  showNoMatches();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
