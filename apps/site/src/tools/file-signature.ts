/**
 * File Signature pure helpers (DOM-free; unit-tested in
 * test/file-signature.test.ts): signature kind detection for the form
 * (SSHSIG / minisign / raw), binary signature files shown as base64, the
 * WASM error code → locale key map, the `.sig` output name and the matching
 * `ssh-keygen` / `openssl` command to verify a signature made here.
 */

export type SignatureKind = "sshsig" | "minisign" | "raw" | "";

/** What the pasted signature looks like (drives the namespace field and the key hint). */
export function detectSignatureKind(text: string): SignatureKind {
  const value = text.trim();
  if (!value) return "";
  if (value.includes("-----BEGIN SSH SIGNATURE-----")) return "sshsig";
  if (value.startsWith("untrusted comment:")) return "minisign";
  return "raw";
}

/**
 * A loaded signature file as text for the signature field: UTF-8 text stays
 * as is (armored SSHSIG, .minisig, hex, base64); binary bytes (openssl
 * `-out file.sig`) become base64, which the verifier accepts as well.
 */
export function signatureFileText(bytes: Uint8Array): { text: string; binary: boolean } {
  let text: string | null = null;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = null;
  }
  // Control characters other than tab/CR/LF mean a binary signature.
  if (text !== null && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    return { text, binary: false };
  }
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return { text: btoa(bin), binary: true };
}

/** Stable WASM error codes (wasm/cryptography/src/filesig.rs `E_*`) → locale keys. */
const ERROR_KEYS: Readonly<Record<string, string>> = {
  "signature-format": "ErrorSignatureFormat",
  "key-format": "ErrorKeyFormat",
  "key-unsupported": "ErrorKeyUnsupported",
  "key-private-given": "ErrorPrivateKeyGiven",
  "key-public-given": "ErrorPublicKeyGiven",
  "key-missing": "ErrorKeyMissing",
  "passphrase-required": "ErrorPassphraseRequired",
  "passphrase-wrong": "ErrorPassphraseWrong",
  "pem-legacy-encrypted": "ErrorLegacyEncryptedPem",
  "namespace-empty": "ErrorNamespaceEmpty",
  "too-large": "ErrorTooLarge",
};

export function signatureErrorKey(message: string): string | null {
  return ERROR_KEYS[message.trim()] ?? null;
}

/** Verdict failure → locale key of the explanation. */
export const FAILURE_KEYS: Readonly<Record<string, string>> = {
  signature: "FailSignature",
  namespace: "FailNamespace",
  untrusted: "FailUntrusted",
  "key-mismatch": "FailKeyMismatch",
  comment: "FailComment",
};

/** Detached signature name next to the file: `report.pdf` → `report.pdf.sig`. */
export function signatureFileName(fileName: string): string {
  return `${fileName || "file"}.sig`;
}

/** Quote a file name for a POSIX shell only when needed. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface CommandInput {
  format: "sshsig" | "raw";
  /** WASM `algorithm`: "Ed25519", "ECDSA P-256", "RSA 3072", … */
  algorithm: string;
  namespace: string;
  hash: "sha256" | "sha384" | "sha512";
  padding: "pkcs1" | "pss";
  encoding: "der" | "p1363";
  fileName: string;
}

/**
 * Command that verifies the produced signature with standard tools
 * (`allowed_signers` / `public.pem` hold the public key shown next to it).
 * Null when no stock tool reads the format (ECDSA P1363 r‖s).
 */
export function verifyCommand(o: CommandInput): string | null {
  const file = shellQuote(o.fileName || "file");
  const sig = shellQuote(signatureFileName(o.fileName));
  if (o.format === "sshsig") {
    return `ssh-keygen -Y verify -f allowed_signers -I signer -n ${shellQuote(o.namespace)} -s ${sig} < ${file}`;
  }
  if (o.algorithm === "Ed25519") {
    return `openssl pkeyutl -verify -rawin -pubin -inkey public.pem -in ${file} -sigfile ${sig}`;
  }
  if (o.algorithm.startsWith("ECDSA") && o.encoding === "p1363") return null;
  const pss = o.algorithm.startsWith("RSA") && o.padding === "pss" ? " -sigopt rsa_padding_mode:pss" : "";
  return `openssl dgst -${o.hash}${pss} -verify public.pem -signature ${sig} ${file}`;
}
