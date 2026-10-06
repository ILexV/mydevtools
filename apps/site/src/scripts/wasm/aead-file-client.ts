/**
 * AEAD file crypto client (main thread). Chunked (1 MiB) streaming
 * encrypt/decrypt via the cryptography WASM stream API: Argon2id KDF
 * (64 MiB, 3 iters, 1 lane), random salt/nonce-prefix, per-chunk counter
 * nonces. New files are written as MDT3 (header + final-chunk flag bound
 * into every chunk's AAD → truncation/extension detected); legacy MDT2
 * containers (empty AAD, no final flag) are still decrypted. Decryption can
 * try several password candidates (as typed, then trimmed — files from the
 * old site used a trimmed password). Progress callbacks between chunks
 * (rAF-yielded); AbortSignal cancels between chunks.
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

/**
 * Where an AEAD run failed, so the UI can show a localized reason:
 * `header` — not an `.aead` container (bad magic/version/truncated header);
 * `auth` — chunk authentication failed (wrong password, tampered or
 * truncated ciphertext); `crypto` — anything else from WASM.
 */
export type AeadFailure = "header" | "auth" | "crypto";

export class AeadError extends WasmError {
  readonly failure: AeadFailure;
  constructor(failure: AeadFailure, message: string) {
    super("unknown", message);
    this.name = "AeadError";
    this.failure = failure;
  }
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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
  /** Container format: 2 = legacy MDT2 (cannot detect a cut at a chunk boundary), 3 = MDT3. */
  format: 2 | 3;
  /** Index of the password candidate that authenticated the first chunk. */
  passwordIndex: number;
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
    header = crypto.aead_stream3_header_pack(algId, KDF_ID, salt, noncePrefix, CHUNK_SIZE);
    key = crypto.aead_stream_derive_key_from_header(
      header,
      new TextEncoder().encode(password),
      KDF_MEM_KIB,
      KDF_ITERATIONS,
      KDF_PARALLELISM,
    );
  } catch (e) {
    throw new AeadError("crypto", errMessage(e));
  }

  const chunks: Uint8Array[] = [header];
  const total = file.size;
  const start = performance.now();
  let processed = 0;
  let counter = 0n;

  // MDT3 always has a final chunk, even for an empty file (do/while).
  do {
    throwIfAborted(opts.signal);
    const end = Math.min(processed + CHUNK_SIZE, total);
    const bytes = new Uint8Array(await file.slice(processed, end).arrayBuffer());
    let ciphertext: Uint8Array;
    try {
      ciphertext = crypto.aead_stream3_encrypt_chunk(header, key, counter, end >= total, bytes);
    } catch (e) {
      throw new AeadError("crypto", errMessage(e));
    }
    chunks.push(ciphertext);
    processed = end;
    counter += 1n;
    opts.onProgress?.({ processed, total, elapsedMs: performance.now() - start });
    await nextFrame();
  } while (processed < total);

  return { blob: new Blob(chunks as unknown as BlobPart[], { type: "application/octet-stream" }), headerHex: bytesToHex(header) };
}

/**
 * Decrypt an MDT3 or legacy MDT2 container → original bytes. `passwords` are
 * tried in order on the first chunk (each costs one Argon2id derivation);
 * the first that authenticates is used for the whole file.
 */
export async function aeadDecryptFile(
  file: File,
  passwords: string | readonly string[],
  opts: AeadRunOptions = {},
): Promise<AeadDecryptResult> {
  await ensureReady();
  const candidates = typeof passwords === "string" ? [passwords] : [...passwords];
  if (candidates.length === 0) throw new AeadError("crypto", "no password");

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
    throw new AeadError("header", errMessage(e));
  }

  const algId = info[0];
  const chunkSize = info[4];
  const headerLen = info[5];
  const format: 2 | 3 = info[6] === 3 ? 3 : 2;
  const total = file.size - headerLen;
  // MDT3 always carries a final chunk; a bare header means the file was cut.
  if (format === 3 && total === 0) throw new AeadError("auth", "truncated container");

  const deriveKey = (password: string): Uint8Array => {
    try {
      return crypto.aead_stream_derive_key_from_header(
        headerBytes,
        new TextEncoder().encode(password),
        KDF_MEM_KIB,
        KDF_ITERATIONS,
        KDF_PARALLELISM,
      );
    } catch (e) {
      throw new AeadError("crypto", errMessage(e));
    }
  };
  /** Throws AeadError("auth") when the tag does not verify. */
  const openChunk = (key: Uint8Array, counter: bigint, bytes: Uint8Array, isFinal: boolean): Uint8Array => {
    try {
      return format === 3
        ? crypto.aead_stream3_decrypt_chunk(headerBytes, key, counter, isFinal, bytes)
        : crypto.aead_stream_decrypt_chunk(algId, key, noncePrefix, counter, bytes, new Uint8Array());
    } catch (e) {
      throw new AeadError("auth", errMessage(e));
    }
  };

  const chunks: Uint8Array[] = [];
  const start = performance.now();
  let offset = headerLen;
  let counter = 0n;
  let key: Uint8Array | null = null;
  let passwordIndex = 0;

  if (total === 0) {
    // Legacy MDT2 of an empty file: no chunk to authenticate.
    key = deriveKey(candidates[0]);
  }

  while (offset < file.size) {
    throwIfAborted(opts.signal);
    const end = Math.min(offset + chunkSize + TAG_LEN, file.size);
    const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    const isFinal = end === file.size;
    let plaintext: Uint8Array;
    if (key) {
      plaintext = openChunk(key, counter, bytes, isFinal);
    } else {
      // First chunk: find the password candidate that authenticates it.
      let lastError: unknown = null;
      let opened: Uint8Array | null = null;
      for (let i = 0; i < candidates.length && !opened; i++) {
        throwIfAborted(opts.signal);
        const candidateKey = deriveKey(candidates[i]);
        try {
          opened = openChunk(candidateKey, counter, bytes, isFinal);
          key = candidateKey;
          passwordIndex = i;
        } catch (e) {
          lastError = e;
        }
      }
      if (!opened) throw lastError;
      plaintext = opened;
    }
    chunks.push(plaintext);
    offset = end;
    counter += 1n;
    opts.onProgress?.({ processed: offset - headerLen, total, elapsedMs: performance.now() - start });
    await nextFrame();
  }

  return {
    blob: new Blob(chunks as unknown as BlobPart[], { type: "application/octet-stream" }),
    headerHex: bytesToHex(headerBytes),
    format,
    passwordIndex,
  };
}
