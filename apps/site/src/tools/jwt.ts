/**
 * JWT pure helpers shared by the JWT encoder/decoder (DOM-free; unit-tested in
 * test/jwt.test.ts). The encoder builds the JWS signing input here so claim
 * order and extra header fields (`kid`, `cty`, …) survive exactly as typed;
 * only the HMAC goes through the cryptography WASM (`jwt_sign_input`).
 * The decoder uses the token normalizer, algorithm classifier and the
 * registered time claims (exp / nbf / iat) to flag expired or not-yet-valid tokens.
 */

export type JwtHmacAlg = "HS256" | "HS384" | "HS512";

export type SigningInputResult =
  | { ok: true; input: string; header: string; payload: string }
  | { ok: false; field: "header" | "payload"; reason: "json" | "object" };

const enc = new TextEncoder();

/** base64url without padding of the UTF-8 bytes of `text` (RFC 7515 §2). */
export function base64UrlEncode(text: string): string {
  let bin = "";
  for (const b of enc.encode(text)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function parseObject(text: string): Record<string, unknown> | "json" | "object" {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "json";
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : "object";
}

/** Field check for the encoder form: null when `text` is a JSON object. */
export function jsonObjectProblem(text: string): "json" | "object" | null {
  const r = parseObject(text);
  return typeof r === "string" ? r : null;
}

/**
 * Header + payload JSON → `base64url(header).base64url(payload)`. Both must be
 * JSON objects (RFC 7519 claims set). The selected `alg` overrides the header
 * value in place (or is prepended when absent); all other fields and key order
 * are kept. Output JSON is compact (no whitespace).
 */
export function buildSigningInput(headerText: string, payloadText: string, alg: JwtHmacAlg): SigningInputResult {
  const header = parseObject(headerText);
  if (typeof header === "string") return { ok: false, field: "header", reason: header };
  const payload = parseObject(payloadText);
  if (typeof payload === "string") return { ok: false, field: "payload", reason: payload };

  const finalHeader = "alg" in header ? { ...header, alg } : { alg, ...header };
  const headerJson = JSON.stringify(finalHeader);
  const payloadJson = JSON.stringify(payload);
  return {
    ok: true,
    header: headerJson,
    payload: payloadJson,
    input: `${base64UrlEncode(headerJson)}.${base64UrlEncode(payloadJson)}`,
  };
}

/** Strip whitespace/line breaks and an optional `Bearer ` prefix from a pasted token. */
export function normalizeToken(raw: string): string {
  return raw.trim().replace(/^Bearer\s+/i, "").replace(/\s+/g, "");
}

export type AlgKind = "hmac" | "rsa" | "none" | "unsupported";

/** Which verification path an `alg` header value takes (WASM verifies HS* and RS*). */
export function classifyAlg(alg: string): AlgKind {
  if (/^HS(256|384|512)$/.test(alg)) return "hmac";
  if (/^RS(256|384|512)$/.test(alg)) return "rsa";
  if (alg.toLowerCase() === "none") return "none";
  return "unsupported";
}

/** `alg` from header JSON; null when missing/not a string/invalid JSON. */
export function algFromHeader(headerJson: string): string | null {
  try {
    const obj = JSON.parse(headerJson) as { alg?: unknown } | null;
    return obj && typeof obj.alg === "string" && obj.alg ? obj.alg : null;
  } catch {
    return null;
  }
}

export interface TimeClaim {
  claim: "exp" | "nbf" | "iat";
  /** Unix seconds. */
  seconds: number;
  /** exp in the past / nbf in the future. iat is never flagged. */
  problem: boolean;
}

/**
 * Registered NumericDate claims (RFC 7519 §4.1.4–4.1.6) present in the payload,
 * in exp → nbf → iat order, evaluated against `nowSeconds`. Non-numeric or
 * non-finite values are ignored.
 */
export function timeClaims(payloadJson: string, nowSeconds: number): TimeClaim[] {
  let obj: unknown;
  try {
    obj = JSON.parse(payloadJson);
  } catch {
    return [];
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  const rec = obj as Record<string, unknown>;
  const out: TimeClaim[] = [];
  for (const claim of ["exp", "nbf", "iat"] as const) {
    const v = rec[claim];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const problem = claim === "exp" ? v <= nowSeconds : claim === "nbf" ? v > nowSeconds : false;
    out.push({ claim, seconds: v, problem });
  }
  return out;
}
