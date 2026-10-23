/**
 * Message protocol between `file-signature-client` and
 * `file-signature.worker` (cryptography WASM `FileSignatureVerifier` /
 * `FileSigner`). The File travels by structured clone and is hashed in
 * 1 MiB chunks; key material stays in the worker only for the job.
 * Replies carry the WASM JSON verdict/info as strings; failures carry the
 * stable WASM error code (`key-format`, `passphrase-wrong`, …) as `message`.
 */
export interface SignOptions {
  format: "sshsig" | "raw";
  namespace: string;
  hash: "sha256" | "sha384" | "sha512";
  padding: "pkcs1" | "pss";
  encoding: "der" | "p1363";
}

export type FileSignatureRequest =
  | { id: number; op: "verify"; file: File; signature: Uint8Array; key: string; namespace: string }
  | { id: number; op: "sign"; file: File; key: string; passphrase: string; options: SignOptions };

export interface FileSignatureReply {
  /** Plan JSON from `info()` (algorithm, fingerprint, public key, …). */
  info: string;
  /** Verdict JSON (verify) or `{armored}` / `{signature}` JSON (sign). */
  result: string;
}
