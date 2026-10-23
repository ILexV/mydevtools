/**
 * Named desk layouts and the favorites/recent widget column.
 * A layout stores one frame per tool slug as fractions of the stage.
 * Typed text, files, query strings and extra copies of the same tool are omitted.
 */

import { normalizeBounds } from "./bounds.ts";
import type { Bounds, DeskSize, DeskWindow } from "./types.ts";

export const WIDGET_IDS = ["favorites", "recent", "clipboard"] as const;
export type WidgetId = (typeof WIDGET_IDS)[number];
export const DEFAULT_WIDGETS: readonly WidgetId[] = ["favorites", "recent", "clipboard"];

export const MAX_WORKSPACES = 16;
export const MAX_WORKSPACE_WINDOWS = 16;
export const MAX_WORKSPACE_NAME = 80;

export interface WorkspaceWindow {
  slug: string;
  /** Shares of the stage: x and y from the top-left, each edge inside 0–1. */
  bounds: Bounds;
  mode: "normal" | "maximized";
  /** Stable only inside this saved layout; matching values restore grouped tabs. */
  groupId?: string;
}

export interface SavedWorkspace {
  id: string;
  name: string;
  windows: WorkspaceWindow[];
}

const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Ready-made desk scenarios (starter layouts) shipped with the site: a task such as
 * API debugging or release verification opens its tools side by side in one click.
 * Names and hints are locale keys in `desktop.json`; nothing is stored until the person saves.
 */
export interface BuiltinWorkspace {
  id: string;
  nameKey: string;
  hintKey: string;
  slugs: readonly string[];
}

export const BUILTIN_WORKSPACES: readonly BuiltinWorkspace[] = [
  { id: "api", nameKey: "ScenarioApi", hintKey: "ScenarioApiHint", slugs: ["http-client", "jwt-decoder", "json-beautifier"] },
  { id: "release", nameKey: "ScenarioRelease", hintKey: "ScenarioReleaseHint", slugs: ["hash-calculator", "file-signature"] },
  { id: "data", nameKey: "ScenarioData", hintKey: "ScenarioDataHint", slugs: ["csv-explorer", "data-format-converter", "json-beautifier"] },
  { id: "images", nameKey: "ScenarioImages", hintKey: "ScenarioImagesHint", slugs: ["image-batch", "image-compressor", "image-converter"] },
  { id: "encoding", nameKey: "ScenarioEncoding", hintKey: "ScenarioEncodingHint", slugs: ["base64-encoder", "url-encoder", "hex-encoder", "hash-calculator"] },
  { id: "keys", nameKey: "ScenarioKeys", hintKey: "ScenarioKeysHint", slugs: ["openssh-keys", "x509", "aead-file"] },
  { id: "text", nameKey: "ScenarioText", hintKey: "ScenarioTextHint", slugs: ["regex-tester", "text-diff-viewer", "word-counter"] },
];

/**
 * Tiles 1–4 tools over the stage as shares: one fills it, two split it in halves,
 * three put the first on the left half and stack the rest on the right, four take the quarters.
 */
export function scenarioWindows(slugs: readonly string[]): WorkspaceWindow[] {
  const list = slugs.slice(0, 4);
  const half = (x: number, y: number, height: number): Bounds => ({ x, y, width: 0.5, height });
  const cells: Bounds[][] = [
    [],
    [{ x: 0, y: 0, width: 1, height: 1 }],
    [half(0, 0, 1), half(0.5, 0, 1)],
    [half(0, 0, 1), half(0.5, 0, 0.5), half(0.5, 0.5, 0.5)],
    [half(0, 0, 0.5), half(0.5, 0, 0.5), half(0, 0.5, 0.5), half(0.5, 0.5, 0.5)],
  ];
  const layout = cells[list.length]!;
  return list.map((slug, index) => ({ slug, bounds: layout[index]!, mode: "normal" as const }));
}

/** Front-most window of each tool, back-to-front, so applying the list leaves that window active. */
export function captureWorkspace(windows: readonly DeskWindow[], desk: DeskSize): WorkspaceWindow[] {
  const front = new Map<string, DeskWindow>();
  for (const window of windows) {
    if (window.kind !== "tool") continue;
    const current = front.get(window.slug);
    if (!current || window.z >= current.z) front.set(window.slug, window);
  }
  const chosen = [...front.values()].sort((left, right) => left.z - right.z);
  const groupIds = new Map<string, string>();
  const result: WorkspaceWindow[] = [];
  for (const window of chosen) {
    if (result.length >= MAX_WORKSPACE_WINDOWS) break;
    const maximized =
      window.mode === "maximized" || (window.mode === "minimized" && window.modeBeforeMinimize === "maximized");
    const source = maximized ? (window.previousBounds ?? window.bounds) : window.bounds;
    const bounds = normalizeBounds(source, desk);
    if (!bounds) continue;
    let groupId: string | undefined;
    if (window.groupId) {
      groupId = groupIds.get(window.groupId);
      if (!groupId) {
        groupId = `group-${groupIds.size + 1}`;
        groupIds.set(window.groupId, groupId);
      }
    }
    result.push({ slug: window.slug, bounds, mode: maximized ? "maximized" : "normal", ...(groupId ? { groupId } : {}) });
  }
  return result;
}

export function isWorkspaceId(value: string): boolean {
  return WORKSPACE_ID.test(value);
}

/** A layout name the person typed. Control characters are rejected so the label stays one line. */
export function isWorkspaceName(value: string): boolean {
  if (value.length < 1 || value.length > MAX_WORKSPACE_NAME) return false;
  if (value.trim() !== value) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

/**
 * Drop a widget onto another one. `after` inserts it below the target.
 * The same id, or an id that is not in the column, leaves the order unchanged.
 */
export function moveWidget(order: readonly WidgetId[], id: WidgetId, targetId: WidgetId, after: boolean): WidgetId[] {
  if (id === targetId || !order.includes(id) || !order.includes(targetId)) return [...order];
  const rest = order.filter((widget) => widget !== id);
  const index = rest.indexOf(targetId) + (after ? 1 : 0);
  return [...rest.slice(0, index), id, ...rest.slice(index)];
}

/** Move a widget one step up (-1) or down (+1). The ends of the column stay put. */
export function shiftWidget(order: readonly WidgetId[], id: WidgetId, delta: -1 | 1): WidgetId[] {
  const index = order.indexOf(id);
  const target = order[index + delta];
  if (index < 0 || target === undefined) return [...order];
  return moveWidget(order, id, target, delta === 1);
}

export function isWidgetId(value: unknown): value is WidgetId {
  return value === "favorites" || value === "recent" || value === "clipboard";
}
