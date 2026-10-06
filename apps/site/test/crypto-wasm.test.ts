/**
 * Contract tests against the generated WASM bindings the site ships
 * (src/generated/wasm/{hash,password,cryptography}, produced by
 * wasm/build.ps1). They pin known vectors (RFC 4231, FIPS 180), the
 * hash-catalog ↔ Rust id mapping, the AEAD container flow used by
 * aead-file-client (incl. wrong password / tamper / non-container errors —
 * paths the native Rust tests cannot reach because `JsValue` errors need a
 * wasm host), and the error-message prefixes the controllers map to
 * localized text. Skipped when the bindings have not been generated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createHash, createHmac, X509Certificate } from "node:crypto";
import { HASH_ALGORITHMS } from "../src/tools/hash-algorithms.ts";

const GEN = new URL("../src/generated/wasm/", import.meta.url);
const has = (d: string) => existsSync(new URL(`${d}/${d}_bg.wasm`, GEN));
const skip = !(has("hash") && has("password") && has("cryptography")) && "WASM bindings not generated";

async function load(domain: string): Promise<any> {
  const mod = await import(new URL(`${domain}/${domain}.js`, GEN).href);
  await mod.default({ module_or_path: readFileSync(new URL(`${domain}/${domain}_bg.wasm`, GEN)) });
  return mod;
}
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const enc = new TextEncoder();

test("hash wasm: every catalog id is accepted by Rust and digests match node", { skip }, async () => {
  const h = await load("hash");
  for (const { id } of HASH_ALGORITHMS) {
    assert.match(h.hash_text_utf8(id, "abc"), /^[0-9a-f]+$/, id);
  }
  const text = "Привет 😀";
  for (const [id, nodeAlg] of [["md5", "md5"], ["sha1", "sha1"], ["sha256", "sha256"], ["sha512", "sha512"], ["sha3-256", "sha3-256"], ["blake2b", "blake2b512"]]) {
    assert.equal(h.hash_text_utf8(id, text), createHash(nodeAlg).update(text).digest("hex"), id);
  }
  // Streaming (file path) == one-shot.
  const hasher = new h.Hasher("sha256");
  hasher.update(enc.encode("Привет "));
  hasher.update(enc.encode("😀"));
  assert.equal(hasher.finalize(), createHash("sha256").update(text).digest("hex"));
  assert.throws(() => h.hash_text_utf8("nope", "x"));
});

test("password wasm: options are honoured", { skip }, async () => {
  const p = await load("password");
  const gen = (len: number, u: boolean, l: boolean, n: boolean, s: boolean, custom: string) => {
    const opts = new p.PasswordOptions(len, u, l, n, s, custom);
    try { return p.generate_password(opts) as string; } finally { opts.free(); }
  };
  assert.match(gen(128, false, false, true, false, ""), /^\d{128}$/);
  assert.match(gen(40, true, false, false, false, ""), /^[A-Z]{40}$/);
  const custom = gen(60, false, false, false, true, "€😀€");
  assert.equal([...custom].length, 60);
  assert.ok([...custom].every((c) => c === "€" || c === "😀"));
  assert.throws(() => gen(16, false, false, false, false, ""), /No character set selected/);
});

test("cryptography wasm: HMAC RFC 4231 vectors", { skip }, async () => {
  const c = await load("cryptography");
  // TC2: key "Jefe".
  const k2 = enc.encode("Jefe"), d2 = enc.encode("what do ya want for nothing?");
  assert.equal(hex(c.hmac_sha256(k2, d2)), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  assert.equal(hex(c.hmac_sha512(k2, d2)), "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737");
  // TC6: 131-byte key (longer than the block → hashed first).
  const k6 = new Uint8Array(131).fill(0xaa), d6 = enc.encode("Test Using Larger Than Block-Size Key - Hash Key First");
  assert.equal(hex(c.hmac_sha256(k6, d6)), "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
  assert.equal(hex(c.hmac_sha512(k6, d6)), "80b24263c7c1a3ebb71493c1dd7be8b49b46d1f41b4aeec1121b013783f8f3526b56d037e05f2598bd0fd2215d6a1e5295e64f73f63f0aec8b915a985d786598");
  // Empty key / message and Unicode vs node.
  assert.equal(hex(c.hmac_sha256(new Uint8Array(), new Uint8Array())), createHmac("sha256", "").update("").digest("hex"));
  assert.equal(hex(c.hmac_sha256(enc.encode("🔑"), enc.encode("тест"))), createHmac("sha256", "🔑").update("тест").digest("hex"));
});

test("cryptography wasm: AEAD container flow (aead-file-client) incl. failures", { skip }, async () => {
  const c = await load("cryptography");
  const CHUNK = 1024, TAG = 16, MEM = 64 * 1024, IT = 3, PAR = 1; // site KDF params
  const plain = new Uint8Array(2600).map((_, i) => (i * 31) % 256);
  const password = enc.encode("пароль 🔑");
  const encrypt = (alg: number) => {
    const salt = new Uint8Array(16).fill(1);
    const prefix = new Uint8Array(alg === 3 ? 16 : 4).fill(2);
    const header: Uint8Array = c.aead_stream_header_pack(alg, 1, salt, prefix, CHUNK);
    const key = c.aead_stream_derive_key_from_header(header, password, MEM, IT, PAR);
    const parts = [header];
    for (let off = 0, n = 0n; off < plain.length; off += CHUNK, n++) {
      parts.push(c.aead_stream_encrypt_chunk(alg, key, prefix, n, plain.subarray(off, off + CHUNK), new Uint8Array()));
    }
    return Buffer.concat(parts);
  };
  const decrypt = (file: Uint8Array, pw: Uint8Array) => {
    const info = c.aead_stream_header_info(file.subarray(0, 128));
    const header = file.subarray(0, info[5]);
    const prefix = c.aead_stream_extract_nonce_prefix(header);
    const key = c.aead_stream_derive_key_from_header(header, pw, MEM, IT, PAR);
    const out: Uint8Array[] = [];
    for (let off = info[5], n = 0n; off < file.length; off += info[4] + TAG, n++) {
      out.push(c.aead_stream_decrypt_chunk(info[0], key, prefix, n, file.subarray(off, off + info[4] + TAG), new Uint8Array()));
    }
    return Buffer.concat(out);
  };
  for (const alg of [1, 2, 3]) {
    const file = encrypt(alg);
    assert.equal(file.subarray(0, 4).toString(), "MDT2");
    assert.deepEqual(decrypt(file, password), Buffer.from(plain), `alg ${alg}`);
  }
  const file = encrypt(1);
  assert.throws(() => decrypt(file, enc.encode("пароль 🔑 ")), "wrong password must fail authentication");
  const tampered = Buffer.from(file); tampered[tampered.length - 1] ^= 0x80;
  assert.throws(() => decrypt(tampered, password), "tampered tag must fail");
  const H = c.aead_stream_header_info(file.subarray(0, 128))[5]; // 15 + salt 16 + prefix 4
  assert.equal(H, 35);
  const C = CHUNK + TAG;
  const swapped = Buffer.concat([file.subarray(0, H), file.subarray(H + C, H + 2 * C), file.subarray(H, H + C), file.subarray(H + 2 * C)]);
  assert.equal(swapped.length, file.length);
  assert.throws(() => decrypt(swapped, password), "reordered chunks must fail (counter nonces)");
  assert.throws(() => c.aead_stream_header_info(enc.encode("not an aead file")), "non-container header");
  assert.throws(() => c.aead_stream_header_info(new Uint8Array()), "empty file");
});

test("cryptography wasm: X.509 Ex API + error prefixes used by x509.client", { skip }, async () => {
  const c = await load("cryptography");
  const now = BigInt(Math.floor(Date.now() / 1000));
  const [certPem, keyPem] = c.x509_self_signed_pem_ex(2, "CN=t.example, O=Org, C=de", 90, now, [], []);
  assert.match(keyPem, /BEGIN PRIVATE KEY/);
  const cert = new X509Certificate(certPem);
  assert.match(cert.subject, /CN=t\.example/);
  assert.match(cert.subject, /C=DE/);
  assert.equal(Math.round((Date.parse(cert.validTo) - Date.parse(cert.validFrom)) / 86_400_000), 90);
  assert.ok(cert.verify(cert.publicKey));
  assert.deepEqual(c.x509_warnings_pem(certPem, now + 1n), []);
  assert.ok(c.x509_warnings_pem(certPem, now + 91n * 86_400n).includes("certificate expired"));
  assert.throws(() => c.x509_self_signed_pem_ex(1, "CN=a, XX=b", 1, now, [], []), /^invalid subject/);
  assert.throws(() => c.x509_self_signed_pem_ex(1, "CN=a", 0, now, [], []), /^invalid validity/);
  const [csr] = c.x509_csr_pem_ex(3, "csr.example", [], []);
  assert.match(csr, /BEGIN CERTIFICATE REQUEST/);
  assert.throws(() => c.x509_parse_pem("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----"));
});

test("cryptography wasm: OpenSSH error messages mapped by sshErrorKey", { skip }, async () => {
  const c = await load("cryptography");
  const seed = new Uint8Array(32).fill(7);
  const encrypted = c.openssh_ed25519_private_key(seed, "me", "secret", null);
  assert.throws(() => c.openssh_private_key_to_public_key_line(encrypted, null, null), /passphrase required/);
  assert.throws(() => c.openssh_private_key_to_public_key_line(encrypted, "wrong", null), /invalid passphrase or corrupted key/);
  const line = c.openssh_private_key_to_public_key_line(encrypted, "secret", null);
  assert.match(line, /^ssh-ed25519 \S+ me$/);
  // Ed25519 public line ↔ SPKI (was "not implemented yet").
  const spki = c.openssh_public_key_to_spki_pem(line);
  assert.equal(c.openssh_public_key_from_spki_pem(spki, "me"), line);
  assert.throws(() => c.openssh_public_key_bytes("ssh-ed25519 AAAA!!!notbase64 c"));
});
