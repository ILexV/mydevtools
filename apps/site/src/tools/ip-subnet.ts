/**
 * IP subnet split helpers (pure, unit-tested in test/ip-subnet.test.ts):
 * the allowed new-prefix range for subnetting a network, a sensible default
 * (IPv4: two bits longer, IPv6: /64 LAN subnets) and parsing of the
 * "new prefix" field (`26` or `/26`). The split itself runs in wasm/ipcalc.
 */

/** Longest prefix: 32 for IPv4, 128 for IPv6. */
export function maxPrefix(v6: boolean): number {
  return v6 ? 128 : 32;
}

/**
 * Default new prefix for splitting a `/prefix` network: IPv6 shorter than /64
 * → /64 (standard LAN size), otherwise prefix + 2 (IPv4) / + 1 (IPv6),
 * clamped to the maximum prefix.
 */
export function defaultSplitPrefix(prefix: number, v6: boolean): number {
  if (v6 && prefix < 64) return 64;
  return Math.min(prefix + (v6 ? 1 : 2), maxPrefix(v6));
}

/** Parse the new-prefix field: whole number (optional leading "/") in prefix..max, else null. */
export function parseSplitPrefix(raw: string, prefix: number, v6: boolean): number | null {
  const match = /^\/?\s*(\d{1,3})$/.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return value >= prefix && value <= maxPrefix(v6) ? value : null;
}

/**
 * Whether an IPv4 /prefix network has a broadcast address. /31 point-to-point
 * links (RFC 3021) and /32 single hosts have none, although wasm/ipcalc still
 * reports the last address there — the UI shows "none" instead of a copyable value.
 */
export type BroadcastKind = "address" | "p2p" | "single";

/** IPv4 broadcast presence by prefix: /0–/30 → "address", /31 → "p2p", /32 → "single". */
export function broadcastKind(prefix: number): BroadcastKind {
  if (prefix >= 32) return "single";
  if (prefix === 31) return "p2p";
  return "address";
}

/**
 * Line-break chunks for long addresses and counts: each chunk ends after its
 * separator run (IPv6 ":" groups, "." or locale digit-group separators), so the
 * UI can put a <wbr> between chunks and never wrap mid-group ("…551,6 / 16").
 */
export function separatorChunks(text: string): string[] {
  return (text.match(/[\p{L}\p{N}]*[^\p{L}\p{N}]*/gu) ?? []).filter(Boolean);
}

/** Digits in a formatted count; above LONG_COUNT_DIGITS the headline steps its font size down. */
export function digitCount(text: string): number {
  return (text.match(/\p{N}/gu) ?? []).length;
}

/** Headline counts longer than this (IPv6 /64 and wider) use the smaller headline size. */
export const LONG_COUNT_DIGITS = 12;

/** Below this share of the bar a segment is too thin to see: it gets a tick (not to scale). */
export const TINY_FRACTION = 0.01;

/** Hues reused cyclically for split segments (spectrum order of the category accents). */
export const SPECTRUM_SIZE = 9;

/** Split segments drawn individually; the rest is aggregated into one remainder segment. */
export const MAX_SPLIT_SEGMENTS = 16;

const RATIO_SCALE = 1_000_000_000n;

/** Exact address count of a /prefix network as BigInt: 2^(32|128 − prefix). */
export function addressCount(prefix: number, v6: boolean): bigint {
  return 1n << BigInt(maxPrefix(v6) - prefix);
}

/**
 * Bounded drawing ratio part/whole in 0..1 from exact BigInt counts — the only
 * place counts become floating point (precision 1e-9, enough for pixels).
 */
export function ratio(part: bigint, whole: bigint): number {
  if (whole <= 0n || part <= 0n) return 0;
  if (part >= whole) return 1;
  return Number((part * RATIO_SCALE) / whole) / Number(RATIO_SCALE);
}

/** Address-space bar segment kinds: IPv4 network/usable/broadcast, /31 point-to-point, /32 single, IPv6 prefix range. */
export type AddressSegmentKind = "network" | "usable" | "broadcast" | "p2p" | "single" | "range";

/** One bar segment: exact address count + drawing geometry as 0..1 fractions; `tiny` → draw a tick. */
export interface AddressSegment {
  kind: AddressSegmentKind;
  count: bigint;
  start: number;
  width: number;
  tiny: boolean;
}

function segment(kind: AddressSegmentKind, count: bigint, offset: bigint, total: bigint): AddressSegment {
  const width = ratio(count, total);
  return { kind, count, start: ratio(offset, total), width, tiny: width < TINY_FRACTION };
}

/**
 * Address-space diagram (network map / host range bar) of one subnet with truthful
 * proportions: IPv4 /0–/30 → network address, usable hosts, broadcast (1 + n−2 + 1);
 * /31 → two usable point-to-point addresses (RFC 3021); /32 → a single address;
 * IPv6 → the whole prefix range (no broadcast, no reservation). Counts stay BigInt.
 */
export function addressSpaceBar(prefix: number, v6: boolean): { total: bigint; segments: AddressSegment[] } {
  const total = addressCount(prefix, v6);
  if (v6) return { total, segments: [segment("range", total, 0n, total)] };
  if (prefix === 32) return { total, segments: [segment("single", 1n, 0n, total)] };
  if (prefix === 31) return { total, segments: [segment("p2p", 2n, 0n, total)] };
  return {
    total,
    segments: [
      segment("network", 1n, 0n, total),
      segment("usable", total - 2n, 1n, total),
      segment("broadcast", 1n, total - 1n, total),
    ],
  };
}

/** One split-bar segment: subnet `index` (1-based, table row #) or the aggregated remainder (index null). */
export interface SplitSegment {
  index: number | null;
  /** Number of subnets this segment stands for (1, or the remainder's exact count). */
  subnets: bigint;
  start: number;
  width: number;
  /** Spectrum hue slot 0..SPECTRUM_SIZE−1 (cyclic), null for the remainder. */
  hue: number | null;
}

/**
 * Subnet split map: the first ≤16 equal subnets as individually labelled
 * segments (hues cycle through the spectrum) plus one remainder segment with
 * the exact count of the rest. `listedTiny` → individual segments are too thin
 * to see and are marked by a single tick (not to scale). Never enumerates.
 */
export function splitBar(
  count: bigint,
  maxSegments = MAX_SPLIT_SEGMENTS,
): { segments: SplitSegment[]; listed: number; remainder: bigint; listedTiny: boolean } {
  if (count <= 0n) return { segments: [], listed: 0, remainder: 0n, listedTiny: false };
  const listed = count < BigInt(maxSegments) ? Number(count) : maxSegments;
  const segments: SplitSegment[] = [];
  for (let i = 0; i < listed; i++) {
    segments.push({ index: i + 1, subnets: 1n, start: ratio(BigInt(i), count), width: ratio(1n, count), hue: i % SPECTRUM_SIZE });
  }
  const remainder = count - BigInt(listed);
  if (remainder > 0n) {
    segments.push({ index: null, subnets: remainder, start: ratio(BigInt(listed), count), width: ratio(remainder, count), hue: null });
  }
  return { segments, listed, remainder, listedTiny: ratio(1n, count) < TINY_FRACTION };
}
