/** Bounded scroll geometry: large datasets must not exceed browser CSS height limits. */
export interface ExplorerWindow {
  start: number;
  count: number;
  anchor: number;
  offset: number;
  trackHeight: number;
}

export const EXPLORER_ROW_HEIGHT = 40;
export const EXPLORER_MAX_TRACK_HEIGHT = 8_000_000;
const OVERSCAN = 5;

export function explorerWindow(
  rowCount: number,
  viewportHeight: number,
  scrollTop: number,
  anchorOverride?: number,
): ExplorerWindow {
  const height = Math.max(EXPLORER_ROW_HEIGHT, viewportHeight);
  const visible = Math.ceil(height / EXPLORER_ROW_HEIGHT);
  const count = Math.min(rowCount, visible + OVERSCAN * 2);
  const trackHeight = Math.min(rowCount * EXPLORER_ROW_HEIGHT, EXPLORER_MAX_TRACK_HEIGHT);
  const maxScroll = Math.max(0, trackHeight - height);
  const top = Math.max(0, Math.min(scrollTop, maxScroll));
  const maxAnchor = Math.max(0, rowCount - visible);
  const compressed = rowCount * EXPLORER_ROW_HEIGHT > EXPLORER_MAX_TRACK_HEIGHT;
  const projected = compressed
    ? (maxScroll > 0 ? Math.floor(top / maxScroll * maxAnchor) : 0)
    : Math.floor(top / EXPLORER_ROW_HEIGHT);
  const anchor = Math.max(0, Math.min(anchorOverride ?? projected, maxAnchor));
  const start = Math.max(0, Math.min(anchor - OVERSCAN, rowCount - count));
  const offset = compressed
    ? Math.max(0, Math.min(top - (anchor - start) * EXPLORER_ROW_HEIGHT, trackHeight - count * EXPLORER_ROW_HEIGHT))
    : start * EXPLORER_ROW_HEIGHT;
  return { start, count, anchor, offset, trackHeight };
}

export function explorerScrollTop(rowCount: number, viewportHeight: number, row: number): number {
  const height = Math.max(EXPLORER_ROW_HEIGHT, viewportHeight);
  const visible = Math.ceil(height / EXPLORER_ROW_HEIGHT);
  const trackHeight = Math.min(rowCount * EXPLORER_ROW_HEIGHT, EXPLORER_MAX_TRACK_HEIGHT);
  const maxScroll = Math.max(0, trackHeight - height);
  const maxAnchor = Math.max(0, rowCount - visible);
  const anchor = Math.max(0, Math.min(row, maxAnchor));
  return rowCount * EXPLORER_ROW_HEIGHT > EXPLORER_MAX_TRACK_HEIGHT
    ? (maxAnchor > 0 ? anchor / maxAnchor * maxScroll : 0)
    : Math.min(anchor * EXPLORER_ROW_HEIGHT, maxScroll);
}
