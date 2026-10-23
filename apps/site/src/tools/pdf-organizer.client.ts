/**
 * PDF Organizer client controller. One PDF (pick or drop) → page sizes from the
 * pdf worker (`pdfPageInfo`) and a card per page; thumbnails are drawn lazily
 * by pdf.js as cards scroll into view (`pdf-thumbnails.ts`; on failure the
 * cards keep numbered placeholders and a note says so). Pages can be selected
 * (checkbox or thumbnail click), rotated, deleted, moved by buttons or drag and
 * drop, and reset. Save builds one PDF, or splits every N pages / by ranges of
 * edited positions, via `organizePdf` (one worker job, Cancel terminates it);
 * several parts get per-file links and a stored ZIP. Any edit hides the old
 * result and revokes its object URLs. Nothing is persisted.
 */
import { organizePdf, pdfPageInfo, type PdfPageInfo } from "@/scripts/wasm/pdf-client";
import { startToolOperation } from "@/scripts/analytics/instrumentation";
import { localizeResourceError, WasmError } from "@/scripts/wasm/worker-protocol";
import { bindDropzone, revealOutput, setDropzoneHasFile, withPreparing } from "@/scripts/tool-ui";
import { formatBytes, formatString } from "@/lib/format";
import { classifyPdfError, isPdfFile } from "@/tools/pdf-files";
import { appendMeta, buildFileRow, downloadLink, iconButton, PDF_ICONS } from "@/tools/pdf-file-ui";
import {
  baseName,
  buildPlans,
  chunkPositions,
  displayRotation,
  initialPages,
  isUnchanged,
  outputNames,
  paperName,
  parseRanges,
  rotatePage,
  storedZip,
  type OrganizerPage,
} from "@/tools/pdf-organizer";
import { openThumbnails, type ThumbnailSource } from "@/tools/pdf-thumbnails";

interface Strings {
  pagesMeta: string;
  selectedCount: string;
  pageLabel: string;
  fromSource: string;
  moveEarlier: string;
  moveLater: string;
  rotateLeft: string;
  rotateRight: string;
  deletePage: string;
  saveButton: string;
  splitButton: string;
  canceled: string;
  resultSummary: string;
  resultPages: string;
  download: string;
  errorNotPdf: string;
  errorInvalidPdf: string;
  errorEncrypted: string;
  errorRanges: string;
  errorNoPages: string;
  nothingChanged: string;
  errorBuild: string;
  thumbsUnavailable: string;
  preparing?: string;
  processingFailed: string;
  memoryExhausted: string;
  invalidFormat: string;
  corruptInput: string;
}

/** Longest thumbnail side in CSS px. */
const THUMB_SIZE = 150;

interface Card {
  li: HTMLLIElement;
  check: HTMLInputElement;
  title: HTMLElement;
  from: HTMLElement;
  thumb: HTMLElement;
  meta: HTMLElement;
  buttons: Record<"earlier" | "later" | "left" | "right" | "delete", HTMLButtonElement>;
  canvas: HTMLCanvasElement | null;
  requested: boolean;
}

interface ResultFile {
  name: string;
  bytes: Uint8Array;
  url: string;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-pdfo-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-pdfo-tool]");
  if (!root || root.dataset.initialized) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);

  const zone = $<HTMLElement>("[data-pdfo-dropzone]");
  const input = $<HTMLInputElement>("[data-pdfo-file]");
  const loading = $<HTMLElement>("[data-pdfo-loading]");
  const errorBox = $<HTMLElement>("[data-pdfo-error]");
  const pagesPanel = $<HTMLElement>("[data-pdfo-pages]");
  const metaEl = $<HTMLElement>("[data-pdfo-meta]");
  const grid = $<HTMLOListElement>("[data-pdfo-grid]");
  const thumbsNote = $<HTMLElement>("[data-pdfo-thumbs-note]");
  const selectAllBtn = $<HTMLButtonElement>("[data-pdfo-select-all]");
  const selectNoneBtn = $<HTMLButtonElement>("[data-pdfo-select-none]");
  const selectedEl = $<HTMLElement>("[data-pdfo-selected]");
  const rotateBtns = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-pdfo-rotate]"));
  const deleteSelectedBtn = $<HTMLButtonElement>("[data-pdfo-delete-selected]");
  const resetBtn = $<HTMLButtonElement>("[data-pdfo-reset]");
  const outputPanel = $<HTMLElement>("[data-pdfo-output]");
  const modeInputs = Array.from(root.querySelectorAll<HTMLInputElement>("[data-pdfo-mode]"));
  const everyField = $<HTMLElement>("[data-pdfo-every-field]");
  const everyInput = $<HTMLInputElement>("[data-pdfo-every]");
  const rangesField = $<HTMLElement>("[data-pdfo-ranges-field]");
  const rangesInput = $<HTMLInputElement>("[data-pdfo-ranges]");
  const runBtn = $<HTMLButtonElement>("[data-pdfo-run]");
  const progress = $<HTMLElement>("[data-pdfo-progress]");
  const progressLabel = $<HTMLElement>("[data-pdfo-progress-label]");
  const cancelBtn = $<HTMLButtonElement>("[data-pdfo-cancel]");
  const noteBox = $<HTMLElement>("[data-pdfo-note]");
  const resultPanel = $<HTMLElement>("[data-pdfo-result]");
  const resultMeta = $<HTMLElement>("[data-pdfo-result-meta]");
  const resultList = $<HTMLOListElement>("[data-pdfo-result-list]");
  const downloadAllBtn = $<HTMLButtonElement>("[data-pdfo-download-all]");
  if (!zone || !input || !pagesPanel || !grid || !outputPanel || !runBtn || !resultPanel || !resultList) return;
  root.dataset.initialized = "true";

  let file: File | null = null;
  let bytes: Uint8Array | null = null;
  let info: PdfPageInfo[] = [];
  let pages: OrganizerPage[] = [];
  const selected = new Set<number>();
  const cards = new Map<number, Card>();
  let thumbs: ThumbnailSource | null = null;
  let loadToken = 0;
  let busy = false;
  let job: AbortController | null = null;
  let results: ResultFile[] = [];
  let dragSource: number | null = null;

  const observer =
    "IntersectionObserver" in window
      ? new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const source = Number((entry.target as HTMLElement).dataset.source);
            requestThumb(source);
          }
        }, { rootMargin: "300px" })
      : null;

  function showError(message: string) {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.hidden = false;
  }
  function clearMessages() {
    if (errorBox) errorBox.hidden = true;
    if (noteBox) noteBox.hidden = true;
    rangesInput?.removeAttribute("aria-invalid");
    everyInput?.removeAttribute("aria-invalid");
  }
  function showNote(message: string) {
    if (!noteBox) return;
    noteBox.textContent = message;
    noteBox.hidden = false;
  }

  function clearResults() {
    for (const r of results) URL.revokeObjectURL(r.url);
    results = [];
    resultList!.replaceChildren();
    resultPanel!.hidden = true;
  }

  function requestThumb(source: number) {
    const card = cards.get(source);
    if (!card || card.requested || !thumbs) return;
    card.requested = true;
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    const active = thumbs;
    void active.render(source, canvas, THUMB_SIZE).then(
      () => {
        if (thumbs !== active) return;
        card.canvas = canvas;
        card.thumb.replaceChildren(canvas);
        applyRotation(card, pages.find((p) => p.source === source));
      },
      () => {
        card.requested = false;
      },
    );
  }

  function applyRotation(card: Card, page: OrganizerPage | undefined) {
    if (card.canvas) card.canvas.style.transform = page && page.rotate ? `rotate(${page.rotate}deg)` : "";
  }

  function buildCard(source: number): Card {
    const li = document.createElement("li");
    li.className = "pdfo-card";
    li.draggable = true;
    li.dataset.source = String(source);
    const head = document.createElement("div");
    head.className = "pdfo-card-head";
    const label = document.createElement("label");
    label.className = "pdfo-card-label";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "ds-check";
    check.dataset.pdfoCheck = String(source);
    const title = document.createElement("span");
    const from = document.createElement("span");
    from.className = "pdfo-from";
    label.append(check, title);
    const thumb = document.createElement("div");
    thumb.className = "pdfo-thumb";
    thumb.dataset.pdfoThumb = String(source);
    const placeholder = document.createElement("span");
    placeholder.className = "pdfo-thumb-placeholder";
    placeholder.textContent = String(source + 1);
    thumb.append(placeholder);
    // Paper size and "from p. N" share the line under the thumbnail (the head is too narrow).
    const metaRow = document.createElement("div");
    metaRow.className = "pdfo-card-meta";
    const meta = document.createElement("span");
    metaRow.append(meta, from);
    const actions = document.createElement("div");
    actions.className = "pdfo-card-actions";
    const make = (act: keyof Card["buttons"], icon: string) => {
      const btn = iconButton(icon, "");
      btn.dataset.pdfoAct = act;
      btn.dataset.source = String(source);
      return btn;
    };
    const buttons = {
      earlier: make("earlier", PDF_ICONS.left),
      left: make("left", PDF_ICONS.rotateLeft),
      right: make("right", PDF_ICONS.rotateRight),
      later: make("later", PDF_ICONS.right),
      delete: make("delete", PDF_ICONS.close),
    };
    // Delete sits in the head so the four move/rotate buttons fit one row on narrow cards.
    head.append(label, buttons.delete);
    actions.append(buttons.earlier, buttons.left, buttons.right, buttons.later);
    li.append(head, thumb, metaRow, actions);
    return { li, check, title, from, thumb, meta, buttons, canvas: null, requested: false };
  }

  function sizeText(own: PdfPageInfo, page: OrganizerPage): string {
    const quarter = displayRotation(own.rotate, page) % 180 !== 0;
    const [w, h] = quarter ? [own.height, own.width] : [own.width, own.height];
    const mm = (pt: number) => Math.round((pt * 25.4) / 72);
    const paper = paperName(w, h);
    const orientation = w > h ? " ⟷" : "";
    return paper ? `${paper}${orientation}` : `${mm(w)}×${mm(h)} mm`;
  }

  function isEdited(): boolean {
    return !isUnchanged(pages, info.length, [pages.map((_, i) => i)]);
  }

  /** Re-order card nodes (canvases survive) and refresh labels, buttons and toolbar. */
  function render(focus?: { source: number; act: string }) {
    // Re-attach nodes only when the order changed: detaching hundreds of cards on every rotate or select is slow.
    const nodes = grid!.children;
    if (nodes.length !== pages.length || pages.some((p, i) => nodes[i] !== cards.get(p.source)!.li)) {
      grid!.replaceChildren(...pages.map((p) => cards.get(p.source)!.li));
    }
    pages.forEach((page, pos) => {
      const card = cards.get(page.source)!;
      const label = formatString(strings.pageLabel, pos + 1);
      card.title.textContent = label;
      card.from.textContent = page.source !== pos ? formatString(strings.fromSource, page.source + 1) : "";
      card.meta.textContent = sizeText(info[page.source], page);
      card.check.checked = selected.has(page.source);
      card.check.setAttribute("aria-label", label);
      card.li.classList.toggle("is-selected", selected.has(page.source));
      const name = (text: string) => `${text}: ${label}`;
      const set = (btn: HTMLButtonElement, text: string, disabled = false) => {
        btn.title = name(text);
        btn.setAttribute("aria-label", name(text));
        btn.disabled = busy || disabled;
      };
      set(card.buttons.earlier, strings.moveEarlier, pos === 0);
      set(card.buttons.later, strings.moveLater, pos === pages.length - 1);
      set(card.buttons.left, strings.rotateLeft);
      set(card.buttons.right, strings.rotateRight);
      set(card.buttons.delete, strings.deletePage);
      card.check.disabled = busy;
      card.li.draggable = !busy;
      applyRotation(card, page);
    });
    if (metaEl) metaEl.textContent = formatString(strings.pagesMeta, pages.length, info.length);
    const count = selected.size;
    if (selectedEl) selectedEl.textContent = count ? formatString(strings.selectedCount, count) : "";
    if (selectAllBtn) selectAllBtn.disabled = busy || pages.length === 0 || count === pages.length;
    if (selectNoneBtn) selectNoneBtn.disabled = busy || count === 0;
    for (const b of rotateBtns) b.disabled = busy || count === 0;
    if (deleteSelectedBtn) deleteSelectedBtn.disabled = busy || count === 0;
    if (resetBtn) resetBtn.disabled = busy || !isEdited();
    runBtn!.disabled = busy;
    if (focus) {
      const card = cards.get(focus.source);
      let target: HTMLElement | undefined = card?.buttons[focus.act as keyof Card["buttons"]];
      if (!card || !card.li.isConnected) {
        target = grid!.querySelector<HTMLElement>(".pdfo-card .ds-check") ?? selectAllBtn ?? undefined;
      } else if (target && (target as HTMLButtonElement).disabled) target = card.check;
      // focus() forces a layout of the whole grid: skip it when focus is already there (rotate, select).
      if (target && document.activeElement !== target) target.focus();
    }
  }

  /** Any page edit invalidates the previous result. */
  function edited(focus?: { source: number; act: string }) {
    clearResults();
    clearMessages();
    render(focus);
  }

  function move(source: number, to: number) {
    const from = pages.findIndex((p) => p.source === source);
    if (from < 0) return;
    const target = Math.max(0, Math.min(pages.length - 1, to));
    const [page] = pages.splice(from, 1);
    pages.splice(target, 0, page);
  }

  function rotateSources(sources: Iterable<number>, delta: number) {
    const set = new Set(sources);
    pages = pages.map((p) => (set.has(p.source) ? rotatePage(p, delta) : p));
  }

  function deleteSources(sources: Iterable<number>) {
    const set = new Set(sources);
    pages = pages.filter((p) => !set.has(p.source));
    for (const s of set) selected.delete(s);
  }

  function resetState() {
    loadToken++;
    thumbs?.destroy();
    thumbs = null;
    observer?.disconnect();
    cards.clear();
    grid!.replaceChildren();
    selected.clear();
    pages = [];
    info = [];
    bytes = null;
    file = null;
    clearResults();
    pagesPanel!.hidden = true;
    outputPanel!.hidden = true;
    if (thumbsNote) thumbsNote.hidden = true;
  }

  function loadErrorMessage(e: unknown, name: string): string {
    if (e instanceof WasmError && (e.code === "worker-failed" || e.code === "init-failed")) return strings.processingFailed;
    const message = e instanceof Error ? e.message : String(e);
    const { kind } = classifyPdfError(message);
    if (kind === "encrypted") return strings.errorEncrypted.replace("{name}", name);
    if (kind === "invalid") return strings.errorInvalidPdf.replace("{name}", name);
    return localizeResourceError(e, strings) ?? strings.errorInvalidPdf.replace("{name}", name);
  }

  async function loadFile(picked: File) {
    if (busy) return;
    clearMessages();
    if (!isPdfFile(picked)) {
      showError(strings.errorNotPdf);
      return;
    }
    resetState();
    const token = loadToken;
    if (loading) loading.hidden = false;
    try {
      const data = new Uint8Array(await picked.arrayBuffer());
      const pageInfo = await withPreparing("pdf", pdfPageInfo(data), { host: loading, label: strings.preparing });
      if (token !== loadToken) return;
      if (pageInfo.length === 0) throw new Error("Failed to load PDF: no pages");
      file = picked;
      bytes = data;
      info = pageInfo;
      pages = initialPages(pageInfo.length);
      for (let i = 0; i < pageInfo.length; i++) cards.set(i, buildCard(i));
      setDropzoneHasFile(zone!, true);
      pagesPanel!.hidden = false;
      outputPanel!.hidden = false;
      render();
      for (const card of cards.values()) observer?.observe(card.li);
      try {
        const source = await openThumbnails(data);
        if (token !== loadToken) {
          source.destroy();
          return;
        }
        thumbs = source;
        if (observer) {
          // Re-observe so cards already in view fire now that thumbnails can render.
          for (const card of cards.values()) {
            observer.unobserve(card.li);
            observer.observe(card.li);
          }
        } else for (const s of cards.keys()) requestThumb(s);
      } catch {
        if (token === loadToken && thumbsNote) {
          thumbsNote.textContent = strings.thumbsUnavailable;
          thumbsNote.hidden = false;
        }
      }
    } catch (e) {
      if (token !== loadToken) return;
      setDropzoneHasFile(zone!, false);
      showError(loadErrorMessage(e, picked.name));
    } finally {
      if (token === loadToken && loading) loading.hidden = true;
    }
  }

  function mode(): "single" | "every" | "ranges" {
    return (modeInputs.find((i) => i.checked)?.value as "single" | "every" | "ranges") ?? "single";
  }

  function syncMode() {
    const m = mode();
    if (everyField) everyField.hidden = m !== "every";
    if (rangesField) rangesField.hidden = m !== "ranges";
    runBtn!.textContent = m === "single" ? strings.saveButton : strings.splitButton;
    clearMessages();
  }

  /** Output groups of edited positions for the chosen mode, or null after showing an error. */
  function outputGroups(): number[][] | null {
    if (pages.length === 0) {
      showError(strings.errorNoPages);
      return null;
    }
    const m = mode();
    if (m === "single") return [pages.map((_, i) => i)];
    if (m === "every") {
      const n = Number(everyInput?.value);
      if (!Number.isInteger(n) || n < 1) {
        everyInput?.setAttribute("aria-invalid", "true");
        everyInput?.focus();
        return null;
      }
      return chunkPositions(pages.length, n);
    }
    const parsed = parseRanges(rangesInput?.value ?? "", pages.length);
    if (!parsed.ok) {
      rangesInput?.setAttribute("aria-invalid", "true");
      showError(formatString(strings.errorRanges, parsed.token || "—", pages.length));
      rangesInput?.focus();
      return null;
    }
    return parsed.groups;
  }

  function setBusy(value: boolean) {
    busy = value;
    runBtn!.setAttribute("aria-busy", String(value));
    for (const i of [...modeInputs, everyInput, rangesInput, input]) if (i) i.disabled = value;
    zone!.setAttribute("aria-disabled", String(value));
    render();
  }

  async function run() {
    if (busy || !bytes || !file) return;
    clearMessages();
    clearResults();
    const groups = outputGroups();
    if (!groups) return;
    if (isUnchanged(pages, info.length, groups)) {
      showNote(strings.nothingChanged);
      return;
    }
    const operation = startToolOperation("pdf-organizer");
    const ctrl = new AbortController();
    job = ctrl;
    setBusy(true);
    const started = performance.now();
    const tick = () => {
      if (progressLabel) progressLabel.textContent = `${Math.floor((performance.now() - started) / 1000)} s`;
    };
    tick();
    const timer = setInterval(tick, 1000);
    if (cancelBtn) cancelBtn.disabled = false;
    if (progress) progress.hidden = false;
    try {
      const outputs = await organizePdf(bytes, buildPlans(pages, groups), ctrl.signal);
      const names = outputNames(file.name, groups);
      results = outputs.map((out, i) => ({
        name: names[i],
        bytes: out,
        url: URL.createObjectURL(new Blob([out.slice()], { type: "application/pdf" })),
      }));
      resultList!.replaceChildren(
        ...results.map((r, i) => {
          const { li, meta, actions } = buildFileRow(r.name, i);
          appendMeta(meta, formatString(strings.resultPages, groups[i].length));
          appendMeta(meta, formatBytes(r.bytes.length, 2));
          actions.append(downloadLink(r.url, r.name, `${strings.download}: ${r.name}`));
          return li;
        }),
      );
      const total = results.reduce((sum, r) => sum + r.bytes.length, 0);
      if (resultMeta) resultMeta.textContent = formatString(strings.resultSummary, results.length, formatBytes(total, 2));
      if (downloadAllBtn) downloadAllBtn.hidden = results.length < 2;
      resultPanel!.hidden = false;
      operation.complete();
      revealOutput(resultPanel);
    } catch (e) {
      if (ctrl.signal.aborted || (e instanceof WasmError && e.code === "aborted")) {
        operation.cancel();
        showNote(strings.canceled);
      } else {
        operation.fail("processing_error");
        const message = e instanceof Error ? e.message : String(e);
        showError(localizeResourceError(e, strings) ?? (message ? `${strings.errorBuild} (${message})` : strings.errorBuild));
      }
    } finally {
      clearInterval(timer);
      if (progress) progress.hidden = true;
      job = null;
      setBusy(false);
    }
  }

  // ── events ──────────────────────────────────────────────────────────────
  bindDropzone(zone, input, (files) => {
    const first = files[0];
    if (first) void loadFile(first);
  });

  grid.addEventListener("click", (e) => {
    if (busy || !(e.target instanceof Element)) return;
    const btn = e.target.closest<HTMLButtonElement>("[data-pdfo-act]");
    if (btn) {
      const source = Number(btn.dataset.source);
      const pos = pages.findIndex((p) => p.source === source);
      const act = btn.dataset.pdfoAct ?? "";
      if (act === "earlier") move(source, pos - 1);
      else if (act === "later") move(source, pos + 1);
      else if (act === "left" || act === "right") rotateSources([source], act === "left" ? -90 : 90);
      else if (act === "delete") deleteSources([source]);
      edited({ source, act });
      return;
    }
    const thumb = e.target.closest<HTMLElement>("[data-pdfo-thumb]");
    if (thumb) {
      const source = Number(thumb.dataset.pdfoThumb);
      if (selected.has(source)) selected.delete(source);
      else selected.add(source);
      render();
    }
  });
  grid.addEventListener("change", (e) => {
    const check = e.target instanceof HTMLInputElement ? e.target : null;
    if (!check?.dataset.pdfoCheck) return;
    const source = Number(check.dataset.pdfoCheck);
    if (check.checked) selected.add(source);
    else selected.delete(source);
    render();
  });

  // Drag and drop reorder (mouse); buttons cover keyboard and touch.
  const clearDropMarks = () =>
    grid.querySelectorAll(".is-drop-before, .is-drop-after, .is-dragging").forEach((el) =>
      el.classList.remove("is-drop-before", "is-drop-after", "is-dragging"),
    );
  const dropSide = (card: HTMLElement, x: number) => {
    const rect = card.getBoundingClientRect();
    return x < rect.left + rect.width / 2 ? "before" : "after";
  };
  grid.addEventListener("dragstart", (e) => {
    const card = e.target instanceof Element ? e.target.closest<HTMLElement>(".pdfo-card") : null;
    if (!card || busy) return;
    dragSource = Number(card.dataset.source);
    card.classList.add("is-dragging");
    e.dataTransfer?.setData("text/plain", card.dataset.source ?? "");
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });
  grid.addEventListener("dragover", (e) => {
    const card = e.target instanceof Element ? e.target.closest<HTMLElement>(".pdfo-card") : null;
    if (dragSource === null || !card) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    grid.querySelectorAll(".is-drop-before, .is-drop-after").forEach((el) => el.classList.remove("is-drop-before", "is-drop-after"));
    if (Number(card.dataset.source) !== dragSource) card.classList.add(`is-drop-${dropSide(card, e.clientX)}`);
  });
  grid.addEventListener("drop", (e) => {
    const card = e.target instanceof Element ? e.target.closest<HTMLElement>(".pdfo-card") : null;
    if (dragSource === null || !card) return;
    e.preventDefault();
    const targetSource = Number(card.dataset.source);
    if (targetSource !== dragSource) {
      const side = dropSide(card, e.clientX);
      const from = pages.findIndex((p) => p.source === dragSource);
      let to = pages.findIndex((p) => p.source === targetSource) + (side === "after" ? 1 : 0);
      if (from < to) to -= 1;
      move(dragSource, to);
      edited();
    }
    clearDropMarks();
    dragSource = null;
  });
  grid.addEventListener("dragend", () => {
    clearDropMarks();
    dragSource = null;
  });

  selectAllBtn?.addEventListener("click", () => {
    for (const p of pages) selected.add(p.source);
    render();
  });
  selectNoneBtn?.addEventListener("click", () => {
    selected.clear();
    render();
    selectAllBtn?.focus();
  });
  for (const b of rotateBtns) {
    b.addEventListener("click", () => {
      rotateSources(selected, Number(b.dataset.pdfoRotate));
      edited();
    });
  }
  deleteSelectedBtn?.addEventListener("click", () => {
    deleteSources([...selected]);
    edited();
    selectAllBtn?.focus();
  });
  resetBtn?.addEventListener("click", () => {
    pages = initialPages(info.length);
    selected.clear();
    edited();
    selectAllBtn?.focus();
  });

  for (const i of modeInputs) i.addEventListener("change", syncMode);
  // Editing the ranges withdraws a stale "invalid range" error.
  rangesInput?.addEventListener("input", () => {
    if (rangesInput.getAttribute("aria-invalid") === "true" && errorBox) errorBox.hidden = true;
    rangesInput.removeAttribute("aria-invalid");
  });
  everyInput?.addEventListener("input", () => everyInput.removeAttribute("aria-invalid"));
  runBtn.addEventListener("click", () => void run());
  cancelBtn?.addEventListener("click", () => {
    cancelBtn.disabled = true;
    job?.abort();
  });
  downloadAllBtn?.addEventListener("click", () => {
    if (results.length < 2 || !file) return;
    const url = URL.createObjectURL(storedZip(results));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${baseName(file.name)}_split.zip`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });
  syncMode();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
