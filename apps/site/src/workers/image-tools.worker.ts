/// <reference lib="webworker" />
/**
 * Image tools Web Worker: runs compress/convert/resize (image_tools WASM) off
 * the main thread so large images don't freeze the page. One job at a time;
 * cancellation is done by the client terminating the worker (WASM calls are
 * synchronous and can't be interrupted cooperatively). The result buffer is
 * transferred back, not copied.
 */
import init, { compress_image, convert_image, resize_image } from "@/generated/wasm/image_tools/image_tools.js";
import type { ImageWorkerRequest, ImageWorkerResponse } from "@/scripts/wasm/image-tools-protocol";

let ready: Promise<void> | null = null;
function ensureReady(): Promise<void> {
  if (!ready) ready = init().then(() => undefined);
  return ready;
}

function post(msg: ImageWorkerResponse, transfer: Transferable[] = []): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);
}

self.addEventListener("message", async (ev: MessageEvent<ImageWorkerRequest>) => {
  const req = ev.data;
  try {
    await ensureReady();
    const input = new Uint8Array(req.input);
    let out: Uint8Array;
    if (req.op === "resize") out = resize_image(input, req.width, req.height, req.format);
    else if (req.op === "convert") out = convert_image(input, req.format, req.quality);
    else out = compress_image(input, req.format, req.quality);
    const buf = out.buffer as ArrayBuffer;
    post({ id: req.id, ok: true, output: buf }, [buf]);
  } catch (e) {
    post({ id: req.id, ok: false, message: e instanceof Error ? e.message : String(e) });
  }
});
