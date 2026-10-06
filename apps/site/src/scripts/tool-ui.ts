/**
 * Shared DOM behaviors for tool controllers (pairs with styles/tool-ui.css,
 * docs/qa/tool-ui-kit.md): copy-to-clipboard with the `.is-copied` button
 * state, and drop-zone wiring with the `.is-dragover` state. Import from a
 * `*.client.ts`; nothing here runs on import (SSR/tree-shake safe).
 */

const restoreTimers = new WeakMap<HTMLElement, number>();

/**
 * Copy `text` and flash the copied state on `btn`: adds `.is-copied`, swaps
 * the label to `copiedLabel` (icon-only buttons: pass null to keep content and
 * only update `aria-label`/`title`), restores after `ms`. Re-clicks restart
 * the timer instead of capturing the "copied" label as the original.
 * Resolves false when the Clipboard API is unavailable or rejected.
 */
export async function copyWithFeedback(
  btn: HTMLElement,
  text: string,
  copiedLabel: string | null,
  ms = 1200,
): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return false;
  }
  const pending = restoreTimers.get(btn);
  if (pending === undefined) {
    btn.dataset.copyOriginalText = btn.textContent ?? "";
    btn.dataset.copyOriginalLabel = btn.getAttribute("aria-label") ?? "";
  } else {
    window.clearTimeout(pending);
  }
  btn.classList.add("is-copied");
  if (copiedLabel !== null) {
    if (btn.children.length === 0) btn.textContent = copiedLabel;
    if (btn.hasAttribute("aria-label")) btn.setAttribute("aria-label", copiedLabel);
  }
  restoreTimers.set(
    btn,
    window.setTimeout(() => {
      restoreTimers.delete(btn);
      btn.classList.remove("is-copied");
      if (copiedLabel !== null) {
        if (btn.children.length === 0) btn.textContent = btn.dataset.copyOriginalText ?? "";
        if (btn.dataset.copyOriginalLabel) btn.setAttribute("aria-label", btn.dataset.copyOriginalLabel);
      }
    }, ms),
  );
  return true;
}

/**
 * Wire a `.ds-dropzone`: drag highlight (`.is-dragover`), drop → `onFiles`,
 * click on the zone background → opens `input` (whose `change` also calls
 * `onFiles`, then clears `input.value` so re-picking the same file fires
 * `change` again — keep the File objects you receive, not `input.files`). Keyboard users reach the picker through the visible
 * `.ds-file-btn` inside the zone (the FileDrop component renders it), so the
 * zone itself is not a focusable button. Returns an unbind function.
 */
export function bindDropzone(
  zone: HTMLElement,
  input: HTMLInputElement | null,
  onFiles: (files: File[]) => void,
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
    if (!input || isDisabled() || target?.closest("button, a, input, label")) return;
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
