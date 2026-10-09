/**
 * Message protocol between `aead-file-client` and `aead-file.worker`
 * (Argon2id key derivation + chunked AEAD encrypt/decrypt off the main
 * thread). One job per worker at a time; `id` correlates replies. The File
 * travels by structured clone and the worker reads it in 1 MiB chunks; the
 * result comes back as a Blob. Cancel = the client terminates the worker
 * (the synchronous Argon2id call can't be interrupted cooperatively).
 */
import type { WasmErrorCode } from "@/scripts/wasm/worker-protocol";

export type AeadAlgorithm = "aes-256-gcm" | "chacha20-poly1305" | "xchacha20-poly1305";

/**
 * Where an AEAD run failed, so the UI can show a localized reason:
 * `header` — not an `.aead` container (bad magic/version/truncated header);
 * `auth` — chunk authentication failed (wrong password, tampered or
 * truncated ciphertext); `crypto` — anything else from WASM.
 */
export type AeadFailure = "header" | "auth" | "crypto";

export type AeadWorkerRequest =
  | { id: number; op: "encrypt"; file: File; password: string; algorithm: AeadAlgorithm }
  | { id: number; op: "decrypt"; file: File; passwords: string[] };

export type AeadWorkerResponse =
  | { id: number; type: "progress"; processed: number; total: number; elapsedMs: number }
  | { id: number; type: "result"; blob: Blob; headerHex: string; format: 2 | 3; passwordIndex: number }
  | { id: number; type: "error"; failure: AeadFailure; message: string; code?: WasmErrorCode };
