/**
 * Large file diff core: compare two local files of any size with bounded memory.
 *
 * Text mode reduces every line to a 64-bit hash (two 32-bit halves) plus one byte offset per
 * 256 lines, so a file costs about 8 bytes per line instead of its text. Whitespace and line
 * ending options are applied while hashing. UTF-8 and UTF-16 are hashed as code points, so the
 * same text in both encodings compares equal. The line diff trims the common head and tail,
 * anchors on lines unique to both sides (patience diff) and fills the gaps with a linear-space
 * Myers diff whose work is capped; a gap over the cap becomes one replace block. Line text is
 * read back from the files only for the rows on screen and for the export.
 *
 * Binary mode compares the files block by block and lists differing byte ranges.
 */

export const FILE_DIFF_CHUNK_BYTES = 1024 * 1024;
/** Lines per file. Hashes take 8 bytes per line; the anchor table up to 9 bytes more while diffing. */
export const FILE_DIFF_MAX_LINES = 10_000_000;
/** A byte offset is kept for every Nth line; reading line k scans at most N - 1 lines. */
export const FILE_DIFF_CHECKPOINT_LINES = 256;
/** Differing byte ranges kept for the table and the report. Later ranges are only counted. */
export const FILE_DIFF_MAX_RANGES = 100_000;
/** Bytes per side shown and exported for one binary range. */
export const FILE_DIFF_RANGE_PREVIEW_BYTES = 16;
/** Clipped line in the table. The export writes whole lines. */
export const FILE_DIFF_PREVIEW_CHARS = 2000;
/** A line longer than this cannot be exported. */
export const FILE_DIFF_MAX_EXPORT_LINE_BYTES = 16 * 1024 * 1024;
export const FILE_DIFF_MAX_CONTEXT = 20;
/** Myers steps one gap may spend before it is reported as a replace block. */
const MYERS_GAP_WORK = 50_000_000;
/** Myers steps for the whole comparison. */
const MYERS_TOTAL_WORK = 2_000_000_000;
/** Ranges with fewer lines skip the unique-line anchors and go straight to Myers. */
const PATIENCE_MIN_LINES = 2048;

export type FileDiffErrorCode = "too-many-lines" | "line-too-long" | "session-missing" | "invalid";

/** Failure the page can map to a localized sentence. `code` is the stable id. */
export class FileDiffError extends Error {
  readonly code: FileDiffErrorCode;

  constructor(code: FileDiffErrorCode, message: string) {
    super(message);
    this.name = "FileDiffError";
    this.code = code;
  }
}

export type ReadRange = (start: number, end: number) => Promise<Uint8Array>;

/**
 * - exact: every character counts;
 * - trailing: ignore whitespace at the end of a line;
 * - change: ignore leading and trailing whitespace and treat any run as one space;
 * - all: ignore all whitespace.
 */
export type WhitespaceMode = "exact" | "trailing" | "change" | "all";

export interface FileDiffTextOptions {
  /** `auto` reads a BOM and otherwise assumes UTF-8. Any other value is a WHATWG encoding label. */
  encoding: string;
  whitespace: WhitespaceMode;
  /** Treat CRLF as LF and ignore a missing newline at the end of the file. */
  ignoreEol: boolean;
}

export type FileDiffEncodingKind = "utf-8" | "utf-16le" | "utf-16be" | "bytes";

export interface ResolvedEncoding {
  /** WHATWG label for TextDecoder. */
  label: string;
  kind: FileDiffEncodingKind;
  /** Bytes skipped at the start of the file. */
  bomLength: number;
}

const WHITESPACE_MODES = new Set<WhitespaceMode>(["exact", "trailing", "change", "all"]);

/** Encoding of one file: the BOM wins in auto mode; an explicit UTF label also skips its own BOM. */
export function resolveEncoding(requested: string, head: Uint8Array): ResolvedEncoding {
  const utf8Bom = head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
  const leBom = head.length >= 2 && head[0] === 0xff && head[1] === 0xfe;
  const beBom = head.length >= 2 && head[0] === 0xfe && head[1] === 0xff;
  const label = requested.trim().toLowerCase();
  if (label === "auto" || label === "") {
    if (utf8Bom) return { label: "utf-8", kind: "utf-8", bomLength: 3 };
    if (leBom) return { label: "utf-16le", kind: "utf-16le", bomLength: 2 };
    if (beBom) return { label: "utf-16be", kind: "utf-16be", bomLength: 2 };
    return { label: "utf-8", kind: "utf-8", bomLength: 0 };
  }
  if (label === "utf-8" || label === "utf8") return { label: "utf-8", kind: "utf-8", bomLength: utf8Bom ? 3 : 0 };
  if (label === "utf-16le" || label === "utf-16") return { label: "utf-16le", kind: "utf-16le", bomLength: leBom ? 2 : 0 };
  if (label === "utf-16be") return { label: "utf-16be", kind: "utf-16be", bomLength: beBom ? 2 : 0 };
  try {
    new TextDecoder(label);
  } catch {
    throw new FileDiffError("invalid", `Unsupported encoding ${requested}`);
  }
  return { label, kind: "bytes", bomLength: 0 };
}

/** NUL bytes in the first block mark binary data, unless the file is UTF-16. */
export function looksBinary(head: Uint8Array): boolean {
  if (head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) return false;
  return head.includes(0);
}

export interface LineIndex {
  /** Lines in the file. A last line without a newline counts; an empty file has none. */
  lines: number;
  h1: Int32Array;
  h2: Int32Array;
  /** Byte offset of line k * FILE_DIFF_CHECKPOINT_LINES. */
  checkpoints: Float64Array;
  size: number;
  encoding: ResolvedEncoding;
  /** The last line ends with a newline (false for an empty file). */
  finalNewline: boolean;
  lf: number;
  crlf: number;
}

const LF = 0x0a;
const CR = 0x0d;
/** Code values that cannot occur in text, mixed in as markers. */
const MARK_CRLF = 0x200001;
const MARK_NO_FINAL_NEWLINE = 0x200002;
const MARK_INVALID = 0x110000;

function isSpace(value: number): boolean {
  return value === 0x20 || value === 0x09 || value === CR || value === 0x0b || value === 0x0c;
}

/**
 * Streaming line hasher. Code values arrive one at a time; LF ends a line. A CR is held back
 * until the next value shows whether it is the CR of a CRLF line ending.
 */
class LineHasher {
  lines = 0;
  lf = 0;
  crlf = 0;
  h1: Int32Array;
  h2: Int32Array;
  checkpoints: Float64Array;
  /** Hash state, public so the indexing loop can hash plain ASCII inline. */
  a = 0;
  b = 0;
  hashed = 0;
  /** Plain bytes may be mixed directly: no held CR, pending spaces or space run. */
  fast = false;
  private open = false;
  private crHeld = false;
  private spaceRun = false;
  private content = false;
  private pending = new Uint32Array(64);
  private pendingLength = 0;
  private lineStart: number;
  private readonly options: FileDiffTextOptions;
  /** Bytes of one LF code unit: 2 in UTF-16. */
  private readonly newlineBytes: number;

  constructor(options: FileDiffTextOptions, start: number, expectedLines: number, newlineBytes: number) {
    this.options = options;
    this.newlineBytes = newlineBytes;
    const capacity = Math.max(1024, Math.min(FILE_DIFF_MAX_LINES, expectedLines));
    this.h1 = new Int32Array(capacity);
    this.h2 = new Int32Array(capacity);
    this.checkpoints = new Float64Array(Math.ceil(capacity / FILE_DIFF_CHECKPOINT_LINES) + 1);
    this.lineStart = start;
    this.reset();
  }

  private reset(): void {
    this.a = 0x811c9dc5 | 0;
    this.b = 0x3c6ef372 | 0;
    this.hashed = 0;
    this.open = false;
    this.spaceRun = false;
    this.content = false;
    this.pendingLength = 0;
    this.fast = false;
  }

  private syncFast(): void {
    this.fast = this.open && !this.crHeld && this.pendingLength === 0
      && (this.options.whitespace !== "change" || (!this.spaceRun && this.content));
  }

  private mix(value: number): void {
    this.a = Math.imul(this.a ^ value, 0x01000193);
    let b = Math.imul(this.b ^ value, 0x5bd1e995);
    b ^= b >>> 15;
    this.b = b;
    this.hashed++;
  }

  /** A value that is not the LF of a line ending, after whitespace rules. */
  private take(value: number): void {
    switch (this.options.whitespace) {
      case "exact":
        this.mix(value);
        return;
      case "all":
        if (!isSpace(value)) this.mix(value);
        return;
      case "change":
        if (isSpace(value)) {
          this.spaceRun = true;
          return;
        }
        if (this.spaceRun && this.content) this.mix(0x20);
        this.spaceRun = false;
        this.content = true;
        this.mix(value);
        return;
      case "trailing":
        if (isSpace(value)) {
          if (this.pendingLength === this.pending.length) {
            const grown = new Uint32Array(this.pending.length * 2);
            grown.set(this.pending);
            this.pending = grown;
          }
          this.pending[this.pendingLength++] = value;
          return;
        }
        for (let index = 0; index < this.pendingLength; index++) this.mix(this.pending[index]);
        this.pendingLength = 0;
        this.mix(value);
    }
  }

  push(value: number, offset: number): void {
    if (this.crHeld) {
      this.crHeld = false;
      if (value === LF) {
        this.crlf++;
        if (!this.options.ignoreEol) this.mix(MARK_CRLF);
        this.finishLine(offset + this.newlineBytes, true);
        return;
      }
      this.take(CR);
      this.syncFast();
    }
    if (value === LF) {
      this.lf++;
      this.finishLine(offset + this.newlineBytes, true);
      return;
    }
    this.open = true;
    if (value === CR) {
      this.crHeld = true;
      this.fast = false;
      return;
    }
    this.take(value);
    this.syncFast();
  }

  /** `next` is the byte offset of the following line. */
  private finishLine(next: number, newline: boolean): void {
    if (this.lines >= FILE_DIFF_MAX_LINES) throw new FileDiffError("too-many-lines", "Too many lines");
    if (!newline && !this.options.ignoreEol) this.mix(MARK_NO_FINAL_NEWLINE);
    if (this.lines === this.h1.length) {
      const capacity = Math.min(FILE_DIFF_MAX_LINES, this.h1.length * 2);
      const h1 = new Int32Array(capacity);
      h1.set(this.h1);
      this.h1 = h1;
      const h2 = new Int32Array(capacity);
      h2.set(this.h2);
      this.h2 = h2;
    }
    if (this.lines % FILE_DIFF_CHECKPOINT_LINES === 0) {
      const slot = this.lines / FILE_DIFF_CHECKPOINT_LINES;
      if (slot >= this.checkpoints.length) {
        const grown = new Float64Array(this.checkpoints.length * 2 + 1);
        grown.set(this.checkpoints);
        this.checkpoints = grown;
      }
      this.checkpoints[slot] = this.lineStart;
    }
    // Final avalanche with the length, so "a" and "a\0"-like collisions stay unlikely.
    let a = Math.imul(this.a ^ this.hashed, 0x85ebca6b);
    a ^= a >>> 13;
    let b = Math.imul(this.b ^ Math.imul(this.hashed, 0x27d4eb2d), 0xc2b2ae35);
    b ^= b >>> 16;
    this.h1[this.lines] = a;
    this.h2[this.lines] = b;
    this.lines++;
    this.lineStart = next;
    this.reset();
  }

  /** Close the last line; returns whether the file ended with a newline. */
  finish(size: number): boolean {
    if (this.crHeld) {
      this.crHeld = false;
      this.open = true;
      this.take(CR);
    }
    if (this.open) {
      this.finishLine(size, false);
      return false;
    }
    return this.lines > 0;
  }
}

/**
 * Hot path: mix a run of printable ASCII (never CR or LF) starting at `from` into the hasher's
 * state, with the same mixing as LineHasher.mix. Returns the index after the run; the caller
 * counts the hashed units. A small function keeps the JIT on its fastest tier.
 */
function asciiRun(bytes: Uint8Array, from: number, to: number, lowest: number, state: { a: number; b: number }): number {
  let a = state.a;
  let b = state.b;
  let index = from;
  for (; index < to; index++) {
    const byte = bytes[index];
    if (byte < lowest || byte >= 0x80) break;
    a = Math.imul(a ^ byte, 0x01000193);
    b = Math.imul(b ^ byte, 0x5bd1e995);
    b ^= b >>> 15;
  }
  state.a = a;
  state.b = b;
  return index;
}

/**
 * Hash every line of a file. Reads FILE_DIFF_CHUNK_BYTES at a time; `onProgress` gets bytes read.
 * Invalid UTF-8 bytes hash as distinct markers instead of failing.
 */
export async function indexLines(
  size: number,
  read: ReadRange,
  options: FileDiffTextOptions,
  onProgress?: (processed: number) => void,
): Promise<LineIndex> {
  if (!WHITESPACE_MODES.has(options.whitespace)) throw new FileDiffError("invalid", "Unknown whitespace mode");
  const head = size === 0 ? new Uint8Array(0) : await read(0, Math.min(size, 4));
  const encoding = resolveEncoding(options.encoding, head);
  const wide = encoding.kind === "utf-16le" || encoding.kind === "utf-16be";
  const hasher = new LineHasher(options, encoding.bomLength, Math.ceil(size / 48), wide ? 2 : 1);
  let codePoint = 0;
  let needed = 0;
  let sequenceStart = 0;
  let unit = -1;
  let unitOffset = 0;
  let high = -1;
  let highOffset = 0;

  for (let start = encoding.bomLength; start < size; start += FILE_DIFF_CHUNK_BYTES) {
    const bytes = await read(start, Math.min(size, start + FILE_DIFF_CHUNK_BYTES));
    const length = bytes.length;
    if (encoding.kind !== "utf-16le" && encoding.kind !== "utf-16be") {
      const utf8 = encoding.kind === "utf-8";
      // In exact mode a space is an ordinary character, so it can take the hot path too.
      const lowest = options.whitespace === "exact" ? 0x20 : 0x21;
      let a = hasher.a, b = hasher.b, hashed = hasher.hashed, fast = hasher.fast;
      for (let index = 0; index < length; index++) {
        const byte = bytes[index];
        if (fast && byte >= lowest && byte < 0x80 && needed === 0) {
          const run = asciiRun(bytes, index, length, lowest, hasher);
          hashed += run - index;
          a = hasher.a;
          b = hasher.b;
          index = run - 1;
          continue;
        }
        hasher.a = a; hasher.b = b; hasher.hashed = hashed;
        const offset = start + index;
        if (!utf8) hasher.push(byte, offset);
        else {
          let lead = true;
          if (needed > 0) {
            if ((byte & 0xc0) === 0x80) {
              codePoint = (codePoint << 6) | (byte & 0x3f);
              if (--needed === 0) hasher.push(codePoint, sequenceStart);
              lead = false;
            } else {
              // A cut sequence: hash it as one invalid marker, then handle this byte afresh.
              hasher.push(MARK_INVALID + (codePoint & 0xff), sequenceStart);
              needed = 0;
            }
          }
          if (lead) {
            if (byte < 0x80) hasher.push(byte, offset);
            else if (byte >= 0xc2 && byte <= 0xdf) { codePoint = byte & 0x1f; needed = 1; sequenceStart = offset; }
            else if (byte >= 0xe0 && byte <= 0xef) { codePoint = byte & 0x0f; needed = 2; sequenceStart = offset; }
            else if (byte >= 0xf0 && byte <= 0xf4) { codePoint = byte & 0x07; needed = 3; sequenceStart = offset; }
            else hasher.push(MARK_INVALID + byte, offset);
          }
        }
        a = hasher.a; b = hasher.b; hashed = hasher.hashed; fast = hasher.fast;
      }
      hasher.a = a; hasher.b = b; hasher.hashed = hashed;
    } else {
      const little = encoding.kind === "utf-16le";
      for (let index = 0; index < length; index++) {
        if (unit < 0) {
          unit = bytes[index];
          unitOffset = start + index;
          continue;
        }
        const value = little ? unit | (bytes[index] << 8) : (unit << 8) | bytes[index];
        unit = -1;
        if (high >= 0) {
          if (value >= 0xdc00 && value <= 0xdfff) {
            hasher.push(0x10000 + ((high - 0xd800) << 10) + (value - 0xdc00), highOffset);
            high = -1;
            continue;
          }
          hasher.push(MARK_INVALID + high, highOffset);
          high = -1;
        }
        if (value >= 0xd800 && value <= 0xdbff) {
          high = value;
          highOffset = unitOffset;
        } else {
          hasher.push(value >= 0xdc00 && value <= 0xdfff ? MARK_INVALID + value : value, unitOffset);
        }
      }
    }
    onProgress?.(Math.min(size, start + FILE_DIFF_CHUNK_BYTES));
  }
  if (needed > 0) hasher.push(MARK_INVALID + (codePoint & 0xff), sequenceStart);
  if (high >= 0) hasher.push(MARK_INVALID + high, highOffset);
  if (unit >= 0) hasher.push(MARK_INVALID + unit, unitOffset);
  const finalNewline = hasher.finish(size);
  return {
    lines: hasher.lines,
    h1: hasher.h1,
    h2: hasher.h2,
    checkpoints: hasher.checkpoints,
    size,
    encoding,
    finalNewline,
    lf: hasher.lf,
    crlf: hasher.crlf,
  };
}

/** Growable list of change regions: lines [aStart, aEnd) of A replaced by [bStart, bEnd) of B. */
export class DiffRegions {
  count = 0;
  aStart = new Int32Array(256);
  aEnd = new Int32Array(256);
  bStart = new Int32Array(256);
  bEnd = new Int32Array(256);

  /** Append in order; a region touching the previous one is merged into it. */
  add(aStart: number, aEnd: number, bStart: number, bEnd: number): void {
    if (aStart === aEnd && bStart === bEnd) return;
    const last = this.count - 1;
    if (last >= 0 && this.aEnd[last] === aStart && this.bEnd[last] === bStart) {
      this.aEnd[last] = aEnd;
      this.bEnd[last] = bEnd;
      return;
    }
    if (this.count === this.aStart.length) {
      const grow = (array: Int32Array) => {
        const next = new Int32Array(array.length * 2);
        next.set(array);
        return next;
      };
      this.aStart = grow(this.aStart);
      this.aEnd = grow(this.aEnd);
      this.bStart = grow(this.bStart);
      this.bEnd = grow(this.bEnd);
    }
    this.aStart[this.count] = aStart;
    this.aEnd[this.count] = aEnd;
    this.bStart[this.count] = bStart;
    this.bEnd[this.count] = bEnd;
    this.count++;
  }
}

export interface LineHashes {
  lines: number;
  h1: Int32Array;
  h2: Int32Array;
}

export interface LineDiffResult {
  regions: DiffRegions;
  removed: number;
  added: number;
  /** Some gaps exceeded the Myers budget and are shown as whole replace blocks. */
  approximate: boolean;
}

/** Line diff of two hashed files. Regions come out sorted and non-overlapping. */
export function diffLineHashes(a: LineHashes, b: LineHashes, onProgress?: (done: number, total: number) => void): LineDiffResult {
  const ah1 = a.h1, ah2 = a.h2, bh1 = b.h1, bh2 = b.h2;
  const equal = (i: number, j: number) => ah1[i] === bh1[j] && ah2[i] === bh2[j];
  const regions = new DiffRegions();
  let totalWork = MYERS_TOTAL_WORK;
  let approximate = false;
  const total = a.lines + b.lines;
  let done = 0;
  const report = (lines: number) => {
    done += lines;
    onProgress?.(Math.min(done, total), total);
  };

  /** Linear-space Myers on one range, emitting regions in order. */
  const myers = (aLo: number, aHi: number, bLo: number, bHi: number): void => {
    while (aLo < aHi && bLo < bHi && equal(aLo, bLo)) { aLo++; bLo++; }
    while (aHi > aLo && bHi > bLo && equal(aHi - 1, bHi - 1)) { aHi--; bHi--; }
    const n = aHi - aLo;
    const m = bHi - bLo;
    if (n === 0 || m === 0) {
      regions.add(aLo, aHi, bLo, bHi);
      return;
    }
    const maxD = Math.ceil((n + m) / 2);
    const budget = Math.min(MYERS_GAP_WORK, totalWork);
    const cap = Math.min(maxD, Math.max(1, Math.floor(budget / (n + m))));
    const offset = cap + 1;
    const length = 2 * cap + 4;
    const v1 = new Int32Array(length).fill(-1);
    const v2 = new Int32Array(length).fill(-1);
    v1[offset + 1] = 0;
    v2[offset + 1] = 0;
    const delta = n - m;
    const front = (delta & 1) !== 0;
    let k1start = 0, k1end = 0, k2start = 0, k2end = 0;
    for (let d = 0; d < cap; d++) {
      totalWork -= 2 * d + 2;
      for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
        const k1Offset = offset + k1;
        let x1 = k1 === -d || (k1 !== d && v1[k1Offset - 1] < v1[k1Offset + 1]) ? v1[k1Offset + 1] : v1[k1Offset - 1] + 1;
        let y1 = x1 - k1;
        while (x1 < n && y1 < m && equal(aLo + x1, bLo + y1)) { x1++; y1++; }
        v1[k1Offset] = x1;
        if (x1 > n) k1end += 2;
        else if (y1 > m) k1start += 2;
        else if (front) {
          const k2Offset = offset + delta - k1;
          if (k2Offset >= 0 && k2Offset < length && v2[k2Offset] !== -1 && x1 >= n - v2[k2Offset]) {
            myers(aLo, aLo + x1, bLo, bLo + y1);
            myers(aLo + x1, aHi, bLo + y1, bHi);
            return;
          }
        }
      }
      for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
        const k2Offset = offset + k2;
        let x2 = k2 === -d || (k2 !== d && v2[k2Offset - 1] < v2[k2Offset + 1]) ? v2[k2Offset + 1] : v2[k2Offset - 1] + 1;
        let y2 = x2 - k2;
        while (x2 < n && y2 < m && equal(aLo + n - x2 - 1, bLo + m - y2 - 1)) { x2++; y2++; }
        v2[k2Offset] = x2;
        if (x2 > n) k2end += 2;
        else if (y2 > m) k2start += 2;
        else if (!front) {
          const k1Offset = offset + delta - k2;
          if (k1Offset >= 0 && k1Offset < length && v1[k1Offset] !== -1) {
            const x1 = v1[k1Offset];
            const y1 = x1 - (k1Offset - offset);
            if (x1 >= n - x2) {
              myers(aLo, aLo + x1, bLo, bLo + y1);
              myers(aLo + x1, aHi, bLo + y1, bHi);
              return;
            }
          }
        }
      }
    }
    // Over budget: one replace block. Exact when the budget covered every possible d.
    if (cap < maxD) approximate = true;
    regions.add(aLo, aHi, bLo, bHi);
  };

  /** Lines unique to both ranges, longest increasing run in A order: the anchors. */
  const anchors = (aLo: number, aHi: number, bLo: number, bHi: number): Int32Array | null => {
    const n = aHi - aLo;
    let capacity = 1024;
    while (capacity < n * 1.4) capacity *= 2;
    const mask = capacity - 1;
    const keys = new Int32Array(capacity); // A index + 1 of the first occurrence; 0 = empty
    const state = new Int32Array(capacity); // B: 0 unseen, -1 repeated, else index + 1
    const repeatedA = new Uint8Array(capacity);
    const slot = (h1: number, h2: number) => (h1 ^ Math.imul(h2, 0x9e3779b1)) & mask;
    for (let i = aLo; i < aHi; i++) {
      let s = slot(ah1[i], ah2[i]);
      for (;;) {
        const key = keys[s];
        if (key === 0) { keys[s] = i + 1; break; }
        if (ah1[key - 1] === ah1[i] && ah2[key - 1] === ah2[i]) { repeatedA[s] = 1; break; }
        s = (s + 1) & mask;
      }
    }
    for (let j = bLo; j < bHi; j++) {
      let s = slot(bh1[j], bh2[j]);
      for (;;) {
        const key = keys[s];
        if (key === 0) break;
        if (ah1[key - 1] === bh1[j] && ah2[key - 1] === bh2[j]) {
          state[s] = state[s] === 0 ? j + 1 : -1;
          break;
        }
        s = (s + 1) & mask;
      }
    }
    // Pairs in B order; their A positions feed a patience-sorting LIS.
    let pairCount = 0;
    for (let s = 0; s < capacity; s++) if (keys[s] !== 0 && !repeatedA[s] && state[s] > 0) pairCount++;
    if (pairCount === 0) return null;
    const pairA = new Int32Array(pairCount);
    const pairB = new Int32Array(pairCount);
    let p = 0;
    for (let j = bLo; j < bHi && p < pairCount; j++) {
      let s = slot(bh1[j], bh2[j]);
      for (;;) {
        const key = keys[s];
        if (key === 0) break;
        if (ah1[key - 1] === bh1[j] && ah2[key - 1] === bh2[j]) {
          if (!repeatedA[s] && state[s] === j + 1) {
            pairA[p] = key - 1;
            pairB[p] = j;
            p++;
          }
          break;
        }
        s = (s + 1) & mask;
      }
    }
    const tails = new Int32Array(pairCount);
    const previous = new Int32Array(pairCount);
    let size = 0;
    for (let index = 0; index < pairCount; index++) {
      const value = pairA[index];
      let low = 0, high = size;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (pairA[tails[middle]] < value) low = middle + 1;
        else high = middle;
      }
      previous[index] = low > 0 ? tails[low - 1] : -1;
      tails[low] = index;
      if (low === size) size++;
    }
    const result = new Int32Array(size * 2);
    for (let index = tails[size - 1], out = size - 1; index >= 0; index = previous[index], out--) {
      result[out * 2] = pairA[index];
      result[out * 2 + 1] = pairB[index];
    }
    return result;
  };

  // Ranges are processed left to right from a stack so regions are emitted in order.
  const stack: number[] = [0, a.lines, 0, b.lines];
  while (stack.length > 0) {
    const bHi = stack.pop()!, bLo = stack.pop()!, aHi = stack.pop()!;
    let aLo = stack.pop()!;
    let bStart = bLo;
    let aEnd = aHi, bEnd = bHi;
    while (aLo < aEnd && bStart < bEnd && equal(aLo, bStart)) { aLo++; bStart++; }
    while (aEnd > aLo && bEnd > bStart && equal(aEnd - 1, bEnd - 1)) { aEnd--; bEnd--; }
    if (aLo === aEnd || bStart === bEnd || aEnd - aLo + bEnd - bStart < PATIENCE_MIN_LINES) {
      myers(aLo, aEnd, bStart, bEnd);
      report(aHi - aLo + bHi - bLo);
      continue;
    }
    const found = anchors(aLo, aEnd, bStart, bEnd);
    if (!found) {
      myers(aLo, aEnd, bStart, bEnd);
      report(aHi - aLo + bHi - bLo);
      continue;
    }
    // Push gaps right to left: after the last anchor, between anchors, before the first.
    const pairs = found.length / 2;
    stack.push(found[(pairs - 1) * 2] + 1, aEnd, found[(pairs - 1) * 2 + 1] + 1, bEnd);
    for (let index = pairs - 1; index > 0; index--) {
      stack.push(found[(index - 1) * 2] + 1, found[index * 2], found[(index - 1) * 2 + 1] + 1, found[index * 2 + 1]);
    }
    stack.push(aLo, found[0], bStart, found[1]);
  }

  let removed = 0, added = 0;
  for (let index = 0; index < regions.count; index++) {
    removed += regions.aEnd[index] - regions.aStart[index];
    added += regions.bEnd[index] - regions.bStart[index];
  }
  onProgress?.(total, total);
  return { regions, removed, added, approximate };
}

export const DiffRowKind = { Header: 0, Context: 1, Removed: 2, Added: 3 } as const;
export type DiffRowKind = (typeof DiffRowKind)[keyof typeof DiffRowKind];

export interface DiffRow {
  kind: DiffRowKind;
  hunk: number;
  /** 0-based line numbers, -1 when the row has no line on that side. */
  a: number;
  b: number;
}

export interface HunkHeader {
  aStart: number;
  aCount: number;
  bStart: number;
  bCount: number;
}

/**
 * Hunks with `context` unchanged lines around each change, laid out as table rows:
 * a header row, then context, removed and added lines in unified-diff order.
 */
export class DiffLayout {
  readonly hunks: number;
  readonly rows: number;
  private readonly firstRegion: Int32Array;
  private readonly hunkRow: Float64Array;
  private readonly regionRow: Float64Array;
  private readonly regions: DiffRegions;
  private readonly aLines: number;
  private readonly bLines: number;
  readonly context: number;

  constructor(regions: DiffRegions, aLines: number, bLines: number, context: number) {
    this.regions = regions;
    this.aLines = aLines;
    this.bLines = bLines;
    this.context = context;
    const count = regions.count;
    const firstRegion = new Int32Array(count + 1);
    const regionRow = new Float64Array(count);
    const hunkRow = new Float64Array(count + 1);
    let hunks = 0;
    let row = 0;
    for (let r = 0; r < count; r++) {
      const startsHunk = r === 0 || regions.aStart[r] - regions.aEnd[r - 1] > 2 * context;
      if (startsHunk) {
        if (r > 0) row += Math.min(context, regions.aStart[r] - regions.aEnd[r - 1]); // trailing context of the previous hunk
        firstRegion[hunks] = r;
        hunkRow[hunks] = row;
        hunks++;
        row += 1;
        regionRow[r] = row;
        row += Math.min(context, regions.aStart[r]);
      } else {
        regionRow[r] = row;
        row += regions.aStart[r] - regions.aEnd[r - 1];
      }
      row += regions.aEnd[r] - regions.aStart[r] + regions.bEnd[r] - regions.bStart[r];
    }
    if (count > 0) row += Math.min(context, aLines - regions.aEnd[count - 1]);
    firstRegion[hunks] = count;
    hunkRow[hunks] = row;
    this.hunks = hunks;
    this.rows = row;
    this.firstRegion = firstRegion;
    this.hunkRow = hunkRow;
    this.regionRow = regionRow;
  }

  /** Row index of the header of hunk `index`. */
  hunkStartRow(index: number): number {
    return this.hunkRow[Math.max(0, Math.min(index, this.hunks - 1))];
  }

  /** Hunk that contains `row`. */
  hunkOfRow(row: number): number {
    let low = 0, high = this.hunks - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.hunkRow[middle] <= row) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  /** Unified-diff header numbers of a hunk (0-based starts). */
  header(hunk: number): HunkHeader {
    const { regions, context } = this;
    const first = this.firstRegion[hunk];
    const last = this.firstRegion[hunk + 1] - 1;
    const leadA = Math.min(context, regions.aStart[first]);
    const aStart = regions.aStart[first] - leadA;
    const bStart = regions.bStart[first] - leadA;
    const trail = Math.min(context, this.aLines - regions.aEnd[last], this.bLines - regions.bEnd[last]);
    return { aStart, aCount: regions.aEnd[last] + trail - aStart, bStart, bCount: regions.bEnd[last] + trail - bStart };
  }

  row(index: number): DiffRow {
    const { regions } = this;
    const hunk = this.hunkOfRow(index);
    if (index === this.hunkRow[hunk]) return { kind: DiffRowKind.Header, hunk, a: -1, b: -1 };
    let low = this.firstRegion[hunk];
    let high = this.firstRegion[hunk + 1] - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.regionRow[middle] <= index) low = middle;
      else high = middle - 1;
    }
    const r = low;
    const first = r === this.firstRegion[hunk];
    const contextLength = first ? Math.min(this.context, regions.aStart[r]) : regions.aStart[r] - regions.aEnd[r - 1];
    let offset = index - this.regionRow[r];
    if (offset < contextLength) {
      return { kind: DiffRowKind.Context, hunk, a: regions.aStart[r] - contextLength + offset, b: regions.bStart[r] - contextLength + offset };
    }
    offset -= contextLength;
    const removed = regions.aEnd[r] - regions.aStart[r];
    if (offset < removed) return { kind: DiffRowKind.Removed, hunk, a: regions.aStart[r] + offset, b: -1 };
    offset -= removed;
    const added = regions.bEnd[r] - regions.bStart[r];
    if (offset < added) return { kind: DiffRowKind.Added, hunk, a: -1, b: regions.bStart[r] + offset };
    offset -= added;
    return { kind: DiffRowKind.Context, hunk, a: regions.aEnd[r] + offset, b: regions.bEnd[r] + offset };
  }
}

/** Unified-diff hunk header with 1-based starts, as `diff -u` prints it. */
export function formatHunkHeader(header: HunkHeader): string {
  const side = (start: number, count: number) => `${count === 0 ? start : start + 1}${count === 1 ? "" : `,${count}`}`;
  return `@@ -${side(header.aStart, header.aCount)} +${side(header.bStart, header.bCount)} @@`;
}

/**
 * Sequential line reader over a file. `seek` jumps through the nearest checkpoint, so a read
 * at line k scans at most FILE_DIFF_CHECKPOINT_LINES - 1 lines; moving forward continues in place.
 */
export class LineCursor {
  private line = 0;
  private position: number;
  private buffer: Uint8Array = new Uint8Array(0);
  private bufferStart = 0;
  private readonly unit: 1 | 2;
  private readonly bigEndian: boolean;
  private readonly index: LineIndex;
  private readonly read: ReadRange;
  private readonly blockBytes: number;

  constructor(index: LineIndex, read: ReadRange, blockBytes = 64 * 1024) {
    this.index = index;
    this.read = read;
    this.blockBytes = blockBytes;
    this.position = index.encoding.bomLength;
    this.unit = index.encoding.kind === "utf-16le" || index.encoding.kind === "utf-16be" ? 2 : 1;
    this.bigEndian = index.encoding.kind === "utf-16be";
  }

  async seek(line: number): Promise<void> {
    const checkpoint = Math.floor(line / FILE_DIFF_CHECKPOINT_LINES);
    if (line < this.line || line - this.line > FILE_DIFF_CHECKPOINT_LINES) {
      this.line = checkpoint * FILE_DIFF_CHECKPOINT_LINES;
      this.position = this.index.checkpoints[checkpoint];
    }
    while (this.line < line) await this.next(0);
  }

  private async ensure(position: number): Promise<boolean> {
    if (position >= this.index.size) return false;
    // In UTF-16 an odd last byte of the block is not a whole unit yet.
    const usable = this.buffer.length - (this.unit === 2 ? this.buffer.length & 1 : 0);
    if (position >= this.bufferStart && position < this.bufferStart + usable) return true;
    const start = this.unit === 2 ? position - ((position - this.index.encoding.bomLength) & 1) : position;
    this.buffer = await this.read(start, Math.min(this.index.size, start + this.blockBytes));
    this.bufferStart = start;
    return this.buffer.length > 0;
  }

  /** Offset of the next LF unit at or after `from` inside the buffer, or -1. */
  private findNewline(from: number): number {
    const local = from - this.bufferStart;
    if (this.unit === 1) {
      const found = this.buffer.indexOf(LF, local);
      return found < 0 ? -1 : this.bufferStart + found;
    }
    for (let index = local; index + 1 < this.buffer.length; index += 2) {
      const value = this.bigEndian ? (this.buffer[index] << 8) | this.buffer[index + 1] : this.buffer[index] | (this.buffer[index + 1] << 8);
      if (value === LF) return this.bufferStart + index;
    }
    return -1;
  }

  /**
   * Bytes of the current line without its LF (a CR before it stays), at most `maxBytes`,
   * then move to the next line. Returns null past the last line.
   */
  async next(maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean } | null> {
    if (this.line >= this.index.lines) return null;
    const parts: Uint8Array[] = [];
    let kept = 0;
    let truncated = false;
    let position = this.position;
    for (;;) {
      if (!(await this.ensure(position))) break;
      const newline = this.findNewline(position);
      const end = newline < 0 ? this.bufferStart + this.buffer.length - (this.unit === 2 ? (this.buffer.length & 1) : 0) : newline;
      const take = Math.min(end - position, maxBytes - kept);
      if (take > 0) {
        parts.push(this.buffer.subarray(position - this.bufferStart, position - this.bufferStart + take));
        kept += take;
      }
      if (end - position > take) truncated = true;
      if (newline >= 0) {
        position = newline + this.unit;
        break;
      }
      if (end <= position) {
        // A trailing odd byte of UTF-16 or the end of the file.
        position = this.index.size;
        break;
      }
      position = end;
    }
    this.position = position;
    this.line++;
    let bytes: Uint8Array;
    if (parts.length === 1) bytes = parts[0].slice();
    else {
      bytes = new Uint8Array(kept);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
    }
    return { bytes, truncated };
  }
}

/** Drop the CR of a CRLF ending from decoded line text. */
export function stripLineEnd(text: string): string {
  return text.endsWith("\r") ? text.slice(0, -1) : text;
}

/** Clip display text without splitting a surrogate pair. */
export function clipLine(text: string, maxChars = FILE_DIFF_PREVIEW_CHARS): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  let end = maxChars;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: `${text.slice(0, end)}…`, truncated: true };
}

export interface BinaryDiffResult {
  identical: boolean;
  /** Start offsets and lengths of the first FILE_DIFF_MAX_RANGES differing ranges. */
  offsets: Float64Array;
  lengths: Float64Array;
  /** Ranges found, including those past the cap. */
  rangeCount: number;
  /** Differing bytes in the common length, plus the extra tail of the longer file. */
  differingBytes: number;
  firstDifference: number;
  sizeA: number;
  sizeB: number;
}

/**
 * Compare two files byte by byte in FILE_DIFF_CHUNK_BYTES blocks and collect differing ranges.
 * The tail of the longer file is reported as one final range.
 */
export async function compareBinary(
  sizeA: number,
  sizeB: number,
  readA: ReadRange,
  readB: ReadRange,
  onProgress?: (processed: number, total: number) => void,
  maxRanges = FILE_DIFF_MAX_RANGES,
): Promise<BinaryDiffResult> {
  const common = Math.min(sizeA, sizeB);
  let offsets = new Float64Array(Math.min(maxRanges, 1024));
  let lengths = new Float64Array(offsets.length);
  let kept = 0;
  let rangeCount = 0;
  let differingBytes = 0;
  let firstDifference = -1;
  let openStart = -1;
  const close = (end: number) => {
    if (openStart < 0) return;
    rangeCount++;
    if (kept < maxRanges) {
      if (kept === offsets.length) {
        const capacity = Math.min(maxRanges, offsets.length * 2);
        const nextOffsets = new Float64Array(capacity);
        nextOffsets.set(offsets);
        offsets = nextOffsets;
        const nextLengths = new Float64Array(capacity);
        nextLengths.set(lengths);
        lengths = nextLengths;
      }
      offsets[kept] = openStart;
      lengths[kept] = end - openStart;
      kept++;
    }
    openStart = -1;
  };

  for (let start = 0; start < common; start += FILE_DIFF_CHUNK_BYTES) {
    const end = Math.min(common, start + FILE_DIFF_CHUNK_BYTES);
    const [left, right] = await Promise.all([readA(start, end), readB(start, end)]);
    const length = end - start;
    const words = left.byteOffset % 4 === 0 && right.byteOffset % 4 === 0 ? length >>> 2 : 0;
    const leftWords = new Int32Array(left.buffer, left.byteOffset, words);
    const rightWords = new Int32Array(right.buffer, right.byteOffset, words);
    let index = 0;
    for (let word = 0; word < words; word++) {
      if (openStart < 0 && leftWords[word] === rightWords[word]) continue;
      for (index = word * 4; index < word * 4 + 4; index++) {
        if (left[index] !== right[index]) {
          differingBytes++;
          if (openStart < 0) {
            openStart = start + index;
            if (firstDifference < 0) firstDifference = openStart;
          }
        } else close(start + index);
      }
    }
    for (index = words * 4; index < length; index++) {
      if (left[index] !== right[index]) {
        differingBytes++;
        if (openStart < 0) {
          openStart = start + index;
          if (firstDifference < 0) firstDifference = openStart;
        }
      } else close(start + index);
    }
    onProgress?.(end, Math.max(common, 1));
  }
  close(common);
  if (sizeA !== sizeB) {
    openStart = common;
    if (firstDifference < 0) firstDifference = common;
    differingBytes += Math.max(sizeA, sizeB) - common;
    close(Math.max(sizeA, sizeB));
  }
  onProgress?.(common, Math.max(common, 1));
  return {
    identical: rangeCount === 0,
    offsets: offsets.subarray(0, kept),
    lengths: lengths.subarray(0, kept),
    rangeCount,
    differingBytes,
    firstDifference,
    sizeA,
    sizeB,
  };
}

/** Lowercase hex with a space between bytes. */
export function hexPreview(bytes: Uint8Array): string {
  let text = "";
  for (let index = 0; index < bytes.length; index++) {
    if (index > 0) text += " ";
    text += bytes[index].toString(16).padStart(2, "0");
  }
  return text;
}

/** Offset as 0x-prefixed hex, padded to at least 8 digits. */
export function formatHexOffset(offset: number): string {
  return `0x${offset.toString(16).padStart(8, "0")}`;
}
