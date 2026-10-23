/**
 * Batch Image Processor pure helpers (DOM-free; unit-tested in
 * test/image-batch.test.ts): output format per file ("keep original"),
 * unique ZIP entry names, max width/height parsing, the "keep the original
 * when the result is not smaller" rule, batch totals with throughput
 * (MB/s, megapixels/s) and the CSV report, plus the worker pool size.
 */
import { savingsPercent } from "./image-tools.ts";

/** Output formats offered by the batch tool ("original" keeps each file's own). */
export const BATCH_FORMATS = ["original", "jpeg", "png", "webp", "gif", "bmp", "tiff"] as const;
export type BatchFormat = (typeof BATCH_FORMATS)[number];

/** Same per-side limit as the WASM resizer (`MAX_DIMENSION`). */
export const BATCH_MAX_SIDE = 16_384;

const MIME_FORMATS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/x-ms-bmp": "bmp",
  "image/tiff": "tiff",
};

/**
 * Encoder format for one file: an explicit choice passes through; "original"
 * keeps JPEG/PNG/WebP/GIF/BMP/TIFF and turns anything else (ICO, TGA) into PNG.
 */
export function resolveBatchFormat(selected: string, file: { type: string; name: string }): string {
  if (selected !== "original") return selected;
  const byMime = MIME_FORMATS[file.type.toLowerCase()];
  if (byMime) return byMime;
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "jpeg";
  if (ext === "tif" || ext === "tiff") return "tiff";
  return ["png", "webp", "gif", "bmp"].includes(ext) ? ext : "png";
}

/** True when the file is already stored in `format` (so keeping it changes nothing). */
export function isSameFormat(file: { type: string; name: string }, format: string): boolean {
  return resolveBatchFormat("original", file) === format;
}

/**
 * ZIP/download name `<base>.<ext>` (jpeg → jpg), made unique within the batch
 * case-insensitively: `photo.jpg`, `photo (2).jpg`, … `used` is updated.
 */
export function batchOutputName(fileName: string, format: string, used: Set<string>): string {
  const dot = fileName.lastIndexOf(".");
  const base = (dot > 0 ? fileName.slice(0, dot) : fileName) || "image";
  const ext = format === "jpeg" ? "jpg" : format;
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${base}.${ext}` : `${base} (${n}).${ext}`;
    const key = name.toLowerCase();
    if (!used.has(key)) {
      used.add(key);
      return name;
    }
  }
}

/** Max width/height field: empty → 0 (no limit), 1…16384 → n, anything else → null. */
export function parseMaxSide(text: string): number | null {
  const value = text.trim();
  if (value === "") return 0;
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 && n <= BATCH_MAX_SIDE ? n : null;
}

/**
 * Keep the source bytes instead of the result: only when asked, the result
 * is not smaller, and nothing else was requested for this file (same format,
 * same pixel size) — a resize or conversion is always delivered.
 */
export function keepsOriginal(o: {
  keepIfLarger: boolean;
  inputBytes: number;
  outputBytes: number;
  sameFormat: boolean;
  resized: boolean;
}): boolean {
  return o.keepIfLarger && o.sameFormat && !o.resized && o.outputBytes >= o.inputBytes;
}

export type BatchStatus = "waiting" | "working" | "done" | "kept" | "failed" | "canceled";

/** One file of the batch report. Sizes in bytes, time in ms (worker job, incl. decode/encode). */
export interface BatchRow {
  name: string;
  inputBytes: number;
  outputName: string;
  outputBytes: number;
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
  ms: number;
  status: BatchStatus;
  error?: string;
}

export interface BatchSummary {
  processed: number;
  kept: number;
  failed: number;
  inputBytes: number;
  outputBytes: number;
  savedPercent: number;
  wallMs: number;
  /** Input bytes per wall-clock second. */
  bytesPerSecond: number;
  /** Source megapixels decoded per wall-clock second. */
  megapixelsPerSecond: number;
}

/** Totals over finished rows (done + kept); failed/canceled rows only count as failed. */
export function summarize(rows: readonly BatchRow[], wallMs: number): BatchSummary {
  const finished = rows.filter((r) => r.status === "done" || r.status === "kept");
  const inputBytes = finished.reduce((s, r) => s + r.inputBytes, 0);
  const outputBytes = finished.reduce((s, r) => s + r.outputBytes, 0);
  const pixels = finished.reduce((s, r) => s + r.sourceWidth * r.sourceHeight, 0);
  const seconds = wallMs / 1000;
  return {
    processed: finished.length,
    kept: rows.filter((r) => r.status === "kept").length,
    failed: rows.filter((r) => r.status === "failed").length,
    inputBytes,
    outputBytes,
    savedPercent: savingsPercent(inputBytes, outputBytes),
    wallMs,
    bytesPerSecond: seconds > 0 ? inputBytes / seconds : 0,
    megapixelsPerSecond: seconds > 0 ? pixels / 1e6 / seconds : 0,
  };
}

function csvCell(value: string | number): string {
  const s = String(value);
  // Quote separators/quotes/newlines; neutralize spreadsheet formulas in file names.
  const safe = /^[=+\-@\t\r]/.test(s) && typeof value === "string" ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Report as CSV with raw numbers (bytes, pixels, milliseconds). */
export function reportCsv(rows: readonly BatchRow[]): string {
  const header = "file,status,input_bytes,output_file,output_bytes,saved_percent,source_width,source_height,width,height,ms,error";
  const lines = rows.map((r) => {
    const finished = r.status === "done" || r.status === "kept";
    return [
      csvCell(r.name),
      r.status,
      r.inputBytes,
      finished ? csvCell(r.outputName) : "",
      finished ? r.outputBytes : "",
      finished ? savingsPercent(r.inputBytes, r.outputBytes) : "",
      r.sourceWidth || "",
      r.sourceHeight || "",
      finished ? r.width : "",
      finished ? r.height : "",
      r.ms ? r.ms.toFixed(0) : "",
      csvCell(r.error ?? ""),
    ].join(",");
  });
  return `${[header, ...lines].join("\n")}\n`;
}

/**
 * Parallel workers for this device: half the logical cores, 1–3. Each worker
 * holds a decoded image (≈4 bytes/pixel plus the resized copy), so devices
 * reporting ≤ 4 GB of memory get a single worker.
 */
export function batchPoolSize(cores: number | undefined, memoryGb: number | undefined): number {
  if (memoryGb !== undefined && memoryGb <= 4) return 1;
  const half = Math.floor((cores ?? 2) / 2);
  return Math.min(3, Math.max(1, half));
}
