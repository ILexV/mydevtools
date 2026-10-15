/**
 * Desktop shortcut grid. Icons fill columns top to bottom, like a computer desktop.
 * Saved gaps are kept. A cell that still belongs to a shortcut which is not on
 * the desk (a hidden saved position) stays reserved, so a drag cannot land on it.
 * Dropping on a visible icon swaps the two. A narrower stage reflows only the
 * icons that no longer fit; it does not rewrite the saved coordinates.
 */

import type { ShortcutCell, ShortcutPositions } from "./types.ts";

export interface ShortcutLayout {
  positions: ShortcutPositions;
  columns: number;
  rows: number;
}

export function cellSize(iconSize: "regular" | "large"): { w: number; h: number } {
  return iconSize === "large" ? { w: 120, h: 128 } : { w: 104, h: 116 };
}

function sameCell(a: ShortcutCell, b: ShortcutCell): boolean {
  return a.column === b.column && a.row === b.row;
}

function validCell(cell: ShortcutCell | undefined, columns: number, rows: number): cell is ShortcutCell {
  return !!cell && Number.isInteger(cell.column) && Number.isInteger(cell.row) && cell.column >= 0 && cell.column < columns && cell.row >= 0 && cell.row < rows;
}

/**
 * How many columns the strip needs. Saved columns are honored until they would
 * span the whole stage; the strip never grows past the stage width.
 */
export function stripColumns(
  count: number,
  stageWidth: number,
  stageHeight: number,
  cell: { w: number; h: number },
  positions: ShortcutPositions,
  ids: readonly string[],
): number {
  const rowsFit = Math.max(1, Math.floor((stageHeight > 0 ? stageHeight : cell.h) / cell.h));
  const needed = Math.max(1, Math.ceil(Math.max(count, 1) / rowsFit));
  let saved = 0;
  for (const id of ids) {
    const preferred = positions[id];
    if (preferred && Number.isInteger(preferred.column) && preferred.column >= 0) {
      saved = Math.max(saved, preferred.column + 1);
    }
  }
  const cap = Math.max(1, Math.floor((stageWidth > 0 ? stageWidth : cell.w) / cell.w));
  return Math.min(cap, Math.max(needed, saved));
}

export function arrangeShortcuts(
  ids: readonly string[],
  preferred: ShortcutPositions,
  columns: number,
  visibleRows: number,
  reserved: ShortcutPositions = {},
): ShortcutLayout {
  columns = Math.max(1, Math.floor(columns));
  const rows = Math.max(1, Math.floor(visibleRows), Math.ceil(ids.length / columns));
  const positions: ShortcutPositions = Object.create(null);
  const occupied = new Set<number>();
  const indexOf = (cell: ShortcutCell) => cell.column * rows + cell.row;
  const visible = new Set(ids);

  for (const [id, cell] of Object.entries(reserved)) {
    if (visible.has(id)) continue;
    if (!validCell(cell, columns, rows)) continue;
    occupied.add(indexOf(cell));
  }

  for (const id of ids) {
    const cell = preferred[id];
    if (!validCell(cell, columns, rows) || occupied.has(indexOf(cell))) continue;
    positions[id] = cell;
    occupied.add(indexOf(cell));
  }

  let next = 0;
  const firstFree = (): ShortcutCell => {
    while (occupied.has(next)) next += 1;
    return { column: Math.floor(next / rows), row: next % rows };
  };
  for (const id of ids) {
    if (positions[id]) continue;
    const cell = firstFree();
    positions[id] = cell;
    occupied.add(indexOf(cell));
  }
  return { positions, columns, rows };
}

/**
 * Move one visible shortcut. A hidden shortcut's saved cell is not a drop
 * target. A visible occupant swaps places. Esc-cancel is the caller's job:
 * this returns the previous map when the drop is rejected.
 */
export function moveShortcut(
  positions: ShortcutPositions,
  visibleIds: readonly string[],
  id: string,
  destination: ShortcutCell,
): ShortcutPositions {
  const origin = positions[id];
  if (
    !origin ||
    !visibleIds.includes(id) ||
    !Number.isInteger(destination.column) ||
    !Number.isInteger(destination.row) ||
    destination.column < 0 ||
    destination.column > 255 ||
    destination.row < 0 ||
    destination.row > 255 ||
    sameCell(origin, destination)
  ) {
    return positions;
  }
  const visible = new Set(visibleIds);
  const occupant = Object.keys(positions).find((key) => positions[key] && sameCell(positions[key], destination));
  if (occupant && occupant !== id && !visible.has(occupant)) return positions;
  const next: ShortcutPositions = { ...positions, [id]: destination };
  if (occupant && occupant !== id) next[occupant] = origin;
  return next;
}

/** Pack icons from the top-left, column by column. Used by "align icons". */
export function packedPositions(ids: readonly string[], columns: number, rows: number): ShortcutPositions {
  const layout = arrangeShortcuts(ids, {}, Math.max(1, columns), Math.max(1, rows));
  return layout.positions;
}
