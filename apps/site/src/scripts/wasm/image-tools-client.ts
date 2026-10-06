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
import { WasmError } from "@/scripts/wasm/worker-protocol";
import type { ImageWorkerRequest, ImageWorkerResponse } from "@/scripts/wasm/image-tools-protocol";

let worker: Worker | null = null;
let nextId = 1;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../../workers/image-tools.worker.ts", import.meta.url), { type: "module" });
  }
  return worker;
}

function killWorker(): void {
  worker?.terminate();
  worker = null;
}

type JobPayload =
  | { op: "compress" | "convert"; format: string; quality: number }
  | { op: "resize"; width: number; height: number; format: string };

/** Encoded output plus which WebP encoder ran (false for non-WebP formats). */
export interface ImageJobResult {
  bytes: Uint8Array;
  webpLossy: boolean;
}

function run(input: Uint8Array, payload: JobPayload, signal?: AbortSignal): Promise<ImageJobResult> {
  if (signal?.aborted) return Promise.reject(new WasmError("aborted", "Aborted"));
  const w = getWorker();
  const id = nextId++;
  const { promise, resolve, reject } = Promise.withResolvers<ImageJobResult>();

  const onMsg = (ev: MessageEvent<ImageWorkerResponse>) => {
    const m = ev.data;
    if (m.id !== id) return;
    cleanup();
    if (m.ok) resolve({ bytes: new Uint8Array(m.output), webpLossy: m.webpLossy });
    else reject(new WasmError("unknown", m.message));
  };
  const onError = (ev: ErrorEvent) => {
    // Worker crashed (e.g. WASM out-of-memory trap): drop it so the next job
    // gets a fresh instance.
    cleanup();
    killWorker();
    reject(new WasmError("unknown", ev.message || "Worker error"));
  };
  const onAbort = () => {
    cleanup();
    killWorker();
    reject(new WasmError("aborted", "Aborted"));
  };
  function cleanup() {
    w.removeEventListener("message", onMsg);
    w.removeEventListener("error", onError);
    signal?.removeEventListener("abort", onAbort);
  }

  w.addEventListener("message", onMsg);
  w.addEventListener("error", onError);
  signal?.addEventListener("abort", onAbort, { once: true });
  // Copy into a standalone buffer so it can be transferred without detaching
  // a caller-owned view.
  const buf = input.slice().buffer as ArrayBuffer;
  w.postMessage({ id, input: buf, ...payload } as ImageWorkerRequest, [buf]);
  return promise;
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
