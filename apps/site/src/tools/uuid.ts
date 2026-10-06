/**
 * UUID generation + formatting. Pure browser JS (Web Crypto CSPRNG) — no WASM.
 * v4: fully random. v7: 48-bit unix-ms timestamp + random (sortable).
 * Mirrors the legacy uuid-generator behavior.
 */

export type UuidVersion = "v4" | "v7";
export type UuidFormat = "hyphenated" | "plain" | "braces" | "urn";
export type UuidCase = "lower" | "upper";

/** Batch size limit (legacy UI: 1–100). */
export const MAX_BATCH = 100;

// v7 monotonicity state (RFC 9562 §6.2 method 1: 12-bit counter in rand_a).
let lastMs = -1;
let seq = 0;

/**
 * Next (timestamp, 12-bit counter) pair for v7. A new millisecond seeds the
 * counter randomly in the lower half (room to increment); within the same ms
 * (or if the clock goes backwards) the counter increments, and on overflow the
 * timestamp is advanced by 1 ms — so ids from one tab are strictly increasing.
 */
function nextV7Clock(now: number): { ms: number; counter: number } {
  if (now > lastMs) {
    lastMs = now;
    const r = new Uint16Array(1);
    crypto.getRandomValues(r);
    seq = r[0] & 0x7ff;
  } else {
    seq++;
    if (seq > 0xfff) {
      lastMs++;
      seq = 0;
    }
  }
  return { ms: lastMs, counter: seq };
}

/** Raw 16-byte UUID with version/variant bits already set. */
export function randomUuidBytes(version: UuidVersion, now: number = Date.now()): Uint8Array {
  const b = new Uint8Array(16);
  if (version === "v7") {
    const { ms, counter } = nextV7Clock(now);
    const view = new DataView(b.buffer);
    view.setUint32(0, Math.floor(ms / 0x10000)); // high 32 bits of 48-bit ms timestamp
    view.setUint16(4, ms % 0x10000); // low 16 bits
    crypto.getRandomValues(b.subarray(8));
    b[6] = 0x70 | (counter >> 8); // version 7 + counter high nibble
    b[7] = counter & 0xff;
  } else {
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
  }
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  return b;
}

/** Canonical (any case) hyphenated UUID with RFC 9562 variant and version 1–8. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Unix-ms timestamp embedded in a v7 UUID (any supported format), or null. */
export function v7Timestamp(uuid: string): number | null {
  const hex = uuid.replace(/^urn:uuid:|[{}-]/gi, "");
  if (!/^[0-9a-f]{32}$/i.test(hex) || hex[12] !== "7") return null;
  return parseInt(hex.slice(0, 12), 16);
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
  const n = Number.isFinite(count) ? Math.max(1, Math.min(MAX_BATCH, Math.floor(count))) : 1;
  return Array.from({ length: n }, () => generateUuid(version, format, casing));
}
