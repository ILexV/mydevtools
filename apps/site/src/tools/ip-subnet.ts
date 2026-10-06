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
