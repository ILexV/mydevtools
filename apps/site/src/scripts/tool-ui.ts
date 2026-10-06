/**
 * Shared DOM behaviors for tool controllers (pairs with styles/tool-ui.css,
 * docs/qa/tool-ui-kit.md): copy-to-clipboard with width-stable ✓/⚠ button
 * feedback + polite announcement, empty-state / "Load example" wiring, and
 * drop-zone wiring with the `.is-dragover` state, revealing an off-screen
 * result after an explicit action (revealOutput) and first-run WASM
 * "Preparing…" feedback (startPreparing/withPreparing). Import from a
 * `*.client.ts`; nothing here runs on import (SSR/tree-shake safe).
 */

const restoreTimers = new WeakMap<HTMLElement, number>();

const SVG_NS = "http://www.w3.org/2000/svg";
/** Same paths as components/Icon.astro (`copy`, `check`, `alert`). */
const FACE_ICONS = {
  copy: '<rect x="7" y="7" width="9" height="9" rx="1.5"/><path d="M13 7V4.5A1.5 1.5 0 0 0 11.5 3h-6A1.5 1.5 0 0 0 4 4.5v6A1.5 1.5 0 0 0 5.5 12H7"/>',
  check: '<path d="m4 10.5 4 4 8-9"/>',
  alert: '<path d="M10 3 17.5 16H2.5L10 3Z"/><path d="M10 8v4M10 14.2v.1"/>',
} as const;

function faceIcon(name: keyof typeof FACE_ICONS, size: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 20 20", width: String(size), height: String(size), fill: "none",
    stroke: "currentColor", "stroke-width": "1.9", "stroke-linecap": "round",
    "stroke-linejoin": "round", "aria-hidden": "true",
  })) svg.setAttribute(k, v);
  svg.innerHTML = FACE_ICONS[name];
  return svg;
}

function fillFace(face: HTMLElement, icon: keyof typeof FACE_ICONS, label: string | null | undefined, iconOnly: boolean, size: number): void {
  const key = `${icon}|${iconOnly ? "" : (label ?? "")}`;
  if (face.dataset.faceKey === key) return;
  face.dataset.faceKey = key;
  face.replaceChildren(faceIcon(icon, size));
  if (!iconOnly && label) {
    const text = document.createElement("span");
    text.className = "ds-copy-text";
    text.textContent = label;
    face.append(text);
  }
}

/**
 * Reserve a copy button's width for its feedback states: wraps the current
 * content in stacked faces (idle / done ✓ + `copiedLabel` / fail ⚠) that
 * share one grid cell, so swapping faces never changes the width. The fail
 * face is always icon-only — long failure text ("Не удалось скопировать")
 * would widen header buttons; it goes to aria-label/title + announce()
 * instead. Icon-only buttons (no text) get icon-only faces; an empty one
 * (e.g. a row button created by a controller with just aria-label) gets
 * the copy icon as its idle face. Idempotent.
 * `failedLabel` is accepted for backward compatibility and ignored here.
 * Call it at bind time (or render CopyButton.astro) so the width is final
 * before the first click; copyWithFeedback() also calls it lazily.
 */
export function prepareCopyButton(
  btn: HTMLElement,
  copiedLabel: string | null,
  failedLabel?: string | null,
): void {
  let faces = btn.querySelector<HTMLElement>(":scope > .ds-copy-faces");
  const iconOnly = faces
    ? faces.dataset.iconOnly === "true"
    : (btn.textContent ?? "").trim() === "";
  if (!faces) {
    faces = document.createElement("span");
    faces.className = "ds-copy-faces";
    faces.dataset.iconOnly = String(iconOnly);
    const idle = document.createElement("span");
    idle.className = "ds-copy-face ds-copy-face-idle";
    idle.append(...Array.from(btn.childNodes));
    if (iconOnly && !idle.querySelector("svg")) idle.replaceChildren(faceIcon("copy", 18));
    const done = document.createElement("span");
    done.className = "ds-copy-face ds-copy-face-done";
    const fail = document.createElement("span");
    fail.className = "ds-copy-face ds-copy-face-fail";
    faces.append(idle, done, fail);
    btn.append(faces);
  }
  const size = iconOnly ? 18 : 15;
  const done = faces.querySelector<HTMLElement>(":scope > .ds-copy-face-done");
  const fail = faces.querySelector<HTMLElement>(":scope > .ds-copy-face-fail");
  if (done) fillFace(done, "check", copiedLabel, iconOnly, size);
  void failedLabel;
  if (fail) fillFace(fail, "alert", null, true, size);
}

/** Write text to the clipboard; falls back to execCommand("copy") where the async API is missing or refused. */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  const active = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.setAttribute("aria-hidden", "true");
  ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  active?.focus({ preventScroll: true });
  return ok;
}

let announcer: HTMLElement | null = null;

/**
 * Announce a short message through one shared, visually hidden polite live
 * region (role="status"), e.g. "Copied". Created lazily on first use.
 */
export function announce(text: string): void {
  if (!text) return;
  if (!announcer?.isConnected) {
    announcer = document.createElement("div");
    announcer.className = "visually-hidden";
    announcer.setAttribute("role", "status");
    announcer.setAttribute("aria-live", "polite");
    announcer.dataset.dsAnnouncer = "";
    document.body.append(announcer);
    // A region inserted in the same tick as its text is often skipped.
    const region = announcer;
    window.setTimeout(() => setLiveText(region, text), 120);
    return;
  }
  setLiveText(announcer, text);
}

export interface CopyFeedbackOptions {
  /** Localized failure text for aria-label/title + announcement (default: `data-copy-failed-label`). The button itself shows only ⚠. */
  failedLabel?: string | null;
  /** Announce the outcome via the shared polite live region (default true). */
  announce?: boolean;
}

/**
 * Copy `text` to the clipboard and give feedback on the clicked control:
 * only after a successful write it shows ✓ + `copiedLabel` (`.is-copied`),
 * announces it politely and updates `aria-label`; on failure it shows an
 * icon-only ⚠ (`.is-copy-failed`) and delivers `failedLabel` through
 * aria-label/title + the polite announcement (no width change). Content is swapped through
 * width-reserving faces (see prepareCopyButton), so the button never jumps.
 * Restores after `ms`; re-clicks restart the timer. Pass `copiedLabel = null`
 * for icon-only buttons that should keep their name. Resolves the outcome
 * (false = nothing was copied; callers may still show their own error).
 */
export async function copyWithFeedback(
  btn: HTMLElement,
  text: string,
  copiedLabel: string | null,
  ms = 1500,
  options: CopyFeedbackOptions = {},
): Promise<boolean> {
  const failedLabel = options.failedLabel ?? btn.dataset.copyFailedLabel ?? null;
  prepareCopyButton(btn, copiedLabel, failedLabel);
  const ok = await writeClipboard(text);

  const pending = restoreTimers.get(btn);
  if (pending === undefined) {
    // "\u0000" marks an absent attribute (restored by removing it).
    btn.dataset.copyOriginalLabel = btn.getAttribute("aria-label") ?? "\u0000";
    btn.dataset.copyOriginalTitle = btn.getAttribute("title") ?? "\u0000";
  } else {
    window.clearTimeout(pending);
  }
  const restoreAttr = (name: string, saved: string | undefined) => {
    if (saved === undefined) return;
    if (saved === "\u0000") btn.removeAttribute(name);
    else btn.setAttribute(name, saved);
  };
  // Reset attributes from a previous state before applying the new one.
  restoreAttr("aria-label", btn.dataset.copyOriginalLabel);
  restoreAttr("title", btn.dataset.copyOriginalTitle);
  btn.classList.toggle("is-copied", ok);
  btn.classList.toggle("is-copy-failed", !ok);
  if (ok) {
    if (copiedLabel && btn.hasAttribute("aria-label")) btn.setAttribute("aria-label", copiedLabel);
  } else if (failedLabel) {
    // The fail face is icon-only, so the text must reach users another way.
    btn.setAttribute("aria-label", failedLabel);
    btn.setAttribute("title", failedLabel);
  }
  const stateLabel = ok ? copiedLabel : failedLabel;
  if (stateLabel && options.announce !== false) announce(stateLabel);

  restoreTimers.set(
    btn,
    window.setTimeout(() => {
      restoreTimers.delete(btn);
      btn.classList.remove("is-copied", "is-copy-failed");
      restoreAttr("aria-label", btn.dataset.copyOriginalLabel);
      restoreAttr("title", btn.dataset.copyOriginalTitle);
    }, ms),
  );
  return ok;
}

/**
 * Wire a `.ds-dropzone`: drag highlight (`.is-dragover`), drop → `onFiles`,
 * click on the zone background → opens `input` (whose `change` also calls
 * `onFiles`, then clears `input.value` so re-picking the same file fires
 * `change` again — keep the File objects you receive, not `input.files`). Keyboard users reach the picker through the visible
 * `.ds-file-btn` inside the zone (the FileDrop component renders it), so the
 * zone itself is not a focusable button. Returns an unbind function.
 *
 * `clickToOpen: false` keeps drop + the input's `change` wiring but stops
 * background clicks from opening the picker — for zones that wrap an editor
 * (a textarea you drop a file onto) whose clicks must place the caret; a
 * separate "Open" button then calls `input.click()`.
 */
export function bindDropzone(
  zone: HTMLElement,
  input: HTMLInputElement | null,
  onFiles: (files: File[]) => void,
  { clickToOpen = true }: { clickToOpen?: boolean } = {},
): () => void {
  let depth = 0;
  const setOver = (on: boolean) => zone.classList.toggle("is-dragover", on);
  const isDisabled = () => zone.getAttribute("aria-disabled") === "true" || input?.disabled === true;

  const onEnter = (e: DragEvent) => {
    e.preventDefault();
    if (isDisabled()) return;
    depth++;
    setOver(true);
  };
  const onOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = isDisabled() ? "none" : "copy";
  };
  const onLeave = () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) setOver(false);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    depth = 0;
    setOver(false);
    if (isDisabled()) return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) onFiles(input?.multiple ? files : files.slice(0, 1));
  };
  const onClick = (e: MouseEvent) => {
    // Inner buttons (clear/change) and the input itself handle their own clicks.
    const target = e.target as HTMLElement | null;
    if (!clickToOpen || !input || isDisabled() || target?.closest("button, a, input, label")) return;
    input.click();
  };
  const onChange = () => {
    if (!input) return;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (files.length > 0) onFiles(files);
  };

  zone.addEventListener("dragenter", onEnter);
  zone.addEventListener("dragover", onOver);
  zone.addEventListener("dragleave", onLeave);
  zone.addEventListener("drop", onDrop);
  zone.addEventListener("click", onClick);
  input?.addEventListener("change", onChange);
  return () => {
    zone.removeEventListener("dragenter", onEnter);
    zone.removeEventListener("dragover", onOver);
    zone.removeEventListener("dragleave", onLeave);
    zone.removeEventListener("drop", onDrop);
    zone.removeEventListener("click", onClick);
    input?.removeEventListener("change", onChange);
  };
}

/**
 * Reflect "a file is selected" on a FileDrop zone: toggles `.has-file` and,
 * when the zone was rendered with `changeLabel`, swaps the button text
 * between "Choose file" and "Choose another file".
 */
export function setDropzoneHasFile(zone: HTMLElement, hasFile: boolean): void {
  zone.classList.toggle("has-file", hasFile);
  const text = zone.querySelector<HTMLElement>(".ds-file-btn-text[data-change-label]");
  if (!text) return;
  const next = hasFile ? text.dataset.changeLabel : text.dataset.chooseLabel;
  if (next !== undefined) text.textContent = next;
}

/**
 * Update a polite live region (e.g. `.ds-output-summary`) so the new text is
 * announced even when it equals the previous one: clear, then set on the next
 * frame. Empty text just clears (the summary hides via :empty).
 */
export function setLiveText(el: HTMLElement, text: string): void {
  el.textContent = "";
  if (text) requestAnimationFrame(() => { el.textContent = text; });
}

/**
 * Mark an empty-state host (`.ds-editor`, output panel) as empty or filled:
 * toggles `is-empty`, which shows its direct-child `.ds-empty-state` and
 * hides its `.ds-when-filled` children. Call after every programmatic write.
 */
export function syncEmptyState(host: HTMLElement, isEmpty: boolean): void {
  host.classList.toggle("is-empty", isEmpty);
}

/**
 * Keep `host`'s empty state in sync with a text field (input/change events,
 * plus once now — browsers may restore a value on back-navigation).
 * Returns `sync()` to call after setting `field.value` from code, which
 * fires no input event (or use setFieldValue()).
 */
export function bindEmptyState(
  host: HTMLElement,
  field: HTMLTextAreaElement | HTMLInputElement,
): () => void {
  const sync = () => syncEmptyState(host, field.value.length === 0);
  field.addEventListener("input", sync);
  field.addEventListener("change", sync);
  sync();
  return sync;
}

/**
 * Set a field's value as if the user typed it: dispatches a bubbling
 * `input` event so the tool's own listeners and bindEmptyState() react.
 */
export function setFieldValue(field: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Wire a "Load example" button: the example is inserted only on click (never
 * silently). `apply` writes it (e.g. `setFieldValue(textarea, EXAMPLE)` or
 * `editor.setValue(EXAMPLE)`). Afterwards focus moves to `focusTarget` —
 * default: the field inside the button's `.ds-editor` — because the
 * empty-state overlay (and the button with it) disappears. Returns unbind.
 */
export function bindLoadExample(
  button: HTMLElement,
  apply: () => void | Promise<void>,
  focusTarget?: HTMLElement | null,
): () => void {
  const onClick = async () => {
    await apply();
    const target =
      focusTarget ??
      button.closest(".ds-editor")?.querySelector<HTMLElement>("textarea, input, [contenteditable=true]");
    target?.focus({ preventScroll: true });
  };
  button.addEventListener("click", onClick);
  return () => button.removeEventListener("click", onClick);
}

/** Gap (px) kept between the sticky site header and a revealed panel. */
const REVEAL_GAP = 12;

/** Bottom edge of the sticky site header (0 when it isn't pinned). */
function stickyHeaderBottom(): number {
  const header = document.querySelector<HTMLElement>("header.site-header");
  if (!header) return 0;
  const rect = header.getBoundingClientRect();
  return rect.top <= 0 && rect.bottom > 0 ? rect.bottom : 0;
}

/**
 * Scroll an output/result panel into view after an explicit action (Generate,
 * Compress, Beautify…) when its top is off screen — typically on phones, where
 * the result panel sits below the fold and the click otherwise looks like it
 * did nothing. No-op when the panel's top is already visible (desktop
 * two-column workbench), when it is hidden, or while the user types — call it
 * only from click/submit handlers, never from live input updates. Offsets the
 * sticky header, smooth only without prefers-reduced-motion, never moves focus.
 */
export function revealOutput(target: HTMLElement | null | undefined): void {
  if (!target) return;
  // Wait a frame so freshly un-hidden / filled content has its final layout.
  requestAnimationFrame(() => {
    if (!target.isConnected || target.hidden || target.getClientRects().length === 0) return;
    const top = target.getBoundingClientRect().top;
    const minTop = stickyHeaderBottom();
    // "Visible" = the panel top sits in the upper ~70% of the viewport, so a
    // meaningful part of the result shows (not just its header strip).
    const visibleLimit = window.innerHeight - Math.max(96, window.innerHeight * 0.3);
    if (top >= minTop && top <= visibleLimit) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({
      top: Math.max(0, window.scrollY + top - minTop - REVEAL_GAP),
      behavior: reduce ? "auto" : "smooth",
    });
  });
}

/** WASM domains (or other lazy engines) that finished their first run on this page. */
const warmEngines = new Set<string>();

export interface PreparingOptions {
  /** Element the indicator is appended to (action row, output panel). */
  host: HTMLElement | null | undefined;
  /** Localized "Preparing…" (`Common_Preparing`, passed through the tool's JSON island). */
  label: string | null | undefined;
  /** Show only after this many ms (default 300) — fast loads show nothing. */
  delay?: number;
}

/**
 * First-run feedback for a lazily loaded WASM engine ("Preparing…"): the
 * first call per `engine` key on a page may download + compile the module.
 * If it is still pending after `delay` ms, a slim indeterminate bar in the
 * category colour plus the label appears in `host` (`.ds-preparing`) and the
 * label is announced politely once; the host gets `.is-preparing` (a panel
 * hides its stale `.ds-when-filled` body). Returns `done()` — call it when the engine
 * answered (result, error, first progress tick); it removes the indicator and
 * marks the engine warm, so later runs never show it. Idempotent.
 */
export function startPreparing(engine: string, { host, label, delay = 300 }: PreparingOptions): () => void {
  if (warmEngines.has(engine) || !host || !label) {
    return () => { warmEngines.add(engine); };
  }
  let el: HTMLElement | null = null;
  let finished = false;
  const timer = window.setTimeout(() => {
    if (finished || !host.isConnected) return;
    el = document.createElement("div");
    el.className = "ds-preparing";
    el.dataset.dsPreparing = engine;
    const bar = document.createElement("span");
    bar.className = "ds-preparing-bar";
    bar.setAttribute("aria-hidden", "true");
    bar.append(document.createElement("i"));
    const text = document.createElement("span");
    text.className = "ds-preparing-text";
    text.textContent = label;
    el.append(text, bar);
    // The node itself stays silent; the shared polite region speaks once.
    el.setAttribute("aria-hidden", "true");
    host.append(el);
    // Panels hide their stale result body (`.ds-when-filled`) meanwhile.
    host.classList.add("is-preparing");
    announce(label);
  }, delay);
  return () => {
    if (finished) return;
    finished = true;
    warmEngines.add(engine);
    window.clearTimeout(timer);
    if (el) host.classList.remove("is-preparing");
    el?.remove();
  };
}

/**
 * Await `work` with startPreparing() feedback: the indicator ends when the
 * promise settles (success or error). For jobs that report progress, use
 * startPreparing() directly and also call `done()` on the first tick.
 */
export async function withPreparing<T>(engine: string, work: Promise<T>, options: PreparingOptions): Promise<T> {
  const done = startPreparing(engine, options);
  try {
    return await work;
  } finally {
    done();
  }
}
