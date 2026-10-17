/**
 * Key generation client (main thread). Runs OpenSSH key pair generation in
 * `crypto-keygen.worker` so RSA 3072/4096 (seconds to a minute in WASM)
 * keeps the page responsive. Aborting the signal terminates the worker and
 * rejects with `WasmError("aborted")`; the next call starts a fresh worker.
 * Same lifecycle as `image-tools-client`.
 *
 * Network: worker + wasm load only on first generation (openssh-keys page).
 */
import { createJobWorker } from "@/scripts/wasm/job-worker";
import type { SshKeygenRequest, SshKeygenResponse, SshKeygenType } from "@/scripts/wasm/keygen-protocol";

type SshKeygenJob = Omit<SshKeygenRequest, "id">;
type SshKeygenSuccess = Extract<SshKeygenResponse, { ok: true }>;
const jobs = createJobWorker<SshKeygenJob, SshKeygenSuccess>(
  () => new Worker(new URL("../../workers/crypto-keygen.worker.ts", import.meta.url), { type: "module" }),
);

export interface SshKeygenOptions {
  keyType: SshKeygenType;
  rsaBits?: number;
  passphrase?: string | null;
  comment?: string | null;
}

export interface SshGeneratedKey {
  privateKey: string;
  publicKey: string;
  warnings: string[];
}

/** Generate an OpenSSH key pair in the worker; abort terminates all work on that exact worker. */
export async function sshGenerateInWorker(opts: SshKeygenOptions, signal?: AbortSignal): Promise<SshGeneratedKey> {
  const result = await jobs.run({
    op: "ssh-generate",
    keyType: opts.keyType,
    rsaBits: opts.rsaBits ?? 3072,
    passphrase: opts.passphrase ?? null,
    comment: opts.comment ?? null,
  }, [], signal);
  return {
    privateKey: result.privateKey,
    publicKey: result.publicKey,
    warnings: result.warnings,
  };
}
