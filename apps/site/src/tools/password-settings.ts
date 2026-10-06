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
