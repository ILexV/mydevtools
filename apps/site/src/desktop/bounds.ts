/**
 * Window geometry for the desktop shell. Frames use left/top in stage pixels,
 * never CSS transform: menus and popovers inside a transformed window get clipped.
 * New windows cascade to the right of the shortcut strip when that free area
 * is wide enough; otherwise they open centered on the stage.
 */

import type { Bounds, DeskSize, ResizeEdge, SplitRatio } from "./types.ts";

export const MIN_WINDOW_WIDTH = 360;
export const MIN_WINDOW_HEIGHT = 240;

const CASCADE_SHIFT = 28;
const FREE_AREA_MIN = 720;

function roundShare(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Turn stage pixels into shares of the desk for a saved layout.
 * Returns null when the stage has no size yet, so a layout is not stored as zeros.
 */
export function normalizeBounds(bounds: Bounds, desk: DeskSize): Bounds | null {
  if (desk.width <= 0 || desk.height <= 0) return null;
  const width = Math.min(1, Math.max(bounds.width / desk.width, 0.05));
  const height = Math.min(1, Math.max(bounds.height / desk.height, 0.05));
  const x = Math.min(Math.max(bounds.x / desk.width, 0), 1 - width);
  const y = Math.min(Math.max(bounds.y / desk.height, 0), 1 - height);
  return { x: roundShare(x), y: roundShare(y), width: roundShare(width), height: roundShare(height) };
}

/** Place a saved share back on the current stage and keep the frame's minimum size. */
export function denormalizeBounds(fractions: Bounds, desk: DeskSize): Bounds {
  if (desk.width <= 0 || desk.height <= 0) return { x: 16, y: 16, width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT };
  return clampBounds(
    {
      x: fractions.x * desk.width,
      y: fractions.y * desk.height,
      width: fractions.width * desk.width,
      height: fractions.height * desk.height,
    },
    desk,
  );
}

export function clampBounds(bounds: Bounds, desk: DeskSize): Bounds {
  if (desk.width <= 0 || desk.height <= 0) return bounds;
  const width = Math.min(Math.max(bounds.width, Math.min(MIN_WINDOW_WIDTH, desk.width)), desk.width);
  const height = Math.min(Math.max(bounds.height, Math.min(MIN_WINDOW_HEIGHT, desk.height)), desk.height);
  const maxX = Math.max(0, desk.width - width);
  const maxY = Math.max(0, desk.height - height);
  return {
    x: Math.min(Math.max(bounds.x, 0), maxX),
    y: Math.min(Math.max(bounds.y, 0), maxY),
    width,
    height,
  };
}

/** Place a new window. `reservedLeft` is the right edge of the shortcut columns. */
export function cascadeBounds(index: number, desk: DeskSize, reservedLeft = 0): Bounds {
  const shift = (index % 6) * CASCADE_SHIFT;
  let width = desk.width > 0 ? Math.min(960, Math.max(MIN_WINDOW_WIDTH, desk.width - 64)) : 960;
  const height = desk.height > 0 ? Math.min(680, Math.max(MIN_WINDOW_HEIGHT, desk.height - 64)) : 680;
  let left = desk.width > 0 ? Math.max(16, (desk.width - width) / 2) : 16;
  const freeWidth = desk.width - reservedLeft - 16;
  if (reservedLeft > 0 && left < reservedLeft && freeWidth >= FREE_AREA_MIN) {
    width = Math.min(width, freeWidth - 16);
    left = reservedLeft + Math.max(16, (freeWidth - width) / 2);
  }
  const proposed = { x: left + shift, y: 16 + shift, width, height };
  if (desk.width <= 0 || desk.height <= 0) return proposed;
  return clampBounds(proposed, desk);
}

export function dragBounds(start: Bounds, dx: number, dy: number, desk: DeskSize): Bounds {
  return clampBounds({ ...start, x: start.x + dx, y: start.y + dy }, desk);
}

/**
 * Drop a restored window so the pointer stays on the same fraction of the
 * title bar it grabbed while the frame was maximized or snapped.
 */
export function restoreUnderPointer(
  previous: Bounds,
  pointerX: number,
  pointerY: number,
  grabFraction: number,
  desk: DeskSize,
): Bounds {
  const fraction = Math.min(1, Math.max(0, grabFraction));
  return clampBounds(
    {
      ...previous,
      x: pointerX - fraction * previous.width,
      y: pointerY - 18,
    },
    desk,
  );
}

function resizeAxis(
  origin: number,
  size: number,
  delta: number,
  limit: number,
  minimum: number,
  fromStart: boolean,
): { origin: number; size: number } {
  if (limit <= 0) {
    const next = Math.max(minimum, size + (fromStart ? -delta : delta));
    return fromStart ? { origin: origin + size - next, size: next } : { origin, size: next };
  }
  if (fromStart) {
    let nextOrigin = origin + delta;
    let nextSize = size - delta;
    if (nextSize < minimum) {
      nextOrigin -= minimum - nextSize;
      nextSize = minimum;
    }
    if (nextOrigin < 0) {
      nextSize += nextOrigin;
      nextOrigin = 0;
    }
    if (nextOrigin + nextSize > limit) nextSize = limit - nextOrigin;
    return { origin: nextOrigin, size: Math.max(minimum, nextSize) };
  }
  let nextSize = size + delta;
  if (nextSize < minimum) nextSize = minimum;
  if (origin + nextSize > limit) nextSize = Math.max(minimum, limit - origin);
  return { origin, size: nextSize };
}

const LEFT_EDGES = new Set<ResizeEdge>(["w", "nw", "sw"]);
const RIGHT_EDGES = new Set<ResizeEdge>(["e", "ne", "se"]);
const TOP_EDGES = new Set<ResizeEdge>(["n", "ne", "nw"]);
const BOTTOM_EDGES = new Set<ResizeEdge>(["s", "se", "sw"]);

/** Resize one or two edges. The opposite edge stays put, including at the stage border. */
export function resizeBounds(start: Bounds, edge: ResizeEdge, dx: number, dy: number, desk: DeskSize): Bounds {
  const limitW = desk.width > 0 ? desk.width : Number.POSITIVE_INFINITY;
  const limitH = desk.height > 0 ? desk.height : Number.POSITIVE_INFINITY;
  let { x, y, width, height } = start;
  if (LEFT_EDGES.has(edge) || RIGHT_EDGES.has(edge)) {
    const axis = resizeAxis(x, width, dx, limitW, Math.min(MIN_WINDOW_WIDTH, limitW), LEFT_EDGES.has(edge));
    x = axis.origin;
    width = axis.size;
  }
  if (TOP_EDGES.has(edge) || BOTTOM_EDGES.has(edge)) {
    const axis = resizeAxis(y, height, dy, limitH, Math.min(MIN_WINDOW_HEIGHT, limitH), TOP_EDGES.has(edge));
    y = axis.origin;
    height = axis.size;
  }
  return { x, y, width, height };
}

export function dockBounds(desk: DeskSize, side: "left" | "right"): Bounds {
  const pad = 8;
  const gap = 8;
  const width = Math.max(MIN_WINDOW_WIDTH, Math.floor((desk.width - pad * 2 - gap) / 2));
  const height = Math.max(MIN_WINDOW_HEIGHT, desk.height - pad * 2);
  const x = side === "left" ? pad : desk.width - pad - width;
  return clampBounds({ x, y: pad, width, height }, desk);
}

/** Two windows side by side. The ratio is the left window's share of the pair. */
export function splitPair(desk: DeskSize, ratio: SplitRatio): { left: Bounds; right: Bounds } {
  const pad = 8;
  const gap = 8;
  const inner = Math.max(MIN_WINDOW_WIDTH * 2, desk.width - pad * 2 - gap);
  let leftW = Math.round(inner / 2);
  if (ratio === "2:1") leftW = Math.round((inner * 2) / 3);
  if (ratio === "1:2") leftW = Math.round(inner / 3);
  const min = Math.min(MIN_WINDOW_WIDTH, Math.floor(inner / 2));
  leftW = Math.max(min, Math.min(leftW, inner - min));
  const height = Math.max(MIN_WINDOW_HEIGHT, desk.height - pad * 2);
  return {
    left: clampBounds({ x: pad, y: pad, width: leftW, height }, desk),
    right: clampBounds({ x: pad + leftW + gap, y: pad, width: inner - leftW, height }, desk),
  };
}

/** Which snap preview to show while dragging, from the pointer position in the stage. */
export function snapTarget(pointerX: number, pointerY: number, desk: DeskSize): "left" | "right" | "max" | null {
  if (desk.width <= 0 || desk.height <= 0) return null;
  if (pointerY < 12) return "max";
  if (pointerX < 16) return "left";
  if (pointerX > desk.width - 16) return "right";
  return null;
}
