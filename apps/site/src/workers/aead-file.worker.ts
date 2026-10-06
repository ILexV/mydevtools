/// <reference lib="webworker" />
/**
 * AEAD file Web Worker (cryptography WASM): Argon2id key derivation
 * (64 MiB, 3 iters, 1 lane, ~1 s) and chunked (1 MiB) streaming
 * encrypt/decrypt off the main thread, so the page never freezes. Writes
 * MDT3 (header + final-chunk flag bound into every chunk's AAD → truncation
 * and extension detected); still reads legacy MDT2 (empty AAD, no final
 * flag). Decrypt tries password candidates (as typed, then trimmed) on the
 * first chunk. Progress after each chunk; cancel = client terminates us.
 */
import init, * as crypto from "@/generated/wasm/cryptography/cryptography.js";
import type { AeadFailure, AeadWorkerRequest, AeadWorkerResponse } from "@/scripts/wasm/aead-file-protocol";
import { aeadAlgorithmId, bytesToHex } from "@/tools/aead-file-helpers";

let ready: Promise<void> | null = null;
function ensureReady(): Promise<void> {
  if (!ready) ready = init().then(() => undefined);
  return ready;
}

const CHUNK_SIZE = 1024 * 1024; // 1 MiB, legacy parity
const KDF_ID = 1; // Argon2id
const KDF_MEM_KIB = 64 * 1024;
const KDF_ITERATIONS = 3;
const KDF_PARALLELISM = 1;
const TAG_LEN = 16;

class AeadFail extends Error {
  readonly failure: AeadFailure;
  constructor(failure: AeadFailure, e: unknown) {
    super(e instanceof Error ? e.message : String(e));
    this.failure = failure;
  }
}

function post(msg: AeadWorkerResponse): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg);
}

function progress(id: number, processed: number, total: number, start: number): void {
  post({ id, type: "progress", processed, total, elapsedMs: performance.now() - start });
}

function deriveKey(header: Uint8Array, password: string): Uint8Array {
  try {
    return crypto.aead_stream_derive_key_from_header(
      header,
      new TextEncoder().encode(password),
      KDF_MEM_KIB,
      KDF_ITERATIONS,
      KDF_PARALLELISM,
    );
  } catch (e) {
    throw new AeadFail("crypto", e);
  }
}

async function encrypt(req: Extract<AeadWorkerRequest, { op: "encrypt" }>): Promise<AeadWorkerResponse> {
  const { id, file } = req;
  const algId = aeadAlgorithmId(req.algorithm);
  const salt = new Uint8Array(16);
  globalThis.crypto.getRandomValues(salt);
  const noncePrefix = new Uint8Array(algId === 3 ? 16 : 4);
  globalThis.crypto.getRandomValues(noncePrefix);

  let header: Uint8Array;
  try {
    header = crypto.aead_stream3_header_pack(algId, KDF_ID, salt, noncePrefix, CHUNK_SIZE);
  } catch (e) {
    throw new AeadFail("crypto", e);
  }
  const key = deriveKey(header, req.password);

  const chunks: Uint8Array[] = [header];
  const total = file.size;
  const start = performance.now();
  let processed = 0;
  let counter = 0n;

  // MDT3 always has a final chunk, even for an empty file (do/while).
  do {
    const end = Math.min(processed + CHUNK_SIZE, total);
    const bytes = new Uint8Array(await file.slice(processed, end).arrayBuffer());
    try {
      chunks.push(crypto.aead_stream3_encrypt_chunk(header, key, counter, end >= total, bytes));
    } catch (e) {
      throw new AeadFail("crypto", e);
    }
    processed = end;
    counter += 1n;
    progress(id, processed, total, start);
  } while (processed < total);

  return {
    id,
    type: "result",
    blob: new Blob(chunks as unknown as BlobPart[], { type: "application/octet-stream" }),
    headerHex: bytesToHex(header),
    format: 3,
    passwordIndex: 0,
  };
}

async function decrypt(req: Extract<AeadWorkerRequest, { op: "decrypt" }>): Promise<AeadWorkerResponse> {
  const { id, file, passwords: candidates } = req;
  if (candidates.length === 0) throw new AeadFail("crypto", "no password");

  let info: Uint32Array;
  let headerBytes: Uint8Array;
  let noncePrefix: Uint8Array;
  try {
    const headerPreview = new Uint8Array(await file.slice(0, 128).arrayBuffer());
    // [algoId, kdfId, saltLen, noncePrefixLen, chunkSize, headerLen, format]
    info = crypto.aead_stream_header_info(headerPreview);
    headerBytes = new Uint8Array(await file.slice(0, info[5]).arrayBuffer());
    noncePrefix = crypto.aead_stream_extract_nonce_prefix(headerBytes);
    // Unknown algorithm or a zero chunk size cannot come from this tool.
    if (info[0] < 1 || info[0] > 3 || info[4] === 0) throw new Error("unsupported AEAD header");
  } catch (e) {
    throw new AeadFail("header", e);
  }

  const algId = info[0];
  const chunkSize = info[4];
  const headerLen = info[5];
  const format: 2 | 3 = info[6] === 3 ? 3 : 2;
  const total = file.size - headerLen;
  // MDT3 always carries a final chunk; a bare header means the file was cut.
  if (format === 3 && total === 0) throw new AeadFail("auth", "truncated container");

  /** Throws AeadFail("auth") when the tag does not verify. */
  const openChunk = (key: Uint8Array, counter: bigint, bytes: Uint8Array, isFinal: boolean): Uint8Array => {
    try {
      return format === 3
        ? crypto.aead_stream3_decrypt_chunk(headerBytes, key, counter, isFinal, bytes)
        : crypto.aead_stream_decrypt_chunk(algId, key, noncePrefix, counter, bytes, new Uint8Array());
    } catch (e) {
      throw new AeadFail("auth", e);
    }
  };

  const chunks: Uint8Array[] = [];
  const start = performance.now();
  let offset = headerLen;
  let counter = 0n;
  let key: Uint8Array | null = null;
  let passwordIndex = 0;

  // Legacy MDT2 of an empty file: no chunk to authenticate.
  if (total === 0) key = deriveKey(headerBytes, candidates[0]);

  while (offset < file.size) {
    const end = Math.min(offset + chunkSize + TAG_LEN, file.size);
    const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    const isFinal = end === file.size;
    let plaintext: Uint8Array | null = null;
    if (key) {
      plaintext = openChunk(key, counter, bytes, isFinal);
    } else {
      // First chunk: find the password candidate that authenticates it.
      let lastError: unknown = null;
      for (let i = 0; i < candidates.length && !plaintext; i++) {
        const candidateKey = deriveKey(headerBytes, candidates[i]);
        try {
          plaintext = openChunk(candidateKey, counter, bytes, isFinal);
          key = candidateKey;
          passwordIndex = i;
        } catch (e) {
          lastError = e;
        }
      }
      if (!plaintext) throw lastError;
    }
    chunks.push(plaintext);
    offset = end;
    counter += 1n;
    progress(id, offset - headerLen, total, start);
  }

  return {
    id,
    type: "result",
    blob: new Blob(chunks as unknown as BlobPart[], { type: "application/octet-stream" }),
    headerHex: bytesToHex(headerBytes),
    format,
    passwordIndex,
  };
}

self.addEventListener("message", async (ev: MessageEvent<AeadWorkerRequest>) => {
  const req = ev.data;
  try {
    await ensureReady();
    post(req.op === "encrypt" ? await encrypt(req) : await decrypt(req));
  } catch (e) {
    const failure: AeadFailure = e instanceof AeadFail ? e.failure : "crypto";
    post({ id: req.id, type: "error", failure, message: e instanceof Error ? e.message : String(e) });
  }
});
