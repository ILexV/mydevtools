/**
 * Message protocol between `qrcode-decode-client` and `qrcode.worker`:
 * an uploaded image (encoded bytes) or a camera frame — an ImageBitmap
 * (drawn to OffscreenCanvas in the worker) or raw RGBA pixels. All payloads
 * are transferred, not copied.
 */
import type { WasmErrorCode } from "@/scripts/wasm/worker-protocol";

export type QrDecodeRequest =
  | { id: number; kind: "image"; input: ArrayBuffer }
  | { id: number; kind: "bitmap"; bitmap: ImageBitmap }
  | { id: number; kind: "rgba"; rgba: ArrayBuffer; width: number; height: number };

export type QrDecodeResponse =
  | { id: number; ok: true; text: string }
  | { id: number; ok: false; message: string; code?: WasmErrorCode };
