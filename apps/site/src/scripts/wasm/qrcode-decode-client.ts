/**
 * QR decode client: decodes uploaded images and live camera frames in the
 * `qrcode.worker` Web Worker (rxing on a multi-megapixel photo takes ~1 s and
 * used to freeze the page). Aborting a call terminates the worker; the next
 * call spawns a fresh one. Frame decoding is meant to be called by a loop that
 * skips frames while a previous decode is still running (no queueing).
 */
import { createJobWorker, transferableCopy } from "@/scripts/wasm/job-worker";
import type { QrDecodeRequest } from "@/scripts/wasm/qrcode-protocol";

type Req = QrDecodeRequest extends infer R ? (R extends unknown ? Omit<R, "id"> : never) : never;

const decoder = createJobWorker<Req, { text: string }>(
  () => new Worker(new URL("../../workers/qrcode.worker.ts", import.meta.url), { type: "module" }),
);

/**
 * Decode a QR code from image bytes (PNG/JPEG/WebP) in the worker. Rejects
 * with WasmError ("aborted" when `signal` fires; otherwise the decoder's
 * message, e.g. no code found).
 */
export async function qrDecode(imageBytes: Uint8Array, signal?: AbortSignal): Promise<string> {
  const input = transferableCopy(imageBytes);
  const res = await decoder.run({ kind: "image", input }, [input], signal);
  return res.text;
}

/** Decode one camera frame (ImageBitmap, transferred and closed by the worker). */
export async function qrDecodeBitmap(bitmap: ImageBitmap, signal?: AbortSignal): Promise<string> {
  const res = await decoder.run({ kind: "bitmap", bitmap }, [bitmap], signal);
  return res.text;
}

/** Decode one camera frame from raw RGBA pixels (fallback without OffscreenCanvas). */
export async function qrDecodeImageData(frame: ImageData, signal?: AbortSignal): Promise<string> {
  const rgba = frame.data.buffer as ArrayBuffer;
  const res = await decoder.run({ kind: "rgba", rgba, width: frame.width, height: frame.height }, [rgba], signal);
  return res.text;
}
