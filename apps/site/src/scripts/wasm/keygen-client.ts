/**
 * Key generation client (main thread). Runs OpenSSH key pair generation in
 * `crypto-keygen.worker` so RSA 3072/4096 (seconds to a minute in WASM)
 * keeps the page responsive. Aborting the signal terminates the worker and
 * rejects with `WasmError("aborted")`; the next call starts a fresh worker.
 * Same lifecycle as `image-tools-client`.
 *
 * Network: worker + wasm load only on first generation (openssh-keys page).
 */
import { WasmError } from "@/scripts/wasm/worker-protocol";
import type { SshKeygenRequest, SshKeygenResponse, SshKeygenType } from "@/scripts/wasm/keygen-protocol";

let worker: Worker | null = null;
let nextId = 1;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../../workers/crypto-keygen.worker.ts", import.meta.url), { type: "module" });
  }
  return worker;
}

function killWorker(): void {
  worker?.terminate();
  worker = null;
}

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

/** Generate an OpenSSH key pair in the worker; abort → terminate. */
export function sshGenerateInWorker(opts: SshKeygenOptions, signal?: AbortSignal): Promise<SshGeneratedKey> {
  if (signal?.aborted) return Promise.reject(new WasmError("aborted", "Aborted"));
  const w = getWorker();
  const id = nextId++;
  const { promise, resolve, reject } = Promise.withResolvers<SshGeneratedKey>();

  const onMsg = (ev: MessageEvent<SshKeygenResponse>) => {
    const m = ev.data;
    if (m.id !== id) return;
    cleanup();
    if (m.ok) resolve({ privateKey: m.privateKey, publicKey: m.publicKey, warnings: m.warnings });
    else reject(new WasmError("unknown", m.message));
  };
  const onError = (ev: ErrorEvent) => {
    // Worker crashed (e.g. WASM trap): drop it so the next job gets a fresh one.
    cleanup();
    killWorker();
    reject(new WasmError("unknown", ev.message || "Worker error"));
  };
  const onAbort = () => {
    cleanup();
    killWorker();
    reject(new WasmError("aborted", "Aborted"));
  };
  function cleanup() {
    w.removeEventListener("message", onMsg);
    w.removeEventListener("error", onError);
    signal?.removeEventListener("abort", onAbort);
  }

  w.addEventListener("message", onMsg);
  w.addEventListener("error", onError);
  signal?.addEventListener("abort", onAbort, { once: true });
  const req: SshKeygenRequest = {
    id,
    op: "ssh-generate",
    keyType: opts.keyType,
    rsaBits: opts.rsaBits ?? 3072,
    passphrase: opts.passphrase ?? null,
    comment: opts.comment ?? null,
  };
  w.postMessage(req);
  return promise;
}
