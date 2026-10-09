/**
 * Text Diff Viewer client. Builds a unified diff from the two inputs with
 * vendored jsdiff (global `Diff`) and renders it with vendored diff2html-ui
 * (global `Diff2HtmlUI`). Both are loaded on demand from `public/lib`,
 * base-path aware, sequentially in legacy order (jsdiff → diff2html-ui),
 * with the load promise cached. View modes (native radios styled as a
 * segmented control): Unified below 768px, Side by side above, until the user
 * picks one explicitly (kept across resizes, not persisted). The result sits
 * in its own scroller with a decorative 10px change rail (deletion/insertion
 * ticks + viewport outline; click jumps to a change) and Previous/Next change
 * buttons with "Change 2 of 7". Intra-line highlights are bounded for long
 * lines (note shown when falling back to line-only); differing line endings
 * and final newlines are reported, not silently normalized. Loading a file
 * fills its side and auto-compares once both sides have content. Dark theme toggles diff2html's `d2h-dark-color-scheme`
 * class (the vendored CSS ships dark variables behind that class).
 * Workbench empty states: each side shows a hint + "Load example" (fills both
 * sides with localized sample text, on click only); the result panel shows a
 * compact placeholder until there is a diff or a status message.
 */
import { startToolOperation } from "@/scripts/analytics/instrumentation";
import { bindEmptyState, bindLoadExample, revealOutput, setFieldValue, syncEmptyState } from "@/scripts/tool-ui";
import {
  countPatchLines,
  detectEol,
  endsWithNewline,
  eolLabel,
  groupChangeBlocks,
  intraLineBudget,
  nearestBlock,
  type ChangeBlock,
  type RowKind,
} from "@/tools/text-diff-core";

declare global {
  interface Window {
    Diff?: {
      createTwoFilesPatch(
        oldFileName: string,
        newFileName: string,
        oldStr: string,
        newStr: string,
        oldHeader?: string,
        newHeader?: string,
        options?: { context?: number; maxEditLength?: number },
      ): string;
    };
    Diff2HtmlUI?: new (
      element: HTMLElement,
      diffString: string,
      configuration: Record<string, unknown>,
    ) => {
      draw(): void;
      highlightCode(): void;
    };
  }
}

interface Strings {
  loading: string;
  errorEmpty: string;
  errorLibLoad: string;
  noDifferences: string;
  fileReadError: string;
  diffTooBig: string;
  exampleOriginal?: string;
  exampleModified?: string;
  /** "{0} added" / "{0} removed" — screen-reader text for the headline counts. */
  linesAdded?: string;
  linesRemoved?: string;
  /** "Change {current} of {total}". */
  changePosition: string;
  longLineNote: string;
  budgetNote: string;
  eolNote: string;
  finalNewlineOriginal: string;
  finalNewlineModified: string;
}

/** Changed lines longer than this get line-only highlighting (diff2html `maxLineLengthHighlight`). */
const INTRA_LINE_MAX = 2000;
/** Total changed characters above which intra-line highlighting is skipped entirely. */
const INTRA_TOTAL_BUDGET = 200_000;
/** Viewport width from which Side by side is the default view. */
const WIDE_QUERY = "(min-width: 768px)";

/**
 * Line-edit budget for jsdiff (Myers is O(N·D) on the main thread: 5k lines
 * with 1.7k edits froze the tab for ~13 s). Equal to diff2html's
 * `diffMaxChanges`, which would refuse to draw a bigger diff anyway.
 */
const MAX_LINE_EDITS = 1000;

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const CSS_HREF = `${BASE}/lib/diff2html.min.css`;
const JS_SOURCES = [`${BASE}/lib/jsdiff.min.js`, `${BASE}/lib/diff2html-ui.min.js`];

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-diff-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function loadStyleOnce(href: string): void {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

function loadScript(src: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
  if (existing) {
    if (existing.dataset.loaded === "true") {
      resolve();
      return promise;
    }
    existing.addEventListener("load", () => resolve(), { once: true });
    existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), { once: true });
    return promise;
  }
  const script = document.createElement("script");
  script.src = src;
  script.async = false;
  script.addEventListener("load", () => {
    script.dataset.loaded = "true";
    resolve();
  }, { once: true });
  script.addEventListener("error", () => {
    // Drop the failed tag so a later retry injects a fresh one instead of
    // waiting forever on a script that will never fire `load`.
    script.remove();
    reject(new Error(`Failed to load ${src}`));
  }, { once: true });
  document.body.appendChild(script);
  return promise;
}

let loading: Promise<void> | null = null;

/** Ensures the globals `Diff` (jsdiff) and `Diff2HtmlUI` are available. */
function ensureDiffLibs(): Promise<void> {
  if (window.Diff && window.Diff2HtmlUI) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      loadStyleOnce(CSS_HREF);
      for (const src of JS_SOURCES) await loadScript(src);
    })().catch((err: unknown) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

function init(): void {
  const root = document.querySelector<HTMLElement>("[data-diff-tool]");
  if (!root) return;
  const toolRoot: HTMLElement = root;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const originalArea = root.querySelector<HTMLTextAreaElement>('[data-diff-text="original"]');
  const modifiedArea = root.querySelector<HTMLTextAreaElement>('[data-diff-text="modified"]');
  const outputArea = root.querySelector<HTMLElement>("[data-diff-output]");
  const resultArea = root.querySelector<HTMLElement>("[data-diff-result]");
  if (!originalArea || !modifiedArea || !outputArea || !resultArea) return;
  const originalText: HTMLTextAreaElement = originalArea;
  const modifiedText: HTMLTextAreaElement = modifiedArea;
  const outputEl: HTMLElement = outputArea;
  const resultEl: HTMLElement = resultArea;

  const statusEl = root.querySelector<HTMLElement>("[data-diff-status]");
  const errorEl = root.querySelector<HTMLElement>("[data-diff-error]");
  const notesEl = root.querySelector<HTMLElement>("[data-diff-notes]");
  const originalFile = root.querySelector<HTMLInputElement>('[data-diff-file="original"]');
  const modifiedFile = root.querySelector<HTMLInputElement>('[data-diff-file="modified"]');
  const railEl = root.querySelector<HTMLElement>("[data-diff-rail]");
  const railViewEl = root.querySelector<HTMLElement>("[data-diff-rail-view]");
  const navEl = root.querySelector<HTMLElement>("[data-diff-nav]");
  const prevBtn = root.querySelector<HTMLButtonElement>("[data-diff-prev]");
  const nextBtn = root.querySelector<HTMLButtonElement>("[data-diff-next]");
  const positionEl = root.querySelector<HTMLElement>("[data-diff-position]");
  const modeRadios = Array.from(root.querySelectorAll<HTMLInputElement>("[data-diff-mode]"));

  const outputPanel = root.querySelector<HTMLElement>("[data-diff-output-panel]");
  const hostOf = (side: string) => toolRoot.querySelector<HTMLElement>(`[data-diff-host="${side}"]`);
  const originalHost = hostOf("original");
  const modifiedHost = hostOf("modified");
  const syncOriginal = originalHost ? bindEmptyState(originalHost, originalText) : () => {};
  const syncModified = modifiedHost ? bindEmptyState(modifiedHost, modifiedText) : () => {};
  root.querySelectorAll<HTMLButtonElement>("[data-diff-example]").forEach((btn) => {
    bindLoadExample(btn, () => {
      rawFile.original = null;
      rawFile.modified = null;
      setFieldValue(originalText, strings.exampleOriginal ?? "");
      setFieldValue(modifiedText, strings.exampleModified ?? "");
    });
  });

  /** Result placeholder while there is neither a diff nor a status/error line. */
  function syncOutput(): void {
    if (!outputPanel) return;
    const empty = outputEl.hidden === true && (statusEl?.hidden ?? true) !== false && (errorEl?.hidden ?? true) !== false;
    syncEmptyState(outputPanel, empty);
  }

  let currentOriginal = originalText.value;
  let currentModified = modifiedText.value;
  /**
   * Raw text of a side loaded from a file (CR/CRLF intact; the textarea
   * normalizes to LF). Used only to report line-ending differences; dropped
   * once the field no longer holds that file's text.
   */
  const rawFile: { original: string | null; modified: string | null } = { original: null, modified: null };
  let renderSequence = 0;

  // ── View mode: Unified (narrow) / Side by side (wide) until chosen explicitly ──
  const wide = window.matchMedia(WIDE_QUERY);
  let explicitMode = false;
  function setMode(value: string): void {
    for (const r of modeRadios) r.checked = r.value === value;
  }
  setMode(wide.matches ? "side-by-side" : "line-by-line");
  wide.addEventListener("change", () => {
    if (explicitMode) return;
    setMode(wide.matches ? "side-by-side" : "line-by-line");
    if (!outputEl.hidden) void renderDiff();
  });

  const syncThemeClass = (): void => {
    outputEl.classList.toggle(
      "d2h-dark-color-scheme",
      document.documentElement.getAttribute("data-theme") === "dark",
    );
  };
  new MutationObserver(syncThemeClass).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  /** Info (role=status) or error (role=alert) line above the diff; null clears both. */
  function showAlert(message: string | null, kind: "info" | "error" = "info"): void {
    if (statusEl) {
      statusEl.textContent = kind === "info" ? (message ?? "") : "";
      statusEl.hidden = kind !== "info" || message === null;
    }
    if (errorEl) {
      errorEl.textContent = kind === "error" ? (message ?? "") : "";
      errorEl.hidden = kind !== "error" || message === null;
    }
    syncOutput();
  }

  /** Notes under the headline: long-line fallback, line endings, final newline. */
  function showNotes(notes: string[]): void {
    if (!notesEl) return;
    notesEl.replaceChildren(
      ...notes.map((n) => {
        const li = document.createElement("li");
        li.textContent = n;
        return li;
      }),
    );
    notesEl.hidden = notes.length === 0;
  }

  /** Line-ending and final-newline differences (reported, never silently normalized). */
  function eolNotes(): string[] {
    dropStaleRaw();
    const notes: string[] = [];
    const rawO = rawFile.original ?? currentOriginal;
    const rawM = rawFile.modified ?? currentModified;
    const eolO = detectEol(rawO);
    const eolM = detectEol(rawM);
    if (eolO !== "none" && eolM !== "none" && eolLabel(eolO, rawO) !== eolLabel(eolM, rawM)) {
      notes.push(strings.eolNote.replace("{original}", eolLabel(eolO, rawO)).replace("{modified}", eolLabel(eolM, rawM)));
    }
    if (currentOriginal && currentModified) {
      const nlO = endsWithNewline(rawO);
      const nlM = endsWithNewline(rawM);
      if (nlO && !nlM) notes.push(strings.finalNewlineOriginal);
      if (nlM && !nlO) notes.push(strings.finalNewlineModified);
    }
    return notes;
  }

  const summaryEl = root.querySelector<HTMLElement>("[data-diff-summary]");
  const addedEl = root.querySelector<HTMLElement>("[data-diff-added]");
  const removedEl = root.querySelector<HTMLElement>("[data-diff-removed]");

  /** Fill one headline count: visible "+12" plus visually hidden "12 added". */
  function setCount(el: HTMLElement | null, sign: string, n: number, template: string | undefined): void {
    if (!el) return;
    const visible = document.createElement("span");
    visible.setAttribute("aria-hidden", "true");
    visible.textContent = `${sign}${n}`;
    const spoken = document.createElement("span");
    spoken.className = "visually-hidden";
    spoken.textContent = (template ?? "{0}").replace("{0}", String(n));
    el.replaceChildren(visible, spoken);
  }

  function renderSummary(patch: string | null): void {
    if (!summaryEl) return;
    summaryEl.hidden = patch === null;
    if (patch === null) return;
    const { added, removed } = countPatchLines(patch);
    setCount(addedEl, "+", added, strings.linesAdded);
    setCount(removedEl, "−", removed, strings.linesRemoved);
  }

  // ── Change blocks: rail ticks + Previous/Next navigation ──

  interface BlockView extends ChangeBlock {
    rows: HTMLElement[];
    top: number;
    bottom: number;
  }
  let blocks: BlockView[] = [];
  let current = -1;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /** Kind of a diff row from its code cell classes (d2h-del / d2h-ins / d2h-info / context). */
  function rowKind(tr: HTMLTableRowElement): RowKind {
    const cell = tr.cells[tr.cells.length - 1];
    if (!cell) return "context";
    if (cell.classList.contains("d2h-del")) return "del";
    if (cell.classList.contains("d2h-ins")) return "ins";
    if (cell.classList.contains("d2h-info")) return "info";
    return "context";
  }

  /**
   * Rows of the drawn diff, merged across sides: side-by-side renders two
   * row-aligned tables, so row i of both forms one visual line.
   */
  function collectRows(): { kinds: RowKind[]; rows: HTMLElement[][] } {
    const sides = Array.from(outputEl.querySelectorAll<HTMLElement>(".d2h-file-side-diff"));
    const tables = sides.length ? sides : Array.from(outputEl.querySelectorAll<HTMLElement>(".d2h-file-diff"));
    const perSide = tables.map((t) => Array.from(t.querySelectorAll<HTMLTableRowElement>("tbody tr")));
    const n = Math.max(0, ...perSide.map((r) => r.length));
    const kinds: RowKind[] = [];
    const rows: HTMLElement[][] = [];
    for (let i = 0; i < n; i++) {
      const trs = perSide.map((r) => r[i]).filter(Boolean);
      const ks = trs.map(rowKind);
      const del = ks.includes("del");
      const ins = ks.includes("ins");
      kinds.push(del && ins ? "both" : del ? "del" : ins ? "ins" : ks.includes("info") ? "info" : "context");
      rows.push(trs);
    }
    return { kinds, rows };
  }

  /** Content-relative vertical extent of an element inside the result scroller. */
  function extentOf(el: HTMLElement): { top: number; bottom: number } {
    const box = el.getBoundingClientRect();
    const host = outputEl.getBoundingClientRect();
    const top = box.top - host.top + outputEl.scrollTop;
    return { top, bottom: top + box.height };
  }

  function buildBlocks(): void {
    const { kinds, rows } = collectRows();
    blocks = groupChangeBlocks(kinds).map((b) => {
      const blockRows = rows.slice(b.first, b.last + 1).flat();
      return { ...b, rows: blockRows, top: 0, bottom: 0 };
    });
    current = blocks.length ? 0 : -1;
    measureBlocks();
    updateNav();
  }

  /** Re-measure block extents and redraw rail ticks (after draw / resize). */
  function measureBlocks(): void {
    for (const b of blocks) {
      const first = b.rows[0];
      const last = b.rows[b.rows.length - 1];
      if (!first || !last) continue;
      b.top = extentOf(first).top;
      b.bottom = extentOf(last).bottom;
    }
    drawRail();
  }

  function drawRail(): void {
    if (!railEl) return;
    railEl.querySelectorAll(".diff-rail-tick").forEach((t) => t.remove());
    const total = outputEl.scrollHeight || 1;
    const frag = document.createDocumentFragment();
    for (const b of blocks) {
      for (const kind of ["del", "ins"] as const) {
        if (kind === "del" ? !b.hasDel : !b.hasIns) continue;
        const tick = document.createElement("i");
        tick.className = `diff-rail-tick is-${kind}`;
        tick.style.top = `${(b.top / total) * 100}%`;
        tick.style.height = `${((b.bottom - b.top) / total) * 100}%`;
        frag.append(tick);
      }
    }
    railEl.append(frag);
    syncRailView();
  }

  let railFrame = 0;
  /** Viewport outline on the rail = visible part of the result scroller. */
  function syncRailView(): void {
    if (!railViewEl) return;
    const total = outputEl.scrollHeight || 1;
    const scrollable = outputEl.scrollHeight > outputEl.clientHeight + 1;
    railViewEl.hidden = !scrollable;
    railViewEl.style.top = `${(outputEl.scrollTop / total) * 100}%`;
    railViewEl.style.height = `${(outputEl.clientHeight / total) * 100}%`;
  }
  outputEl.addEventListener("scroll", () => {
    if (railFrame) return;
    railFrame = requestAnimationFrame(() => {
      railFrame = 0;
      syncRailView();
    });
  }, { passive: true });
  new ResizeObserver(() => {
    if (!outputEl.hidden && blocks.length) measureBlocks();
  }).observe(outputEl);

  function updateNav(): void {
    if (navEl) navEl.hidden = blocks.length === 0;
    if (positionEl) {
      positionEl.textContent = blocks.length
        ? strings.changePosition.replace("{current}", String(current + 1)).replace("{total}", String(blocks.length))
        : "";
    }
    if (prevBtn) prevBtn.disabled = current <= 0;
    if (nextBtn) nextBtn.disabled = current >= blocks.length - 1;
    outputEl.querySelectorAll(".is-current-change").forEach((el) => el.classList.remove("is-current-change"));
    for (const tr of blocks[current]?.rows ?? []) tr.classList.add("is-current-change");
  }

  /** Make change `index` current and scroll it into the result viewport (no page jump). */
  function goTo(index: number): void {
    if (index < 0 || index >= blocks.length) return;
    current = index;
    updateNav();
    const b = blocks[index];
    outputEl.scrollTo({
      top: Math.max(0, b.top - Math.min(48, outputEl.clientHeight / 4)),
      behavior: reduceMotion.matches ? "auto" : "smooth",
    });
  }
  prevBtn?.addEventListener("click", () => goTo(current - 1));
  nextBtn?.addEventListener("click", () => goTo(current + 1));
  if (railEl) {
    const rail: HTMLElement = railEl;
    // Decorative shortcut (aria-hidden): jump to the change nearest the click.
    rail.addEventListener("click", (e: MouseEvent) => {
      const box = rail.getBoundingClientRect();
      if (box.height <= 0) return;
      const y = ((e.clientY - box.top) / box.height) * outputEl.scrollHeight;
      goTo(nearestBlock(blocks, y));
    });
  }

  function setResultVisible(visible: boolean): void {
    outputEl.hidden = !visible;
    resultEl.hidden = !visible;
    if (!visible) {
      blocks = [];
      current = -1;
      updateNav();
    }
  }

  function hideOutput(): void {
    renderSummary(null);
    showNotes([]);
    outputEl.innerHTML = "";
    setResultVisible(false);
    syncOutput();
  }

  async function renderDiff(explicit = false): Promise<void> {
    const sequence = ++renderSequence;
    if (!currentOriginal && !currentModified) {
      showAlert(null);
      hideOutput();
      return;
    }
    const operation = explicit ? startToolOperation("text-diff-viewer") : null;
    if (currentOriginal === currentModified) {
      hideOutput();
      showAlert(strings.noDifferences, "info");
      showNotes(eolNotes());
      operation?.complete();
      return;
    }
    showAlert(strings.loading, "info");
    try {
      await ensureDiffLibs();
      if (sequence !== renderSequence) return;
    } catch {
      if (sequence !== renderSequence) return;
      hideOutput();
      showAlert(strings.errorLibLoad, "error");
      operation?.fail();
      return;
    }
    const DiffNs = window.Diff;
    const DiffUI = window.Diff2HtmlUI;
    if (!DiffNs || !DiffUI) {
      hideOutput();
      showAlert(strings.errorLibLoad, "error");
      operation?.fail();
      return;
    }
    // Let the "Loading…" status paint before the synchronous diff blocks the thread.
    await new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    if (sequence !== renderSequence) return;
    let patch: string | undefined;
    try {
      // Over budget, jsdiff 5.1 yields no structured patch and createTwoFilesPatch throws.
      patch = DiffNs.createTwoFilesPatch("Original", "Modified", currentOriginal, currentModified, "", "", {
        maxEditLength: MAX_LINE_EDITS,
      });
    } catch {
      patch = undefined;
    }
    if (!patch) {
      hideOutput();
      showAlert(strings.diffTooBig.replace("{max}", String(MAX_LINE_EDITS)), "error");
      operation?.fail();
      return;
    }
    const budget = intraLineBudget(patch, INTRA_LINE_MAX, INTRA_TOTAL_BUDGET);
    const notes = eolNotes();
    if (budget.longLines) notes.unshift(strings.longLineNote.replace("{max}", INTRA_LINE_MAX.toLocaleString(document.documentElement.lang || undefined)));
    if (budget.overBudget) notes.unshift(strings.budgetNote);
    // diffMaxChanges caps the line count (same budget as jsdiff above). No
    // diffMaxLineLength: it would replace the whole diff with an English
    // "too big" message; long lines are bounded via maxLineLengthHighlight.
    const configuration = {
      drawFileList: false,
      matching: "lines",
      outputFormat: toolRoot.querySelector<HTMLInputElement>("[data-diff-mode]:checked")?.value ?? "side-by-side",
      highlight: true,
      renderNothingWhenEmpty: false,
      diffMaxChanges: MAX_LINE_EDITS,
      maxLineLengthHighlight: budget.highlightMax,
    };
    showAlert(null);
    renderSummary(patch);
    showNotes(notes);
    outputEl.innerHTML = "";
    setResultVisible(true);
    syncOutput();
    syncThemeClass();
    try {
      const ui = new DiffUI(outputEl, patch, configuration);
      ui.draw();
      try {
        ui.highlightCode();
      } catch (e) {
        console.warn("Syntax highlighting failed", e);
      }
      outputEl.scrollTop = 0;
      buildBlocks();
      operation?.complete();
    } catch (error) {
      operation?.fail();
      throw error;
    }
  }

  root.addEventListener("click", (e: MouseEvent) => {
    const target = e.target as HTMLElement;

    const loadBtn = target.closest<HTMLButtonElement>("[data-diff-load]");
    if (loadBtn) {
      e.preventDefault();
      const input = loadBtn.dataset.diffLoad === "original" ? originalFile : modifiedFile;
      input?.click();
      return;
    }

    if (target.closest("[data-diff-compare]")) {
      e.preventDefault();
      currentOriginal = originalText.value;
      currentModified = modifiedText.value;
      if (!currentOriginal && !currentModified) {
        hideOutput();
        showAlert(strings.errorEmpty, "error");
        originalText.focus();
        return;
      }
      // Explicit Compare: bring the result into view on phones once drawn.
      void renderDiff(true).then(() => revealOutput(outputPanel));
      return;
    }

    if (target.closest("[data-diff-clear]")) {
      e.preventDefault();
      originalText.value = "";
      modifiedText.value = "";
      currentOriginal = "";
      currentModified = "";
      rawFile.original = null;
      rawFile.modified = null;
      if (originalFile) originalFile.value = "";
      if (modifiedFile) modifiedFile.value = "";
      syncOriginal();
      syncModified();
      hideOutput();
      showAlert(null);
      originalText.focus();
    }
  });

  /** Forget raw file text once its field was edited (normalized text no longer matches). */
  function dropStaleRaw(): void {
    const norm = (t: string) => t.replace(/\r\n?/g, "\n");
    if (rawFile.original !== null && norm(rawFile.original) !== currentOriginal) rawFile.original = null;
    if (rawFile.modified !== null && norm(rawFile.modified) !== currentModified) rawFile.modified = null;
  }

  for (const radio of modeRadios) {
    radio.addEventListener("change", () => {
      explicitMode = true;
      if (currentOriginal || currentModified) void renderDiff();
    });
  }

  const bindFile = (
    input: HTMLInputElement | null,
    area: HTMLTextAreaElement,
    isOriginal: boolean,
  ): void => {
    if (!input) return;
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = typeof reader.result === "string" ? reader.result : "";
        area.value = text;
        if (isOriginal) syncOriginal();
        else syncModified();
        // Diff the field value (textarea normalizes CRLF → LF, so the
        // auto-compare matches a later manual Compare); the raw text is kept
        // only to report differing line endings.
        if (isOriginal) {
          currentOriginal = area.value;
          rawFile.original = text;
        } else {
          currentModified = area.value;
          rawFile.modified = text;
        }
        // Auto-trigger once both sides have content (legacy parity).
        if (currentOriginal && currentModified) void renderDiff();
      };
      reader.onerror = () => {
        hideOutput();
        showAlert(strings.fileReadError, "error");
      };
      // Same file picked again must still fire `change`.
      reader.onloadend = () => {
        input.value = "";
      };
      reader.readAsText(file);
    });
  };
  bindFile(originalFile, originalText, true);
  bindFile(modifiedFile, modifiedText, false);
  syncOutput();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}

export {};
