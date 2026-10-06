/// <reference lib="webworker" />
/**
 * Image tools Web Worker: runs compress/convert/resize (image_tools WASM) off
 * the main thread so large images don't freeze the page. One job at a time;
 * cancellation is done by the client terminating the worker (WASM calls are
 * synchronous and can't be interrupted cooperatively). The result buffer is
 * transferred back, not copied.
 *
 * Lossy WebP: image-rs only has a lossless WebP encoder (quality ignored, a
 * JPEG photo grows several times). For WebP output we use the browser encoder
 * (`OffscreenCanvas.convertToBlob({ type: "image/webp", quality })`) when it
 * really returns `image/webp` (Safari falls back to PNG — detected by the
 * blob type), otherwise the lossless WASM path; `webpLossy` reports which.
 */
import init, { compress_image, convert_image, resize_image } from "@/generated/wasm/image_tools/image_tools.js";
import type { ImageWorkerRequest, ImageWorkerResponse } from "@/scripts/wasm/image-tools-protocol";

/** Fixed WebP quality for the resizer (no slider; matches its JPEG quality 90). */
const RESIZE_WEBP_QUALITY = 90;

let ready: Promise<void> | null = null;
function ensureReady(): Promise<void> {
  if (!ready) ready = init().then(() => undefined);
  return ready;
}

let webpProbe: Promise<boolean> | null = null;
/** True when this browser's canvas encoder produces real (lossy) WebP. */
function canEncodeLossyWebp(): Promise<boolean> {
  if (!webpProbe) {
    webpProbe = (async () => {
      if (typeof OffscreenCanvas === "undefined") return false;
      try {
        const c = new OffscreenCanvas(2, 2);
        c.getContext("2d")?.fillRect(0, 0, 1, 1);
        const blob = await c.convertToBlob({ type: "image/webp", quality: 0.5 });
        return blob.type === "image/webp";
      } catch {
        return false;
      }
    })();
  }
  return webpProbe;
}

/**
 * Encode `source` as lossy WebP via the browser (quality 1-100). Images the
 * browser can't decode (TIFF/TGA/…) go through a lossless PNG from WASM
 * first. Returns null when the browser can't produce WebP (caller falls back).
 */
async function browserWebp(source: Uint8Array, quality: number, sourceIsPng = false): Promise<ArrayBuffer | null> {
  if (!(await canEncodeLossyWebp())) return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([source as BlobPart], sourceIsPng ? { type: "image/png" } : {}));
  } catch {
    if (sourceIsPng) return null;
    const png = convert_image(source, "png", 100);
    bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }));
  }
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    const q = Math.min(100, Math.max(1, quality)) / 100;
    const blob = await canvas.convertToBlob({ type: "image/webp", quality: q });
    return blob.type === "image/webp" ? await blob.arrayBuffer() : null;
  } catch {
    return null; // e.g. canvas too large for this browser → lossless WASM path
  } finally {
    bitmap.close();
  }
}

function post(msg: ImageWorkerResponse, transfer: Transferable[] = []): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);
}

async function runJob(req: ImageWorkerRequest): Promise<{ buf: ArrayBuffer; webpLossy: boolean }> {
  const input = new Uint8Array(req.input);
  const webp = req.format.toLowerCase() === "webp";
  if (req.op === "resize") {
    if (webp && (await canEncodeLossyWebp())) {
      // Lanczos3 resize in WASM to lossless PNG, then lossy WebP in the browser.
      const png = resize_image(input, req.width, req.height, "png");
      const lossy = await browserWebp(png, RESIZE_WEBP_QUALITY, true);
      if (lossy) return { buf: lossy, webpLossy: true };
    }
    return { buf: resize_image(input, req.width, req.height, req.format).buffer as ArrayBuffer, webpLossy: false };
  }
  if (webp) {
    const lossy = await browserWebp(input, req.quality);
    if (lossy) return { buf: lossy, webpLossy: true };
  }
  const out = req.op === "convert" ? convert_image(input, req.format, req.quality) : compress_image(input, req.format, req.quality);
  return { buf: out.buffer as ArrayBuffer, webpLossy: false };
}

self.addEventListener("message", async (ev: MessageEvent<ImageWorkerRequest>) => {
  const req = ev.data;
  try {
    await ensureReady();
    const { buf, webpLossy } = await runJob(req);
    post({ id: req.id, ok: true, output: buf, webpLossy }, [buf]);
  } catch (e) {
    post({ id: req.id, ok: false, message: e instanceof Error ? e.message : String(e) });
  }
});
