/**
 * Home hero "text lab" encoders: live Base64 / URL / Hex / SHA-256 of the
 * visitor's text, computed in the browser (no WASM on the home page).
 * All encoders work on UTF-8 bytes from TextEncoder, so lone surrogates
 * become U+FFFD instead of throwing (encodeURIComponent would throw).
 *
 * Pure module — runs under node --test and in Astro frontmatter (SSR seed).
 */

export type LabKind = "base64" | "url" | "hex" | "sha256";

export const LAB_KINDS: readonly LabKind[] = ["base64", "url", "hex", "sha256"];

const encoder = new TextEncoder();

export function utf8Bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Standard (RFC 4648) padded Base64 of the UTF-8 bytes. */
export function base64Utf8(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

const URL_SAFE = /[A-Za-z0-9\-_.!~*'()]/;

/** Percent-encoding identical to encodeURIComponent, but byte-based. */
export function percentEncodeUtf8(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    const ch = String.fromCharCode(b);
    out += b < 0x80 && URL_SAFE.test(ch) ? ch : "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/** Lowercase hex, space-separated bytes (`68 65 6c`) like the Hex tool. */
export function hexUtf8(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}

/** SHA-256 hex via WebCrypto; `null` outside a secure context. */
export async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface LabResult {
  bytes: number;
  base64: string;
  url: string;
  hex: string;
  sha256: string | null;
}

/** All four encodings of `text`; empty input gives empty outputs. */
export async function computeLab(text: string): Promise<LabResult> {
  const bytes = utf8Bytes(text);
  return {
    bytes: bytes.length,
    base64: base64Utf8(bytes),
    url: percentEncodeUtf8(bytes),
    hex: hexUtf8(bytes),
    sha256: bytes.length ? await sha256Hex(bytes) : "",
  };
}
