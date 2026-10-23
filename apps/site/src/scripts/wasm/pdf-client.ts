/**
 * PDF WASM client (main thread side). Compress / merge / extract-text run on
 * whole file buffers in a dedicated Web Worker (`pdf.worker`) so large PDFs
 * don't freeze the page. Every call takes an optional AbortSignal: aborting
 * terminates the worker mid-file and rejects with `WasmError("aborted")`.
 * Errors are normalized into typed `WasmError`.
 *
 * Network: the worker + wasm load only on first use (PDF tool pages only).
 */
import { createJobWorker, transferableCopy } from "@/scripts/wasm/job-worker";
import type { PdfWorkerRequest } from "@/scripts/wasm/pdf-protocol";

type Req = PdfWorkerRequest extends infer R ? (R extends unknown ? Omit<R, "id"> : never) : never;

const jobs = createJobWorker<Req, { output?: ArrayBuffer; text?: string; outputs?: ArrayBuffer[] }>(
  () => new Worker(new URL("../../workers/pdf.worker.ts", import.meta.url), { type: "module" }),
);

/** Compress a PDF (lossless stream optimization) → compressed bytes. */
export async function compressPdf(data: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
  const input = transferableCopy(data);
  const res = await jobs.run({ op: "compress", input }, [input], signal);
  return new Uint8Array(res.output!);
}

/** Merge multiple PDFs in order → merged PDF bytes. */
export async function mergePdfs(files: Uint8Array[], signal?: AbortSignal): Promise<Uint8Array> {
  const inputs = files.map(transferableCopy);
  const res = await jobs.run({ op: "merge", inputs }, inputs, signal);
  return new Uint8Array(res.output!);
}

/** Extract plain text from a PDF → text content. */
export async function extractText(data: Uint8Array, signal?: AbortSignal): Promise<string> {
  const input = transferableCopy(data);
  const res = await jobs.run({ op: "extract", input }, [input], signal);
  return res.text ?? "";
}

export interface PdfPageInfo {
  /** Unrotated visible box in points. */
  width: number;
  height: number;
  /** Page /Rotate in degrees (0, 90, 180, 270). */
  rotate: number;
}

/** Page sizes and rotation of a PDF (one entry per page, in page order). */
export async function pdfPageInfo(data: Uint8Array, signal?: AbortSignal): Promise<PdfPageInfo[]> {
  const input = transferableCopy(data);
  const res = await jobs.run({ op: "info", input }, [input], signal);
  return (JSON.parse(res.text ?? "{}") as { pages?: PdfPageInfo[] }).pages ?? [];
}

/** One output page: 0-based source page index and extra clockwise rotation in degrees. */
export interface PdfPlanPage {
  page: number;
  rotate: number;
}

/** Rebuild a PDF from page plans: one output file per plan (reorder / rotate / delete / split). */
export async function organizePdf(data: Uint8Array, plans: PdfPlanPage[][], signal?: AbortSignal): Promise<Uint8Array[]> {
  const input = transferableCopy(data);
  const res = await jobs.run({ op: "organize", input, plan: JSON.stringify(plans) }, [input], signal);
  return (res.outputs ?? []).map((b) => new Uint8Array(b));
}
