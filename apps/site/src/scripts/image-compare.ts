/**
 * Before/after image comparison controller for `components/tool/ImageCompare.astro`
 * (image-compressor, image-converter, image-resizer). Overlays original and
 * result with the original (before) on the left and the result (after) on the
 * right of the divider. The native range value is the divider position from
 * the left; its localized aria-valuetext reports "Result visible: (100 − N)%"
 * or pointer drag with pointer capture (touch keeps vertical page scroll via
 * `touch-action: pan-y`). Clipping is written once per animation frame.
 * Fit / 1:1 zoom: 1:1 renders natural pixel sizes in a focusable scroll region.
 * Does not own object URLs: tools revoke their own and call `reset()` first.
 */
import { formatBytes } from "@/lib/format";
import { formatSizeChange, savingsPercent } from "@/tools/image-tools";

/** One side of the comparison: an object URL the tool owns plus its byte size. */
export interface CompareSide {
  url: string;
  size: number;
}

/** Which facts the meta row shows per side (skip what the tool headline already says). */
export interface CompareMetaOptions {
  originalDims?: boolean;
  originalSize?: boolean;
  resultDims?: boolean;
  resultSize?: boolean;
  /** Signed "−N%" / "+N%" size change of the result vs. the original. */
  change?: boolean;
}

export interface ImageCompareController {
  /**
   * Load both images and reveal the panel at 50%. Resolves false (panel stays
   * hidden) when the result can't be displayed or a newer show/reset won; a
   * non-displayable original degrades to a result-only view.
   */
  show(original: CompareSide | null, result: CompareSide): Promise<boolean>;
  /** Hide, drop image sources (frees decoded bitmaps) and cancel pending work. */
  reset(): void;
}

interface RuntimeStrings {
  valueText: string;
  change: string;
  viewport: string;
}

type Mode = "fit" | "actual";

/** Loads `url` into `img` and waits for decode; false on a decode error. */
function loadInto(img: HTMLImageElement, url: string): Promise<boolean> {
  img.src = url;
  return img.decode().then(
    () => img.naturalWidth > 0,
    () => false,
  );
}

/**
 * Wire one `[data-image-compare]` root. Call once per tool; keep the returned
 * controller and use `show()` after every successful result.
 */
export function bindImageCompare(root: HTMLElement, meta: CompareMetaOptions = {}): ImageCompareController {
  const q = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
  let strings: RuntimeStrings = { valueText: "{percent}%", change: "", viewport: "" };
  try {
    strings = { ...strings, ...JSON.parse(root.dataset.icStrings || "{}") };
  } catch {
    /* keep defaults */
  }

  const range = q<HTMLInputElement>("[data-ic-range]");
  const viewport = q<HTMLElement>("[data-ic-viewport]");
  const stage = q<HTMLElement>("[data-ic-stage]");
  const originalImg = q<HTMLImageElement>("[data-ic-original]");
  const resultImg = q<HTMLImageElement>("[data-ic-result]");
  const handle = q<HTMLElement>("[data-ic-handle]");
  const originalMeta = q<HTMLElement>("[data-ic-original-meta]");
  const resultMeta = q<HTMLElement>("[data-ic-result-meta]");
  const modeButtons = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-ic-mode]"));

  let position = 50;
  let mode: Mode = "fit";
  let frame = 0;
  let token = 0;
  let stageW = 0;
  let stageH = 0;
  let dragId: number | null = null;
  let touchPending = false;

  /** Write the clip position (and 1:1 handle height) once per animation frame. */
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      root.style.setProperty("--ic-pos", `${position}%`);
      if (mode === "actual") {
        const y = viewport.scrollTop + Math.min(viewport.clientHeight, stageH) / 2;
        root.style.setProperty("--ic-handle-y", `${y}px`);
      } else {
        root.style.removeProperty("--ic-handle-y");
      }
    });
  }

  function setPosition(pct: number, fromRange = false) {
    position = Math.min(100, Math.max(0, pct));
    const rounded = Math.round(position);
    if (!fromRange) range.value = String(rounded);
    // The result occupies the part right of the divider.
    range.setAttribute("aria-valuetext", strings.valueText.replace("{percent}", String(100 - rounded)));
    schedule();
  }

  /** At 1:1, scroll horizontally so the divider stays inside the viewport. */
  function keepDividerVisible() {
    if (mode !== "actual") return;
    const x = (position / 100) * stageW;
    const pad = 32;
    if (x < viewport.scrollLeft + pad || x > viewport.scrollLeft + viewport.clientWidth - pad) {
      viewport.scrollLeft = Math.max(0, x - viewport.clientWidth / 2);
    }
  }

  function setMode(next: Mode) {
    mode = next;
    root.classList.toggle("is-actual", next === "actual");
    for (const b of modeButtons) b.setAttribute("aria-pressed", String(b.dataset.icMode === next));
    if (next === "actual") {
      // Focusable, labelled scroll region only when it can actually scroll.
      viewport.tabIndex = 0;
      viewport.setAttribute("role", "region");
      viewport.setAttribute("aria-label", strings.viewport);
      viewport.scrollTop = 0;
      keepDividerVisible();
    } else {
      viewport.removeAttribute("tabindex");
      viewport.removeAttribute("role");
      viewport.removeAttribute("aria-label");
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    }
    schedule();
  }

  function pctFromEvent(e: PointerEvent): number {
    const rect = stage.getBoundingClientRect();
    return rect.width > 0 ? ((e.clientX - rect.left) / rect.width) * 100 : position;
  }

  // Keyboard / assistive tech: the native range is the single source of input.
  range.addEventListener("input", () => {
    setPosition(Number(range.value), true);
    keepDividerVisible();
  });

  // Pointer drag. Fit: anywhere on the frame; 1:1: only on the handle, so the
  // viewport itself still pans/scrolls natively. Touch waits for movement so a
  // vertical swipe scrolls the page (the browser then sends pointercancel).
  function onPointerDown(e: PointerEvent) {
    if (dragId !== null || (e.pointerType === "mouse" && e.button !== 0)) return;
    if (mode === "actual" && !handle.contains(e.target as Node)) return;
    dragId = e.pointerId;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    touchPending = e.pointerType === "touch";
    if (!touchPending) {
      e.preventDefault();
      setPosition(pctFromEvent(e));
    }
    range.focus({ preventScroll: true });
  }
  function onPointerMove(e: PointerEvent) {
    if (e.pointerId !== dragId) return;
    touchPending = false;
    setPosition(pctFromEvent(e));
  }
  function endDrag(e: PointerEvent, commit: boolean) {
    if (e.pointerId !== dragId) return;
    if (commit && touchPending) setPosition(pctFromEvent(e));
    dragId = null;
    touchPending = false;
  }
  viewport.addEventListener("pointerdown", onPointerDown);
  viewport.addEventListener("pointermove", onPointerMove);
  viewport.addEventListener("pointerup", (e) => endDrag(e, true));
  viewport.addEventListener("pointercancel", (e) => endDrag(e, false));
  viewport.addEventListener("scroll", schedule, { passive: true });

  for (const b of modeButtons) {
    b.addEventListener("click", () => setMode(b.dataset.icMode === "actual" ? "actual" : "fit"));
  }

  function metaText(parts: string[]): string {
    return parts.filter(Boolean).join(" · ");
  }

  function renderMeta(original: CompareSide | null, hasOriginal: boolean, result: CompareSide) {
    const dims = (img: HTMLImageElement) => `${img.naturalWidth}×${img.naturalHeight}`;
    originalMeta.textContent = original
      ? metaText([
          meta.originalDims !== false && hasOriginal ? dims(originalImg) : "",
          meta.originalSize ? formatBytes(original.size, 2) : "",
        ])
      : "";
    resultMeta.textContent = metaText([
      meta.resultDims !== false ? dims(resultImg) : "",
      meta.resultSize ? formatBytes(result.size, 2) : "",
    ]);
    if (meta.change && original) {
      const change = document.createElement("span");
      const saved = savingsPercent(original.size, result.size);
      change.className = saved > 0 ? "ds-compare-change is-smaller" : saved < 0 ? "ds-compare-change is-larger" : "ds-compare-change";
      if (strings.change) {
        const label = document.createElement("span");
        label.className = "visually-hidden";
        label.textContent = `${strings.change} `;
        change.append(label);
      }
      change.append(formatSizeChange(original.size, result.size));
      if (resultMeta.textContent) resultMeta.append(" · ");
      resultMeta.append(change);
    }
  }

  function reset() {
    token++;
    root.hidden = true;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    dragId = null;
    originalImg.removeAttribute("src");
    resultImg.removeAttribute("src");
    originalMeta.textContent = "";
    resultMeta.textContent = "";
    root.classList.remove("is-single");
  }

  async function show(original: CompareSide | null, result: CompareSide): Promise<boolean> {
    reset();
    const mine = token;
    const [okResult, okOriginal] = await Promise.all([
      loadInto(resultImg, result.url),
      original ? loadInto(originalImg, original.url) : Promise.resolve(false),
    ]);
    if (mine !== token) return false;
    if (!okResult) {
      reset();
      return false;
    }
    const single = !okOriginal;
    if (single) originalImg.removeAttribute("src");
    root.classList.toggle("is-single", single);

    // Fit framing follows the original's aspect ratio (resizer: both images
    // are scaled into this one frame with object-fit: contain, never stretched).
    const base = single ? resultImg : originalImg;
    stageW = Math.max(originalImg.naturalWidth || 0, resultImg.naturalWidth);
    stageH = Math.max(originalImg.naturalHeight || 0, resultImg.naturalHeight);
    root.style.setProperty("--ic-ratio", `${base.naturalWidth} / ${base.naturalHeight}`);
    root.style.setProperty("--ic-ratio-n", String(base.naturalWidth / base.naturalHeight));
    root.style.setProperty("--ic-w", `${stageW}px`);
    root.style.setProperty("--ic-h", `${stageH}px`);
    root.style.setProperty("--ic-ow", `${originalImg.naturalWidth || 0}px`);
    root.style.setProperty("--ic-oh", `${originalImg.naturalHeight || 0}px`);
    root.style.setProperty("--ic-rw", `${resultImg.naturalWidth}px`);
    root.style.setProperty("--ic-rh", `${resultImg.naturalHeight}px`);

    renderMeta(original, okOriginal, result);
    root.hidden = false;
    setPosition(single ? 0 : 50);
    setMode(mode);
    return true;
  }

  setPosition(50);
  return { show, reset };
}
