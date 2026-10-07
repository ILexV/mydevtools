/**
 * JWT temporal status helpers (DOM-free; unit-tested in test/jwt-time.test.ts).
 * Reads the registered NumericDate claims exp / nbf / iat (RFC 7519 §4.1.4–6)
 * from a decoded payload, validates them (number of seconds, fractions allowed,
 * within the JS Date range) and derives one time-bounds status with the
 * precedence invalid → expired → not yet valid → expires soon → within time
 * bounds → no time bounds. Also flags inconsistent bounds (nbf ≥ exp, iat > exp,
 * iat in the future, millisecond-looking values) and picks the refresh cadence
 * for the live decoder (1 s near a boundary, 60 s otherwise). No clock tolerance.
 * Time checks say nothing about authenticity — only a verified signature does.
 */

export type TemporalClaimName = "exp" | "nbf" | "iat";

/** Why a present temporal claim can't be used: not a JSON number / outside the Date range. */
export type TemporalClaimProblem = "type" | "range";

export interface TemporalClaim {
  claim: TemporalClaimName;
  /** NumericDate seconds; null when the value is invalid. */
  seconds: number | null;
  /** Compact JSON spelling of the raw value (shown for invalid claims). */
  raw: string;
  problem: TemporalClaimProblem | null;
}

export type TemporalStatus = "invalid" | "expired" | "not-yet-valid" | "expires-soon" | "valid" | "unbounded";

export type TemporalWarning =
  | { code: "nbf-after-exp" }
  | { code: "iat-after-exp" }
  | { code: "iat-in-future" }
  | { code: "milliseconds"; claim: TemporalClaimName };

export interface TemporalReport {
  status: TemporalStatus;
  warnings: TemporalWarning[];
}

/** Largest |NumericDate| in seconds that a JS Date (±8.64e15 ms) can represent. */
export const MAX_NUMERIC_DATE = 8.64e12;
/** "Expires soon" window before exp, in seconds (5 minutes). */
export const EXPIRES_SOON_SECONDS = 300;
/** Values this large are almost certainly milliseconds by mistake (year ≥ 5138 as seconds). */
const MILLISECONDS_HINT = 1e11;
/** Within this many seconds of any boundary the decoder refreshes every second. */
const NEAR_BOUNDARY_SECONDS = 120;

const ORDER: readonly TemporalClaimName[] = ["exp", "nbf", "iat"];

/**
 * Temporal claims present in a decoded payload, in exp → nbf → iat order,
 * each validated as a NumericDate. Returns null when the payload is not a
 * JSON object (then no time section applies at all).
 */
export function readTemporalClaims(payloadJson: string): TemporalClaim[] | null {
  let obj: unknown;
  try {
    obj = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  const out: TemporalClaim[] = [];
  for (const claim of ORDER) {
    if (!Object.prototype.hasOwnProperty.call(rec, claim)) continue;
    const v = rec[claim];
    const raw = JSON.stringify(v) ?? String(v);
    if (typeof v !== "number" || !Number.isFinite(v)) {
      out.push({ claim, seconds: null, raw, problem: "type" });
    } else if (Math.abs(v) > MAX_NUMERIC_DATE) {
      out.push({ claim, seconds: null, raw, problem: "range" });
    } else {
      out.push({ claim, seconds: v, raw, problem: null });
    }
  }
  return out;
}

function secondsOf(claims: readonly TemporalClaim[], name: TemporalClaimName): number | null {
  return claims.find((c) => c.claim === name)?.seconds ?? null;
}

/**
 * Time-bounds status at `nowSeconds`: any invalid claim → "invalid" (never a
 * positive badge); now ≥ exp → "expired"; now < nbf → "not-yet-valid"; exp
 * within 5 min → "expires-soon"; exp or nbf present → "valid"; neither →
 * "unbounded" (iat alone bounds nothing). Plus consistency warnings.
 */
export function temporalReport(claims: readonly TemporalClaim[], nowSeconds: number): TemporalReport {
  const warnings: TemporalWarning[] = [];
  const exp = secondsOf(claims, "exp");
  const nbf = secondsOf(claims, "nbf");
  const iat = secondsOf(claims, "iat");

  if (exp !== null && nbf !== null && nbf >= exp) warnings.push({ code: "nbf-after-exp" });
  if (exp !== null && iat !== null && iat > exp) warnings.push({ code: "iat-after-exp" });
  if (iat !== null && iat > nowSeconds) warnings.push({ code: "iat-in-future" });
  for (const c of claims) {
    if (c.seconds !== null && Math.abs(c.seconds) >= MILLISECONDS_HINT) {
      warnings.push({ code: "milliseconds", claim: c.claim });
    }
  }

  let status: TemporalStatus;
  if (claims.some((c) => c.problem !== null)) status = "invalid";
  else if (exp !== null && nowSeconds >= exp) status = "expired";
  else if (nbf !== null && nowSeconds < nbf) status = "not-yet-valid";
  else if (exp !== null && exp - nowSeconds <= EXPIRES_SOON_SECONDS) status = "expires-soon";
  else if (exp !== null || nbf !== null) status = "valid";
  else status = "unbounded";
  return { status, warnings };
}

/**
 * Milliseconds until the next status/relative-time refresh: 1 s while any
 * boundary (exp, nbf, exp − 5 min, iat) is within 2 minutes of now (relative
 * text counts seconds and the status may flip), else 60 s. The near window is
 * wider than the slow tick, so no boundary is skipped.
 */
export function nextRefreshDelay(claims: readonly TemporalClaim[], nowSeconds: number): number {
  const exp = secondsOf(claims, "exp");
  const bounds: number[] = [];
  for (const c of claims) if (c.seconds !== null) bounds.push(c.seconds);
  if (exp !== null) bounds.push(exp - EXPIRES_SOON_SECONDS);
  return bounds.some((b) => Math.abs(b - nowSeconds) < NEAR_BOUNDARY_SECONDS) ? 1000 : 60_000;
}

export interface RelativeParts {
  value: number;
  unit: "second" | "minute" | "hour" | "day" | "month" | "year";
}

/**
 * Largest sensible unit for `Intl.RelativeTimeFormat` given `deltaSeconds`
 * (target − now; negative = past): seconds under a minute, then minutes,
 * hours, days (< 30), months (< 365 days), years. Values are rounded, so a
 * far-future exp reads "in 74 years", never a seconds countdown.
 */
export function relativeParts(deltaSeconds: number): RelativeParts {
  const abs = Math.abs(deltaSeconds);
  const pick = (size: number, unit: RelativeParts["unit"]): RelativeParts => {
    const value = Math.round(deltaSeconds / size);
    return { value: value === 0 ? 0 : value, unit }; // normalize -0
  };
  if (abs < 60) return pick(1, "second");
  if (abs < 3600) return pick(60, "minute");
  if (abs < 86_400) return pick(3600, "hour");
  if (abs < 30 * 86_400) return pick(86_400, "day");
  if (abs < 365 * 86_400) return pick(30.436875 * 86_400, "month");
  return pick(365.2425 * 86_400, "year");
}
