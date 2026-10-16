/**
 * Desktop window manager. Minimizing and "show desktop" keep the window record
 * so the iframe stays mounted and the user's input survives. A second open of
 * the same tool activates the existing window; `fresh` opens another copy.
 * Category folders are single-instance.
 */

import { clampBounds, dockBounds, splitPair } from "./bounds.ts";
import type { Bounds, DeskSize, DeskState, DeskWindow, Dock, SplitRatio } from "./types.ts";
import { emptyDesk } from "./types.ts";

export type OpenTool = {
  type: "open-tool";
  id: string;
  slug: string;
  instance: number;
  bounds: Bounds;
  fresh: boolean;
};

export type OpenFolder = {
  type: "open-folder";
  id: string;
  category: string;
  bounds: Bounds;
};

export type DeskAction =
  | OpenTool
  | OpenFolder
  | { type: "activate"; id: string }
  | { type: "minimize"; id: string }
  | { type: "maximize"; id: string }
  | { type: "restore"; id: string }
  | { type: "close"; id: string }
  | { type: "close-many"; ids: string[] }
  | { type: "group"; id: string; targetId: string }
  | { type: "ungroup"; id: string; bounds: Bounds }
  | { type: "move"; id: string; bounds: Bounds }
  | { type: "fit-content"; id: string; bounds: Bounds }
  | { type: "dock"; id: string; side: Dock; desk: DeskSize }
  | { type: "tile"; id: string; companionId: string; ratio: SplitRatio; desk: DeskSize }
  | { type: "clamp"; desk: DeskSize }
  | { type: "conceal" }
  | { type: "reveal" }
  | { type: "hydrate"; state: DeskState }
  | {
      type: "apply-workspace";
      /** When true, other frames close. When false, an open tool keeps its iframe and only moves. */
      replace: boolean;
      windows: { id: string; slug: string; instance: number; bounds: Bounds; mode: "normal" | "maximized"; groupId?: string }[];
    };

function normalize(windows: readonly DeskWindow[]): DeskWindow[] {
  const groups = new Map<string, number>();
  const ordered = [...windows].sort((a, b) => a.z - b.z || a.id.localeCompare(b.id));
  for (const window of ordered) {
    const key = window.groupId ?? window.id;
    if (!groups.has(key)) groups.set(key, groups.size + 1);
  }
  return windows.map((window) => {
    const z = groups.get(window.groupId ?? window.id)!;
    return window.z === z ? window : { ...window, z };
  });
}

function withWindows(windows: DeskWindow[], activeId: string | null, concealed: boolean): DeskState {
  const next = normalize(windows);
  const active = next.some((window) => window.id === activeId) ? activeId : null;
  return { windows: next, activeId: active, concealed };
}

function highest(windows: readonly DeskWindow[]): number {
  return windows.reduce((max, window) => Math.max(max, window.z), 0);
}


function nextVisible(windows: readonly DeskWindow[], exceptId: string): string | null {
  const closing = windows.find((window) => window.id === exceptId);
  if (closing?.groupId) {
    const sibling = windows.find((window) => window.id !== exceptId && window.groupId === closing.groupId && window.mode !== "minimized");
    if (sibling) return sibling.id;
  }
  const visible = windows
    .filter((window) => window.id !== exceptId && window.mode !== "minimized" && (!window.groupId || window.tabActive))
    .sort((a, b) => b.z - a.z);
  return visible[0]?.id ?? null;
}

function remember(window: DeskWindow): Bounds {
  return window.previousBounds ?? window.bounds;
}

function groupKey(window: DeskWindow): string {
  return window.groupId ?? window.id;
}

function groupIds(windows: readonly DeskWindow[], id: string): Set<string> {
  const target = windows.find((window) => window.id === id);
  if (!target) return new Set();
  const key = groupKey(target);
  return new Set(windows.filter((window) => groupKey(window) === key).map((window) => window.id));
}

function raiseGroup(windows: readonly DeskWindow[], id: string): DeskWindow[] {
  const ids = groupIds(windows, id);
  const top = highest(windows) + 1;
  return windows.map((window) => (ids.has(window.id) ? { ...window, z: top } : window));
}

function mapGroup(
  windows: readonly DeskWindow[],
  id: string,
  update: (window: DeskWindow) => DeskWindow,
): DeskWindow[] {
  const ids = groupIds(windows, id);
  return windows.map((window) => (ids.has(window.id) ? update(window) : window));
}

function cleanSingleTabGroups(windows: readonly DeskWindow[]): DeskWindow[] {
  const groups = new Map<string, DeskWindow[]>();
  for (const window of windows) {
    if (!window.groupId) continue;
    const members = groups.get(window.groupId);
    if (members) members.push(window);
    else groups.set(window.groupId, [window]);
  }
  const selected = new Map<string, string>();
  for (const [id, members] of groups) selected.set(id, members.find((member) => member.tabActive)?.id ?? members[0]!.id);
  return windows.map((window) => {
    if (!window.groupId) return window.tabActive ? { ...window, tabActive: undefined } : window;
    if (groups.get(window.groupId)?.length === 1) return { ...window, groupId: undefined, tabActive: undefined };
    return { ...window, tabActive: selected.get(window.groupId) === window.id };
  });
}

function frontToolIndex(windows: readonly DeskWindow[], slug: string): number {
  let best = -1;
  let z = -Infinity;
  windows.forEach((window, index) => {
    if (window.kind === "tool" && window.slug === slug && window.z >= z) {
      best = index;
      z = window.z;
    }
  });
  return best;
}

function findTool(windows: readonly DeskWindow[], slug: string): DeskWindow | undefined {
  return [...windows]
    .filter((window) => window.kind === "tool" && window.slug === slug)
    .sort((a, b) => b.z - a.z)[0];
}

function activateRecord(windows: DeskWindow[], id: string): DeskWindow[] {
  const ids = groupIds(windows, id);
  return raiseGroup(windows, id).map((window) => {
    if (!ids.has(window.id)) return window;
    const mode = window.mode === "minimized" ? (window.modeBeforeMinimize ?? "normal") : window.mode;
    return {
      ...window,
      tabActive: window.groupId ? window.id === id : undefined,
      mode,
      modeBeforeMinimize: window.mode === "minimized" ? undefined : window.modeBeforeMinimize,
    };
  });
}

export function desktopReducer(state: DeskState, action: DeskAction): DeskState {
  switch (action.type) {
    case "hydrate": {
      return withWindows(cleanSingleTabGroups(action.state.windows), action.state.activeId, false);
    }
    case "conceal":
      return state.concealed ? state : { ...state, concealed: true };
    case "reveal":
      return state.concealed ? { ...state, concealed: false } : state;
    case "open-tool": {
      if (!action.fresh) {
        const existing = findTool(state.windows, action.slug);
        if (existing) {
          return withWindows(activateRecord(state.windows, existing.id), existing.id, false);
        }
      }
      const window: DeskWindow = {
        id: action.id,
        kind: "tool",
        slug: action.slug,
        instance: action.instance,
        bounds: action.bounds,
        mode: "normal",
        z: highest(state.windows) + 1,
      };
      return withWindows([...state.windows, window], window.id, false);
    }
    case "open-folder": {
      const existing = state.windows.find((window) => window.kind === "folder" && window.slug === action.category);
      if (existing) {
        return withWindows(activateRecord(state.windows, existing.id), existing.id, false);
      }
      const window: DeskWindow = {
        id: action.id,
        kind: "folder",
        slug: action.category,
        instance: 1,
        bounds: action.bounds,
        mode: "normal",
        z: highest(state.windows) + 1,
      };
      return withWindows([...state.windows, window], window.id, false);
    }
    case "group": {
      const source = state.windows.find((window) => window.id === action.id && window.kind === "tool");
      const target = state.windows.find((window) => window.id === action.targetId && window.kind === "tool");
      if (!source || !target || groupKey(source) === groupKey(target)) return state;
      const sourceIds = groupIds(state.windows, source.id);
      const targetIds = groupIds(state.windows, target.id);
      const groupId = target.groupId ?? `group-${target.id}`;
      const top = highest(state.windows) + 1;
      const windows = state.windows.map((window) => {
        if (!sourceIds.has(window.id) && !targetIds.has(window.id)) return window;
        return {
          ...window,
          groupId,
          tabActive: window.id === source.id,
          bounds: target.bounds,
          previousBounds: target.previousBounds,
          mode: target.mode,
          modeBeforeMinimize: target.modeBeforeMinimize,
          dock: target.dock,
          z: top,
        };
      });
      return withWindows(windows, source.id, false);
    }
    case "ungroup": {
      const target = state.windows.find((window) => window.id === action.id);
      if (!target?.groupId) return state;
      const siblings = state.windows.filter((window) => window.groupId === target.groupId && window.id !== target.id);
      const windows = state.windows.map((window) =>
        window.id === target.id
          ? {
              ...window,
              groupId: undefined,
              tabActive: undefined,
              bounds: action.bounds,
              previousBounds: undefined,
              mode: "normal" as const,
              modeBeforeMinimize: undefined,
              dock: undefined,
              z: highest(state.windows) + 1,
            }
          : siblings.length === 1 && window.id === siblings[0]!.id
            ? { ...window, groupId: undefined, tabActive: undefined }
            : window,
      );
      return withWindows(cleanSingleTabGroups(windows), target.id, false);
    }
    case "activate": {
      if (!state.windows.some((window) => window.id === action.id)) return state;
      return withWindows(activateRecord(state.windows, action.id), action.id, false);
    }
    case "minimize": {
      const target = state.windows.find((window) => window.id === action.id);
      if (!target || target.mode === "minimized") return state;
      const windows = mapGroup(state.windows, action.id, (window) => ({
        ...window,
        mode: "minimized" as const,
        modeBeforeMinimize: window.mode === "maximized" ? ("maximized" as const) : ("normal" as const),
      }));
      const ids = groupIds(state.windows, action.id);
      const activeId = state.activeId && ids.has(state.activeId) ? nextVisible(windows, action.id) : state.activeId;
      return withWindows(windows, activeId, state.concealed);
    }
    case "maximize": {
      const target = state.windows.find((window) => window.id === action.id);
      if (!target || target.mode === "maximized") return state;
      const previous = target.mode === "normal" && !target.dock ? target.bounds : remember(target);
      const windows = mapGroup(raiseGroup(state.windows, action.id), action.id, (window) => ({
        ...window,
        mode: "maximized" as const,
        dock: undefined,
        previousBounds: previous,
        modeBeforeMinimize: undefined,
      }));
      return withWindows(windows, action.id, false);
    }
    case "restore": {
      const target = state.windows.find((window) => window.id === action.id);
      if (!target) return state;
      if (target.mode === "normal" && !target.dock && target.modeBeforeMinimize === undefined) return state;
      const bounds = target.previousBounds ?? target.bounds;
      const windows = mapGroup(raiseGroup(state.windows, action.id), action.id, (window) => ({
        ...window,
        mode: "normal" as const,
        dock: undefined,
        bounds,
        previousBounds: undefined,
        modeBeforeMinimize: undefined,
      }));
      return withWindows(windows, action.id, false);
    }
    case "fit-content":
    case "move": {
      const ids = groupIds(state.windows, action.id);
      const target = state.windows.find((window) => window.id === action.id);
      if (!target || (action.type === "fit-content" && (target.mode !== "normal" || target.dock))) return state;
      if (
        target.bounds.x === action.bounds.x &&
        target.bounds.y === action.bounds.y &&
        target.bounds.width === action.bounds.width &&
        target.bounds.height === action.bounds.height &&
        target.mode === "normal" &&
        !target.dock
      ) {
        return state;
      }
      const windows = state.windows.map((window) =>
        ids.has(window.id) ? { ...window, bounds: action.bounds, mode: "normal" as const, dock: undefined } : window,
      );
      const changed = windows.some((window, index) => window !== state.windows[index]);
      if (!changed) return state;
      return action.type === "fit-content"
        ? { ...state, windows }
        : withWindows(raiseGroup(windows, action.id), action.id, false);
    }
    case "dock": {
      const target = state.windows.find((window) => window.id === action.id);
      if (!target) return state;
      const bounds = dockBounds(action.desk, action.side);
      const previous = target.mode === "normal" && !target.dock ? target.bounds : remember(target);
      const windows = mapGroup(raiseGroup(state.windows, action.id), action.id, (window) => ({
        ...window,
        mode: "normal" as const,
        dock: action.side,
        bounds,
        previousBounds: previous,
      }));
      return withWindows(windows, action.id, false);
    }
    case "tile": {
      if (action.id === action.companionId) return state;
      const leftIds = groupIds(state.windows, action.id);
      const rightIds = groupIds(state.windows, action.companionId);
      if ([...leftIds].some((id) => rightIds.has(id))) return state;
      const pair = splitPair(action.desk, action.ratio);
      const left = state.windows.find((window) => window.id === action.id);
      const right = state.windows.find((window) => window.id === action.companionId);
      if (!left || !right) return state;
      const previousLeft = left.mode === "normal" && !left.dock ? left.bounds : remember(left);
      const previousRight = right.mode === "normal" && !right.dock ? right.bounds : remember(right);
      const windows = state.windows.map((window) => {
        if (leftIds.has(window.id)) return { ...window, mode: "normal" as const, dock: undefined, bounds: pair.left, previousBounds: previousLeft, modeBeforeMinimize: undefined };
        if (rightIds.has(window.id)) return { ...window, mode: "normal" as const, dock: undefined, bounds: pair.right, previousBounds: previousRight, modeBeforeMinimize: undefined };
        return window;
      });
      return withWindows(raiseGroup(windows, action.id), action.id, false);
    }
    case "close": {
      if (!state.windows.some((window) => window.id === action.id)) return state;
      const activeId = state.activeId === action.id ? nextVisible(state.windows, action.id) : state.activeId;
      return withWindows(cleanSingleTabGroups(state.windows.filter((window) => window.id !== action.id)), activeId, state.concealed);
    }
    case "close-many": {
      const drop = new Set(action.ids);
      const windows = cleanSingleTabGroups(state.windows.filter((window) => !drop.has(window.id)));
      const activeId = windows.some((window) => window.id === state.activeId)
        ? state.activeId
        : (windows.filter((window) => window.mode !== "minimized").sort((a, b) => b.z - a.z)[0]?.id ?? null);
      return withWindows(windows, activeId, state.concealed);
    }
    case "apply-workspace": {
      const windows = action.replace ? [] : [...state.windows];
      let activeId = action.replace ? null : state.activeId;
      for (const incoming of action.windows) {
        const existingIndex = action.replace ? -1 : frontToolIndex(windows, incoming.slug);
        const existing = existingIndex >= 0 ? windows[existingIndex] : undefined;
        const next: DeskWindow = {
          id: existing?.id ?? incoming.id,
          kind: "tool",
          slug: incoming.slug,
          instance: existing?.instance ?? incoming.instance,
          groupId: incoming.groupId,
          bounds: incoming.bounds,
          previousBounds: incoming.mode === "maximized" ? incoming.bounds : undefined,
          mode: incoming.mode,
          modeBeforeMinimize: undefined,
          dock: undefined,
          z: highest(windows) + 1,
        };
        if (existing) windows[existingIndex] = next;
        else windows.push(next);
        activeId = next.id;
      }
      return withWindows(cleanSingleTabGroups(windows), activeId, false);
    }
    case "clamp": {
      const windows = state.windows.map((window) => {
        if (window.dock) {
          const bounds = dockBounds(action.desk, window.dock);
          return bounds.x === window.bounds.x &&
            bounds.y === window.bounds.y &&
            bounds.width === window.bounds.width &&
            bounds.height === window.bounds.height
            ? window
            : { ...window, bounds };
        }
        if (window.mode === "maximized") return window;
        const bounds = clampBounds(window.bounds, action.desk);
        const previous = window.previousBounds ? clampBounds(window.previousBounds, action.desk) : undefined;
        if (
          bounds.x === window.bounds.x &&
          bounds.y === window.bounds.y &&
          bounds.width === window.bounds.width &&
          bounds.height === window.bounds.height &&
          previous?.x === window.previousBounds?.x &&
          previous?.y === window.previousBounds?.y &&
          previous?.width === window.previousBounds?.width &&
          previous?.height === window.previousBounds?.height
        ) {
          return window;
        }
        return { ...window, bounds, previousBounds: previous };
      });
      const changed = windows.some((window, index) => window !== state.windows[index]);
      return changed ? withWindows(windows, state.activeId, state.concealed) : state;
    }
    default:
      return state;
  }
}

export { emptyDesk };
