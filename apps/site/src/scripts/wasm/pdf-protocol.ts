/**
 * Message protocol between `pdf-client` and `pdf.worker`. PDF bytes travel as
 * transferred ArrayBuffers (merge: one buffer per input, in merge order).
 */
export type PdfWorkerRequest =
  | { id: number; op: "compress"; input: ArrayBuffer }
  | { id: number; op: "extract"; input: ArrayBuffer }
  | { id: number; op: "merge"; inputs: ArrayBuffer[] };

export type PdfWorkerResponse =
  | { id: number; ok: true; output: ArrayBuffer }
  | { id: number; ok: true; text: string }
  | { id: number; ok: false; message: string };
