/**
 * Hex Encoder / Decoder client controller. Drives the `HexEncoder.astro`
 * shell through the shared `initEncodingTool` (text + file, drag & drop,
 * progress/cancel, swap/clear/copy/download, localized errors).
 *
 * Parity with the legacy `hex-encoder.js`: charset + case (lower/upper)
 * settings, decode toggles (ignore whitespace, allow `:`/`-` separators,
 * allow a `0x` prefix per token), preview/full output for file encodes.
 * Errors carrying a "position N" marker select the offending character.
 */
import type { EncodingOptions } from "@/scripts/wasm/encoding-client";
import { initEncodingTool, onReady } from "@/tools/encoding-tool";

function readOptions(root: HTMLElement): EncodingOptions {
  const val = (name: string) => root.querySelector<HTMLSelectElement>(`[data-hex-${name}]`)?.value;
  const checked = (name: string) => root.querySelector<HTMLInputElement>(`[data-hex-${name}]`)?.checked ?? true;
  return {
    format: "hex",
    upper: val("case") === "upper",
    ignoreWhitespace: checked("ignore-whitespace"),
    allowSeparators: checked("allow-separators"),
    allow0x: checked("allow-0x"),
    charset: val("charset") ?? "utf-8",
  };
}

/** "Load example" sample: non-ASCII on purpose, so multi-byte UTF-8 shows in the hex. */
const EXAMPLE = "café ☕ #42";

onReady(() => initEncodingTool({ prefix: "hex", formatName: "hex", ext: "hex", readOptions, example: EXAMPLE }));
