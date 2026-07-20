/**
 * UUID generation + formatting. Pure browser JS (Web Crypto CSPRNG) — no WASM.
 * v4: fully random. v7: 48-bit unix-ms timestamp + random (sortable).
 * Mirrors the legacy uuid-generator behavior.
 */

export type UuidVersion = "v4" | "v7";
export type UuidFormat = "hyphenated" | "plain" | "braces" | "urn";
export type UuidCase = "lower" | "upper";

/** Raw 16-byte UUID with version/variant bits already set. */
function randomUuidBytes(version: UuidVersion): Uint8Array {
  const b = new Uint8Array(16);
  if (version === "v7") {
    const ts = Date.now();
    const view = new DataView(b.buffer);
    view.setUint32(0, Math.floor(ts / 0x10000)); // high 32 bits of 48-bit ms timestamp
    view.setUint16(4, ts & 0xffff); // low 16 bits
    crypto.getRandomValues(b.subarray(6));
    b[6] = (b[6] & 0x0f) | 0x70; // version 7
  } else {
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
  }
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  return b;
}

/** Format raw bytes as a canonical hyphenated hex string. */
function toHyphenated(b: Uint8Array): string {
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}

export function generateUuid(version: UuidVersion, format: UuidFormat, casing: UuidCase): string {
  const raw = toHyphenated(randomUuidBytes(version));
  let out: string;
  switch (format) {
    case "plain":
      out = raw.replaceAll("-", "");
      break;
    case "braces":
      out = `{${raw}}`;
      break;
    case "urn":
      out = `urn:uuid:${raw}`;
      break;
    default:
      out = raw;
  }
  return casing === "upper" ? out.toUpperCase() : out;
}

export function generateBatch(version: UuidVersion, format: UuidFormat, casing: UuidCase, count: number): string[] {
  const n = Math.max(1, Math.min(100, Math.floor(count)));
  return Array.from({ length: n }, () => generateUuid(version, format, casing));
}
