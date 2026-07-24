/**
 * QR code WASM client (main thread). One-shot PNG/SVG generation and image
 * decode. Caches the module init promise; normalizes thrown values into
 * typed `WasmError`.
 */
import init, * as qr from "@/generated/wasm/qrcode/qrcode.js";
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

export interface QrPngOptions {
  size: number;
  fgColor: string;
  bgColor: string;
  ecLevel: string;
  style: string;
  logoData?: Uint8Array | null;
}

/** Generate a QR code as PNG bytes. */
export async function qrPng(data: string, options: QrPngOptions): Promise<Uint8Array> {
  await ensureReady();
  return wrap(() =>
    qr.generate_qr_png(data, options.size, options.fgColor, options.bgColor, options.ecLevel, options.style, options.logoData ?? null),
  );
}

/** Generate a QR code as SVG markup. */
export async function qrSvg(data: string, fgColor: string, bgColor: string, ecLevel: string): Promise<string> {
  await ensureReady();
  return wrap(() => qr.generate_qr_svg(data, fgColor, bgColor, ecLevel));
}

/** Decode a QR code from image bytes (PNG/JPEG/…). Throws WasmError when no code is found. */
export async function qrDecode(imageBytes: Uint8Array): Promise<string> {
  await ensureReady();
  return wrap(() => qr.decode_qr(imageBytes));
}
