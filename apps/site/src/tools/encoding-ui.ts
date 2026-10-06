/**
 * Pure helpers shared by the encoding tool controllers (base64/32/58, hex,
 * url): map raw English WASM error messages from the `encoding` crate to
 * localized error keys (+ caret position), and truncate huge outputs for the
 * "preview" output mode. No DOM, no aliases — unit-tested in
 * `test/encoding-ui.test.ts`.
 */

/** Locale keys (per tool namespace) for user-facing decode/encode errors. */
export type EncodingErrorKey =
  | "Error_InvalidChar"
  | "Error_NotRepresentable"
  | "Error_InvalidLength"
  | "Error_Whitespace"
  | "Error_Padding"
  | "Error_NotText"
  | "Error_InvalidData";

export interface ClassifiedError {
  key: EncodingErrorKey;
  /** 0-based char index of the offending input character, when known. */
  position?: number;
}

/**
 * Classify an `encoding` crate error message. Order matters: specific
 * patterns (charset, whitespace, padding, length) win over the generic
 * "<Format> decode error" fallback.
 */
export function classifyEncodingError(message: string): ClassifiedError {
  const pos = /position (\d+)/.exec(message);
  const position = pos ? Number.parseInt(pos[1], 10) : undefined;

  if (/not representable in Latin-1|Non-ASCII character/.test(message)) {
    return { key: "Error_NotRepresentable", position };
  }
  if (/Invalid UTF-8|UTF-16(LE|BE)|not representable in ASCII/.test(message)) {
    return { key: "Error_NotText" };
  }
  if (/^Invalid hex character/.test(message)) return { key: "Error_InvalidChar", position };
  if (/Whitespace not allowed/.test(message)) return { key: "Error_Whitespace" };
  if (/Padding '=' is not allowed/.test(message)) return { key: "Error_Padding" };
  if (/Invalid (Base64|hex) length|Invalid (last symbol|length|padding)|Truncated % encoding/i.test(message)) {
    return { key: "Error_InvalidLength" };
  }
  return { key: "Error_InvalidData", position };
}

/**
 * Text shown in the output box: the full text, or (preview mode and longer
 * than `limit`) the first `limit` chars + a newline + `suffix`.
 */
export function previewText(text: string, mode: string, limit: number, suffix: string): { text: string; truncated: boolean } {
  if (mode === "full" || text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}\n…${suffix}`, truncated: true };
}

/** "photo.png" → "photo.png.b64"; empty/absent name → "<fallback>.<ext>". */
export function outputFileName(sourceName: string | null | undefined, ext: string, fallback = "text"): string {
  const base = sourceName && sourceName.trim() ? sourceName : fallback;
  return `${base}.${ext}`;
}
