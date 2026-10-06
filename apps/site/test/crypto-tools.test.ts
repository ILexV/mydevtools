/**
 * Unit tests for the crypto-group tool helpers (pure logic extracted from the
 * password-generator / aead-file / openssh-keys / x509 controllers) and the
 * hash-calculator algorithm catalog.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { alphabetSize, entropyBits, hasCharset, sanitizeSettings, strengthFill, strengthLevel, PW_MAX_LENGTH, PW_MIN_LENGTH } from "../src/tools/password-settings.ts";
import { aeadAlgorithmId, aeadProgressView, bytesToHex, decryptedName, encryptedName, formatDuration } from "../src/tools/aead-file-helpers.ts";
import { guessSshInput, rsaBits, sshErrorKey } from "../src/tools/openssh-keys-helpers.ts";
import { base64ToBytes, derBase64ToPem, isCsrPem, parseSanList, parseValidityDays, prettyJson, X509_MAX_VALIDITY_DAYS } from "../src/tools/x509-helpers.ts";
import { hasEdgeWhitespace, passwordCandidates } from "../src/tools/crypto-password.ts";
import { HASH_ALGORITHMS, DEFAULT_HASH_ALGORITHMS } from "../src/tools/hash-algorithms.ts";

/* ── password-generator ─────────────────────────────────────────────────── */

test("password: sanitizeSettings clamps length and drops wrong types", () => {
  assert.deepEqual(sanitizeSettings({ length: 1000, uppercase: true, numbers: "yes", specialChars: "#" }), {
    length: PW_MAX_LENGTH,
    uppercase: true,
    specialChars: "#",
  });
  assert.equal(sanitizeSettings({ length: 1 }).length, PW_MIN_LENGTH);
  assert.equal(sanitizeSettings({ length: 15.6 }).length, 16);
  assert.equal(sanitizeSettings({ length: Number.NaN }).length, undefined);
  assert.equal(sanitizeSettings({ length: "20" }).length, undefined);
});

test("password: sanitizeSettings tolerates garbage storage values", () => {
  for (const raw of [null, undefined, 42, "str", [], true]) assert.deepEqual(sanitizeSettings(raw), {});
});

test("password: hasCharset requires at least one class", () => {
  const none = { uppercase: false, lowercase: false, numbers: false, special: false };
  assert.equal(hasCharset(none), false);
  for (const k of ["uppercase", "lowercase", "numbers", "special"] as const) {
    assert.equal(hasCharset({ ...none, [k]: true }), true, k);
  }
});

/* ── aead-file ──────────────────────────────────────────────────────────── */

test("password: alphabetSize mirrors the Rust charset rules", () => {
  const all = { length: 16, uppercase: true, lowercase: true, numbers: true, special: true, specialChars: "" };
  assert.equal(alphabetSize(all), 88);
  assert.equal(alphabetSize({ ...all, special: false }), 62);
  // Custom symbols replace the default set; spaces and duplicates are dropped.
  assert.equal(alphabetSize({ ...all, specialChars: " -_. -_ " }), 65);
  // Duplicates across sets count once ("a" is already lowercase).
  assert.equal(alphabetSize({ ...all, uppercase: false, numbers: false, specialChars: "a!" }), 27);
  assert.equal(alphabetSize({ ...all, uppercase: false, lowercase: false, special: false }), 10);
});

test("password: entropy bits and strength grade", () => {
  assert.ok(Math.abs(entropyBits(16, 88) - 103.35) < 0.01);
  assert.equal(entropyBits(0, 88), 0);
  assert.equal(entropyBits(12, 1), 0);
  assert.equal(strengthLevel(entropyBits(6, 10)), 1);
  assert.equal(strengthLevel(entropyBits(8, 88)), 2);
  assert.equal(strengthLevel(entropyBits(12, 88)), 3);
  assert.equal(strengthLevel(entropyBits(16, 88)), 4);
  assert.equal(strengthFill(0), 0);
  assert.equal(strengthFill(64), 0.5);
  assert.equal(strengthFill(400), 1);
});

test("aead: output names (legacy parity)", () => {
  assert.equal(encryptedName("report.pdf"), "report.pdf.aead");
  assert.equal(decryptedName("report.pdf.aead"), "report.pdf");
  assert.equal(decryptedName("REPORT.PDF.AEAD"), "REPORT.PDF");
  assert.equal(decryptedName("blob.bin"), "blob.bin.dec");
  assert.equal(decryptedName(".aead"), ".aead.dec"); // nothing left to strip
  assert.equal(decryptedName("файл 😀.txt.aead"), "файл 😀.txt");
});

test("aead: formatDuration", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(59.9), "0:59");
  assert.equal(formatDuration(61), "1:01");
  assert.equal(formatDuration(3723), "1:02:03");
  assert.equal(formatDuration(Number.NaN), "--:--");
  assert.equal(formatDuration(-1), "--:--");
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), "--:--");
});

test("aead: container algorithm ids and header hex", () => {
  assert.equal(aeadAlgorithmId("aes-256-gcm"), 1);
  assert.equal(aeadAlgorithmId("chacha20-poly1305"), 2);
  assert.equal(aeadAlgorithmId("xchacha20-poly1305"), 3);
  assert.equal(bytesToHex(new Uint8Array([0x4d, 0x44, 0x54, 0x33, 0x00, 0x0f, 0xff])), "4d445433000fff");
  assert.equal(bytesToHex(new Uint8Array()), "");
});

test("aead: progress view (percent, speed, ETA)", () => {
  const mib = 1024 * 1024;
  const v = aeadProgressView(2 * mib, 8 * mib, 1000);
  assert.equal(v.percent, 25);
  assert.equal(v.text, "2.00 MB / 8.00 MB • 2.00 MB/s • ETA 0:03");
  // No elapsed time yet → unknown ETA, no division by zero.
  assert.match(aeadProgressView(0, mib, 0).text, /ETA --:--$/);
  // Empty file: 0 %, not NaN.
  assert.equal(aeadProgressView(0, 0, 10).percent, 0);
  // Never above 100 % even if processed overshoots.
  assert.equal(aeadProgressView(2 * mib, mib, 1000).percent, 100);
});

/* ── openssh-keys ───────────────────────────────────────────────────────── */

test("ssh: guessSshInput sniffs every supported format", () => {
  assert.equal(guessSshInput("   \n"), "empty");
  assert.equal(guessSshInput("ssh-ed25519 AAAAC3Nz me@host"), "openssh-public");
  assert.equal(guessSshInput("ssh-rsa AAAAB3Nz"), "openssh-public");
  // Regression: ECDSA public lines were "unsupported format" in the first port.
  assert.equal(guessSshInput("ecdsa-sha2-nistp256 AAAAE2Vj c"), "openssh-public");
  assert.equal(guessSshInput("ecdsa-sha2-nistp384 AAAAE2Vj"), "openssh-public");
  assert.equal(guessSshInput("-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----"), "openssh-private");
  assert.equal(guessSshInput("-----BEGIN PUBLIC KEY-----\nMCow\n-----END PUBLIC KEY-----"), "spki-public");
  assert.equal(guessSshInput("-----BEGIN PRIVATE KEY-----\nMC4C\n-----END PRIVATE KEY-----"), "pkcs8-private");
  assert.equal(guessSshInput("-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIF\n-----END ENCRYPTED PRIVATE KEY-----"), "pkcs8-private");
  assert.equal(guessSshInput("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----"), "unknown");
  assert.equal(guessSshInput("hello 😀"), "unknown");
});

test("ssh: rsaBits — explicit size wins, else algorithm suffix, else 3072", () => {
  // Regression: "RSA 4096" with key size "default" generated 3072-bit keys.
  assert.equal(rsaBits("rsa-4096", "default"), 4096);
  assert.equal(rsaBits("rsa-3072", "default"), 3072);
  assert.equal(rsaBits("rsa-3072", "4096"), 4096);
  assert.equal(rsaBits("rsa-4096", "3072"), 3072);
  assert.equal(rsaBits("rsa", "default"), 3072);
  assert.equal(rsaBits("rsa-1024", "512"), 3072); // weak sizes are never accepted
});

test("ssh: sshErrorKey maps known WASM messages", () => {
  assert.equal(sshErrorKey("passphrase required"), "ErrorPassphraseRequired");
  assert.equal(sshErrorKey("invalid passphrase or corrupted key"), "ErrorWrongPassphrase");
  assert.equal(sshErrorKey("decrypt failed"), "ErrorWrongPassphrase");
  assert.equal(sshErrorKey("invalid base64"), null);
});

/* ── x509 ───────────────────────────────────────────────────────────────── */

test("x509: parseValidityDays accepts whole days 1..36500 only", () => {
  assert.equal(parseValidityDays("365"), 365);
  assert.equal(parseValidityDays(" 1 "), 1);
  assert.equal(parseValidityDays(String(X509_MAX_VALIDITY_DAYS)), X509_MAX_VALIDITY_DAYS);
  for (const bad of ["", "0", "-1", "1.5", "1e3", "36501", "abc", "٣٦٥"]) {
    assert.equal(parseValidityDays(bad), null, bad);
  }
});

test("x509: base64ToBytes is strict and whitespace-tolerant", () => {
  assert.deepEqual([...base64ToBytes("AQID\n BA==")], [1, 2, 3, 4]);
  for (const bad of ["", "   ", "not base64 ☃", "A", "AB=C", "-----BEGIN"]) {
    assert.throws(() => base64ToBytes(bad), /invalid base64/, bad);
  }
});

test("x509: derBase64ToPem wraps at 64 chars", () => {
  const b64 = "A".repeat(130);
  const pem = derBase64ToPem(b64.slice(0, 65) + "\n" + b64.slice(65));
  const lines = pem.split("\n");
  assert.equal(lines[0], "-----BEGIN CERTIFICATE-----");
  assert.deepEqual(lines.slice(1, -1).map((l) => l.length), [64, 64, 2]);
  assert.equal(lines.at(-1), "-----END CERTIFICATE-----");
});

test("x509: prettyJson indents JSON and passes other text through", () => {
  assert.equal(prettyJson('{"a":[1]}'), '{\n  "a": [\n    1\n  ]\n}');
  assert.equal(prettyJson("not json"), "not json");
});

/* ── hash-calculator catalog ────────────────────────────────────────────── */

test("hash: catalog has 39 unique ids/labels and valid defaults", () => {
  assert.equal(HASH_ALGORITHMS.length, 39);
  assert.equal(new Set(HASH_ALGORITHMS.map((a) => a.id)).size, 39);
  assert.equal(new Set(HASH_ALGORITHMS.map((a) => a.label)).size, 39);
  const ids = new Set(HASH_ALGORITHMS.map((a) => a.id));
  assert.deepEqual([...DEFAULT_HASH_ALGORITHMS], ["md5", "sha1", "sha256"]);
  for (const id of DEFAULT_HASH_ALGORITHMS) assert.ok(ids.has(id), id);
});

test("password input: no silent trim — candidates are as typed, then trimmed", () => {
  assert.deepEqual(passwordCandidates(""), []);
  assert.deepEqual(passwordCandidates("secret"), ["secret"]);
  assert.deepEqual(passwordCandidates(" secret "), [" secret ", "secret"]);
  assert.deepEqual(passwordCandidates("pass phrase"), ["pass phrase"], "inner spaces are kept, no fallback");
  assert.deepEqual(passwordCandidates("\tкод 🔑\n"), ["\tкод 🔑\n", "код 🔑"]);
  // Whitespace-only: used as typed; an empty trimmed variant is never tried.
  assert.deepEqual(passwordCandidates("   "), ["   "]);
});

test("password input: hasEdgeWhitespace flags leading/trailing whitespace only", () => {
  assert.equal(hasEdgeWhitespace(""), false);
  assert.equal(hasEdgeWhitespace("a b"), false);
  assert.equal(hasEdgeWhitespace(" a"), true);
  assert.equal(hasEdgeWhitespace("a "), true);
  assert.equal(hasEdgeWhitespace("a\u00a0"), true);
  assert.equal(hasEdgeWhitespace("   "), true);
});

test("x509: isCsrPem recognises PKCS#10 armor only", () => {
  assert.equal(isCsrPem("-----BEGIN CERTIFICATE REQUEST-----\nAA==\n-----END CERTIFICATE REQUEST-----"), true);
  assert.equal(isCsrPem("-----BEGIN NEW CERTIFICATE REQUEST-----\nAA=="), true);
  assert.equal(isCsrPem("-----BEGIN CERTIFICATE-----\nAA=="), false);
  assert.equal(isCsrPem("MIIB"), false);
});

test("x509: parseSanList sorts DNS / IP / e-mail, lines or commas, dedupes", () => {
  const r = parseSanList("example.com, www.example.com\n*.Example.com\n192.168.1.10;2001:DB8::0:1\n admin@Example.com\nexample.com");
  assert.deepEqual(r.dns, ["example.com", "www.example.com", "*.example.com"]);
  assert.deepEqual(r.ip, ["192.168.1.10", "2001:db8::1"]);
  assert.deepEqual(r.email, ["admin@example.com"]);
  assert.deepEqual(r.invalid, []);
  assert.deepEqual(parseSanList("  \n , "), { dns: [], ip: [], email: [], invalid: [] });
});

test("x509: parseSanList accepts parser/OpenSSL prefixes, IDN and trailing dot", () => {
  const r = parseSanList("DNS:api.example.com IP:10.0.0.1 IP:::1 EMAIL:ops@example.com email:a@b.example localhost bücher.example host.example.");
  assert.deepEqual(r.dns, ["api.example.com", "localhost", "xn--bcher-kva.example", "host.example"]);
  assert.deepEqual(r.ip, ["10.0.0.1", "::1"]);
  assert.deepEqual(r.email, ["ops@example.com", "a@b.example"]);
  assert.deepEqual(r.invalid, []);
});

test("x509: parseSanList rejects malformed entries", () => {
  const bad = ["300.1.1.1", "1.2.3", "01.2.3.4", "2001:db8::g", "fe80::1%eth0", "-bad.example", "bad-.example", "a..b", "*.com", "*", "foo.*.example", "under_score.example", "x@", "@x.example", "a@*.example", "a..b@x.example", "DNS:", "IP:example.com", `${"a".repeat(64)}.example`];
  for (const entry of bad) {
    assert.deepEqual(parseSanList(entry), { dns: [], ip: [], email: [], invalid: [entry] }, entry);
  }
  assert.deepEqual(parseSanList("ok.example, 999.0.0.1").invalid, ["999.0.0.1"]);
});
