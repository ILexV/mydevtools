/**
 * Local hex viewer: 16-byte rows, offset parsing, signature search and
 * sampled Shannon entropy. The page reads visible rows with File.slice;
 * search and entropy call these helpers from a worker. Nothing here touches
 * the network or localStorage.
 */
import { detectFileType, isLikelyText } from "./base64.ts";

/** Classic hex-dump width. A 1 GiB file is this many virtual rows, not DOM nodes. */
export const HEX_BYTES_PER_ROW = 16;
/** Same probe length as the base64 text-vs-binary check. */
export const HEX_PROBE_BYTES = 512;
/** Cap so a pasted blob cannot become a multi-megabyte search needle. */
export const HEX_MAX_NEEDLE_BYTES = 256;
/** Stop after this many hits so the match list stays usable on repetitive data. */
export const HEX_MAX_MATCHES = 200;
/** Search reads the file in these slices and overlaps the needle so a hit can cross a boundary. */
export const HEX_SEARCH_CHUNK_BYTES = 1024 * 1024;
/** Inclusive export range. The download is a Blob slice, not a second copy of the whole file. */
export const HEX_EXPORT_MAX_BYTES = 256 * 1024 * 1024;
/** Entropy block. Files up to 256 of these are measured in full; larger files are sampled. */
export const HEX_ENTROPY_BLOCK_BYTES = 4096;
export const HEX_ENTROPY_MAX_BLOCKS = 256;

export type HexViewerErrorCode =
  | "empty"
  | "invalid-offset"
  | "invalid-needle"
  | "needle-too-long"
  | "range-invalid"
  | "range-too-large";

/** Domain error. `message` is the stable code the page maps to locale text. */
export class HexViewerError extends Error {
  readonly code: HexViewerErrorCode;

  constructor(code: HexViewerErrorCode) {
    super(code);
    this.name = "HexViewerError";
    this.code = code;
  }
}

export type ProbeKind = "image" | "binary" | "text" | "unknown";

export interface ProbeSummary {
  kind: ProbeKind;
  /** Language-neutral name from magic bytes, such as PNG. Null for text and unknown bytes. */
  label: string | null;
  mime: string;
  ext: string;
}

export interface ByteRange {
  start: number;
  end: number;
}

export interface EntropyBlock {
  start: number;
  length: number;
}

export interface EntropySample extends EntropyBlock {
  /** Shannon entropy in bits per byte, from 0 (one symbol) to 8 (uniform). */
  entropy: number;
}

export interface HexSearchHit {
  offsets: number[];
  /** True when more hits may exist beyond the match cap or the scanned prefix. */
  capped: boolean;
}

type ByteRead = (start: number, end: number) => Uint8Array | Promise<Uint8Array>;

/** Virtual row count for a file. Zero bytes is an empty file, not one blank row. */
export function hexRowCount(fileSize: number): number {
  if (fileSize <= 0) return 0;
  return Math.ceil(fileSize / HEX_BYTES_PER_ROW);
}

/** Hex digits needed to label the last byte, at least 8 so short files still align. */
export function offsetWidth(fileSize: number): number {
  if (fileSize <= 1) return 8;
  return Math.max(8, (fileSize - 1).toString(16).length);
}

/** Lowercase hex offset without a prefix, padded for the dump column. */
export function formatOffsetHex(offset: number, width: number): string {
  return offset.toString(16).padStart(width, "0");
}

/** `0x` offset for jump status and the match list. */
export function formatOffset(offset: number, width: number): string {
  return `0x${formatOffsetHex(offset, width)}`;
}

/**
 * Identify a file from its leading bytes. Magic bytes win (PNG, PDF, ZIP, …);
 * otherwise a UTF-8 probe marks text, and everything else stays unknown binary.
 */
export function describeProbe(bytes: Uint8Array): ProbeSummary {
  const detected = detectFileType(bytes);
  if (detected) return { kind: detected.kind, label: detected.label, mime: detected.mime, ext: detected.ext };
  if (isLikelyText(bytes)) return { kind: "text", label: null, mime: "text/plain", ext: "txt" };
  return { kind: "unknown", label: null, mime: "application/octet-stream", ext: "bin" };
}

/**
 * Parse a dump offset. Decimal or `0x` hex. The offset must address a byte
 * that exists (`0` .. `fileSize - 1`). Values past the safe integer range are rejected.
 */
export function parseOffset(input: string, fileSize: number): number {
  const text = input.trim();
  if (!text || fileSize <= 0) throw new HexViewerError("invalid-offset");
  const match = /^(?:0x([0-9a-f]+)|([0-9]+))$/iu.exec(text);
  if (!match) throw new HexViewerError("invalid-offset");
  let value: bigint;
  try {
    value = match[1] !== undefined ? BigInt(`0x${match[1]}`) : BigInt(match[2]);
  } catch {
    throw new HexViewerError("invalid-offset");
  }
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER) || value >= BigInt(fileSize)) {
    throw new HexViewerError("invalid-offset");
  }
  return Number(value);
}

/**
 * Parse a search needle. Text is UTF-8. Hex allows spaces, colons, dashes
 * and one leading `0x`, and must be an even number of digits. Empty and
 * over-long needles are rejected before the file is scanned.
 */
export function parseNeedle(input: string, mode: "text" | "hex"): Uint8Array {
  if (mode === "text") {
    const bytes = new TextEncoder().encode(input);
    if (bytes.length === 0) throw new HexViewerError("invalid-needle");
    if (bytes.length > HEX_MAX_NEEDLE_BYTES) throw new HexViewerError("needle-too-long");
    return bytes;
  }
  const compact = input.trim().replace(/^0x/iu, "").replace(/[\s:_-]/gu, "");
  if (!compact || compact.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(compact)) {
    throw new HexViewerError("invalid-needle");
  }
  if (compact.length / 2 > HEX_MAX_NEEDLE_BYTES) throw new HexViewerError("needle-too-long");
  const out = new Uint8Array(compact.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(compact.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Inclusive byte range for export. `end` must be a real byte, the range must
 * run forward, and the slice must stay within the export cap.
 */
export function parseExportRange(startText: string, endText: string, fileSize: number): ByteRange {
  const start = parseOffset(startText, fileSize);
  const end = parseOffset(endText, fileSize);
  if (end < start) throw new HexViewerError("range-invalid");
  if (end - start + 1 > HEX_EXPORT_MAX_BYTES) throw new HexViewerError("range-too-large");
  return { start, end };
}

/** One dump row of hex, grouped 8 + 8. Missing tail bytes stay spaces so the gap lines up. */
export function formatHexBytes(row: Uint8Array): string {
  const cells: string[] = [];
  for (let i = 0; i < HEX_BYTES_PER_ROW; i++) {
    cells.push(i < row.length ? row[i].toString(16).padStart(2, "0") : "  ");
  }
  return `${cells.slice(0, 8).join(" ")}  ${cells.slice(8).join(" ")}`;
}

/** ASCII column: printable 0x20–0x7e, a dot for everything else including NUL and DEL. */
export function formatAscii(row: Uint8Array): string {
  let out = "";
  for (let i = 0; i < row.length; i++) {
    const byte = row[i];
    out += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".";
  }
  return out;
}

/**
 * UTF-8 column for a single row. A sequence that starts or ends outside the
 * row, or that is invalid, becomes one dot per byte so split characters are visible.
 */
export function formatUtf8(row: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < row.length) {
    const needed = utf8SequenceLength(row[i]);
    if (needed >= 2 && i + needed <= row.length && validUtf8Sequence(row, i, needed)) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(row.subarray(i, i + needed));
      const codePoint = text.codePointAt(0) ?? 0;
      const printable = codePoint >= 0x20 && codePoint !== 0x7f && (codePoint < 0x80 || codePoint > 0x9f);
      out += printable ? text : ".";
      i += needed;
      continue;
    }
    if (needed === 1) {
      const byte = row[i];
      out += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".";
      i++;
      continue;
    }
    out += ".";
    i++;
  }
  return out;
}

/** Rows for one table window: offset, hex, ASCII, UTF-8. `firstRow` is the virtual row index. */
export function formatHexRows(bytes: Uint8Array, firstRow: number, fileSize: number): string[][] {
  const width = offsetWidth(fileSize);
  const rows: string[][] = [];
  const count = Math.ceil(bytes.length / HEX_BYTES_PER_ROW);
  for (let row = 0; row < count; row++) {
    const slice = bytes.subarray(row * HEX_BYTES_PER_ROW, (row + 1) * HEX_BYTES_PER_ROW);
    const offset = (firstRow + row) * HEX_BYTES_PER_ROW;
    rows.push([formatOffsetHex(offset, width), formatHexBytes(slice), formatAscii(slice), formatUtf8(slice)]);
  }
  return rows;
}

/**
 * Find needle occurrences without loading the file. `read(start, end)` returns
 * that half-open slice. Chunks overlap by needle length − 1 so a match may
 * cross a boundary, and hits from the overlap are not reported twice.
 * Scanning stops once the match cap is reached.
 */
export async function searchBytes(
  fileSize: number,
  needle: Uint8Array,
  read: ByteRead,
  options?: {
    chunkBytes?: number;
    maxMatches?: number;
    onProgress?: (processed: number, total: number) => void;
  },
): Promise<HexSearchHit> {
  if (needle.length === 0) throw new HexViewerError("invalid-needle");
  if (needle.length > HEX_MAX_NEEDLE_BYTES) throw new HexViewerError("needle-too-long");
  const maxMatches = options?.maxMatches ?? HEX_MAX_MATCHES;
  const chunkBytes = Math.max(needle.length, options?.chunkBytes ?? HEX_SEARCH_CHUNK_BYTES);
  const report = options?.onProgress;
  if (fileSize < needle.length || maxMatches <= 0) {
    report?.(fileSize, Math.max(fileSize, 1));
    return { offsets: [], capped: false };
  }

  const overlap = needle.length - 1;
  const offsets: number[] = [];
  let carry = new Uint8Array(0);
  let start = 0;
  while (start < fileSize && offsets.length < maxMatches) {
    const requestedEnd = Math.min(fileSize, start + chunkBytes);
    const chunk = await read(start, requestedEnd);
    if (chunk.length === 0) break;
    const actualEnd = Math.min(fileSize, start + chunk.length);
    const window = carry.length === 0 ? chunk : concatBytes(carry, chunk);
    const base = start - carry.length;
    let extra = false;
    scanNeedle(window, needle, (index) => {
      const fileOffset = base + index;
      // A hit that ends before this chunk already fit in the previous window.
      // The overlap is one byte short of the needle, so those hits are not seen again.
      if (fileOffset + needle.length <= start || fileOffset > fileSize - needle.length) return true;
      if (offsets.length >= maxMatches) {
        extra = true;
        return false;
      }
      offsets.push(fileOffset);
      return true;
    });
    carry = overlap === 0 || window.length === 0
      ? new Uint8Array(0)
      : Uint8Array.from(window.subarray(Math.max(0, window.length - overlap)));
    start = actualEnd;
    report?.(start, fileSize);
    if (extra || (offsets.length >= maxMatches && start < fileSize)) {
      return { offsets, capped: true };
    }
  }
  report?.(fileSize, Math.max(fileSize, 1));
  return { offsets, capped: false };
}

/** True when the file is larger than every 4 KiB block we are willing to hash. */
export function entropyIsSampled(fileSize: number): boolean {
  if (fileSize <= 0) return false;
  return Math.ceil(fileSize / HEX_ENTROPY_BLOCK_BYTES) > HEX_ENTROPY_MAX_BLOCKS;
}

/**
 * Block plan for the entropy chart. Small files are covered completely.
 * Larger files get at most 256 evenly spaced 4 KiB blocks, including the tail.
 */
export function entropyBlocks(fileSize: number): EntropyBlock[] {
  if (fileSize <= 0) return [];
  if (fileSize <= HEX_ENTROPY_BLOCK_BYTES) return [{ start: 0, length: fileSize }];
  const full = Math.ceil(fileSize / HEX_ENTROPY_BLOCK_BYTES);
  if (full <= HEX_ENTROPY_MAX_BLOCKS) {
    const blocks: EntropyBlock[] = [];
    for (let i = 0; i < full; i++) {
      const start = i * HEX_ENTROPY_BLOCK_BYTES;
      blocks.push({ start, length: Math.min(HEX_ENTROPY_BLOCK_BYTES, fileSize - start) });
    }
    return blocks;
  }
  const blocks: EntropyBlock[] = [];
  const span = fileSize - HEX_ENTROPY_BLOCK_BYTES;
  for (let i = 0; i < HEX_ENTROPY_MAX_BLOCKS; i++) {
    const start = Math.floor((i * span) / (HEX_ENTROPY_MAX_BLOCKS - 1));
    blocks.push({ start, length: HEX_ENTROPY_BLOCK_BYTES });
  }
  return blocks;
}

/** Shannon entropy in bits/byte. An empty slice is 0, not NaN. */
export function shannonEntropy(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  const counts = new Uint32Array(256);
  for (let i = 0; i < bytes.length; i++) counts[bytes[i]]++;
  let entropy = 0;
  const total = bytes.length;
  for (let i = 0; i < 256; i++) {
    if (counts[i] === 0) continue;
    const p = counts[i] / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Read the entropy plan and return a length-weighted average of the samples. */
export async function scanEntropy(
  fileSize: number,
  read: ByteRead,
  onProgress?: (processed: number, total: number) => void,
): Promise<{ samples: EntropySample[]; average: number; sampled: boolean }> {
  const blocks = entropyBlocks(fileSize);
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const samples: EntropySample[] = [];
  let weighted = 0;
  let weight = 0;
  let processed = 0;
  for (const block of blocks) {
    const bytes = await read(block.start, block.start + block.length);
    const entropy = shannonEntropy(bytes);
    const length = bytes.length;
    samples.push({ start: block.start, length, entropy });
    weighted += entropy * length;
    weight += length;
    processed += length;
    onProgress?.(processed, Math.max(total, 1));
  }
  return {
    samples,
    average: weight > 0 ? weighted / weight : 0,
    sampled: entropyIsSampled(fileSize),
  };
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

/**
 * Horspool scan. `onMatch` receives a haystack index and returns false to stop.
 * Overlapping hits are reported (the window advances by one after a match).
 */
function scanNeedle(haystack: Uint8Array, needle: Uint8Array, onMatch: (index: number) => boolean): void {
  const needleLength = needle.length;
  const haystackLength = haystack.length;
  if (needleLength === 0 || haystackLength < needleLength) return;
  if (needleLength === 1) {
    const byte = needle[0];
    for (let i = 0; i < haystackLength; i++) {
      if (haystack[i] === byte && !onMatch(i)) return;
    }
    return;
  }
  const skip = new Uint16Array(256);
  skip.fill(needleLength);
  for (let i = 0; i < needleLength - 1; i++) skip[needle[i]] = needleLength - 1 - i;
  const last = needleLength - 1;
  let i = 0;
  while (i <= haystackLength - needleLength) {
    let j = last;
    while (j >= 0 && haystack[i + j] === needle[j]) j--;
    if (j < 0) {
      if (!onMatch(i)) return;
      i += 1;
    } else {
      i += skip[haystack[i + last]];
    }
  }
}

function utf8SequenceLength(lead: number): number {
  if (lead <= 0x7f) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

function validUtf8Sequence(row: Uint8Array, start: number, needed: number): boolean {
  for (let j = 1; j < needed; j++) {
    const byte = row[start + j];
    if (byte < 0x80 || byte > 0xbf) return false;
  }
  const lead = row[start];
  const next = row[start + 1];
  if (needed === 3) {
    if (lead === 0xe0 && next < 0xa0) return false;
    if (lead === 0xed && next >= 0xa0) return false;
  }
  if (needed === 4) {
    if (lead === 0xf0 && next < 0x90) return false;
    if (lead === 0xf4 && next >= 0x90) return false;
  }
  return true;
}
