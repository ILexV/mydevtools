/**
 * Message protocol between `image-tools-client` and `image-tools.worker`.
 * Input/output image bytes travel as transferred ArrayBuffers.
 */
import type { WasmErrorCode } from "@/scripts/wasm/worker-protocol";

export type ImageWorkerRequest =
  | { id: number; op: "compress" | "convert"; input: ArrayBuffer; format: string; quality: number }
  | { id: number; op: "resize"; input: ArrayBuffer; width: number; height: number; format: string }
  | { id: number; op: "process"; input: ArrayBuffer; maxWidth: number; maxHeight: number; format: string; quality: number };

/** Pixel sizes reported by the batch `process` op (source and written output). */
export interface ImageDimensions {
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
}

/**
 * `webpLossy`: true when a WebP result came from the browser's lossy encoder
 * (quality applied); false for the lossless WASM fallback or non-WebP output.
 */
export type ImageWorkerResponse =
  | { id: number; ok: true; output: ArrayBuffer; webpLossy: boolean; dims?: ImageDimensions }
  | { id: number; ok: false; message: string; code?: WasmErrorCode };
