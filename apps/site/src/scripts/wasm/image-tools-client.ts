/**
 * Image tools WASM client (main thread). Compress/convert/resize whole image
 * buffers in a dedicated Web Worker (`image-tools.worker`) so the page stays
 * responsive on large images. Each call accepts an AbortSignal: aborting
 * terminates the worker (the synchronous WASM call can't be interrupted
 * otherwise) and rejects with `WasmError("aborted")`; the next call starts a
 * fresh worker. Errors are normalized into typed `WasmError`.
 *
 * Network: the worker + wasm load only on first use (image tool pages only).
 */
import { createJobWorker, transferableCopy } from "@/scripts/wasm/job-worker";
import { WasmError } from "@/scripts/wasm/worker-protocol";
import type { ImageWorkerRequest, ImageWorkerResponse } from "@/scripts/wasm/image-tools-protocol";

type ImageJobRequest = ImageWorkerRequest extends infer Request
  ? Request extends unknown ? Omit<Request, "id"> : never
  : never;
type ImageJobSuccess = Extract<ImageWorkerResponse, { ok: true }>;
const jobs = createJobWorker<ImageJobRequest, ImageJobSuccess>(
  () => new Worker(new URL("../../workers/image-tools.worker.ts", import.meta.url), { type: "module" }),
);

type JobPayload =
  | { op: "compress" | "convert"; format: string; quality: number }
  | { op: "resize"; width: number; height: number; format: string };

/** Encoded output plus which WebP encoder ran (false for non-WebP formats). */
export interface ImageJobResult {
  bytes: Uint8Array;
  webpLossy: boolean;
}

async function run(input: Uint8Array, payload: JobPayload, signal?: AbortSignal): Promise<ImageJobResult> {
  if (signal?.aborted) throw new WasmError("aborted", "Aborted");
  const buffer = transferableCopy(input);
  const result = await jobs.run(
    { input: buffer, ...payload } as ImageJobRequest,
    [buffer],
    signal,
  );
  return { bytes: new Uint8Array(result.output), webpLossy: result.webpLossy };
}

/** Compress an image (target format + quality 1-100; WebP lossy when the browser can). */
export function compressImage(
  input: Uint8Array,
  format: string,
  quality: number,
  signal?: AbortSignal,
): Promise<ImageJobResult> {
  return run(input, { op: "compress", format, quality }, signal);
}

/** Convert an image to another format (quality 1-100 for jpeg/webp/png<90). */
export function convertImage(
  input: Uint8Array,
  format: string,
  quality: number,
  signal?: AbortSignal,
): Promise<ImageJobResult> {
  return run(input, { op: "convert", format, quality }, signal);
}

/** Resize an image to width×height → encoded bytes (jpeg/webp at quality 90). */
export function resizeImage(
  input: Uint8Array,
  width: number,
  height: number,
  format: string,
  signal?: AbortSignal,
): Promise<ImageJobResult> {
  return run(input, { op: "resize", width, height, format }, signal);
}
