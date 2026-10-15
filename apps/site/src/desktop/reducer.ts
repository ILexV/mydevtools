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
  | { type: "move"; id: string; bounds: Bounds }
  | { type: "dock"; id: string; side: Dock; desk: DeskSize }
  | { type: "tile"; id: string; companionId: string; ratio: SplitRatio; desk: DeskSize }
  | { type: "clamp"; desk: DeskSize }
  | { type: "conceal" }
  | { type: "reveal" }
  | { type: "hydrate"; state: DeskState };

function normalize(windows: readonly DeskWindow[]): DeskWindow[] {
  return [...windows]
    .sort((a, b) => a.z - b.z || a.id.localeCompare(b.id))
    .map((window, index) => (window.z === index + 1 ? window : { ...window, z: index + 1 }));
}

function withWindows(windows: DeskWindow[], activeId: string | null, concealed: boolean): DeskState {
  const next = normalize(windows);
  const active = next.some((window) => window.id === activeId) ? activeId : null;
  return { windows: next, activeId: active, concealed };
}

function highest(windows: readonly DeskWindow[]): number {
  return windows.reduce((max, window) => Math.max(max, window.z), 0);
}

function raise(windows: readonly DeskWindow[], id: string): DeskWindow[] {
  const top = highest(windows) + 1;
  return windows.map((window) => (window.id === id ? { ...window, z: top } : window));
}

function nextVisible(windows: readonly DeskWindow[], exceptId: string): string | null {
  const visible = windows
    .filter((window) => window.id !== exceptId && window.mode !== "minimized")
    .sort((a, b) => b.z - a.z);
  return visible[0]?.id ?? null;
}

function remember(window: DeskWindow): Bounds {
  return window.previousBounds ?? window.bounds;
}

function findTool(windows: readonly DeskWindow[], slug: string): DeskWindow | undefined {
  return [...windows]
    .filter((window) => window.kind === "tool" && window.slug === slug)
    .sort((a, b) => b.z - a.z)[0];
}

function activateRecord(windows: DeskWindow[], id: string): DeskWindow[] {
  return raise(windows, id).map((window) => {
    if (window.id !== id || window.mode !== "minimized") return window;
    const mode = window.modeBeforeMinimize ?? "normal";
    return { ...window, mode, modeBeforeMinimize: undefined };
  });
}

export function desktopReducer(state: DeskState, action: DeskAction): DeskState {
  switch (action.type) {
    case "hydrate": {
      return withWindows(action.state.windows, action.state.activeId, false);
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
    case "activate": {
      if (!state.windows.some((window) => window.id === action.id)) return state;
      return withWindows(activateRecord(state.windows, action.id), action.id, false);
    }
    case "minimize": {
      const target = state.windows.find((window) => window.id === action.id);
      if (!target || target.mode === "minimized") return state;
      const windows = state.windows.map((window) =>
        window.id === action.id
          ? {
              ...window,
              mode: "minimized" as const,
              modeBeforeMinimize: window.mode === "maximized" ? ("maximized" as const) : ("normal" as const),
            }
          : window,
      );
      const activeId = state.activeId === action.id ? nextVisible(windows, action.id) : state.activeId;
      return withWindows(windows, activeId, state.concealed);
    }
    case "maximize": {
      const target = state.windows.find((window) => window.id === action.id);
      if (!target || target.mode === "maximized") return state;
      const windows = raise(state.windows, action.id).map((window) => {
        if (window.id !== action.id) return window;
        const previous = window.mode === "normal" && !window.dock ? window.bounds : remember(window);
        return { ...window, mode: "maximized" as const, dock: undefined, previousBounds: previous, modeBeforeMinimize: undefined };
      });
      return withWindows(windows, action.id, false);
    }
    case "restore": {
      const target = state.windows.find((window) => window.id === action.id);
      if (!target) return state;
      if (target.mode === "normal" && !target.dock && target.modeBeforeMinimize === undefined) return state;
      const windows = raise(state.windows, action.id).map((window) => {
        if (window.id !== action.id) return window;
        const bounds = window.previousBounds ?? window.bounds;
        return {
          ...window,
          mode: "normal" as const,
          dock: undefined,
          bounds,
          previousBounds: undefined,
          modeBeforeMinimize: undefined,
        };
      });
      return withWindows(windows, action.id, false);
    }
    case "move": {
      const windows = state.windows.map((window) => {
        if (window.id !== action.id) return window;
        if (
          window.bounds.x === action.bounds.x &&
          window.bounds.y === action.bounds.y &&
          window.bounds.width === action.bounds.width &&
          window.bounds.height === action.bounds.height &&
          window.mode === "normal" &&
          !window.dock
        ) {
          return window;
        }
        return { ...window, bounds: action.bounds, mode: "normal" as const, dock: undefined };
      });
      const changed = windows.some((window, index) => window !== state.windows[index]);
      if (!changed) return state;
      return withWindows(raise(windows, action.id), action.id, false);
    }
    case "dock": {
      const target = state.windows.find((window) => window.id === action.id);
      if (!target) return state;
      const bounds = dockBounds(action.desk, action.side);
      const windows = raise(state.windows, action.id).map((window) => {
        if (window.id !== action.id) return window;
        const previous = window.mode === "normal" && !window.dock ? window.bounds : remember(window);
        return { ...window, mode: "normal" as const, dock: action.side, bounds, previousBounds: previous };
      });
      return withWindows(windows, action.id, false);
    }
    case "tile": {
      const pair = splitPair(action.desk, action.ratio);
      const ids = new Set([action.id, action.companionId]);
      if (action.id === action.companionId) return state;
      const windows = state.windows.map((window) => {
        if (!ids.has(window.id)) return window;
        const previous = window.mode === "normal" && !window.dock ? window.bounds : remember(window);
        const bounds = window.id === action.id ? pair.left : pair.right;
        return { ...window, mode: "normal" as const, dock: undefined, bounds, previousBounds: previous, modeBeforeMinimize: undefined };
      });
      return withWindows(raise(windows, action.id), action.id, false);
    }
    case "close": {
      if (!state.windows.some((window) => window.id === action.id)) return state;
      const activeId = state.activeId === action.id ? nextVisible(state.windows, action.id) : state.activeId;
      return withWindows(
        state.windows.filter((window) => window.id !== action.id),
        activeId,
        state.concealed,
      );
    }
    case "close-many": {
      const drop = new Set(action.ids);
      const windows = state.windows.filter((window) => !drop.has(window.id));
      const activeId = windows.some((window) => window.id === state.activeId)
        ? state.activeId
        : (windows.filter((window) => window.mode !== "minimized").sort((a, b) => b.z - a.z)[0]?.id ?? null);
      return withWindows(windows, activeId, state.concealed);
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
