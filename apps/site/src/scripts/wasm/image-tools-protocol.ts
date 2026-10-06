/**
 * Message protocol between `image-tools-client` and `image-tools.worker`.
 * Input/output image bytes travel as transferred ArrayBuffers.
 */
export type ImageWorkerRequest =
  | { id: number; op: "compress" | "convert"; input: ArrayBuffer; format: string; quality: number }
  | { id: number; op: "resize"; input: ArrayBuffer; width: number; height: number; format: string };

/**
 * `webpLossy`: true when a WebP result came from the browser's lossy encoder
 * (quality applied); false for the lossless WASM fallback or non-WebP output.
 */
export type ImageWorkerResponse =
  | { id: number; ok: true; output: ArrayBuffer; webpLossy: boolean }
  | { id: number; ok: false; message: string };
