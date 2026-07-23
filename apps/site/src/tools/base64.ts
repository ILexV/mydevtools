/**
 * Base64 helpers: file-type detection from magic bytes + formatting.
 * Mirrors legacy base64-encoder detection (PNG/JPEG/GIF/WebP image preview,
 * ZIP/GZIP/ELF/PE binary info).
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

  // Binaries
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return { kind: "binary", mime: "application/zip", ext: "zip", label: "ZIP" };
  if (b[0] === 0x1f && b[1] === 0x8b) return { kind: "binary", mime: "application/gzip", ext: "gz", label: "GZIP" };
  if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return { kind: "binary", mime: "application/octet-stream", ext: "elf", label: "ELF Binary" };
  if (b[0] === 0x4d && b[1] === 0x5a) return { kind: "binary", mime: "application/octet-stream", ext: "exe", label: "Windows EXE" };

  return null;
}

/** UTF-8-validity probe for text-vs-binary classification (legacy parity). */
export function isLikelyText(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, Math.min(512, bytes.length)));
    return true;
  } catch {
    return false;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const m = Math.floor(seconds / 60);
  return `${m}m ${Math.round(seconds % 60)}s`;
}
