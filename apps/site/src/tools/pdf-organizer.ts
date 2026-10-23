/**
 * PDF Organizer pure helpers (DOM-free; unit-tested in test/pdf-organizer.test.ts):
 * page list edits (rotate, move, delete), split modes — one file, every N
 * pages, custom ranges like `1-3, 5, 8-` (positions in the edited order) —
 * turned into WASM page plans, output file names and a stored ZIP of the
 * split parts (`storedZip` in archive-format.ts).
 */

/** One page of the edited document: 0-based source page and added clockwise rotation. */
export interface OrganizerPage {
  source: number;
  rotate: number;
}

/** Initial list: every source page once, unrotated. */
export function initialPages(count: number): OrganizerPage[] {
  return Array.from({ length: count }, (_, source) => ({ source, rotate: 0 }));
}

/** Add `delta` degrees (±90) to the page rotation, normalized to 0–270. */
export function rotatePage(page: OrganizerPage, delta: number): OrganizerPage {
  return { ...page, rotate: (((page.rotate + delta) % 360) + 360) % 360 };
}

/** Effective rotation shown on screen: the page's own /Rotate plus the edit. */
export function displayRotation(ownRotate: number, page: OrganizerPage): number {
  return (((ownRotate + page.rotate) % 360) + 360) % 360;
}

export type RangeResult = { ok: true; groups: number[][] } | { ok: false; token: string };

/**
 * Parse custom ranges into groups of 0-based positions, one group per output
 * file: `1-3, 5, 8-` → [[0,1,2],[4],[7…last]]. Separators: comma, semicolon
 * or new line; `-`, `–` and `—` make a range; an open end means "to the last
 * page"; a reversed range (`5-3`) runs backwards. Out-of-range or malformed
 * tokens fail with that token.
 */
export function parseRanges(text: string, count: number): RangeResult {
  const groups: number[][] = [];
  for (const raw of text.split(/[,;\n]+/)) {
    const token = raw.trim();
    if (!token) continue;
    const m = /^(\d*)\s*(?:([-–—])\s*(\d*))?$/.exec(token);
    if (!m || (!m[1] && !m[3])) return { ok: false, token };
    const from = m[1] ? Number(m[1]) : 1;
    const to = m[2] ? (m[3] ? Number(m[3]) : count) : from;
    if (from < 1 || to < 1 || from > count || to > count) return { ok: false, token };
    const step = from <= to ? 1 : -1;
    const group: number[] = [];
    for (let p = from; p !== to + step; p += step) group.push(p - 1);
    groups.push(group);
  }
  return groups.length > 0 ? { ok: true, groups } : { ok: false, token: text.trim() };
}

/** Groups of `size` consecutive positions (the last may be shorter). */
export function chunkPositions(count: number, size: number): number[][] {
  const n = Math.max(1, Math.floor(size));
  const out: number[][] = [];
  for (let start = 0; start < count; start += n) {
    out.push(Array.from({ length: Math.min(n, count - start) }, (_, i) => start + i));
  }
  return out;
}

/** Positions → WASM plans (`{page, rotate}` per output page). */
export function buildPlans(pages: readonly OrganizerPage[], groups: readonly number[][]): { page: number; rotate: number }[][] {
  return groups.map((group) => group.map((pos) => ({ page: pages[pos].source, rotate: pages[pos].rotate })));
}

/**
 * True when `groups` reproduce the source unchanged (same pages, same order,
 * no rotation): there is nothing to save.
 */
export function isUnchanged(pages: readonly OrganizerPage[], sourceCount: number, groups: readonly number[][]): boolean {
  return (
    groups.length === 1 &&
    pages.length === sourceCount &&
    groups[0].length === sourceCount &&
    groups[0].every((pos, i) => pos === i && pages[pos].source === i && pages[pos].rotate === 0)
  );
}

/** Source name without `.pdf`, never empty. */
export function baseName(fileName: string): string {
  return fileName.replace(/\.pdf$/i, "") || "document";
}

/**
 * Output names: a single file is `<name>_organized.pdf`; split parts are
 * `<name>_p<first>-<last>.pdf` (1-based positions of the edited order;
 * `_p<n>` for one page), made unique with `_2`, `_3`… when ranges repeat.
 */
export function outputNames(fileName: string, groups: readonly number[][]): string[] {
  const base = baseName(fileName);
  if (groups.length === 1) return [`${base}_organized.pdf`];
  const used = new Map<string, number>();
  return groups.map((g) => {
    const first = g[0] + 1;
    const last = g[g.length - 1] + 1;
    const stem = `${base}_p${first === last || g.length === 1 ? first : `${first}-${last}`}`;
    const n = (used.get(stem) ?? 0) + 1;
    used.set(stem, n);
    return `${n === 1 ? stem : `${stem}_${n}`}.pdf`;
  });
}

/** "A4", "Letter", … for common paper sizes (either orientation, ±2 pt), else null. */
export function paperName(width: number, height: number): string | null {
  const sizes: [string, number, number][] = [
    ["A3", 842, 1191],
    ["A4", 595, 842],
    ["A5", 420, 595],
    ["Letter", 612, 792],
    ["Legal", 612, 1008],
  ];
  const [a, b] = width <= height ? [width, height] : [height, width];
  return sizes.find(([, w, h]) => Math.abs(a - w) <= 2 && Math.abs(b - h) <= 2)?.[0] ?? null;
}
