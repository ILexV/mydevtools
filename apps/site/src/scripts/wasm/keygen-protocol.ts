/**
 * Message protocol between `keygen-client` and `crypto-keygen.worker`
 * (OpenSSH key pair generation off the main thread — RSA 4096 takes tens of
 * seconds in WASM). One job per message; `id` correlates replies so a stale
 * answer from a cancelled job is ignored. Cancellation terminates the worker
 * (the synchronous WASM keygen can't be interrupted cooperatively).
 */
export type SshKeygenType = "ed25519" | "ecdsa-p256" | "ecdsa-p384" | "rsa";

export interface SshKeygenRequest {
  id: number;
  op: "ssh-generate";
  keyType: SshKeygenType;
  /** RSA modulus size (3072 | 4096); ignored for other key types. */
  rsaBits: number;
  /** Encrypts the private key when non-null; used exactly as given. */
  passphrase: string | null;
  comment: string | null;
}

export type SshKeygenResponse =
  | { id: number; ok: true; privateKey: string; publicKey: string; warnings: string[] }
  | { id: number; ok: false; message: string };
