/**
 * Desktop preferences and window layout, versioned for localStorage.
 * Layout remembers frames only: slug, geometry, dock, which window is active.
 * It never stores tool input, files, or results. A broken payload or an
 * unknown version yields an empty desk; the catalog still works.
 * Wallpaper bytes live in IndexedDB (`wallpaper.ts`), not in this JSON.
 */

import type { Bounds, DeskState, DeskWindow, ShortcutPositions } from "./types.ts";
import { WALLPAPER_PRESETS, type WallpaperPresetId } from "./wallpaper.ts";

export const LAYOUT_KEY = "mdt.desktop.layout.v1";
export const PREFS_KEY = "mdt.desktop.prefs.v1";
/** "Open the desktop from the home page." Absent means the catalog stays. */
export const ENTRY_KEY = "mdt.desktop.entry.v1";
/** Session flag so "back to catalog" is not immediately sent back to the desk. */
export const SKIP_KEY = "mdt.desktop.skip";

const PRESET_IDS = new Set<string>(WALLPAPER_PRESETS.map((preset) => preset.id));

export interface DeskPrefs {
  preset: WallpaperPresetId;
  fit: "cover" | "contain";
  /** 0–60, applied as a dark veil over the wallpaper. */
  dim: number;
  hasImage: boolean;
  /** `cat:<id>` or `tool:<slug>`, in user order. */
  shortcuts: string[];
  positions: ShortcutPositions;
  /** Same id shape as shortcuts. Shown on the taskbar even when closed. */
  pinned: string[];
  iconSize: "regular" | "large";
  /** Comfortable is the roomy default. Compact packs icons and the shell chrome. */
  density: "comfortable" | "compact";
  locked: boolean;
  /** The shortcut-move hint stays hidden after the person dismisses it. */
  hintDismissed: boolean;
}

export function defaultPrefs(categoryIds: readonly string[]): DeskPrefs {
  return {
    preset: "dusk",
    fit: "cover",
    dim: 0,
    hasImage: false,
    shortcuts: categoryIds.map((id) => `cat:${id}`),
    positions: {},
    pinned: [],
    iconSize: "regular",
    density: "comfortable",
    locked: false,
    hintDismissed: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readBounds(value: unknown): Bounds | null {
  if (!isRecord(value) || !finite(value.x) || !finite(value.y) || !finite(value.width) || !finite(value.height)) {
    return null;
  }
  if (value.width <= 0 || value.height <= 0) return null;
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

function readCell(value: unknown): { column: number; row: number } | null {
  if (!isRecord(value) || typeof value.column !== "number" || typeof value.row !== "number") return null;
  if (!Number.isInteger(value.column) || !Number.isInteger(value.row)) return null;
  if (value.column < 0 || value.column > 255 || value.row < 0 || value.row > 255) return null;
  return { column: value.column, row: value.row };
}

function knownShortcut(id: string, slugs: ReadonlySet<string>, categories: ReadonlySet<string>): boolean {
  if (id.startsWith("tool:")) return slugs.has(id.slice(5));
  if (id.startsWith("cat:")) return categories.has(id.slice(4));
  return false;
}

export function parsePrefs(
  raw: string | null,
  slugs: ReadonlySet<string>,
  categories: ReadonlySet<string>,
): DeskPrefs | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1) return null;
  const fallback = defaultPrefs([...categories]);
  const preset = typeof parsed.preset === "string" && PRESET_IDS.has(parsed.preset) ? (parsed.preset as WallpaperPresetId) : fallback.preset;
  const fit = parsed.fit === "contain" ? "contain" : "cover";
  const dim = finite(parsed.dim) ? Math.max(0, Math.min(60, Math.round(parsed.dim))) : 0;
  const shortcuts = Array.isArray(parsed.shortcuts)
    ? parsed.shortcuts.filter((id): id is string => typeof id === "string" && knownShortcut(id, slugs, categories)).slice(0, 256)
    : fallback.shortcuts;
  const uniqueShortcuts = [...new Set(shortcuts)];
  const positions: ShortcutPositions = {};
  if (isRecord(parsed.positions)) {
    for (const [id, cell] of Object.entries(parsed.positions)) {
      if (!knownShortcut(id, slugs, categories)) continue;
      const next = readCell(cell);
      if (next) positions[id] = next;
    }
  }
  const pinned = Array.isArray(parsed.pinned)
    ? [...new Set(parsed.pinned.filter((id): id is string => typeof id === "string" && knownShortcut(id, slugs, categories)))].slice(0, 64)
    : [];
  return {
    preset,
    fit,
    dim,
    hasImage: parsed.hasImage === true,
    shortcuts: uniqueShortcuts,
    positions,
    pinned,
    iconSize: parsed.iconSize === "large" ? "large" : "regular",
    density: parsed.density === "compact" ? "compact" : "comfortable",
    locked: parsed.locked === true,
    hintDismissed: parsed.hintDismissed === true,
  };
}

export function serializePrefs(prefs: DeskPrefs): string {
  return JSON.stringify({ v: 1, ...prefs });
}

function readWindow(value: unknown, slugs: ReadonlySet<string>, categories: ReadonlySet<string>): DeskWindow | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) return null;
  if (value.kind !== "tool" && value.kind !== "folder") return null;
  if (typeof value.slug !== "string") return null;
  if (value.kind === "tool" && !slugs.has(value.slug)) return null;
  if (value.kind === "folder" && !categories.has(value.slug)) return null;
  const bounds = readBounds(value.bounds);
  if (!bounds) return null;
  const mode = value.mode === "minimized" || value.mode === "maximized" ? value.mode : "normal";
  const dock = value.dock === "left" || value.dock === "right" ? value.dock : undefined;
  const previous = readBounds(value.previousBounds) ?? undefined;
  const instance = Number.isInteger(value.instance) && (value.instance as number) > 0 ? (value.instance as number) : 1;
  const modeBefore = value.modeBeforeMinimize === "maximized" ? "maximized" : value.modeBeforeMinimize === "normal" ? "normal" : undefined;
  return {
    id: value.id,
    kind: value.kind,
    slug: value.slug,
    instance: value.kind === "folder" ? 1 : instance,
    bounds,
    previousBounds: previous,
    mode,
    modeBeforeMinimize: mode === "minimized" ? modeBefore : undefined,
    dock: mode === "maximized" ? undefined : dock,
    z: finite(value.z) ? value.z : 1,
  };
}

/** `null` means the payload is unusable and the desk should start empty. */
export function parseLayout(raw: string | null, slugs: ReadonlySet<string>, categories: ReadonlySet<string>): DeskState | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.windows)) return null;
  const seen = new Set<string>();
  const folders = new Set<string>();
  const tools = new Set<string>();
  const windows: DeskWindow[] = [];
  for (const item of parsed.windows) {
    const window = readWindow(item, slugs, categories);
    if (!window || seen.has(window.id)) continue;
    if (window.kind === "folder") {
      if (folders.has(window.slug)) continue;
      folders.add(window.slug);
    } else {
      const key = `${window.slug}#${window.instance}`;
      if (tools.has(key)) continue;
      tools.add(key);
    }
    seen.add(window.id);
    windows.push(window);
  }
  const activeId = typeof parsed.activeId === "string" && seen.has(parsed.activeId) ? parsed.activeId : null;
  return { windows, activeId, concealed: false };
}

export function serializeLayout(state: DeskState): string {
  const windows = state.windows.map((window) => ({
    id: window.id,
    kind: window.kind,
    slug: window.slug,
    instance: window.instance,
    bounds: window.bounds,
    previousBounds: window.previousBounds,
    mode: window.mode,
    modeBeforeMinimize: window.modeBeforeMinimize,
    dock: window.dock,
    z: window.z,
  }));
  return JSON.stringify({ v: 1, activeId: state.activeId, windows });
}
