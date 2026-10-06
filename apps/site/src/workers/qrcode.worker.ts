/// <reference lib="webworker" />
/**
 * QR decode Web Worker: runs rxing (qrcode WASM) off the main thread for
 * uploaded images (`decode_qr`, a ~3800 px photo used to block the UI for
 * over a second) and live camera frames (`decode_qr_rgba`: an ImageBitmap is
 * drawn to an OffscreenCanvas here, so the main thread never reads pixels).
 * One job at a time; the client drops frames while a decode is running and
 * cancels a superseded upload by terminating the worker.
 */
import init, { decode_qr, decode_qr_rgba } from "@/generated/wasm/qrcode/qrcode.js";
import type { QrDecodeRequest, QrDecodeResponse } from "@/scripts/wasm/qrcode-protocol";

let ready: Promise<void> | null = null;
function ensureReady(): Promise<void> {
  if (!ready) ready = init().then(() => undefined);
  return ready;
}

let canvas: OffscreenCanvas | null = null;
/** RGBA pixels of a camera frame bitmap (bitmap is closed afterwards). */
function bitmapPixels(bitmap: ImageBitmap): ImageData {
  const { width, height } = bitmap;
  if (!canvas) canvas = new OffscreenCanvas(width, height);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Failed to load image: no 2D context");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, width, height);
}

function decode(req: QrDecodeRequest): string {
  if (req.kind === "image") return decode_qr(new Uint8Array(req.input));
  if (req.kind === "rgba") return decode_qr_rgba(new Uint8Array(req.rgba), req.width, req.height);
  const px = bitmapPixels(req.bitmap);
  return decode_qr_rgba(new Uint8Array(px.data.buffer), px.width, px.height);
}

self.addEventListener("message", async (ev: MessageEvent<QrDecodeRequest>) => {
  const req = ev.data;
  let msg: QrDecodeResponse;
  try {
    await ensureReady();
    msg = { id: req.id, ok: true, text: decode(req) };
  } catch (e) {
    if (req.kind === "bitmap") req.bitmap.close();
    msg = { id: req.id, ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  (self as DedicatedWorkerGlobalScope).postMessage(msg);
});
