/**
 * Base58 Encoder / Decoder client controller. Drives the `Base58Encoder.astro`
 * shell through the shared `initEncodingTool` (text + file, drag & drop,
 * progress/cancel, swap/clear/copy/download, localized errors).
 *
 * Base58 big-int math is O(n²), so input is capped (legacy: encode 1 MiB;
 * the crate rejects more than 2 000 000 encoded chars, so decode uses that).
 * The worker reports real progress while READING a file; the base58 math is
 * one opaque call, so the bar fills during the read and stays full meanwhile.
 */
import type { EncodingOptions } from "@/scripts/wasm/encoding-client";
import { initEncodingTool, onReady } from "@/tools/encoding-tool";

const ENCODE_LIMIT = 1024 * 1024; // raw bytes (1 MiB)
const DECODE_LIMIT = 2_000_000; // encoded chars (crate MAX_BASE58_INPUT_LEN)
/** "Load example" sample (language-neutral; a short JSON payload). */
const EXAMPLE = '{"id":42,"tag":"b58"}';

function readOptions(root: HTMLElement): EncodingOptions {
  const val = (name: string) => root.querySelector<HTMLSelectElement>(`[data-b58-${name}]`)?.value;
  return {
    format: "base58",
    alphabet: val("alphabet") || "bitcoin",
    allowWhitespace: root.querySelector<HTMLInputElement>("[data-b58-allow-whitespace]")?.checked ?? true,
    charset: val("charset") || "utf-8",
  };
}

onReady(() =>
  initEncodingTool({
    prefix: "b58",
    toolId: "base58-encoder",
    formatName: "Base58",
    ext: "b58",
    readOptions,
    example: EXAMPLE,
    encodeLimit: ENCODE_LIMIT,
    decodeLimit: DECODE_LIMIT,
  }),
);
