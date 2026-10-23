/**
 * Message protocol between `pdf-client` and `pdf.worker`. PDF bytes travel as
 * transferred ArrayBuffers (merge: one buffer per input, in merge order;
 * organize: one buffer per output file).
 */
import type { WasmErrorCode } from "@/scripts/wasm/worker-protocol";

export type PdfWorkerRequest =
  | { id: number; op: "compress"; input: ArrayBuffer }
  | { id: number; op: "extract"; input: ArrayBuffer }
  | { id: number; op: "merge"; inputs: ArrayBuffer[] }
  | { id: number; op: "info"; input: ArrayBuffer }
  /** `plan`: JSON `[[{page, rotate}, …], …]` — one array per output file (wasm/pdf/src/pages.rs). */
  | { id: number; op: "organize"; input: ArrayBuffer; plan: string };

export type PdfWorkerResponse =
  | { id: number; ok: true; output: ArrayBuffer }
  | { id: number; ok: true; text: string }
  | { id: number; ok: true; outputs: ArrayBuffer[] }
  | { id: number; ok: false; message: string; code?: WasmErrorCode };
