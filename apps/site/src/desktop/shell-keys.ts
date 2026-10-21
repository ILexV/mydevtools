/**
 * Desktop hotkeys shared by the shell and every tool iframe: the launcher
 * (Ctrl/⌘+K), window switching (Alt+` on Windows/Linux, Ctrl+` on macOS, where
 * Option+` types an accent) and Alt+Shift+arrows to dock, maximize or minimize,
 * plus Alt+Shift+W to close. Window keys stay out of text fields so word
 * selection (Option+Shift+arrows) and typing keep working there.
 */

export type ShellCommand =
  | "launcher"
  | "next-window"
  | "previous-window"
  | "dock-left"
  | "dock-right"
  | "maximize"
  | "minimize"
  | "close-window";

export interface ShellKey {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

/** Fields where the browser and the tool own the keyboard. Works across iframe realms. */
export const EDITABLE_SELECTOR = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

export function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  return typeof element?.closest === "function" && element.closest(EDITABLE_SELECTOR) !== null;
}

export function shellCommand(event: ShellKey, editable: boolean, mac: boolean): ShellCommand | null {
  if (event.isComposing) return null;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (key === "k" || event.code === "KeyK")) {
    return "launcher";
  }
  if (event.code === "Backquote" && !event.metaKey) {
    const held = mac ? event.ctrlKey && !event.altKey : event.altKey && !event.ctrlKey;
    if (held) return event.shiftKey ? "previous-window" : "next-window";
  }
  if (editable || !event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return null;
  switch (event.code || event.key) {
    case "ArrowLeft":
      return "dock-left";
    case "ArrowRight":
      return "dock-right";
    case "ArrowUp":
      return "maximize";
    case "ArrowDown":
      return "minimize";
    case "KeyW":
      return "close-window";
    default:
      return null;
  }
}

/** Next window in taskbar order, wrapping around; the first one when nothing is active. */
export function cycleWindow(ids: readonly string[], activeId: string | null, step: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const index = activeId ? ids.indexOf(activeId) : -1;
  if (index < 0) return step === 1 ? ids[0]! : ids.at(-1)!;
  return ids[(index + step + ids.length) % ids.length]!;
}

export function isMacPlatform(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}
