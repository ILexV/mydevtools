/**
 * Cryptography WASM client (main thread). One-shot HMAC/JWT/OpenSSH/X.509
 * operations — no file chunking, so no worker. Caches the module init
 * promise; normalizes thrown values into typed `WasmError`.
 */
import init, * as crypto from "@/generated/wasm/cryptography/cryptography.js";
import { WasmError } from "@/scripts/wasm/worker-protocol";

let ready: Promise<void> | null = null;
function ensureReady(): Promise<void> {
  if (!ready) ready = init().then(() => undefined);
  return ready;
}

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new WasmError("unknown", message);
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.replace(/[\s:-]/g, "");
  if (cleaned.length % 2 !== 0 || /[^0-9a-fA-F]/.test(cleaned)) {
    throw new WasmError("unknown", "Invalid hex input");
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export type HmacAlgorithm = "sha256" | "sha512";
export type HmacKeyFormat = "text" | "hex";
export type HmacOutputFormat = "hex" | "base64";

/** HMAC over a text message. Key may be raw text or hex. */
export async function hmacCompute(
  algorithm: HmacAlgorithm,
  key: string,
  message: string,
  keyFormat: HmacKeyFormat,
  outputFormat: HmacOutputFormat,
): Promise<string> {
  await ensureReady();
  return wrap(() => {
    const keyBytes = keyFormat === "hex" ? hexToBytes(key) : textEncoder.encode(key);
    const digest =
      algorithm === "sha512"
        ? crypto.hmac_sha512(keyBytes, textEncoder.encode(message))
        : crypto.hmac_sha256(keyBytes, textEncoder.encode(message));
    return outputFormat === "base64" ? btoa(String.fromCharCode(...digest)) : bytesToHex(digest);
  });
}

/** Decoded JWT as pretty JSON { header, payload, signature, ... } (WASM-defined shape). */
export async function jwtDecode(token: string): Promise<string> {
  await ensureReady();
  return wrap(() => crypto.jwt_decode(token));
}

export async function jwtVerify(token: string, secret: string, alg: string): Promise<boolean> {
  await ensureReady();
  return wrap(() => crypto.jwt_verify(token, secret, alg));
}

export async function jwtSign(
  headerJson: string,
  payloadJson: string,
  secret: string,
  alg: string,
): Promise<string> {
  await ensureReady();
  return wrap(() => crypto.jwt_sign(headerJson, payloadJson, secret, alg));
}

/* ── OpenSSH ─────────────────────────────────────────────────────────────── */

export type SshKeyType = "ed25519" | "ecdsa-p256" | "ecdsa-p384" | "rsa";

export interface SshKeyPair {
  privateKey: string;
  publicKey: string;
}

/** Generate an OpenSSH key pair (new-format private key + public key line). */
export async function sshGenerate(
  keyType: SshKeyType,
  comment: string,
  passphrase: string,
): Promise<SshKeyPair> {
  await ensureReady();
  return wrap(() => {
    const c = comment || null;
    const p = passphrase || null;
    switch (keyType) {
      case "ed25519": {
        const priv = crypto.openssh_ed25519_private_key(crypto.ed25519_generate_keypair().slice(0, 32), c, p, null);
        const pub = crypto.openssh_private_key_to_public_key_line(priv, p, c);
        return { privateKey: priv, publicKey: pub };
      }
      case "ecdsa-p256": {
        const priv = crypto.openssh_ecdsa_p256_private_key(crypto.ecdsa_p256_generate_keypair().slice(0, 32), c, p, null);
        const pub = crypto.openssh_private_key_to_public_key_line(priv, p, c);
        return { privateKey: priv, publicKey: pub };
      }
      case "ecdsa-p384": {
        const priv = crypto.openssh_ecdsa_p384_private_key(crypto.ecdsa_p384_generate_keypair().slice(0, 48), c, p, null);
        const pub = crypto.openssh_private_key_to_public_key_line(priv, p, c);
        return { privateKey: priv, publicKey: pub };
      }
      case "rsa": {
        const priv = crypto.openssh_rsa_private_key_from_pkcs8(crypto.rsa_generate_private_key_pkcs8(3072), c, p, null);
        const pub = crypto.openssh_private_key_to_public_key_line(priv, p, c);
        return { privateKey: priv, publicKey: pub };
      }
    }
  });
}

export interface SshPublicKeyInfo {
  algorithm: string;
  comment: string;
  warnings: string[];
}

/** Inspect a public key line. */
export async function sshPublicKeyInfo(line: string): Promise<SshPublicKeyInfo> {
  await ensureReady();
  return wrap(() => {
    const algNum = crypto.openssh_public_key_algorithm(line);
    const warnings = crypto.openssh_public_key_warnings(line);
    const comment = line.trim().split(/\s+/).slice(2).join(" ");
    const algorithms: Record<number, string> = { 1: "ssh-ed25519", 2: "ecdsa-sha2-nistp256", 3: "ecdsa-sha2-nistp384", 4: "ssh-rsa" };
    return { algorithm: algorithms[algNum] ?? `unknown(${algNum})`, comment, warnings };
  });
}

/** PKCS#8 PEM export of an OpenSSH private key. */
export async function sshToPkcs8Pem(pem: string, passphrase: string): Promise<string> {
  await ensureReady();
  return wrap(() => crypto.openssh_private_key_to_pkcs8_pem(pem, passphrase || null));
}

/* ── X.509 ───────────────────────────────────────────────────────────────── */

/** Parse a PEM/DER certificate → pretty JSON summary (WASM-defined shape). */
export async function x509Parse(input: string): Promise<string> {
  await ensureReady();
  return wrap(() => {
    const trimmed = input.trim();
    if (trimmed.startsWith("-----BEGIN")) return crypto.x509_parse_pem(trimmed);
    return crypto.x509_parse_der(hexToBytes(trimmed));
  });
}

export async function x509Warnings(pem: string): Promise<string[]> {
  await ensureReady();
  return wrap(() => crypto.x509_warnings_pem(pem, BigInt(Math.floor(Date.now() / 1000))));
}

export interface X509GenerateResult {
  privateKey: string;
  certificate: string;
}

/** Self-signed certificate + private key (PEM). algorithm: 1=ecdsa-p256, 2=ecdsa-p384, 3=ed25519. */
export async function x509SelfSigned(
  algorithm: number,
  subjectCn: string,
  sanDns: string[],
  sanIp: string[],
): Promise<X509GenerateResult> {
  await ensureReady();
  return wrap(() => {
    const [privateKey, certificate] = crypto.x509_self_signed_pem(algorithm, subjectCn || null, sanDns, sanIp);
    return { privateKey, certificate };
  });
}

export interface X509CsrResult {
  privateKey: string;
  csr: string;
}

/** CSR + private key (PEM). */
export async function x509Csr(
  algorithm: number,
  subjectCn: string,
  sanDns: string[],
  sanIp: string[],
): Promise<X509CsrResult> {
  await ensureReady();
  return wrap(() => {
    const [privateKey, csr] = crypto.x509_csr_pem(algorithm, subjectCn || null, sanDns, sanIp);
    return { privateKey, csr };
  });
}

export { bytesToHex, hexToBytes, textEncoder, textDecoder };
