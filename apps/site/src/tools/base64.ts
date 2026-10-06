/**
 * Base64 helpers: file-type detection from magic bytes + text probe.
 * Mirrors legacy base64-encoder detection: image preview for
 * PNG/JPEG/GIF/WebP/BMP/ICO/TIFF/SVG, binary info for PDF/ZIP/GZIP/ELF/PE/MP3/MP4.
 */

export type DetectedKind = "image" | "binary" | "text";

export interface DetectedFile {
  kind: DetectedKind;
  mime: string;
  ext: string;
  label: string;
}

export function detectFileType(b: Uint8Array): DetectedFile | null {
  if (b.length < 4) return null;

  // Images
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { kind: "image", mime: "image/png", ext: "png", label: "PNG" };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: "image", mime: "image/jpeg", ext: "jpg", label: "JPEG" };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { kind: "image", mime: "image/gif", ext: "gif", label: "GIF" };
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return { kind: "image", mime: "image/webp", ext: "webp", label: "WebP" };
  if (b[0] === 0x42 && b[1] === 0x4d) return { kind: "image", mime: "image/bmp", ext: "bmp", label: "BMP" };
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return { kind: "image", mime: "image/x-icon", ext: "ico", label: "ICO" };
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a))
    return { kind: "image", mime: "image/tiff", ext: "tiff", label: "TIFF" };
  // SVG is text, but legacy previews it as an image.
  const head = latin1Head(b, 64).trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("svg"))) {
    return { kind: "image", mime: "image/svg+xml", ext: "svg", label: "SVG" };
  }

  // Binaries
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return { kind: "binary", mime: "application/pdf", ext: "pdf", label: "PDF" };
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return { kind: "binary", mime: "application/zip", ext: "zip", label: "ZIP" };
  if (b[0] === 0x1f && b[1] === 0x8b) return { kind: "binary", mime: "application/gzip", ext: "gz", label: "GZIP" };
  if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return { kind: "binary", mime: "application/octet-stream", ext: "elf", label: "ELF Binary" };
  if (b[0] === 0x4d && b[1] === 0x5a) return { kind: "binary", mime: "application/octet-stream", ext: "exe", label: "PE Binary" };
  if ((b[0] === 0xff && (b[1] === 0xfb || b[1] === 0xf3 || b[1] === 0xf2)) || (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33))
    return { kind: "binary", mime: "audio/mpeg", ext: "mp3", label: "MP3" };
  if (b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70)
    return { kind: "binary", mime: "video/mp4", ext: "mp4", label: "MP4/MOV" };

  return null;
}

function latin1Head(b: Uint8Array, n: number): string {
  let out = "";
  for (let i = 0; i < Math.min(n, b.length); i++) out += String.fromCharCode(b[i]);
  return out;
}

/**
 * Text-vs-binary probe (legacy parity): the first 512 bytes must be valid
 * UTF-8 with < 10 % control characters (tab/LF/VT/FF/CR allowed). A
 * multi-byte sequence cut at the 512-byte boundary is tolerated.
 */
export function isLikelyText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  const sample = bytes.subarray(0, Math.min(512, bytes.length));
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: sample.length < bytes.length });
  } catch {
    return false;
  }
  if (decoded.length === 0) return true;
  let control = 0;
  for (let i = 0; i < decoded.length; i++) {
    const code = decoded.charCodeAt(i);
    if (code < 0x09 || (code > 0x0d && code < 0x20)) control++;
  }
  return control / decoded.length < 0.1;
}
