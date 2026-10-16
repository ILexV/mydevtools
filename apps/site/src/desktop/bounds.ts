/**
 * Window geometry for the desktop shell. Frames use left/top in stage pixels,
 * never CSS transform: menus and popovers inside a transformed window get clipped.
 * New windows cascade to the right of the shortcut strip when that free area
 * is wide enough; otherwise they open centered on the stage.
 */

import type { Bounds, DeskSize, Dock, ResizeEdge, SplitRatio } from "./types.ts";

export const MIN_WINDOW_WIDTH = 360;
export const MIN_WINDOW_HEIGHT = 240;

const CASCADE_SHIFT = 28;
const FREE_AREA_MIN = 720;

type WindowProfile = "standard" | "wide" | "compact";

const SIZE_BY_PROFILE = {
  standard: { width: 960, height: 680 },
  wide: { width: 1200, height: 760 },
  compact: { width: 720, height: 520 },
} as const satisfies Record<WindowProfile, { width: number; height: number }>;

/** Explicit exceptions for tools whose real layout benefits from a non-standard first frame. */
const PROFILE_BY_SLUG: Record<string, WindowProfile> = {
  "json-beautifier": "wide",
  "json-to-typescript": "wide",
  "json-explorer": "wide",
  "csv-explorer": "wide",
  "parquet-explorer": "wide",
  "xml-beautifier": "wide",
  "yaml-beautifier-validator": "wide",
  "text-diff-viewer": "wide",
  "markdown-preview": "wide",
  "hex-viewer": "wide",
  "uuid-generator": "compact",
  "password-generator": "compact",
};

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

/**
 * Fit a first-open frame to its measured tool content without changing its
 * horizontal geometry. Restored or user-adjusted bounds must bypass this helper.
 */
export function fitContentHeight(
  bounds: Bounds,
  contentHeight: number,
  chromeHeight: number,
  desk: DeskSize,
): Bounds {
  if (
    !Number.isFinite(contentHeight) ||
    contentHeight <= 0 ||
    !Number.isFinite(chromeHeight) ||
    chromeHeight < 0 ||
    !Number.isFinite(desk.width) ||
    desk.width <= 0 ||
    !Number.isFinite(desk.height) ||
    desk.height <= 0
  ) {
    return bounds;
  }

  const naturalHeight = Math.ceil(contentHeight + chromeHeight);
  const maximumHeight = Math.max(MIN_WINDOW_HEIGHT, desk.height - 32);
  const height = Math.min(Math.max(naturalHeight, MIN_WINDOW_HEIGHT), maximumHeight);
  const y = Math.min(bounds.y, Math.max(0, desk.height - height - 16));
  return clampBounds({ ...bounds, y, height }, desk);
}

/** Place a new window. `reservedLeft` is the right edge of the shortcut columns. */
export function cascadeBounds(index: number, desk: DeskSize, reservedLeft = 0, slug?: string): Bounds {
  const profile = slug ? (PROFILE_BY_SLUG[slug] ?? "standard") : "standard";
  const size = SIZE_BY_PROFILE[profile];
  const shift = (index % 6) * CASCADE_SHIFT;
  let width = desk.width > 0 ? Math.min(size.width, Math.max(MIN_WINDOW_WIDTH, desk.width - 64)) : size.width;
  const height = desk.height > 0 ? Math.min(size.height, Math.max(MIN_WINDOW_HEIGHT, desk.height - 64)) : size.height;
  let left = desk.width > 0 ? Math.max(16, (desk.width - width) / 2) : 16;
  const freeWidth = desk.width - reservedLeft - 16;
  // A wide workbench is more useful overlapping the shortcut strip than
  // compressed into a merely adequate gap. The other profiles retain the
  // established free-area threshold and placement.
  const freeAreaMinimum = profile === "wide" ? size.width + 16 : FREE_AREA_MIN;
  if (reservedLeft > 0 && left < reservedLeft && freeWidth >= freeAreaMinimum) {
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

export function dockBounds(desk: DeskSize, side: Dock): Bounds {
  const pad = 8;
  const gap = 8;
  const halfWidth = Math.max(MIN_WINDOW_WIDTH, Math.floor((desk.width - pad * 2 - gap) / 2));
  const halfHeight = Math.max(MIN_WINDOW_HEIGHT, Math.floor((desk.height - pad * 2 - gap) / 2));
  const right = side === "right" || side.endsWith("-right");
  const bottom = side.startsWith("bottom-");
  const corner = side.includes("-");
  const width = halfWidth;
  const height = corner ? halfHeight : Math.max(MIN_WINDOW_HEIGHT, desk.height - pad * 2);
  return clampBounds(
    {
      x: right ? desk.width - pad - width : pad,
      y: bottom ? desk.height - pad - height : pad,
      width,
      height,
    },
    desk,
  );
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
export function snapTarget(pointerX: number, pointerY: number, desk: DeskSize): Dock | "max" | null {
  if (desk.width <= 0 || desk.height <= 0) return null;
  const nearLeft = pointerX < 16;
  const nearRight = pointerX > desk.width - 16;
  const nearTop = pointerY < 16;
  const nearBottom = pointerY > desk.height - 16;
  if (nearTop && nearLeft) return "top-left";
  if (nearTop && nearRight) return "top-right";
  if (nearBottom && nearLeft) return "bottom-left";
  if (nearBottom && nearRight) return "bottom-right";
  if (nearTop) return "max";
  if (nearLeft) return "left";
  if (nearRight) return "right";
  return null;
}
