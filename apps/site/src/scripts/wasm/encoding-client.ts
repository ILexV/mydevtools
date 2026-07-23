/**
 * Encoding WASM client (main thread). One-shot encode/decode for text and
 * small buffers. File work goes through `encoding-file-client.ts` (worker,
 * progress + cancel). Caches the module init promise.
 *
 * Formats: base64 | base32 | base58 | hex | url.
 * Options mirror the legacy per-format settings.
 */
import init, * as enc from "@/generated/wasm/encoding/encoding.js";
import { WasmError } from "@/scripts/wasm/worker-protocol";

export type EncodingFormat = "base64" | "base32" | "base58" | "hex" | "url";

export interface Base64Options {
  alphabet: string; // "standard" | "urlsafe"
  padding: string; // "required" | "optional" | "none"
  lineWrap: number | null; // null | 76
  allowWhitespace: boolean;
  charset: string;
}

export interface Base32Options {
  alphabet: string; // "rfc4648" | "crockford" | "zbase32"
  padding: string;
  case: string | null; // "upper" | "lower" | null (auto)
  allowWhitespace: boolean;
  charset: string;
}

export interface Base58Options {
  alphabet: string; // "bitcoin" | "flickr" | "ripple"
  allowWhitespace: boolean;
  charset: string;
}

export interface HexOptions {
  upper: boolean;
  ignoreWhitespace: boolean;
  allowSeparators: boolean;
  allow0x: boolean;
  charset: string;
}

export interface UrlOptions {
  mode: string; // "component" | "uri" | "form"
  charset: string;
}

export type EncodingOptions =
  | ({ format: "base64" } & Base64Options)
  | ({ format: "base32" } & Base32Options)
  | ({ format: "base58" } & Base58Options)
  | ({ format: "hex" } & HexOptions)
  | ({ format: "url" } & UrlOptions);

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

/** Encode bytes → encoded string for the given format/options. */
export async function encodeBytes(options: EncodingOptions, bytes: Uint8Array): Promise<string> {
  await ensureReady();
  return wrap(() => {
    switch (options.format) {
      case "base64":
        return enc.base64_encode(bytes, options.alphabet, options.padding, options.lineWrap);
      case "base32":
        return enc.base32_encode(bytes, options.alphabet, options.padding, options.case);
      case "base58":
        return enc.base58_encode(bytes, options.alphabet);
      case "hex":
        return enc.hex_encode(bytes, options.upper);
      case "url":
        return enc.url_encode(bytes, options.mode);
    }
  });
}

/** Decode encoded string → bytes. */
export async function decodeToBytes(options: EncodingOptions, input: string): Promise<Uint8Array> {
  await ensureReady();
  return wrap(() => {
    switch (options.format) {
      case "base64":
        return enc.base64_decode(input, options.alphabet, options.padding, options.allowWhitespace);
      case "base32":
        return enc.base32_decode(input, options.alphabet, options.padding, options.allowWhitespace);
      case "base58":
        return enc.base58_decode(input, options.alphabet, options.allowWhitespace);
      case "hex":
        return enc.hex_decode(input, options.ignoreWhitespace, options.allowSeparators, options.allow0x);
      case "url":
        return enc.url_decode(input, options.mode);
    }
  });
}

/** Encode text (via charset) → encoded string. */
export async function encodeText(options: EncodingOptions, text: string): Promise<string> {
  await ensureReady();
  const bytes = wrap(() => enc.encode_text_to_bytes(text, options.charset));
  return encodeBytes(options, bytes);
}

/** Decode encoded string → text (via charset). */
export async function decodeText(options: EncodingOptions, input: string): Promise<string> {
  const bytes = await decodeToBytes(options, input);
  return wrap(() => enc.decode_bytes_to_text(bytes, options.charset));
}
