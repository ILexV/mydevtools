/**
 * JWK / JWKS support for the JWT decoder (RFC 7517 / 7518): recognise a pasted
 * JSON Web Key or key set, pick the verification key by the token's `kid`
 * (or try every key that fits the `alg` when there is no `kid`), and verify
 * the JWS signature with WebCrypto `importKey("jwk")` — HS*, RS*, PS*, ES*
 * and EdDSA (Ed25519). Private members are dropped: only the public part is
 * imported. Unit-tested in test/jwk.test.ts.
 */

export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  crv?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  k?: string;
}

export type JwkInput =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "jwk" | "jwks"; keys: Jwk[] };

/**
 * Classify the key field: `none` when it is not a JSON object (secret text or
 * PEM keep their existing path), `invalid` for JSON that is neither a JWK
 * (object with `kty`) nor a JWKS (`{"keys": [...]}` with at least one JWK).
 */
export function parseJwkInput(text: string): JwkInput {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return { kind: "none" };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { kind: "invalid" };
  }
  const isJwk = (v: unknown): v is Jwk =>
    !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as { kty?: unknown }).kty === "string";
  if (isJwk(value)) return { kind: "jwk", keys: [value] };
  const keys = (value as { keys?: unknown } | null)?.keys;
  if (Array.isArray(keys)) {
    const valid = keys.filter(isJwk);
    if (valid.length > 0) return { kind: "jwks", keys: valid };
  }
  return { kind: "invalid" };
}

interface AlgSpec {
  kty: "oct" | "RSA" | "EC" | "OKP";
  crv?: string;
  importAlg: AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams | HmacImportParams;
  verifyAlg: AlgorithmIdentifier | RsaPssParams | EcdsaParams;
}

/** WebCrypto parameters for a JWS `alg`; null for anything not verifiable (incl. `none`). */
export function algSpec(alg: string): AlgSpec | null {
  const bits = alg.slice(2);
  const hash = `SHA-${bits}`;
  if (/^HS(256|384|512)$/.test(alg)) return { kty: "oct", importAlg: { name: "HMAC", hash }, verifyAlg: "HMAC" };
  if (/^RS(256|384|512)$/.test(alg)) {
    return { kty: "RSA", importAlg: { name: "RSASSA-PKCS1-v1_5", hash }, verifyAlg: "RSASSA-PKCS1-v1_5" };
  }
  if (/^PS(256|384|512)$/.test(alg)) {
    return { kty: "RSA", importAlg: { name: "RSA-PSS", hash }, verifyAlg: { name: "RSA-PSS", saltLength: Number(bits) / 8 } };
  }
  const ec: Record<string, string> = { ES256: "P-256", ES384: "P-384", ES512: "P-521" };
  if (ec[alg]) {
    const crv = ec[alg];
    return { kty: "EC", crv, importAlg: { name: "ECDSA", namedCurve: crv }, verifyAlg: { name: "ECDSA", hash: alg === "ES512" ? "SHA-512" : hash } };
  }
  if (alg === "EdDSA" || alg === "Ed25519") return { kty: "OKP", crv: "Ed25519", importAlg: { name: "Ed25519" }, verifyAlg: { name: "Ed25519" } };
  return null;
}

/** True when the key's type, curve, declared `alg` and `use` allow verifying `alg`. */
export function keyFitsAlg(key: Jwk, alg: string): boolean {
  const spec = algSpec(alg);
  if (!spec || key.kty !== spec.kty) return false;
  if (spec.crv && key.crv !== spec.crv) return false;
  if (key.alg && key.alg !== alg) return false;
  return key.use === undefined || key.use === "sig";
}

export type KeySelection =
  | { ok: true; keys: Jwk[] }
  | { ok: false; reason: "kid-not-found"; kid: string; count: number }
  | { ok: false; reason: "no-compatible-key"; count: number };

/**
 * Keys to try for a token: with a `kid` header only keys carrying that `kid`
 * (a single bare JWK without `kid` is accepted as the user's explicit choice);
 * without `kid` every key that fits `alg`.
 */
export function selectKeys(input: { kind: "jwk" | "jwks"; keys: Jwk[] }, kid: string | null, alg: string): KeySelection {
  const count = input.keys.length;
  if (kid !== null) {
    const byKid = input.keys.filter((k) => k.kid === kid);
    if (byKid.length > 0) return { ok: true, keys: byKid };
    if (input.kind === "jwk" && input.keys[0].kid === undefined) return { ok: true, keys: input.keys };
    return { ok: false, reason: "kid-not-found", kid, count };
  }
  const fitting = input.keys.filter((k) => keyFitsAlg(k, alg));
  return fitting.length > 0 ? { ok: true, keys: fitting } : { ok: false, reason: "no-compatible-key", count };
}

/** Public members only, so a pasted private JWK still imports as a verify key. */
function publicJwk(key: Jwk): JsonWebKey {
  switch (key.kty) {
    case "RSA":
      return { kty: "RSA", n: key.n, e: key.e };
    case "EC":
      return { kty: "EC", crv: key.crv, x: key.x, y: key.y };
    case "OKP":
      return { kty: "OKP", crv: key.crv, x: key.x };
    default:
      return { kty: key.kty, k: key.k };
  }
}

/** base64url → bytes (no padding); throws on invalid input. */
function base64UrlBytes(segment: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) throw new Error("invalid base64url");
  const bin = atob(segment.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((segment.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Result per key: `valid` / `invalid` signature, `mismatch` when the key
 * cannot be used for `alg` (wrong kty/curve), `unsupported` when this browser's
 * WebCrypto lacks the algorithm (e.g. Ed25519 in older engines).
 */
export type JwkVerifyResult = "valid" | "invalid" | "mismatch" | "unsupported";

export async function verifyWithJwk(token: string, alg: string, key: Jwk): Promise<JwkVerifyResult> {
  const spec = algSpec(alg);
  if (!spec) return "unsupported";
  if (key.kty !== spec.kty || (spec.crv && key.crv !== spec.crv)) return "mismatch";
  const parts = token.split(".");
  if (parts.length !== 3) return "invalid";
  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey("jwk", publicJwk(key), spec.importAlg, false, ["verify"]);
  } catch (e) {
    return e instanceof DOMException && e.name === "NotSupportedError" ? "unsupported" : "mismatch";
  }
  try {
    const signature = base64UrlBytes(parts[2]);
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    return (await crypto.subtle.verify(spec.verifyAlg, cryptoKey, signature, data)) ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
}

/** `kid` from header JSON; null when absent or not a string. */
export function kidFromHeader(headerJson: string): string | null {
  try {
    const obj = JSON.parse(headerJson) as { kid?: unknown } | null;
    return obj && typeof obj.kid === "string" ? obj.kid : null;
  } catch {
    return null;
  }
}
