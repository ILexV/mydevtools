import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectSignatureKind,
  shellQuote,
  signatureErrorKey,
  signatureFileName,
  signatureFileText,
  verifyCommand,
  type CommandInput,
} from "../src/tools/file-signature.ts";

test("file-signature: detects SSHSIG, minisign and raw signatures", () => {
  assert.equal(detectSignatureKind("  \n"), "");
  assert.equal(detectSignatureKind("-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\n-----END SSH SIGNATURE-----\n"), "sshsig");
  assert.equal(detectSignatureKind("untrusted comment: signature from minisign secret key\nRUQ…"), "minisign");
  assert.equal(detectSignatureKind("MEUCIQD…"), "raw");
});

test("file-signature: text signature files stay text, binary ones become base64", () => {
  const armored = new TextEncoder().encode("-----BEGIN SSH SIGNATURE-----\r\nAAAA\r\n");
  assert.deepEqual(signatureFileText(armored), { text: "-----BEGIN SSH SIGNATURE-----\r\nAAAA\r\n", binary: false });
  const der = new Uint8Array([0x30, 0x45, 0x02, 0x21, 0x00, 0xff]);
  assert.deepEqual(signatureFileText(der), { text: "MEUCIQD/", binary: true });
  // Invalid UTF-8 is binary too.
  assert.equal(signatureFileText(new Uint8Array([0xc3, 0x28])).binary, true);
});

test("file-signature: WASM error codes map to locale keys", () => {
  assert.equal(signatureErrorKey("passphrase-wrong"), "ErrorPassphraseWrong");
  assert.equal(signatureErrorKey("key-private-given"), "ErrorPrivateKeyGiven");
  assert.equal(signatureErrorKey("RuntimeError: unreachable"), null);
});

test("file-signature: output name and shell quoting", () => {
  assert.equal(signatureFileName("release.tar.gz"), "release.tar.gz.sig");
  assert.equal(signatureFileName(""), "file.sig");
  assert.equal(shellQuote("data.txt"), "data.txt");
  assert.equal(shellQuote("my report.pdf"), "'my report.pdf'");
  assert.equal(shellQuote("it's.txt"), "'it'\\''s.txt'");
});

test("file-signature: verify command matches the produced format", () => {
  const base: CommandInput = { format: "sshsig", algorithm: "Ed25519", namespace: "file", hash: "sha256", padding: "pkcs1", encoding: "der", fileName: "data.txt" };
  assert.equal(verifyCommand(base), "ssh-keygen -Y verify -f allowed_signers -I signer -n file -s data.txt.sig < data.txt");
  assert.equal(
    verifyCommand({ ...base, format: "raw" }),
    "openssl pkeyutl -verify -rawin -pubin -inkey public.pem -in data.txt -sigfile data.txt.sig",
  );
  assert.equal(
    verifyCommand({ ...base, format: "raw", algorithm: "RSA 3072", hash: "sha384", padding: "pss" }),
    "openssl dgst -sha384 -sigopt rsa_padding_mode:pss -verify public.pem -signature data.txt.sig data.txt",
  );
  assert.equal(
    verifyCommand({ ...base, format: "raw", algorithm: "ECDSA P-256", padding: "pss" }),
    "openssl dgst -sha256 -verify public.pem -signature data.txt.sig data.txt",
  );
  assert.equal(verifyCommand({ ...base, format: "raw", algorithm: "ECDSA P-384", encoding: "p1363" }), null);
});
