/**
 * AEAD file crypto client (main thread). Chunked (1 MiB) streaming
 * encrypt/decrypt via the cryptography WASM stream API — exact legacy
 * flow: Argon2id KDF (64 MiB, 3 iters, 1 lane), random salt/nonce-prefix,
 * per-chunk counter nonces, empty AAD. Progress callbacks between chunks
 * (rAF-yielded so the UI stays responsive); AbortSignal cancels between
 * chunks. Caches the module init promise.
 */
import init, * as crypto from "@/generated/wasm/cryptography/cryptography.js";
import { WasmError } from "@/scripts/wasm/worker-protocol";

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

export type AeadAlgorithm = "aes-256-gcm" | "chacha20-poly1305" | "xchacha20-poly1305";

export interface AeadProgress {
  processed: number;
  total: number;
  elapsedMs: number;
}

export interface AeadRunOptions {
  onProgress?: (info: AeadProgress) => void;
  signal?: AbortSignal;
}

export interface AeadEncryptResult {
  blob: Blob;
  headerHex: string;
}

export interface AeadDecryptResult {
  blob: Blob;
  headerHex: string;
}

function algorithmId(algorithm: AeadAlgorithm): number {
  if (algorithm === "chacha20-poly1305") return 2;
  if (algorithm === "xchacha20-poly1305") return 3;
  return 1;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function nextFrame(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  requestAnimationFrame(() => resolve());
  return promise;
}

/** Encrypt a file → .aead container (header + per-chunk ciphertext). */
export async function aeadEncryptFile(
  file: File,
  password: string,
  algorithm: AeadAlgorithm,
  opts: AeadRunOptions = {},
): Promise<AeadEncryptResult> {
  await ensureReady();
  const algId = algorithmId(algorithm);
  const salt = new Uint8Array(16);
  globalThis.crypto.getRandomValues(salt);
  const noncePrefix = new Uint8Array(algId === 3 ? 16 : 4);
  globalThis.crypto.getRandomValues(noncePrefix);

  let header: Uint8Array;
  let key: Uint8Array;
  try {
    header = crypto.aead_stream_header_pack(algId, KDF_ID, salt, noncePrefix, CHUNK_SIZE);
    key = crypto.aead_stream_derive_key_from_header(
      header,
      new TextEncoder().encode(password),
      KDF_MEM_KIB,
      KDF_ITERATIONS,
      KDF_PARALLELISM,
    );
  } catch (e) {
    throw new WasmError("unknown", e instanceof Error ? e.message : String(e));
  }

  const chunks: Uint8Array[] = [header];
  const total = file.size;
  const start = performance.now();
  let processed = 0;
  let counter = 0n;

  while (processed < total) {
    throwIfAborted(opts.signal);
    const slice = file.slice(processed, Math.min(processed + CHUNK_SIZE, total));
    const bytes = new Uint8Array(await slice.arrayBuffer());
    let ciphertext: Uint8Array;
    try {
      ciphertext = crypto.aead_stream_encrypt_chunk(algId, key, noncePrefix, counter, bytes, new Uint8Array());
    } catch (e) {
      throw new WasmError("unknown", e instanceof Error ? e.message : String(e));
    }
    chunks.push(ciphertext);
    processed += slice.size;
    counter += 1n;
    opts.onProgress?.({ processed, total, elapsedMs: performance.now() - start });
    await nextFrame();
  }

  return { blob: new Blob(chunks as unknown as BlobPart[], { type: "application/octet-stream" }), headerHex: bytesToHex(header) };
}

/** Decrypt an .aead container → original bytes. */
export async function aeadDecryptFile(
  file: File,
  password: string,
  opts: AeadRunOptions = {},
): Promise<AeadDecryptResult> {
  await ensureReady();

  let info: Uint32Array;
  let headerBytes: Uint8Array;
  let key: Uint8Array;
  let noncePrefix: Uint8Array;
  try {
    const headerPreview = new Uint8Array(await file.slice(0, 128).arrayBuffer());
    // [algoId, kdfId, saltLen, noncePrefixLen, chunkSize, headerLen]
    info = crypto.aead_stream_header_info(headerPreview);
    const headerLen = info[5];
    headerBytes = new Uint8Array(await file.slice(0, headerLen).arrayBuffer());
    noncePrefix = crypto.aead_stream_extract_nonce_prefix(headerBytes);
    key = crypto.aead_stream_derive_key_from_header(
      headerBytes,
      new TextEncoder().encode(password),
      KDF_MEM_KIB,
      KDF_ITERATIONS,
      KDF_PARALLELISM,
    );
  } catch (e) {
    throw new WasmError("unknown", e instanceof Error ? e.message : String(e));
  }

  const algId = info[0];
  const chunkSize = info[4];
  const headerLen = info[5];
  const chunks: Uint8Array[] = [];
  const total = file.size - headerLen;
  const start = performance.now();
  let offset = headerLen;
  let counter = 0n;

  while (offset < file.size) {
    throwIfAborted(opts.signal);
    const slice = file.slice(offset, Math.min(offset + chunkSize + TAG_LEN, file.size));
    const bytes = new Uint8Array(await slice.arrayBuffer());
    let plaintext: Uint8Array;
    try {
      plaintext = crypto.aead_stream_decrypt_chunk(algId, key, noncePrefix, counter, bytes, new Uint8Array());
    } catch (e) {
      throw new WasmError("unknown", e instanceof Error ? e.message : String(e));
    }
    chunks.push(plaintext);
    offset += bytes.length;
    counter += 1n;
    opts.onProgress?.({ processed: offset - headerLen, total, elapsedMs: performance.now() - start });
    await nextFrame();
  }

  return { blob: new Blob(chunks as unknown as BlobPart[], { type: "application/octet-stream" }), headerHex: bytesToHex(headerBytes) };
}
