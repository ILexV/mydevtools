/**
 * Regex Tester client. Live regex testing via the Rust regex WASM engine
 * (`regex-client`): 150ms debounce on pattern/text input, immediate on flag
 * change. Match highlighting via a backdrop layer under the transparent
 * textarea (scroll-synced). Match list with capture groups (render limit 50,
 * legacy parity), quick examples table, and saved patterns persisted in
 * localStorage under `mydevtools_regex_saved` (legacy key + entry shape).
 */
import { regexTest } from "@/scripts/wasm/regex-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";

interface Strings {
  noMatches: string;
  loadButton: string;
  deleteButton: string;
  deleteConfirm: string;
  matchNumber: string;
  groupLabel: string;
  moreMatches: string;
}

/** WASM `test_regex` result JSON (wasm/regex_tool/src/lib.rs). */
interface CaptureGroup {
  name: string | null;
  text: string;
  start: number;
  end: number;
}
interface RegexMatch {
  text: string;
  start: number;
  end: number;
  captures: CaptureGroup[];
}
interface RegexResult {
  matches: RegexMatch[];
  error: string | null;
}

interface SavedPattern {
  name: string;
  pattern: string;
  sample?: string;
  flags?: string[];
}

const STORAGE_KEY = "mydevtools_regex_saved";
const DEBOUNCE_MS = 150;
const RENDER_LIMIT = 50;

/** Legacy COMMON_REGEXES (1:1). */
const COMMON_REGEXES: Array<{ name: string; pattern: string; sample: string }> = [
  { name: "Email", pattern: "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}", sample: "test@example.com\ninvalid-email\nuser.name+tag@mail.co.uk" },
  { name: "IPv4 Address", pattern: "\\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\b", sample: "192.168.1.1\n10.0.0.1\n256.0.0.1 (invalid)" },
  { name: "Date (YYYY-MM-DD)", pattern: "\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])", sample: "2023-12-31\n2024-02-29\n2023-13-01 (invalid)" },
  { name: "Hex Color", pattern: "#?([a-fA-F0-9]{6}|[a-fA-F0-9]{3})", sample: "#FFF\n#000000\n#555555" },
  { name: "URL (Simple)", pattern: "https?:\\/\\/[\\w\\-\\.]+(?::\\d+)?(?:\\/[\\w\\-._~:/?#[\\]@!$&'()*+,;=]*)?", sample: "https://www.google.com\nhttp://localhost:8080/api/v1" },
];

const LOAD_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="rx-icon" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" /></svg>';
const DELETE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="rx-icon" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>';

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-rx-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getSavedPatterns(): SavedPattern[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn("Saved regex patterns corrupted (not an array). Resetting.");
      return [];
    }
    return (parsed as unknown[]).filter(
      (item): item is SavedPattern =>
        !!item &&
        typeof item === "object" &&
        typeof (item as SavedPattern).name === "string" &&
        typeof (item as SavedPattern).pattern === "string",
    );
  } catch (err) {
    console.error("Error reading saved regex patterns:", err);
    return [];
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
  const examplesBodyEl = root.querySelector<HTMLElement>("[data-rx-examples-body]");
  const savedBodyEl = root.querySelector<HTMLElement>("[data-rx-saved-body]");
  const savedEmptyEl = root.querySelector<HTMLElement>("[data-rx-saved-empty]");
  const dialogEl = root.querySelector<HTMLDialogElement>("[data-rx-dialog]");
  const saveNameEl = root.querySelector<HTMLInputElement>("[data-rx-save-name]");
  const cheatsheetEl = root.querySelector<HTMLElement>("[data-rx-cheatsheet]");
  const cheatsheetToggleEl = root.querySelector<HTMLButtonElement>("[data-rx-cheatsheet-toggle]");
  const flagEls = Array.from(root.querySelectorAll<HTMLInputElement>("[data-rx-flag]"));

  if (!patternEl || !textEl || !backdropEl || !resultsEl || !countEl || !examplesBodyEl || !savedBodyEl || !savedEmptyEl || !dialogEl || !saveNameEl) return;
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

  let debounceTimer = 0;
  let runSeq = 0;

  function syncScroll(): void {
    backdrop.scrollTop = text.scrollTop;
    backdrop.scrollLeft = text.scrollLeft;
  }

  function showNoMatches(): void {
    results.innerHTML = `<p class="rx-empty">${escapeHtml(strings.noMatches)}</p>`;
    countBadge.textContent = "0";
  }

  function showError(message: string): void {
    results.innerHTML = `<p class="rx-error">${escapeHtml(message)}</p>`;
    countBadge.textContent = "!";
    backdrop.innerHTML = escapeHtml(text.value);
  }

  function updateHighlight(value: string, matches: RegexMatch[]): void {
    let html = "";
    let lastIndex = 0;

    for (const m of matches) {
      if (m.start < lastIndex) continue;
      html += escapeHtml(value.substring(lastIndex, m.start));
      html += `<mark class="rx-mark">${escapeHtml(value.substring(m.start, m.end))}</mark>`;
      lastIndex = m.end;
    }
    html += escapeHtml(value.substring(lastIndex));

    if (value.endsWith("\n")) {
      html += "<br>&nbsp;";
    }

    backdrop.innerHTML = html;
  }

  function renderMatchDetails(matches: RegexMatch[]): void {
    countBadge.textContent = String(matches.length);

    if (matches.length === 0) {
      results.innerHTML = `<p class="rx-empty">${escapeHtml(strings.noMatches)}</p>`;
      return;
    }

    const visible = matches.slice(0, RENDER_LIMIT);
    let html = "";
    visible.forEach((m, idx) => {
      const matchText = m.text || "";
      const display = matchText.length > 100 ? matchText.substring(0, 100) + "..." : matchText;

      let groupsHtml = "";
      if (m.captures && m.captures.length > 0) {
        for (const c of m.captures) {
          const groupName = c.name ? c.name : strings.groupLabel;
          groupsHtml += `
            <div class="rx-group">
              <span class="rx-group-name">${escapeHtml(groupName)}:</span>
              <span class="rx-group-text">${escapeHtml(c.text)}</span>
              <span class="rx-group-pos">[${c.start}-${c.end}]</span>
            </div>`;
        }
      }

      html += `
        <div class="rx-match">
          <div class="rx-match-head">
            <span>${escapeHtml(strings.matchNumber.replace("{n}", String(idx + 1)))}</span>
            <span class="rx-pos">[${m.start}-${m.end}]</span>
          </div>
          <div class="rx-match-text">${escapeHtml(display)}</div>
          ${groupsHtml}
        </div>`;
    });

    if (matches.length > RENDER_LIMIT) {
      html += `<div class="rx-more">${escapeHtml(strings.moreMatches.replace("{count}", String(matches.length - RENDER_LIMIT)))}</div>`;
    }

    results.innerHTML = html;
  }

  async function runTest(): Promise<void> {
    const seq = ++runSeq;
    const patternValue = pattern.value;
    const textValue = text.value;

    syncScroll();

    if (!patternValue) {
      backdrop.innerHTML = escapeHtml(textValue);
      showNoMatches();
      return;
    }

    try {
      // Legacy: strip JS-only flags (g/y) and embed the rest inline.
      let allFlags = "";
      for (const flag of flags) if (flag.checked) allFlags += flag.value;
      const rustFlags = allFlags.replace(/[gy]/g, "");
      const fullPattern = rustFlags ? `(?${rustFlags})${patternValue}` : patternValue;

      const result = (await regexTest(fullPattern, textValue)) as RegexResult;
      if (seq !== runSeq) return; // stale — a newer run already applied

      if (result.error) {
        showError(result.error);
        return;
      }

      updateHighlight(textValue, result.matches);
      renderMatchDetails(result.matches);
    } catch (err) {
      if (seq !== runSeq) return;
      console.error(err);
      const message = err instanceof WasmError ? err.message : err instanceof Error ? err.message : String(err);
      showError(`WASM Error: ${message}`);
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

    if (saved.length === 0) {
      savedEmpty.hidden = false;
      return;
    }
    savedEmpty.hidden = true;

    saved.forEach((item, idx) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="rx-cell-name">${escapeHtml(item.name)}</td>
        <td><code class="rx-cell-pattern">${escapeHtml(item.pattern)}</code></td>
        <td>
          <div class="rx-cell-actions">
            <button type="button" class="rx-icon-btn" data-rx-load-saved="${idx}" title="${escapeHtml(strings.loadButton)}" aria-label="${escapeHtml(strings.loadButton)}">${LOAD_ICON}</button>
            <button type="button" class="rx-icon-btn rx-danger" data-rx-delete-saved="${idx}" title="${escapeHtml(strings.deleteButton)}" aria-label="${escapeHtml(strings.deleteButton)}">${DELETE_ICON}</button>
          </div>
        </td>`;
      savedBody.appendChild(tr);
    });
  }

  function saveCurrentPattern(): void {
    const name = saveName.value.trim();
    if (!name || !pattern.value) return;

    const saved = getSavedPatterns();
    saved.push({
      name,
      pattern: pattern.value,
      sample: text.value,
      flags: flags.filter((f) => f.checked).map((f) => f.value),
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));

    saveName.value = "";
    renderSavedPatterns();
    dialog.close();
  }

  function loadPattern(data: SavedPattern): void {
    pattern.value = data.pattern;
    text.value = data.sample || "";
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

  saveName.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveCurrentPattern();
    }
  });

  root.addEventListener("click", (e: MouseEvent) => {
    const target = e.target as HTMLElement;

    if (target.closest("[data-rx-save-open]")) {
      e.preventDefault();
      dialog.showModal();
      saveName.focus();
      return;
    }
    if (target.closest("[data-rx-save-cancel]")) {
      e.preventDefault();
      dialog.close();
      return;
    }
    if (target.closest("[data-rx-save-confirm]")) {
      e.preventDefault();
      saveCurrentPattern();
      return;
    }

    const loadExampleBtn = target.closest<HTMLElement>("[data-rx-load-example]");
    if (loadExampleBtn) {
      e.preventDefault();
      const idx = parseInt(loadExampleBtn.dataset.rxLoadExample || "", 10);
      const ex = COMMON_REGEXES[idx];
      if (ex) loadPattern({ name: ex.name, pattern: ex.pattern, sample: ex.sample, flags: ["u"] });
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
        localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
        renderSavedPatterns();
      }
    }
  });

  // ── Init ──

  COMMON_REGEXES.forEach((ex, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="rx-cell-name">${escapeHtml(ex.name)}</td>
      <td><code class="rx-cell-pattern">${escapeHtml(ex.pattern)}</code></td>
      <td>
        <div class="rx-cell-actions">
          <button type="button" class="rx-icon-btn" data-rx-load-example="${idx}" title="${escapeHtml(strings.loadButton)}" aria-label="${escapeHtml(strings.loadButton)}">${LOAD_ICON}</button>
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
