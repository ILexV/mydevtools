/**
 * Pure helpers shared by the image-compressor / image-converter /
 * image-resizer controllers: output naming (download file names), MIME types,
 * "keep original format" resolution, savings %, aspect-ratio lock math and
 * resize-dimension validation (mirrors the Rust limits in wasm/image_tools).
 * No DOM — unit-tested under node --test (test/image-tools.test.ts).
 */

/** Same limits as `MAX_DIMENSION` / `MAX_PIXELS` in wasm/image_tools/src/lib.rs. */
export const MAX_RESIZE_DIMENSION = 16_384;
export const MAX_RESIZE_PIXELS = 64 * 1024 * 1024;

/** Formats the image_tools WASM module can decode (input check before WASM). */
const DECODABLE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/x-ms-bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/tiff",
  "image/x-tga",
  "image/x-targa",
]);

/** True for an image MIME type (`image/*`), the controllers' accept rule. */
export function isImageFile(file: { type: string }): boolean {
  return file.type.startsWith("image/");
}

/** True when the WASM decoder supports the file's MIME type. */
export function isDecodableImage(file: { type: string; name?: string }): boolean {
  if (DECODABLE_MIME.has(file.type.toLowerCase())) return true;
  // Some OSes report "" for .tga/.ico — fall back to the extension.
  return file.type === "" && /\.(tga|ico|tiff?|bmp)$/i.test(file.name ?? "");
}

/** File name without the last extension (`a.b.png` → `a.b`, `README` → `README`). */
export function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Download extension for a target format (`jpeg` → `jpg`, `tiff` stays). */
export function extensionFor(format: string): string {
  const f = format.toLowerCase();
  return f === "jpeg" ? "jpg" : f;
}

/** Blob MIME type for a target format (legacy parity: ico → image/x-icon). */
export function mimeFor(format: string): string {
  const f = format.toLowerCase();
  if (f === "jpg" || f === "jpeg") return "image/jpeg";
  if (f === "ico") return "image/x-icon";
  if (f === "tga") return "image/x-tga";
  return `image/${f}`;
}

/**
 * Compressor "Keep original format": jpeg → jpeg, png → png, anything else →
 * webp (legacy parity). Explicit choices pass through.
 */
export function resolveCompressFormat(selected: string, sourceMime: string): string {
  if (selected !== "original") return selected;
  const sub = sourceMime.split("/")[1] ?? "";
  return sub === "jpeg" ? "jpeg" : sub === "png" ? "png" : "webp";
}

/** Resizer default output format from the source extension (jpg → jpeg, unknown → png). */
export function guessResizeFormat(fileName: string): string {
  const ext = (fileName.split(".").pop() ?? "").toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "jpeg";
  if (ext === "png" || ext === "webp") return ext;
  return "png";
}

/** Compressor download name: `<base>_min.<ext>`. */
export function compressedName(fileName: string, format: string): string {
  return `${baseName(fileName)}_min.${extensionFor(format)}`;
}

/** Converter download name: `<base>.<ext>`. */
export function convertedName(fileName: string, format: string): string {
  return `${baseName(fileName)}.${extensionFor(format)}`;
}

/** Resizer download name: `<base>_<w>x<h>.<ext>`. */
export function resizedName(fileName: string, width: number, height: number, format: string): string {
  return `${baseName(fileName)}_${width}x${height}.${extensionFor(format)}`;
}

/** Rounded % saved (positive = smaller output); 0 for an empty source. */
export function savingsPercent(originalSize: number, newSize: number): number {
  if (!(originalSize > 0)) return 0;
  return Math.round((1 - newSize / originalSize) * 100);
}

/**
 * Aspect-ratio lock: the other dimension for an edited value, or null when it
 * shouldn't change (unknown original size or non-positive input).
 */
export function lockedDimension(
  edited: "width" | "height",
  value: number,
  originalWidth: number,
  originalHeight: number,
): number | null {
  if (!(originalWidth > 0 && originalHeight > 0) || !(value > 0)) return null;
  const ratio = originalWidth / originalHeight;
  return Math.max(1, Math.round(edited === "width" ? value / ratio : value * ratio));
}

export type DimensionError = "invalid" | "too-large";

/**
 * Parse width/height field values. Positive integers only (a negative number
 * would wrap to a huge u32 in WASM); `too-large` past the WASM limits.
 */
export function parseResizeDimensions(
  widthText: string,
  heightText: string,
): { width: number; height: number } | { error: DimensionError } {
  const parse = (s: string) => (/^\s*\d+\s*$/.test(s) ? Number.parseInt(s, 10) : NaN);
  const width = parse(widthText);
  const height = parse(heightText);
  if (!(width > 0) || !(height > 0)) return { error: "invalid" };
  if (width > MAX_RESIZE_DIMENSION || height > MAX_RESIZE_DIMENSION || width * height > MAX_RESIZE_PIXELS) {
    return { error: "too-large" };
  }
  return { width, height };
}

/**
 * Signed size change for the result headline / comparison: "−42%" when the
 * output is smaller, "+12%" when it grew (never presented as savings), "0%".
 * Uses the true minus sign (U+2212) like the rest of the image tools.
 */
export function formatSizeChange(originalSize: number, newSize: number): string {
  const saved = savingsPercent(originalSize, newSize);
  return saved > 0 ? `−${saved}%` : saved < 0 ? `+${-saved}%` : "0%";
}

/**
 * True when an image-tools failure means the input couldn't be decoded — not
 * an image, a damaged file or an unsupported variant. wasm/image_tools
 * `decode` prefixes these with "Failed to load image:" (unknown bytes are
 * retried as TGA, so a text file reads "…decoder for Tga…"); browsers report
 * "could not be decoded". Controllers show a localized "isn't a supported
 * image or is damaged" message instead of the raw decoder text.
 */
export function isImageDecodeError(message: string): boolean {
  return /^Failed to load image\b/i.test(message) || /could not be decoded|source image cannot be decoded/i.test(message);
}
