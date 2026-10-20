/**
 * Desktop preferences and window layout, versioned for localStorage.
 * Layout remembers frames only: slug, geometry, dock, which window is active.
 * It never stores tool input, files, or results. A broken payload or an
 * unknown version yields an empty desk; the catalog still works.
 * Wallpaper bytes live in IndexedDB (`wallpaper.ts`), not in this JSON.
 */

import type { Bounds, DeskState, DeskWindow, ShortcutPositions } from "./types.ts";
import { WALLPAPER_PRESETS, type WallpaperPresetId } from "./wallpaper.ts";
import {
  DEFAULT_WIDGETS,
  MAX_WORKSPACE_WINDOWS,
  MAX_WORKSPACES,
  isWidgetId,
  isWorkspaceId,
  isWorkspaceName,
  type SavedWorkspace,
  type WidgetId,
  type WorkspaceWindow,
} from "./workspaces.ts";

export const LAYOUT_KEY = "mdt.desktop.layout.v1";
export const PREFS_KEY = "mdt.desktop.prefs.v1";
export const WINDOW_BOUNDS_KEY = "mdt.desktop.window-bounds.v1";
/** "Open the desktop from the home page." Absent means the catalog stays. */
export const ENTRY_KEY = "mdt.desktop.entry.v1";
/** Session flag so "back to catalog" is not immediately sent back to the desk. */
export const SKIP_KEY = "mdt.desktop.skip";

const PRESET_IDS = new Set<string>(WALLPAPER_PRESETS.map((preset) => preset.id));
/** Defaults introduced before saved preferences recorded which catalog categories they had seen. */
const LEGACY_UNSEEN_CATEGORY_IDS: Readonly<Record<string, true>> = { networking: true };

export interface CustomFolder {
  id: string;
  name: string;
  /** Tool shortcut ids only; category and nested folders are deliberately excluded. */
  items: string[];
}

export interface DeskPrefs {
  preset: WallpaperPresetId;
  fit: "cover" | "contain";
  /** 0–60, applied as a dark veil over the wallpaper. */
  dim: number;
  hasImage: boolean;
  /** `cat:<id>`, `tool:<slug>` or `folder:<id>`, in user order. */
  shortcuts: string[];
  /** Catalog categories already offered as defaults; lets later categories appear exactly once. */
  catalogCategories: string[];
  positions: ShortcutPositions;
  /** Same id shape as shortcuts. Shown on the taskbar even when closed. */
  pinned: string[];
  iconSize: "regular" | "large";
  /** Comfortable is the roomy default. Compact packs icons and the shell chrome. */
  density: "comfortable" | "compact";
  locked: boolean;
  /** The shortcut-move hint stays hidden after the person dismisses it. */
  hintDismissed: boolean;
  /** Named layouts: tool slugs and stage shares only. Missing on older records. */
  workspaces: SavedWorkspace[];
  /** Visible widget column, top to bottom. An empty list hides the column. */
  widgets: WidgetId[];
  /** Widgets whose body is folded. The choice survives hiding and showing them. */
  widgetsCollapsed: WidgetId[];
  /** User-created desktop folders. Contents are shortcut ids, never tool data. */
  folders: CustomFolder[];
  /** Focus mode hides shortcuts and widgets while leaving an always-visible exit. */
  focusMode: boolean;
}

export function defaultPrefs(categoryIds: readonly string[]): DeskPrefs {
  return {
    preset: "dusk",
    fit: "cover",
    dim: 0,
    hasImage: false,
    shortcuts: categoryIds.map((id) => `cat:${id}`),
    catalogCategories: [...categoryIds],
    positions: {},
    pinned: [],
    iconSize: "regular",
    density: "comfortable",
    locked: false,
    hintDismissed: false,
    workspaces: [],
    widgets: [...DEFAULT_WIDGETS],
    widgetsCollapsed: [],
    folders: [],
    focusMode: false,
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

export function parseWindowBounds(raw: string | null, slugs: ReadonlySet<string>): Record<string, Bounds> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed) || parsed.v !== 1 || !isRecord(parsed.bounds)) return {};

  const result: Record<string, Bounds> = {};
  for (const [slug, value] of Object.entries(parsed.bounds)) {
    if (!slugs.has(slug)) continue;
    const bounds = readBounds(value);
    if (!bounds || bounds.x < 0 || bounds.y < 0) continue;
    result[slug] = bounds;
  }
  return result;
}

export function serializeWindowBounds(bounds: Readonly<Record<string, Bounds>>): string {
  const saved: Record<string, Bounds> = {};
  for (const [slug, value] of Object.entries(bounds)) {
    saved[slug] = {
      x: value.x,
      y: value.y,
      width: value.width,
      height: value.height,
    };
  }
  return JSON.stringify({ v: 1, bounds: saved });
}

function readCell(value: unknown): { column: number; row: number } | null {
  if (!isRecord(value) || typeof value.column !== "number" || typeof value.row !== "number") return null;
  if (!Number.isInteger(value.column) || !Number.isInteger(value.row)) return null;
  if (value.column < 0 || value.column > 255 || value.row < 0 || value.row > 255) return null;
  return { column: value.column, row: value.row };
}

function knownShortcut(
  id: string,
  slugs: ReadonlySet<string>,
  categories: ReadonlySet<string>,
  folderIds?: ReadonlySet<string>,
): boolean {
  if (id.startsWith("tool:")) return slugs.has(id.slice(5));
  if (id.startsWith("cat:")) return categories.has(id.slice(4));
  if (id.startsWith("folder:")) return folderIds?.has(id.slice(7)) === true;
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
  const seenCategories = new Set(
    Array.isArray(parsed.catalogCategories)
      ? parsed.catalogCategories.filter((id): id is string => typeof id === "string" && categories.has(id))
      : [...categories].filter((id) => LEGACY_UNSEEN_CATEGORY_IDS[id] !== true),
  );
  const folders = readFolders(parsed.folders, slugs);
  const folderIds = new Set(folders.map((folder) => folder.id));
  const preset = typeof parsed.preset === "string" && PRESET_IDS.has(parsed.preset) ? (parsed.preset as WallpaperPresetId) : fallback.preset;
  const fit = parsed.fit === "contain" ? "contain" : "cover";
  const dim = finite(parsed.dim) ? Math.max(0, Math.min(60, Math.round(parsed.dim))) : 0;
  const shortcuts = Array.isArray(parsed.shortcuts)
    ? parsed.shortcuts.filter((id): id is string => typeof id === "string" && knownShortcut(id, slugs, categories, folderIds)).slice(0, 256)
    : fallback.shortcuts;
  const addedCategoryShortcuts = [...categories].filter((id) => !seenCategories.has(id)).map((id) => `cat:${id}`);
  const uniqueShortcuts = [...new Set([...shortcuts, ...addedCategoryShortcuts])];
  const positions: ShortcutPositions = {};
  if (isRecord(parsed.positions)) {
    for (const [id, cell] of Object.entries(parsed.positions)) {
      if (!knownShortcut(id, slugs, categories, folderIds)) continue;
      const next = readCell(cell);
      if (next) positions[id] = next;
    }
  }
  const pinned = Array.isArray(parsed.pinned)
    ? [...new Set(parsed.pinned.filter((id): id is string => typeof id === "string" && knownShortcut(id, slugs, categories, folderIds)))].slice(0, 64)
    : [];
  return {
    preset,
    fit,
    dim,
    hasImage: parsed.hasImage === true,
    shortcuts: uniqueShortcuts,
    catalogCategories: [...categories],
    positions,
    pinned,
    iconSize: parsed.iconSize === "large" ? "large" : "regular",
    density: parsed.density === "compact" ? "compact" : "comfortable",
    locked: parsed.locked === true,
    hintDismissed: parsed.hintDismissed === true,
    workspaces: readWorkspaces(parsed.workspaces, slugs),
    widgets: readWidgets(parsed.widgets, [...DEFAULT_WIDGETS]),
    widgetsCollapsed: readWidgets(parsed.widgetsCollapsed, []),
    folders,
    focusMode: parsed.focusMode === true,
  };
}

function readFolders(value: unknown, slugs: ReadonlySet<string>): CustomFolder[] {
  if (!Array.isArray(value)) return [];
  const folders: CustomFolder[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    if (folders.length >= 64) break;
    if (!isRecord(candidate)) continue;
    if (typeof candidate.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(candidate.id) || ids.has(candidate.id)) continue;
    if (typeof candidate.name !== "string") continue;
    const name = candidate.name.trim();
    if (!isWorkspaceName(name)) continue;
    const items = Array.isArray(candidate.items)
      ? [...new Set(candidate.items.filter((id): id is string => typeof id === "string" && id.startsWith("tool:") && slugs.has(id.slice(5))))].slice(0, 64)
      : [];
    ids.add(candidate.id);
    folders.push({ id: candidate.id, name, items });
  }
  return folders;
}

function readWidgets(value: unknown, fallback: WidgetId[]): WidgetId[] {
  if (!Array.isArray(value)) return fallback;
  const result: WidgetId[] = [];
  for (const item of value) {
    if (isWidgetId(item) && !result.includes(item)) result.push(item);
  }
  return result;
}

/** Keep layouts that still name a known tool. Extra fields such as typed text are not copied. */
function readWorkspaces(value: unknown, slugs: ReadonlySet<string>): SavedWorkspace[] {
  if (!Array.isArray(value)) return [];
  const result: SavedWorkspace[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    if (result.length >= MAX_WORKSPACES) break;
    if (!isRecord(candidate) || typeof candidate.id !== "string" || typeof candidate.name !== "string") continue;
    const name = candidate.name.trim();
    if (!isWorkspaceId(candidate.id) || ids.has(candidate.id) || !isWorkspaceName(name)) continue;
    if (!Array.isArray(candidate.windows)) continue;
    const windows: WorkspaceWindow[] = [];
    const seen = new Set<string>();
    for (const item of candidate.windows) {
      if (windows.length >= MAX_WORKSPACE_WINDOWS) break;
      if (!isRecord(item) || typeof item.slug !== "string" || !slugs.has(item.slug) || seen.has(item.slug)) continue;
      const bounds = readFractionBounds(item.bounds);
      if (!bounds) continue;
      if (item.mode !== "normal" && item.mode !== "maximized") continue;
      seen.add(item.slug);
      const groupId = typeof item.groupId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(item.groupId) ? item.groupId : undefined;
      windows.push({ slug: item.slug, bounds, mode: item.mode, ...(groupId ? { groupId } : {}) });
    }
    if (windows.length === 0) continue;
    ids.add(candidate.id);
    result.push({ id: candidate.id, name, windows });
  }
  return result;
}

function readFractionBounds(value: unknown): Bounds | null {
  const bounds = readBounds(value);
  if (!bounds) return null;
  if (bounds.x < 0 || bounds.y < 0 || bounds.width > 1 || bounds.height > 1) return null;
  if (bounds.x > 1 || bounds.y > 1) return null;
  if (bounds.x + bounds.width > 1.001 || bounds.y + bounds.height > 1.001) return null;
  return bounds;
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
  const dockValues: readonly string[] = ["left", "right", "top-left", "top-right", "bottom-left", "bottom-right"];
  const dock = typeof value.dock === "string" && dockValues.includes(value.dock) ? (value.dock as DeskWindow["dock"]) : undefined;
  const previous = readBounds(value.previousBounds) ?? undefined;
  const instance = Number.isInteger(value.instance) && (value.instance as number) > 0 ? (value.instance as number) : 1;
  const modeBefore = value.modeBeforeMinimize === "maximized" ? "maximized" : value.modeBeforeMinimize === "normal" ? "normal" : undefined;
  return {
    id: value.id,
    kind: value.kind,
    slug: value.slug,
    tabActive: value.tabActive === true ? true : undefined,
    groupId: typeof value.groupId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.groupId) ? value.groupId : undefined,
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
    tabActive: window.tabActive,
    groupId: window.groupId,
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
