/**
 * Pure helpers shared by the PDF tools (pdf-compressor, pdf-merger,
 * pdf-to-text): PDF file acceptance, output file names, savings %, list
 * reordering, and mapping pdf-WASM error messages to localized error kinds
 * (encrypted / invalid-or-corrupted PDF). No DOM access — unit-tested in
 * `test/pdf-files.test.ts`.
 */

/** Accept by MIME type or `.pdf` extension (legacy acceptance filter). */
export function isPdfFile(file: { name: string; type: string }): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

/** Legacy compressor download name: `compressed_<original name>`. */
export function compressedFileName(name: string): string {
  return `compressed_${name}`;
}

/** Legacy pdf-to-text download name: source name minus `.pdf` + `.txt`. */
export function textFileName(name: string): string {
  return `${name.replace(/\.pdf$/i, "")}.txt`;
}

/**
 * Rounded savings percentage (legacy parity: may be negative when the output
 * is larger). 0 for an empty original to avoid NaN/Infinity.
 */
export function savingsPercent(originalSize: number, newSize: number): number {
  if (!(originalSize > 0)) return 0;
  return Math.round((1 - newSize / originalSize) * 100);
}

/** Copy of `items` with the element at `from` moved to `to` (clamped; no-op if out of range). */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const out = items.slice();
  if (from < 0 || from >= out.length) return out;
  const target = Math.max(0, Math.min(out.length - 1, to));
  const [item] = out.splice(from, 1);
  out.splice(target, 0, item as T);
  return out;
}

export type PdfErrorKind = "encrypted" | "invalid" | "other";

export interface PdfError {
  kind: PdfErrorKind;
  /** 0-based input index for merge errors (`PDF <i>: …`), if present. */
  index: number | null;
}

/**
 * Classify a pdf-WASM error message. The crate emits
 * `PDF is encrypted (password protected)` for locked files,
 * `Failed to load PDF: …` for unparsable/corrupted input, and prefixes
 * merge errors with the input index (`PDF 2: …`).
 */
export function classifyPdfError(message: string): PdfError {
  const indexMatch = /^PDF (\d+): /.exec(message);
  const index = indexMatch ? Number(indexMatch[1]) : null;
  if (/encrypted/i.test(message)) return { kind: "encrypted", index };
  if (/Failed to load PDF/i.test(message)) return { kind: "invalid", index };
  return { kind: "other", index };
}

/**
 * Page count of pdf-to-text output: the pdf crate joins pages with one blank
 * line ("\n\n") and never emits a blank line inside a page, so an empty
 * (scanned) page still counts. Used for the "N pages" result summary.
 */
export function countExtractedPages(text: string): number {
  return text.split("\n\n").length;
}

/**
 * Preview slice for the pdf-to-text result textarea: at most `limit` UTF-16
 * units, never cutting a surrogate pair; `truncated` when text was dropped.
 */
export function previewText(text: string, limit = 2000): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  let end = limit;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return { text: text.slice(0, end), truncated: true };
}
