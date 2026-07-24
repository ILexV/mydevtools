/**
 * Image tools WASM client (main thread). One-shot compress/convert/resize
 * on whole image buffers (legacy processes single images in memory — no
 * chunking). Caches the module init promise; normalizes thrown values into
 * typed `WasmError`.
 */
import init, * as img from "@/generated/wasm/image_tools/image_tools.js";
import { WasmError } from "@/scripts/wasm/worker-protocol";

let ready: Promise<void> | null = null;
function ensureReady(): Promise<void> {
  if (!ready) ready = init().then(() => undefined);
  return ready;
}

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new WasmError("unknown", message);
  }
}

/** Compress an image (target format + quality 1-100) → encoded bytes. */
export async function compressImage(
  input: Uint8Array,
  format: string,
  quality: number,
): Promise<Uint8Array> {
  await ensureReady();
  return wrap(() => img.compress_image(input, format, quality));
}

/** Convert an image to another format (quality 1-100) → encoded bytes. */
export async function convertImage(
  input: Uint8Array,
  format: string,
  quality: number,
): Promise<Uint8Array> {
  await ensureReady();
  return wrap(() => img.convert_image(input, format, quality));
}

/** Resize an image to width×height → encoded bytes in the given format. */
export async function resizeImage(
  input: Uint8Array,
  width: number,
  height: number,
  format: string,
): Promise<Uint8Array> {
  await ensureReady();
  return wrap(() => img.resize_image(input, width, height, format));
}
