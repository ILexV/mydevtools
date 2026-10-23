import { test } from "node:test";
import assert from "node:assert/strict";
import { constants, createHmac, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { keyFitsAlg, kidFromHeader, parseJwkInput, selectKeys, verifyWithJwk, type Jwk } from "../src/tools/jwk.ts";

const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** Signed compact JWS for `alg` with node:crypto (ES* in IEEE P1363 form as JWS requires). */
function jws(alg: string, key: KeyObject | string, kid?: string): string {
  const input = `${b64u(JSON.stringify({ alg, ...(kid ? { kid } : {}) }))}.${b64u(JSON.stringify({ sub: "1" }))}`;
  const hash = `sha${alg.slice(2)}`;
  let sig: Buffer;
  if (alg.startsWith("HS")) sig = createHmac(hash, key as string).update(input).digest();
  else if (alg === "EdDSA") sig = sign(null, Buffer.from(input), key as KeyObject);
  else if (alg.startsWith("PS")) {
    sig = sign(hash, Buffer.from(input), { key: key as KeyObject, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: Number(alg.slice(2)) / 8 });
  } else if (alg.startsWith("ES")) sig = sign(hash, Buffer.from(input), { key: key as KeyObject, dsaEncoding: "ieee-p1363" });
  else sig = sign(hash, Buffer.from(input), key as KeyObject);
  return `${input}.${b64u(sig)}`;
}

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec256 = generateKeyPairSync("ec", { namedCurve: "P-256" });
const ec521 = generateKeyPairSync("ec", { namedCurve: "P-521" });
const ed = generateKeyPairSync("ed25519");
const pub = (k: KeyObject, extra: Partial<Jwk> = {}) => ({ ...(k.export({ format: "jwk" }) as Jwk), ...extra });

test("jwk: parseJwkInput tells JWK, JWKS, other text and broken JSON apart", () => {
  assert.deepEqual(parseJwkInput("my-secret"), { kind: "none" });
  assert.deepEqual(parseJwkInput("-----BEGIN PUBLIC KEY-----"), { kind: "none" });
  assert.deepEqual(parseJwkInput("{oops"), { kind: "invalid" });
  assert.deepEqual(parseJwkInput('{"keys": []}'), { kind: "invalid" });
  assert.deepEqual(parseJwkInput('{"a": 1}'), { kind: "invalid" });
  assert.equal(parseJwkInput('{"kty":"oct","k":"c2VjcmV0"}').kind, "jwk");
  const set = parseJwkInput(JSON.stringify({ keys: [pub(rsa.publicKey, { kid: "a" }), { nope: 1 }] }));
  assert.equal(set.kind, "jwks");
  assert.equal(set.kind === "jwks" && set.keys.length, 1);
});

test("jwk: selectKeys picks by kid, falls back to alg-compatible keys without kid", () => {
  const set = { kind: "jwks" as const, keys: [pub(rsa.publicKey, { kid: "r1" }), pub(ec256.publicKey, { kid: "e1" })] };
  assert.deepEqual(selectKeys(set, "e1", "ES256"), { ok: true, keys: [set.keys[1]] });
  assert.deepEqual(selectKeys(set, "zz", "ES256"), { ok: false, reason: "kid-not-found", kid: "zz", count: 2 });
  assert.deepEqual(selectKeys(set, null, "RS256"), { ok: true, keys: [set.keys[0]] });
  assert.deepEqual(selectKeys(set, null, "EdDSA"), { ok: false, reason: "no-compatible-key", count: 2 });
  // A single bare JWK without kid is used even when the token names a kid.
  const bare = { kind: "jwk" as const, keys: [pub(rsa.publicKey)] };
  assert.equal(selectKeys(bare, "any", "RS256").ok, true);
});

test("jwk: keyFitsAlg respects kty, curve, declared alg and use", () => {
  const p256 = pub(ec256.publicKey);
  assert.equal(keyFitsAlg(p256, "ES256"), true);
  assert.equal(keyFitsAlg(p256, "ES384"), false);
  assert.equal(keyFitsAlg(pub(rsa.publicKey, { alg: "PS256" }), "RS256"), false);
  assert.equal(keyFitsAlg(pub(rsa.publicKey, { use: "enc" }), "RS256"), false);
  assert.equal(keyFitsAlg(pub(rsa.publicKey), "none"), false);
});

test("jwk: verifyWithJwk checks RS/PS/ES/EdDSA/HS signatures", async () => {
  for (const alg of ["RS256", "RS512", "PS256", "PS384"]) {
    assert.equal(await verifyWithJwk(jws(alg, rsa.privateKey), alg, pub(rsa.publicKey)), "valid", alg);
  }
  assert.equal(await verifyWithJwk(jws("ES256", ec256.privateKey), "ES256", pub(ec256.publicKey)), "valid");
  assert.equal(await verifyWithJwk(jws("ES512", ec521.privateKey), "ES512", pub(ec521.publicKey)), "valid");
  assert.equal(await verifyWithJwk(jws("EdDSA", ed.privateKey), "EdDSA", pub(ed.publicKey)), "valid");
  const k = b64u("demo-secret");
  assert.equal(await verifyWithJwk(jws("HS256", "demo-secret"), "HS256", { kty: "oct", k }), "valid");
  // A private JWK works too: only its public part is imported.
  assert.equal(await verifyWithJwk(jws("RS256", rsa.privateKey), "RS256", rsa.privateKey.export({ format: "jwk" }) as Jwk), "valid");
});

test("jwk: verifyWithJwk reports invalid signatures and key/alg mismatches", async () => {
  const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
  assert.equal(await verifyWithJwk(jws("ES256", ec256.privateKey), "ES256", pub(other.publicKey)), "invalid");
  const token = jws("RS256", rsa.privateKey);
  assert.equal(await verifyWithJwk(token.slice(0, -4) + "AAAA", "RS256", pub(rsa.publicKey)), "invalid");
  assert.equal(await verifyWithJwk(token, "RS256", pub(ec256.publicKey)), "mismatch");
  assert.equal(await verifyWithJwk(token, "none", pub(rsa.publicKey)), "unsupported");
});

test("jwk: kidFromHeader", () => {
  assert.equal(kidFromHeader('{"alg":"RS256","kid":"abc"}'), "abc");
  assert.equal(kidFromHeader('{"alg":"RS256","kid":5}'), null);
  assert.equal(kidFromHeader("nope"), null);
});
