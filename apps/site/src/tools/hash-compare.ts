/**
 * Hash verification helpers for the Hash Calculator "Expected hash" field
 * (DOM-free; unit-tested in test/hash-compare.test.ts). The expected checksum
 * is trimmed at the edges and compared as hexadecimal, case-insensitively,
 * against already computed digests of the selected algorithms only — no
 * rehashing, no guessing the algorithm from digest length. Inner whitespace
 * (e.g. a pasted `sha256sum` line "digest  file.txt") or any non-hex character
 * is rejected instead of being silently normalized.
 */

export type ExpectedHash =
  | { kind: "empty" }
  | { kind: "invalid"; reason: "whitespace" | "non-hex" }
  | { kind: "ok"; hex: string };

/** Validate/normalize the expected digest: outer trim, hex only, lower-cased. */
export function parseExpectedHash(raw: string): ExpectedHash {
  const value = raw.trim();
  if (!value) return { kind: "empty" };
  if (/\s/.test(value)) return { kind: "invalid", reason: "whitespace" };
  if (!/^[0-9a-fA-F]+$/.test(value)) return { kind: "invalid", reason: "non-hex" };
  return { kind: "ok", hex: value.toLowerCase() };
}

/** Ids of the digests equal to `expectedHex` (case-insensitive), in input order. */
export function matchingDigests(expectedHex: string, digests: readonly { id: string; hex: string }[]): string[] {
  const want = expectedHex.toLowerCase();
  return digests.filter((d) => d.hex.trim().toLowerCase() === want).map((d) => d.id);
}
