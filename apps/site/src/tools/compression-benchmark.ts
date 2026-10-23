/**
 * Compression benchmark helpers: codecs and their level ranges, the level list parser, the
 * sample sizes, and the derived numbers (ratio, saving, throughput) shown in the results table
 * and its CSV. Gzip, Brotli and Zstandard run in WASM; "gzip-native" is the browser's own
 * CompressionStream, which has no level.
 */

export type BenchCodec = "gzip" | "brotli" | "zstd" | "gzip-native";

export const BENCH_CODECS: readonly BenchCodec[] = ["gzip", "brotli", "zstd", "gzip-native"];

/** Inclusive level range per codec; mirrors `level_range` in wasm/compression. */
export const BENCH_LEVELS: Readonly<Record<BenchCodec, readonly [number, number]>> = {
  gzip: [0, 9],
  brotli: [0, 11],
  zstd: [1, 22],
  "gzip-native": [0, 0],
};

export const BENCH_DEFAULT_LEVELS: Readonly<Record<BenchCodec, string>> = {
  gzip: "1, 6, 9",
  brotli: "1, 5, 9",
  zstd: "1, 3, 9, 19",
  "gzip-native": "",
};

export const BENCH_SAMPLE_MIB = [1, 4, 16, 64, 256] as const;
export const BENCH_DEFAULT_SAMPLE_MIB = 16;
export const BENCH_MAX_LEVELS = 12;
export const BENCH_CHUNK_BYTES = 1024 * 1024;

export class LevelListError extends Error {
  readonly codec: BenchCodec;
  constructor(codec: BenchCodec, message: string) {
    super(message);
    this.name = "LevelListError";
    this.codec = codec;
  }
}

/** "1, 3-5 9" → [1, 3, 4, 5, 9]: commas or spaces, ranges with a hyphen, sorted, no repeats. */
export function parseLevels(codec: BenchCodec, text: string): number[] {
  const [min, max] = BENCH_LEVELS[codec];
  if (min === max) return [min];
  const levels = new Set<number>();
  for (const part of text.split(/[\s,;]+/u).filter(Boolean)) {
    const range = /^(-?\d+)(?:\s*[-–]\s*(-?\d+))?$/u.exec(part);
    if (!range) throw new LevelListError(codec, `Bad level "${part}"`);
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    if (from < min || to > max || from > to) throw new LevelListError(codec, `Levels must be ${min}..${max}`);
    for (let level = from; level <= to; level++) levels.add(level);
    if (levels.size > BENCH_MAX_LEVELS) throw new LevelListError(codec, `At most ${BENCH_MAX_LEVELS} levels`);
  }
  if (levels.size === 0) throw new LevelListError(codec, "No levels");
  return [...levels].sort((a, b) => a - b);
}

export interface BenchResult {
  codec: BenchCodec;
  level: number;
  inputBytes: number;
  outputBytes: number;
  compressMs: number;
  /** null when decompression was not checked. */
  decompressMs: number | null;
  /** Growth of the WASM heap during compression; null for the browser codec. */
  compressMemory: number | null;
  decompressMemory: number | null;
  /** The decompressed bytes matched the input (CRC-32 and length). */
  verified: boolean | null;
}

/** Input size / output size, e.g. 4.2 means the data shrank to a quarter. */
export function compressionRatio(result: Pick<BenchResult, "inputBytes" | "outputBytes">): number {
  return result.outputBytes > 0 ? result.inputBytes / result.outputBytes : 0;
}

/** Share of bytes saved, 0..1 (negative when the output grew). */
export function savedShare(result: Pick<BenchResult, "inputBytes" | "outputBytes">): number {
  return result.inputBytes > 0 ? 1 - result.outputBytes / result.inputBytes : 0;
}

/** Bytes per second of input. */
export function throughput(bytes: number, ms: number): number {
  return ms > 0 ? bytes / (ms / 1000) : 0;
}

/** File extension of a codec's output. */
export function codecExtension(codec: BenchCodec): string {
  return codec === "brotli" ? "br" : codec === "zstd" ? "zst" : "gz";
}

/** Results as CSV with raw numbers (bytes, milliseconds, bytes per second). */
export function resultsCsv(results: readonly BenchResult[]): string {
  const header = "codec,level,input_bytes,output_bytes,ratio,saved_percent,compress_ms,compress_bytes_per_s,decompress_ms,decompress_bytes_per_s,compress_wasm_memory_bytes,decompress_wasm_memory_bytes,verified";
  const lines = results.map((r) => [
    r.codec,
    r.codec === "gzip-native" ? "" : String(r.level),
    r.inputBytes,
    r.outputBytes,
    compressionRatio(r).toFixed(4),
    (savedShare(r) * 100).toFixed(2),
    r.compressMs.toFixed(1),
    Math.round(throughput(r.inputBytes, r.compressMs)),
    r.decompressMs === null ? "" : r.decompressMs.toFixed(1),
    r.decompressMs === null ? "" : Math.round(throughput(r.inputBytes, r.decompressMs)),
    r.compressMemory ?? "",
    r.decompressMemory ?? "",
    r.verified === null ? "" : String(r.verified),
  ].join(","));
  return `${[header, ...lines].join("\n")}\n`;
}
