/**
 * Text Diff Viewer pure helpers (DOM-free; unit-tested in test/text-diff.test.ts):
 * added/removed line counts of a unified patch, the intra-line highlight
 * budget for pathological long lines, line-ending / final-newline detection
 * (reported to the user instead of silently normalized), and grouping of
 * rendered diff rows into navigable change blocks for the change rail and
 * Previous/Next navigation.
 */

/** Added / removed line counts of a unified diff (file headers `+++`/`---` excluded). */
export function countPatchLines(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

export interface IntraLineBudget {
  /** Value for diff2html `maxLineLengthHighlight`: longer changed lines get line-only highlighting. */
  highlightMax: number;
  /** Some changed line exceeds the per-line limit (those lines fall back to line-only). */
  longLines: boolean;
  /** Changed text in total is too large: every line falls back to line-only highlighting. */
  overBudget: boolean;
}

/**
 * Bounds character-level diff work (word diff per changed line pair is
 * O(N·D)): lines longer than `lineMax` chars are highlighted as whole lines,
 * and when all changed lines together exceed `totalBudget` chars, intra-line
 * highlighting is switched off entirely (`highlightMax` = 0).
 */
export function intraLineBudget(patch: string, lineMax = 2000, totalBudget = 200_000): IntraLineBudget {
  let total = 0;
  let longLines = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) {
      const len = line.length - 1;
      total += len;
      if (len > lineMax) longLines = true;
    }
  }
  const overBudget = total > totalBudget;
  return { highlightMax: overBudget ? 0 : lineMax, longLines: longLines && !overBudget, overBudget };
}

export type EolStyle = "none" | "LF" | "CRLF" | "CR" | "mixed";

/** Line-ending style of raw text (before a textarea normalizes it to LF). */
export function detectEol(text: string): EolStyle {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const kinds = [crlf && "CRLF", cr && "CR", lf && "LF"].filter(Boolean) as EolStyle[];
  if (kinds.length === 0) return "none";
  return kinds.length === 1 ? kinds[0] : "mixed";
}

/** Readable token for an EOL style ("CRLF + LF" for mixed files). */
export function eolLabel(style: EolStyle, raw: string): string {
  if (style !== "mixed") return style;
  const parts: string[] = [];
  if (/\r\n/.test(raw)) parts.push("CRLF");
  if (/\r(?!\n)/.test(raw)) parts.push("CR");
  if (/(?<!\r)\n/.test(raw)) parts.push("LF");
  return parts.join(" + ");
}

/** True when the text ends with a line break (LF, CRLF or CR). */
export function endsWithNewline(text: string): boolean {
  return /[\r\n]$/.test(text);
}

/** Kind of one rendered diff row (side-by-side: both sides merged). */
export type RowKind = "context" | "info" | "del" | "ins" | "both";

export interface ChangeBlock {
  /** First and last row index (inclusive). */
  first: number;
  last: number;
  hasDel: boolean;
  hasIns: boolean;
}

/**
 * Groups consecutive changed rows (del/ins/both) into change blocks; context
 * and hunk-header rows separate blocks. Used for "Change 2 of 7" navigation
 * and the change-rail ticks.
 */
export function groupChangeBlocks(kinds: readonly RowKind[]): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  let cur: ChangeBlock | null = null;
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    const del = kind === "del" || kind === "both";
    const ins = kind === "ins" || kind === "both";
    if (!del && !ins) {
      cur = null;
      continue;
    }
    if (cur === null) {
      cur = { first: i, last: i, hasDel: false, hasIns: false };
      blocks.push(cur);
    }
    cur.last = i;
    if (del) cur.hasDel = true;
    if (ins) cur.hasIns = true;
  }
  return blocks;
}

/**
 * Index of the block closest to content offset `y` (pixels), given each
 * block's [top, bottom] extent; -1 when there are no blocks. Rail clicks use it.
 */
export function nearestBlock(extents: ReadonlyArray<{ top: number; bottom: number }>, y: number): number {
  let best = -1;
  let bestDist = Infinity;
  extents.forEach((e, i) => {
    const dist = y < e.top ? e.top - y : y > e.bottom ? y - e.bottom : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  return best;
}
