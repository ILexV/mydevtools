/**
 * PDF WASM client (main thread). One-shot compress/merge/extract on whole
 * file buffers (no streaming in the pdf crate). Caches the module init
 * promise; normalizes thrown values into typed `WasmError`.
 */
import init, * as pdf from "@/generated/wasm/pdf/pdf.js";
import { WasmError } from "@/scripts/wasm/worker-protocol";

let ready: Promise<void> | null = null;
function ensureReady(): Promise<void> {
  if (!ready) ready = init().then(() => undefined);
  return ready;
}

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new WasmError("unknown", message);
  }
}

/** Compress a PDF (lossless stream optimization) → compressed bytes. */
export async function compressPdf(data: Uint8Array): Promise<Uint8Array> {
  await ensureReady();
  return wrap(() => pdf.compress_pdf(data));
}

/** Merge multiple PDFs in order → merged PDF bytes. */
export async function mergePdfs(files: Uint8Array[]): Promise<Uint8Array> {
  await ensureReady();
  return wrap(() => pdf.merge_pdfs(files));
}

/** Extract plain text from a PDF → text content. */
export async function extractText(data: Uint8Array): Promise<string> {
  await ensureReady();
  return wrap(() => pdf.extract_text(data));
}
