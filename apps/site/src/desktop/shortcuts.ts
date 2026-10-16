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

/**
 * Cell of one shortcut. Compact density packs the same icons closer together;
 * it does not rewrite saved column and row.
 */
export function cellSize(
  iconSize: "regular" | "large",
  density: "comfortable" | "compact" = "comfortable",
): { w: number; h: number } {
  if (density === "compact") return iconSize === "large" ? { w: 112, h: 112 } : { w: 96, h: 94 };
  return iconSize === "large" ? { w: 136, h: 132 } : { w: 120, h: 112 };
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
 * Translate a selection without changing its shape. Visible occupants move into
 * vacated source cells; hidden saved cells block the entire move. The same plan
 * drives the drag preview and the committed drop, so they cannot disagree.
 */
export function moveShortcut(
  positions: ShortcutPositions,
  visibleIds: readonly string[],
  id: string,
  destination: ShortcutCell,
  selectedIds: readonly string[] = [id],
): ShortcutPositions {
  const origin = positions[id];
  const selected = new Set(selectedIds);
  const visible = new Set(visibleIds);
  if (!origin || !selected.has(id) || !Number.isInteger(destination.column) || !Number.isInteger(destination.row)) return positions;
  const dx = destination.column - origin.column;
  const dy = destination.row - origin.row;
  if (dx === 0 && dy === 0) return positions;
  const targets = new Map<string, ShortcutCell>();
  const targetCells = new Set<string>();
  for (const key of selected) {
    const source = positions[key];
    if (!source || !visible.has(key)) return positions;
    const cell = { column: source.column + dx, row: source.row + dy };
    if (!validCell(cell, 256, 256)) return positions;
    targets.set(key, cell);
    targetCells.add(`${cell.column}:${cell.row}`);
  }
  const displaced: string[] = [];
  for (const [key, cell] of Object.entries(positions)) {
    if (selected.has(key) || !targetCells.has(`${cell.column}:${cell.row}`)) continue;
    if (!visible.has(key)) return positions;
    displaced.push(key);
  }
  const vacated = [...selected].map((key) => positions[key]!)
    .filter((cell) => !targetCells.has(`${cell.column}:${cell.row}`));
  if (displaced.length > vacated.length) return positions;
  const next: ShortcutPositions = { ...positions };
  for (const [key, cell] of targets) next[key] = cell;
  displaced.forEach((key, index) => { next[key] = vacated[index]!; });
  return next;
}

/** Pack icons from the top-left, column by column. Used by "align icons". */
export function packedPositions(ids: readonly string[], columns: number, rows: number): ShortcutPositions {
  const layout = arrangeShortcuts(ids, {}, Math.max(1, columns), Math.max(1, rows));
  return layout.positions;
}
