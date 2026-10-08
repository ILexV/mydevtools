/// <reference lib="webworker" />
/**
 * Encoding file worker. Reads the file in 1 MiB chunks with progress, then
 * runs the encode/decode via the encoding glue. The whole file is read first;
 * the client terminates this worker on success, error or cancellation.
 */
import init, * as enc from "@/generated/wasm/encoding/encoding.js";
import type { EncodingOptions } from "@/scripts/wasm/encoding-client";
import type { EncodingWorkerRequest, EncodingWorkerResponse } from "@/scripts/wasm/encoding-file-protocol";
import { WasmError } from "@/scripts/wasm/worker-protocol";

const CHUNK_SIZE = 1024 * 1024;

let ready: Promise<void> | null = null;
function ensureReady(): Promise<void> {
  if (!ready) {
    ready = init().then(() => undefined).catch((error) => {
      throw new WasmError("init-failed", error instanceof Error ? error.message : String(error));
    });
  }
  return ready;
}

function post(msg: EncodingWorkerResponse): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg);
}

/** Read file fully as bytes with progress; termination also stops this read. */
async function readFileBytes(file: File, id: number): Promise<Uint8Array> {
  const total = file.size;
  const out = new Uint8Array(total);
  const start = performance.now();
  let processed = 0;
  while (processed < total) {
    const end = Math.min(processed + CHUNK_SIZE, total);
    const buf = await file.slice(processed, end).arrayBuffer();
    out.set(new Uint8Array(buf), processed);
    processed += buf.byteLength;
    post({ type: "progress", id, processed, total, elapsedMs: performance.now() - start });
  }
  return out;
}

/** Read file fully as UTF-8 text (for decode). */
async function readFileText(file: File, id: number): Promise<string> {
  const bytes = await readFileBytes(file, id);
  return new TextDecoder().decode(bytes);
}

function encodeBytes(options: EncodingOptions, bytes: Uint8Array): string {
  switch (options.format) {
    case "base64": return enc.base64_encode(bytes, options.alphabet, options.padding, options.lineWrap);
    case "base32": return enc.base32_encode(bytes, options.alphabet, options.padding, options.case);
    case "base58": return enc.base58_encode(bytes, options.alphabet);
    case "hex": return enc.hex_encode(bytes, options.upper);
    case "url": return enc.url_encode(bytes, options.mode);
  }
}

function decodeText(options: EncodingOptions, input: string): Uint8Array {
  switch (options.format) {
    case "base64": return enc.base64_decode(input, options.alphabet, options.padding, options.allowWhitespace);
    case "base32": return enc.base32_decode(input, options.alphabet, options.padding, options.allowWhitespace);
    case "base58": return enc.base58_decode(input, options.alphabet, options.allowWhitespace);
    case "hex": return enc.hex_decode(input, options.ignoreWhitespace, options.allowSeparators, options.allow0x);
    case "url": return enc.url_decode(input, options.mode);
  }
}

self.addEventListener("message", async (ev: MessageEvent<EncodingWorkerRequest>) => {
  const req = ev.data;
  const { id, direction, options, file } = req;
  try {
    await ensureReady();
    let text = "";
    let bytes: Uint8Array | undefined;
    if (direction === "encode") {
      const buf = await readFileBytes(file, id);
      text = encodeBytes(options, buf);
    } else {
      const input = await readFileText(file, id);
      bytes = decodeText(options, input);
    }
    const result = { type: "result", id, direction, text, bytes } satisfies EncodingWorkerResponse;
    // Bindings return standalone byte arrays; transfer them instead of cloning.
    if (bytes) (self as DedicatedWorkerGlobalScope).postMessage(result, [bytes.buffer as ArrayBuffer]);
    else post(result);
  } catch (e) {
    post({ type: "error", id, code: e instanceof WasmError ? e.code : "unknown", message: e instanceof Error ? e.message : String(e) });
  }
});

export {};
