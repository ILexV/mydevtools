/**
 * Password Generator settings helpers (pure, unit-tested in
 * test/crypto-tools.test.ts). Validates settings restored from localStorage
 * (length clamped to the 4–128 slider range, wrong types dropped) and checks
 * that at least one character set is selected before calling WASM.
 */
export interface PwSettings {
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  numbers: boolean;
  special: boolean;
  specialChars: string;
}

export const PW_MIN_LENGTH = 4;
export const PW_MAX_LENGTH = 128;

/** Keep only well-typed fields of a stored settings object; clamp the length. */
export function sanitizeSettings(raw: unknown): Partial<PwSettings> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const out: Partial<PwSettings> = {};
  if (typeof src.length === "number" && Number.isFinite(src.length)) {
    out.length = Math.min(PW_MAX_LENGTH, Math.max(PW_MIN_LENGTH, Math.round(src.length)));
  }
  for (const key of ["uppercase", "lowercase", "numbers", "special"] as const) {
    if (typeof src[key] === "boolean") out[key] = src[key] as boolean;
  }
  if (typeof src.specialChars === "string") out.specialChars = src.specialChars;
  return out;
}

/** True when at least one character class is enabled. */
export function hasCharset(s: Pick<PwSettings, "uppercase" | "lowercase" | "numbers" | "special">): boolean {
  return s.uppercase || s.lowercase || s.numbers || s.special;
}

const UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
const NUMBERS = "0123456789";
/** Mirrors `DEFAULT_SPECIAL` in wasm/password/src/lib.rs. */
export const DEFAULT_SPECIAL = "!@#$%^&*()_+-=[]{}|;:,.<>?";

/**
 * Alphabet size the WASM generator draws from — same rules as Rust
 * `build_charset`: custom symbols (trimmed) replace the default special set,
 * whitespace/control chars and duplicates across all sets are dropped.
 */
export function alphabetSize(s: PwSettings): number {
  const seen = new Set<string>();
  const add = (set: string) => {
    for (const ch of set) {
      if (/\s/u.test(ch) || /\p{Cc}/u.test(ch)) continue;
      seen.add(ch);
    }
  };
  if (s.uppercase) add(UPPERCASE);
  if (s.lowercase) add(LOWERCASE);
  if (s.numbers) add(NUMBERS);
  if (s.special) {
    const custom = s.specialChars.trim();
    add(custom === "" ? DEFAULT_SPECIAL : custom);
  }
  return seen.size;
}

/** Password entropy in bits: length × log2(alphabet); 0 for an empty/1-symbol alphabet. */
export function entropyBits(length: number, alphabet: number): number {
  if (!(length > 0) || !(alphabet > 1)) return 0;
  return length * Math.log2(alphabet);
}

/** Strength grade 1–4 (weak / fair / strong / very strong) by entropy bits: <50, <70, <100, ≥100. */
export type StrengthLevel = 1 | 2 | 3 | 4;
export function strengthLevel(bits: number): StrengthLevel {
  if (bits < 50) return 1;
  if (bits < 70) return 2;
  if (bits < 100) return 3;
  return 4;
}

/** Meter fill 0..1: entropy against 128 bits (beyond that brute force is moot). */
export function strengthFill(bits: number): number {
  return Math.max(0, Math.min(1, bits / 128));
}
