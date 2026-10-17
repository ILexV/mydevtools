/**
 * Local Parquet explorer helpers: schema labels, cell text, and CSV/JSONL lines.
 *
 * Values stay text the table and the export can share. INT64 and other bigints
 * keep their decimal spelling so identifiers above 2^53 are not rounded.
 * Nested structs and lists become JSON. Binary cells become lowercase hex.
 * Spreadsheet formula protection for CSV lives in `encodeCsvRow`.
 */
import { encodeCsvRow } from "./explorer-delimited.ts";

/** Top-level columns shown and exported. Wider files are rejected up front. */
export const PARQUET_MAX_COLUMNS = 512;
/** One interactive table request. The viewport asks for far fewer rows. */
export const PARQUET_MAX_READ_ROWS = 500;
/** Rows decoded per export step so a full scan does not materialize the file. */
export const PARQUET_EXPORT_WINDOW = 2048;
/** Maximum retained by the non-streaming export and browser download fallback. */
export const PARQUET_MAX_EXPORT_BYTES = 512 * 1024 * 1024;
/** A single exported value, in characters or raw bytes, before encoding. */
export const PARQUET_MAX_CELL_CHARS = 1024 * 1024;
/** Clipped table cell. The inspector and the export use higher limits. */
export const PARQUET_PREVIEW_CHARS = 512;
/** Selected-row inspector. Longer values stay in the export. */
export const PARQUET_INSPECT_CHARS = 64 * 1024;
/** Footer key/value pairs copied into the summary. */
export const PARQUET_MAX_METADATA_PAIRS = 12;
/** Row groups returned to the page. The summary count still covers the file. */
export const PARQUET_MAX_LISTED_ROW_GROUPS = 500;

export type ParquetExplorerErrorCode =
  | "empty"
  | "invalid"
  | "too-many-columns"
  | "export-too-large"
  | "cell-too-large"
  | "unsupported-codec"
  | "session-missing";

/** Failure the page can map to a localized sentence. `code` is the stable id. */
export class ParquetExplorerError extends Error {
  readonly code: ParquetExplorerErrorCode;

  constructor(code: ParquetExplorerErrorCode, message: string) {
    super(message);
    this.name = "ParquetExplorerError";
    this.code = code;
  }
}

export interface ParquetFieldType {
  physical?: string;
  /** Logical type or legacy converted type, for example UTF8 or DECIMAL. */
  logical?: string;
  precision?: number;
  scale?: number;
  bitWidth?: number;
  signed?: boolean;
}

export interface ClippedText {
  text: string;
  truncated: boolean;
}

/** Human label for a Parquet physical type plus its logical or converted type. */
export function parquetTypeLabel(field: ParquetFieldType): string {
  const physical = field.physical ?? "group";
  if (field.logical === "DECIMAL" && field.precision !== undefined) {
    return `DECIMAL(${field.precision},${field.scale ?? 0})`;
  }
  if (field.logical === "INTEGER" && field.bitWidth !== undefined) {
    return `${field.signed === false ? "UINT" : "INT"}${field.bitWidth}`;
  }
  if (field.logical === "UTF8" || field.logical === "STRING") return "STRING";
  if (field.logical === "TIMESTAMP" || field.logical?.startsWith("TIMESTAMP_")) return field.logical;
  if (!field.logical || field.logical === physical) return physical;
  return `${physical} ${field.logical}`;
}

/**
 * Make column labels unique for the table and for JSONL keys.
 * Blank names become `Column N`. Duplicate names gain a numeric suffix.
 */
export function uniqueColumnLabels(names: readonly string[]): { labels: string[]; duplicateCount: number } {
  const labels: string[] = [];
  const uses = new Map<string, number>();
  let duplicateCount = 0;
  for (let index = 0; index < names.length; index++) {
    const raw = names[index]?.trim() ?? "";
    const base = raw.length === 0 ? `Column ${index + 1}` : raw;
    const occurrence = (uses.get(base) ?? 0) + 1;
    uses.set(base, occurrence);
    if (occurrence > 1) duplicateCount++;
    let label = occurrence === 1 ? base : `${base} (${occurrence})`;
    let suffix = occurrence;
    while (labels.includes(label)) {
      suffix++;
      label = `${base} (${suffix})`;
    }
    labels.push(label);
  }
  return { labels, duplicateCount };
}

function byteView(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function hexBytes(bytes: Uint8Array, maxChars: number): ClippedText {
  const take = Math.min(bytes.byteLength, Math.floor(maxChars / 2));
  let text = "";
  for (let index = 0; index < take; index++) text += bytes[index].toString(16).padStart(2, "0");
  const truncated = bytes.byteLength * 2 > maxChars;
  return { text: truncated ? `${text}…` : text, truncated };
}

function clip(text: string, maxChars: number): ClippedText {
  if (text.length <= maxChars) return { text, truncated: false };
  let end = maxChars;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: `${text.slice(0, Math.max(0, end))}…`, truncated: true };
}

function nestedJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") return item.toString();
    if (item instanceof Date) return Number.isNaN(item.getTime()) ? null : item.toISOString();
    const bytes = byteView(item);
    if (bytes) return hexBytes(bytes, PARQUET_MAX_CELL_CHARS).text;
    return item;
  }) ?? "";
}

/**
 * Text for one Parquet value. `maxChars` clips the table and the inspector.
 * Pass `PARQUET_MAX_CELL_CHARS` when a clipped export must be rejected instead.
 */
export function formatParquetCell(value: unknown, maxChars = PARQUET_PREVIEW_CHARS): ClippedText {
  if (value == null) return { text: "", truncated: false };
  if (typeof value === "string") return clip(value, maxChars);
  if (typeof value === "boolean") return { text: value ? "true" : "false", truncated: false };
  if (typeof value === "bigint") return clip(value.toString(), maxChars);
  if (typeof value === "number") return { text: Object.is(value, -0) ? "-0" : String(value), truncated: false };
  if (value instanceof Date) {
    return { text: Number.isNaN(value.getTime()) ? "" : value.toISOString(), truncated: false };
  }
  const bytes = byteView(value);
  if (bytes) return hexBytes(bytes, maxChars);
  return clip(nestedJson(value), maxChars);
}

/** JSONL value. Bigint and binary become strings so the line stays valid JSON. */
export function parquetJsonValue(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const bytes = byteView(value);
  if (bytes) {
    if (bytes.byteLength > PARQUET_MAX_CELL_CHARS) {
      throw new ParquetExplorerError("cell-too-large", "A binary value exceeds the cell limit");
    }
    return hexBytes(bytes, Number.MAX_SAFE_INTEGER).text;
  }
  if (Array.isArray(value)) return value.map((item) => parquetJsonValue(item));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = parquetJsonValue(item);
    return out;
  }
  return String(value);
}

/** Reject a value that cannot be exported without buffering a huge cell. */
export function assertExportableValue(value: unknown): void {
  const seen = new Set<object>();
  const visit = (item: unknown): void => {
    if (item == null || typeof item === "number" || typeof item === "boolean") return;
    if (typeof item === "string" || typeof item === "bigint") {
      if (String(item).length > PARQUET_MAX_CELL_CHARS) {
        throw new ParquetExplorerError("cell-too-large", "A value exceeds the 1 MiB cell limit");
      }
      return;
    }
    if (item instanceof Date) return;
    const bytes = byteView(item);
    if (bytes) {
      if (bytes.byteLength > PARQUET_MAX_CELL_CHARS) {
        throw new ParquetExplorerError("cell-too-large", "A binary value exceeds the 1 MiB cell limit");
      }
      return;
    }
    if (typeof item !== "object") return;
    if (seen.has(item)) return;
    seen.add(item);
    if (Array.isArray(item)) {
      for (const entry of item) visit(entry);
      return;
    }
    for (const entry of Object.values(item)) visit(entry);
  };
  visit(value);
}

const textEncoder = new TextEncoder();

/** UTF-8 size of an export line, used to stop at the download cap. */
export function utf8ByteLength(text: string): number {
  return textEncoder.encode(text).byteLength;
}

/** One CSV record plus the newline the caller writes between records. */
export function buildCsvLine(values: readonly string[], protectFormulas: boolean): string {
  return `${encodeCsvRow(values, protectFormulas)}\n`;
}

/** One JSON object per line, keyed by the unique column labels. */
export function buildJsonlLine(labels: readonly string[], values: readonly unknown[]): string {
  const row: Record<string, unknown> = {};
  for (let index = 0; index < labels.length; index++) row[labels[index]] = parquetJsonValue(values[index]);
  return `${JSON.stringify(row)}\n`;
}

/** PAR1 magic at both ends of a Parquet file. */
export function hasParquetMagic(head: Uint8Array, tail: Uint8Array): boolean {
  const mark = [0x50, 0x41, 0x52, 0x31];
  if (head.length < 4 || tail.length < 4) return false;
  return mark.every((byte, index) => head[index] === byte && tail[index] === byte);
}
