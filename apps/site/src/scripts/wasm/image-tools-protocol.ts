/**
 * Message protocol between `image-tools-client` and `image-tools.worker`.
 * Input/output image bytes travel as transferred ArrayBuffers.
 */
export type ImageWorkerRequest =
  | { id: number; op: "compress" | "convert"; input: ArrayBuffer; format: string; quality: number }
  | { id: number; op: "resize"; input: ArrayBuffer; width: number; height: number; format: string };

export type ImageWorkerResponse =
  | { id: number; ok: true; output: ArrayBuffer }
  | { id: number; ok: false; message: string };
