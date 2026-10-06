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

/** base64url (no padding, RFC 7515 §2) → bytes; null on any invalid character/length. */
export function base64UrlDecodeBytes(segment: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(segment) || segment.length % 4 === 1) return null;
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((segment.length + 3) % 4);
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Pretty-print JSON text (2-space indent) by re-indenting its tokens instead of
 * parse → stringify, so the decoded JWT keeps the token's original key order
 * (incl. integer-like keys), duplicate keys and number spelling (no float or
 * > 2^53 precision loss). Input must already be valid JSON.
 */
export function reindentJson(json: string): string {
  let out = "";
  let depth = 0;
  const nl = () => "\n" + "  ".repeat(depth);
  for (let i = 0; i < json.length; i++) {
    const ch = json.charAt(i);
    if (ch === '"') {
      let j = i + 1;
      while (j < json.length && json.charAt(j) !== '"') j += json.charAt(j) === "\\" ? 2 : 1;
      out += json.slice(i, j + 1);
      i = j;
    } else if (ch === "{" || ch === "[") {
      const close = ch === "{" ? "}" : "]";
      let j = i + 1;
      while (/\s/.test(json.charAt(j))) j++;
      if (json.charAt(j) === close) {
        out += ch + close; // empty container stays inline: {} / []
        i = j;
      } else {
        depth++;
        out += ch + nl();
      }
    } else if (ch === "}" || ch === "]") {
      depth--;
      out += nl() + ch;
    } else if (ch === ",") {
      out += "," + nl();
    } else if (ch === ":") {
      out += ": ";
    } else if (!/\s/.test(ch)) {
      out += ch;
    }
  }
  return out;
}

export type DecodedJwt =
  | { ok: true; header: string; payload: string }
  | { ok: false; error: string };

const utf8 = new TextDecoder("utf-8", { fatal: true });

function decodeSegment(segment: string, label: "Header" | "Payload"): string | { error: string } {
  const bytes = base64UrlDecodeBytes(segment);
  if (!bytes) return { error: `${label} decode error: invalid base64url` };
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return { error: `${label} invalid UTF-8` };
  }
  try {
    JSON.parse(text);
    return reindentJson(text);
  } catch {
    return JSON.stringify(text); // not JSON → shown as a JSON string (legacy WASM parity)
  }
}

/**
 * Decode a (normalized) JWT's header and payload for display, in the original
 * claim order. Same contract as the legacy WASM `jwt_decode` (≥ 2 dot parts,
 * strict base64url/UTF-8, non-JSON segment shown as a string) minus its
 * alphabetical key sorting. The signature is not checked here.
 */
export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split(".");
  if (parts.length < 2) return { ok: false, error: "Invalid JWT format" };
  const header = decodeSegment(parts[0] ?? "", "Header");
  if (typeof header !== "string") return { ok: false, error: header.error };
  const payload = decodeSegment(parts[1] ?? "", "Payload");
  if (typeof payload !== "string") return { ok: false, error: payload.error };
  return { ok: true, header, payload };
}
