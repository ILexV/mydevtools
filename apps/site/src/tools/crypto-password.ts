/**
 * Password/passphrase handling shared by aead-file and openssh-keys (pure,
 * unit-tested in test/crypto-tools.test.ts). Secrets are used exactly as
 * typed — no silent trim(). For decryption the trimmed variant is offered as
 * a fallback, because the old site trimmed passwords before deriving keys.
 */

/** True when the value starts or ends with whitespace (worth a non-blocking hint). */
export function hasEdgeWhitespace(value: string): boolean {
  return value.length > 0 && /^\s|\s$/u.test(value);
}

/**
 * Decryption candidates: as typed, then trimmed when that differs and is not
 * empty (legacy-compatible fallback). Empty input → no candidates.
 */
export function passwordCandidates(value: string): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  return trimmed && trimmed !== value ? [value, trimmed] : [value];
}
