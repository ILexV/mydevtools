/**
 * Base32 Encoder / Decoder client controller. Drives the `Base32Encoder.astro`
 * shell through the shared `initEncodingTool` (text + file, drag & drop,
 * progress/cancel, swap/clear/copy/download, localized errors).
 *
 * Parity with the legacy `base32-encoder.js`: charset + alphabet (RFC 4648 /
 * Crockford / z-base-32) + padding + case settings, whitespace tolerance on
 * decode, preview/full output for file encodes. No image preview — the
 * legacy tool never had one.
 */
import type { EncodingOptions } from "@/scripts/wasm/encoding-client";
import { initEncodingTool, onReady } from "@/tools/encoding-tool";

function readOptions(root: HTMLElement): EncodingOptions {
  const val = (name: string) => root.querySelector<HTMLSelectElement>(`[data-b32-${name}]`)?.value;
  const letterCase = val("case") ?? "auto";
  return {
    format: "base32",
    alphabet: val("alphabet") ?? "rfc4648",
    padding: val("padding") ?? "required",
    case: letterCase === "auto" ? null : letterCase,
    allowWhitespace: root.querySelector<HTMLInputElement>("[data-b32-allow-whitespace]")?.checked ?? true,
    charset: val("charset") ?? "utf-8",
  };
}

onReady(() => initEncodingTool({ prefix: "b32", formatName: "Base32", ext: "b32", readOptions }));
