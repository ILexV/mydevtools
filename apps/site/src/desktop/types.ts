/**
 * Desktop shell model: floating tool windows on a computer workspace.
 * A window is either a tool (loaded in its own iframe) or a category folder.
 * Geometry is in pixels of the stage above the taskbar. Nothing here is persisted
 * except what `persistence.ts` explicitly copies — field text and files are not.
 */

export type Bounds = { x: number; y: number; width: number; height: number };

export type DeskSize = { width: number; height: number };

export type WindowMode = "normal" | "minimized" | "maximized";

/** Edge snap. Maximized is `mode`, not a dock. */
export type Dock = "left" | "right";

export type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export type SplitRatio = "1:1" | "2:1" | "1:2";

export interface DeskWindow {
  id: string;
  kind: "tool" | "folder";
  /** Tool slug or category id. */
  slug: string;
  /** Copies of one tool. Folders are always 1. */
  instance: number;
  bounds: Bounds;
  /** Geometry to return to after maximize, dock, or a drag-restore. */
  previousBounds?: Bounds;
  mode: WindowMode;
  modeBeforeMinimize?: Exclude<WindowMode, "minimized">;
  dock?: Dock;
  z: number;
}

export interface DeskState {
  windows: DeskWindow[];
  activeId: string | null;
  /** "Show desktop" hides frames without unmounting them. Not persisted. */
  concealed: boolean;
}

export const emptyDesk: DeskState = { windows: [], activeId: null, concealed: false };

export type ShortcutCell = { column: number; row: number };

export type ShortcutPositions = Record<string, ShortcutCell>;
