/// <reference lib="webworker" />
/**
 * File signature Web Worker (cryptography WASM). Verify: parse the signature
 * and trusted key(s) first (fails fast on bad input or an early verdict such
 * as a namespace mismatch, before reading the file), then stream the file in
 * 1 MiB chunks into the digests the signature needs and return the verdict.
 * Sign: parse (and decrypt) the private key, stream, sign. Pure Ed25519 and
 * legacy minisign need the whole file, capped at 128 MiB. Cancel = the
 * client terminates us.
 */
import { readBlobChunks } from "@/scripts/blob-chunks";
import init, { FileSignatureVerifier, FileSigner } from "@/generated/wasm/cryptography/cryptography.js";
import type { JobResponse } from "@/scripts/wasm/job-worker";
import type { FileSignatureReply, FileSignatureRequest } from "@/scripts/wasm/file-signature-protocol";
import { classifyWorkerError } from "@/scripts/wasm/worker-protocol";

const CHUNK_SIZE = 1024 * 1024;
const MAX_WHOLE_FILE = 128 * 1024 * 1024;

let ready: Promise<void> | null = null;
function ensureReady(): Promise<void> {
  if (!ready) ready = init().then(() => undefined);
  return ready;
}

function post(msg: JobResponse<FileSignatureReply>): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg);
}

interface Streaming {
  info(): string;
  update(chunk: Uint8Array): void;
}

async function stream(id: number, file: File, job: Streaming): Promise<string> {
  const info = job.info();
  const plan = JSON.parse(info) as { wholeFile?: boolean; failure?: string };
  if (plan.failure) return info;
  if (plan.wholeFile && file.size > MAX_WHOLE_FILE) throw new Error("too-large");
  const start = performance.now();
  post({ id, type: "progress", processed: 0, total: file.size, elapsedMs: 0 });
  for await (const chunk of readBlobChunks(file, { chunkBytes: CHUNK_SIZE })) {
    job.update(chunk.bytes);
    post({ id, type: "progress", processed: chunk.end, total: file.size, elapsedMs: performance.now() - start });
  }
  return info;
}

async function run(req: FileSignatureRequest): Promise<FileSignatureReply> {
  if (req.op === "verify") {
    const verifier = new FileSignatureVerifier(req.signature, req.key, req.namespace);
    try {
      const info = await stream(req.id, req.file, verifier);
      return { info, result: verifier.finish() };
    } finally {
      verifier.free();
    }
  }
  const signer = new FileSigner(req.key, req.passphrase || undefined, JSON.stringify(req.options));
  try {
    const info = await stream(req.id, req.file, signer);
    return { info, result: signer.finish() };
  } finally {
    signer.free();
  }
}

self.addEventListener("message", async (ev: MessageEvent<FileSignatureRequest>) => {
  const req = ev.data;
  try {
    await ensureReady();
    post({ id: req.id, ok: true, ...(await run(req)) });
  } catch (e) {
    const { code, message } = classifyWorkerError(e);
    post({ id: req.id, ok: false, code, message });
  }
});

export {}; // module
