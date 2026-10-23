/// <reference lib="webworker" />
/**
 * Compression benchmark worker. The page starts a fresh worker for every measurement, so the
 * WASM heap growth it reports belongs to that one codec and level. The sample is read into
 * memory first; only the codec calls are timed. `save` streams the whole file through the
 * chosen codec to a download.
 */
import init, { Crc32, Decoder, Encoder, type InitOutput } from "@/generated/wasm/compression/compression.js";
import { classifyWorkerError, createWorkerByteWriter } from "@/scripts/wasm/worker-protocol";
import { BENCH_CHUNK_BYTES, type BenchCodec } from "@/tools/compression-benchmark";

export type BenchRequest =
  | { type: "compress"; file: File; codec: BenchCodec; level: number; sampleBytes: number; keep: boolean }
  | { type: "decompress"; codec: BenchCodec; chunks: ArrayBuffer[] }
  | { type: "save"; file: File; codec: BenchCodec; level: number; stream: MessagePort };

export type BenchSuccess =
  | { kind: "compress"; inputBytes: number; outputBytes: number; ms: number; memory: number | null; crc: number; chunks: ArrayBuffer[] }
  | { kind: "decompress"; bytes: number; ms: number; memory: number | null; crc: number }
  | { kind: "save"; inputBytes: number; outputBytes: number };

type BenchMessage =
  | ({ id: number; ok: true } & BenchSuccess)
  | { id: number; ok: false; message: string; code?: string }
  | { id: number; type: "progress"; processed: number; total: number; elapsedMs: number };

let wasm: Promise<InitOutput> | null = null;

function ready(): Promise<InitOutput> {
  if (!wasm) {
    wasm = init().catch((error: unknown) => {
      wasm = null;
      throw error;
    });
  }
  return wasm;
}

function post(message: BenchMessage, transfer: Transferable[] = []): void {
  (self as DedicatedWorkerGlobalScope).postMessage(message, transfer);
}

function ticker(id: number, total: number) {
  const started = performance.now();
  let last = 0;
  return (processed: number, force = false) => {
    const now = performance.now();
    if (!force && now - last < 100) return;
    last = now;
    post({ id, type: "progress", processed, total, elapsedMs: now - started });
  };
}

async function readSample(file: File, bytes: number): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  const end = Math.min(file.size, bytes);
  for (let pos = 0; pos < end; pos += BENCH_CHUNK_BYTES) {
    chunks.push(new Uint8Array(await file.slice(pos, Math.min(end, pos + BENCH_CHUNK_BYTES)).arrayBuffer()));
  }
  return chunks;
}

/** Runs a browser CompressionStream/DecompressionStream over `input`, collecting the output. */
async function nativeStream(stream: CompressionStream | DecompressionStream, input: readonly Uint8Array[], onOutput: (bytes: Uint8Array) => void, onInput?: (bytes: number) => void): Promise<void> {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const reading = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      onOutput(value);
    }
  })();
  let fed = 0;
  for (const chunk of input) {
    await writer.write(chunk as Uint8Array<ArrayBuffer>);
    fed += chunk.length;
    onInput?.(fed);
  }
  await writer.close();
  await reading;
}

async function compress(id: number, request: Extract<BenchRequest, { type: "compress" }>): Promise<BenchSuccess> {
  const exports = await ready();
  const sample = await readSample(request.file, request.sampleBytes);
  const inputBytes = sample.reduce((sum, chunk) => sum + chunk.length, 0);
  const tick = ticker(id, inputBytes);
  const out: Uint8Array[] = [];
  let outputBytes = 0;
  const collect = (bytes: Uint8Array) => {
    outputBytes += bytes.length;
    if (request.keep && bytes.length > 0) out.push(bytes);
  };
  const crcOfInput = new Crc32();
  for (const chunk of sample) crcOfInput.update(chunk);
  const crc = crcOfInput.value() >>> 0;
  crcOfInput.free();
  let ms: number;
  let memory: number | null = null;
  if (request.codec === "gzip-native") {
    const started = performance.now();
    await nativeStream(new CompressionStream("gzip"), sample, collect, (fed) => tick(fed));
    ms = performance.now() - started;
  } else {
    const baseline = exports.memory.buffer.byteLength;
    const started = performance.now();
    const encoder = new Encoder(request.codec, request.level, inputBytes, null);
    try {
      let fed = 0;
      for (const chunk of sample) {
        collect(encoder.push(chunk));
        fed += chunk.length;
        tick(fed);
      }
      collect(encoder.finish());
    } finally {
      encoder.free();
    }
    ms = performance.now() - started;
    memory = exports.memory.buffer.byteLength - baseline;
  }
  tick(inputBytes, true);
  const chunks = out.map((bytes) => (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer);
  return { kind: "compress", inputBytes, outputBytes, ms, memory, crc, chunks };
}

async function decompress(id: number, request: Extract<BenchRequest, { type: "decompress" }>): Promise<BenchSuccess> {
  const exports = await ready();
  const input = request.chunks.map((buffer) => new Uint8Array(buffer));
  const total = input.reduce((sum, chunk) => sum + chunk.length, 0);
  const tick = ticker(id, total);
  let bytes = 0;
  let ms: number;
  let memory: number | null = null;
  let crc: number;
  if (request.codec === "gzip-native") {
    const hasher = new Crc32();
    const started = performance.now();
    await nativeStream(new DecompressionStream("gzip"), input, (out) => { bytes += out.length; hasher.update(out); }, (fed) => tick(fed));
    ms = performance.now() - started;
    crc = hasher.value() >>> 0;
    hasher.free();
  } else {
    const baseline = exports.memory.buffer.byteLength;
    const started = performance.now();
    const decoder = new Decoder(request.codec);
    try {
      let fed = 0;
      const drain = () => {
        for (let out = decoder.read(BENCH_CHUNK_BYTES); out.length > 0; out = decoder.read(BENCH_CHUNK_BYTES)) bytes += out.length;
      };
      for (const chunk of input) {
        decoder.write(chunk);
        drain();
        fed += chunk.length;
        tick(fed);
      }
      decoder.end();
      drain();
      crc = decoder.output_crc32() >>> 0;
    } finally {
      decoder.free();
    }
    ms = performance.now() - started;
    memory = exports.memory.buffer.byteLength - baseline;
  }
  tick(total, true);
  return { kind: "decompress", bytes, ms, memory, crc };
}

async function save(id: number, request: Extract<BenchRequest, { type: "save" }>): Promise<BenchSuccess> {
  await ready();
  const writer = createWorkerByteWriter(request.stream);
  const tick = ticker(id, request.file.size);
  let outputBytes = 0;
  const pending: Uint8Array[] = [];
  let pendingBytes = 0;
  // Coalesce small codec outputs into ~1 MiB transfers.
  const emit = async (bytes: Uint8Array, flush = false) => {
    if (bytes.length > 0) {
      pending.push(bytes);
      pendingBytes += bytes.length;
      outputBytes += bytes.length;
    }
    if (pendingBytes === 0 || (!flush && pendingBytes < BENCH_CHUNK_BYTES)) return;
    const joined = new Uint8Array(pendingBytes);
    let at = 0;
    for (const part of pending) { joined.set(part, at); at += part.length; }
    pending.length = 0;
    pendingBytes = 0;
    await writer.write(joined);
  };
  const file = request.file;
  if (request.codec === "gzip-native") {
    const stream = file.stream().pipeThrough(new CompressionStream("gzip"));
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await emit(value);
      tick(Math.min(file.size, outputBytes));
    }
  } else {
    const name = request.codec === "gzip" ? file.name : null;
    const encoder = new Encoder(request.codec, request.level, file.size, name);
    try {
      for (let pos = 0; pos < file.size; pos += BENCH_CHUNK_BYTES) {
        const chunk = new Uint8Array(await file.slice(pos, pos + BENCH_CHUNK_BYTES).arrayBuffer());
        await emit(encoder.push(chunk));
        tick(pos + chunk.length);
      }
      await emit(encoder.finish());
    } finally {
      encoder.free();
    }
  }
  await emit(new Uint8Array(0), true);
  writer.close();
  tick(file.size, true);
  return { kind: "save", inputBytes: file.size, outputBytes };
}

async function handle(id: number, request: BenchRequest): Promise<void> {
  try {
    const result = request.type === "compress" ? await compress(id, request)
      : request.type === "decompress" ? await decompress(id, request)
      : await save(id, request);
    post({ id, ok: true, ...result }, result.kind === "compress" ? result.chunks : []);
  } catch (error) {
    const message = typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
    const classified = classifyWorkerError(error, /^(corrupt|truncated|checksum|invalid):/u.test(message) ? "unknown" : "worker-failed");
    post({ id, ok: false, code: classified.code, message: classified.message || message });
  }
}

let queue = Promise.resolve();
self.addEventListener("message", (event: MessageEvent<BenchRequest & { id: number }>) => {
  const { id, ...request } = event.data;
  queue = queue.then(() => handle(id, request as BenchRequest));
});
