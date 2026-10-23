/// <reference lib="webworker" />
/**
 * PDF Web Worker: runs compress / merge / extract-text / page info / page
 * organize (reorder, rotate, delete, split) (pdf WASM, lopdf) off
 * the main thread — a multi-MB PDF used to freeze the page for seconds. One
 * job at a time; cancellation = the client terminates the worker (WASM calls
 * are synchronous). Output bytes are transferred back, not copied.
 */
import init, { compress_pdf, extract_text, merge_pdfs, pdf_organize, pdf_page_info } from "@/generated/wasm/pdf/pdf.js";
import type { PdfWorkerRequest, PdfWorkerResponse } from "@/scripts/wasm/pdf-protocol";
import { classifyWorkerError } from "@/scripts/wasm/worker-protocol";

let ready: Promise<void> | null = null;
function ensureReady(): Promise<void> {
  if (!ready) ready = init().then(() => undefined);
  return ready;
}

function post(msg: PdfWorkerResponse, transfer: Transferable[] = []): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);
}

self.addEventListener("message", async (ev: MessageEvent<PdfWorkerRequest>) => {
  const req = ev.data;
  try {
    await ensureReady();
  } catch (e) {
    const error = classifyWorkerError(e, "init-failed");
    post({
      id: req.id,
      ok: false,
      code: error.code,
      message: error.message,
    });
    return;
  }
  try {
    if (req.op === "info") {
      post({ id: req.id, ok: true, text: pdf_page_info(new Uint8Array(req.input)) });
      return;
    }
    if (req.op === "organize") {
      const outputs = (pdf_organize(new Uint8Array(req.input), req.plan) as Uint8Array[]).map((u) => u.buffer as ArrayBuffer);
      post({ id: req.id, ok: true, outputs }, outputs);
      return;
    }
    if (req.op === "extract") {
      post({ id: req.id, ok: true, text: extract_text(new Uint8Array(req.input)) });
      return;
    }
    const out = req.op === "merge" ? merge_pdfs(req.inputs.map((b) => new Uint8Array(b))) : compress_pdf(new Uint8Array(req.input));
    const buf = out.buffer as ArrayBuffer;
    post({ id: req.id, ok: true, output: buf }, [buf]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const error = classifyWorkerError(e, /Failed to load PDF/iu.test(message) ? "corrupt-input" : "unknown");
    post({ id: req.id, ok: false, message: error.message, code: error.code });
  }
});
