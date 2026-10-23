/**
 * File signature client (main thread). Runs verify/sign jobs in
 * `file-signature.worker` so hashing a multi-gigabyte file never blocks the
 * page; aborting terminates the worker and rejects with `WasmError("aborted")`.
 * The worker and the cryptography WASM load on first use only.
 */
import { createJobWorker, type JobProgress } from "@/scripts/wasm/job-worker";
import type { FileSignatureReply, FileSignatureRequest, SignOptions } from "@/scripts/wasm/file-signature-protocol";

type Req = FileSignatureRequest extends infer R ? (R extends unknown ? Omit<R, "id"> : never) : never;

const jobs = createJobWorker<Req, FileSignatureReply>(
  () => new Worker(new URL("../../workers/file-signature.worker.ts", import.meta.url), { type: "module" }),
);

/** Parsed `FileSignatureVerifier` verdict (see wasm/cryptography/src/filesig.rs). */
export interface VerifyVerdict {
  valid: boolean;
  failure?: "signature" | "namespace" | "untrusted" | "key-mismatch" | "comment";
  format: "sshsig" | "minisign" | "raw";
  algorithm: string;
  scheme?: string;
  hash?: string;
  encoding?: string;
  fingerprint?: string;
  publicKey?: string;
  namespace?: string;
  /** SSHSIG: true = key found in the trusted list, false = not found, null/absent = no list given. */
  trusted?: boolean | null;
  principal?: string;
  keyId?: string;
  expectedKeyId?: string;
  trustedComment?: string;
}

export interface SignInfo {
  format: "sshsig" | "raw";
  algorithm: string;
  fingerprint: string;
  publicKey: string;
  publicKeyPem: string;
  scheme: string;
  namespace: string;
}

export interface SignOutput {
  info: SignInfo;
  /** SSHSIG armored text. */
  armored?: string;
  /** Raw signature bytes (base64 from WASM, decoded here). */
  signature?: Uint8Array;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function verifyFileSignature(
  file: File,
  signature: Uint8Array,
  key: string,
  namespace: string,
  signal?: AbortSignal,
  onProgress?: (info: JobProgress) => void,
): Promise<VerifyVerdict> {
  const res = await jobs.run({ op: "verify", file, signature, key, namespace }, undefined, signal, onProgress);
  return JSON.parse(res.result) as VerifyVerdict;
}

export async function signFile(
  file: File,
  key: string,
  passphrase: string,
  options: SignOptions,
  signal?: AbortSignal,
  onProgress?: (info: JobProgress) => void,
): Promise<SignOutput> {
  const res = await jobs.run({ op: "sign", file, key, passphrase, options }, undefined, signal, onProgress);
  const out = JSON.parse(res.result) as { armored?: string; signature?: string };
  return {
    info: JSON.parse(res.info) as SignInfo,
    armored: out.armored,
    signature: out.signature === undefined ? undefined : base64ToBytes(out.signature),
  };
}
