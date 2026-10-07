/**
 * Pure helpers shared by the QR code generator and scanner controllers:
 * hex color normalization (text field ↔ color picker), mapping raw WASM error
 * messages (English, from the `qrcode` crate) to localized-message kinds,
 * image MIME checks for the formats the crate can decode, the URL test
 * for the scanner's "Open link" action, and the generator's live-preview
 * advice: luminance contrast, pixels per module (from the SVG geometry) and
 * a latest-request gate. No DOM access — unit tested.
 */

/** Image MIME types the `qrcode` crate decodes (image crate features: png, jpeg, webp). */
export const QR_IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];

/** Normalize "#abc123" / "ABC123" (surrounding spaces ok) to "#ABC123"; null if not 6 hex digits. */
export function normalizeHexColor(value: string): string | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return m ? `#${m[1].toUpperCase()}` : null;
}

export type QrGenerateErrorKind = "tooLong" | "invalidColor" | "generic";

/** Classify a `generate_qr_png/svg` error message (qrcode crate: "data too long"). */
export function classifyGenerateError(message: string): QrGenerateErrorKind {
  if (/too long/i.test(message)) return "tooLong";
  if (/invalid hex color|invalid (red|green|blue) component/i.test(message)) return "invalidColor";
  return "generic";
}

export type QrDecodeErrorKind = "unsupportedImage" | "noQr";

/** Classify a `decode_qr` error: image could not be loaded vs. no QR code found. */
export function classifyDecodeError(message: string): QrDecodeErrorKind {
  return /failed to load image/i.test(message) ? "unsupportedImage" : "noQr";
}

/** True for any image/* MIME (scanner accepts the file; the decoder may still reject it). */
export function isImageType(type: string): boolean {
  return type.toLowerCase().startsWith("image/");
}

/** True when the logo/scan file type is one the WASM decoder supports. */
export function isDecodableImageType(type: string): boolean {
  return QR_IMAGE_TYPES.includes(type.toLowerCase());
}

/** Legacy parity: decoded text is offered as a link only for http(s) URLs. */
export function isHttpUrl(text: string): boolean {
  if (!/^https?:\/\//i.test(text)) return false;
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}

/** Longest side of a camera frame sent to the decoder (keeps rxing fast). */
export const CAMERA_FRAME_MAX = 1024;

/** Downscaled frame size: longest side ≤ `max`, aspect kept, never upscaled; null if unknown. */
export function cameraFrameSize(width: number, height: number, max = CAMERA_FRAME_MAX): { width: number; height: number } | null {
  if (!(width > 0 && height > 0)) return null;
  const k = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

export type CameraErrorKind = "denied" | "notFound" | "inUse" | "insecure" | "generic";

/**
 * Map a `getUserMedia` failure (DOMException name) to a localized-message
 * kind: permission denied, no camera, camera busy, insecure context.
 */
export function classifyCameraError(name: string | undefined): CameraErrorKind {
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "notFound";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "inUse";
    case "insecure":
      return "insecure";
    default:
      return "generic";
  }
}

/** WCAG relative luminance (0 = black … 1 = white) of a "#RRGGBB" colour; null if invalid. */
export function relativeLuminance(hex: string): number | null {
  const norm = normalizeHexColor(hex);
  if (!norm) return null;
  const channel = (i: number) => {
    const c = parseInt(norm.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Contrast ratio below which the QR colour pair gets a scanning-reliability warning. */
export const QR_MIN_CONTRAST = 4.5;

/** "ok" | "low" (ratio < 4.5:1) | "inverted" (modules as light as or lighter than the background). */
export type QrContrastLevel = "ok" | "low" | "inverted";

export interface QrContrast {
  /** Exact WCAG luminance contrast ratio (1…21). */
  ratio: number;
  /** Ratio truncated to one decimal for display, so a warned value never reads as ≥ 4.5. */
  display: number;
  level: QrContrastLevel;
}

/**
 * Luminance contrast between QR module (foreground) and background colours
 * for the colour-controls hint. Scanners expect dark modules on a light
 * background: equal or reversed luminance is "inverted" (stronger warning
 * than merely low contrast). Advice only — never a scannability guarantee.
 */
export function assessQrContrast(fg: string, bg: string): QrContrast | null {
  const lf = relativeLuminance(fg);
  const lb = relativeLuminance(bg);
  if (lf === null || lb === null) return null;
  const ratio = (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05);
  const display = Math.floor(ratio * 10 + 1e-9) / 10;
  const level: QrContrastLevel = lf >= lb ? "inverted" : ratio < QR_MIN_CONTRAST ? "low" : "ok";
  return { ratio, display, level };
}

/** Quiet zone (light border) in modules the encoder keeps around the code in PNG and SVG. */
export const QR_QUIET_ZONE = 4;

/** Smallest module size in pixels before the preview warns about scanning reliability. */
export const QR_MIN_PX_PER_MODULE = 4;

/**
 * Pixels per module in the PNG raster: mirrors `generate_qr_png` in the
 * qrcode crate (integer module size over code width + 2 × 4-module quiet zone).
 */
export function pixelsPerModule(size: number, modules: number): number {
  if (!(size > 0 && modules > 0)) return 0;
  return Math.floor(size / (modules + 2 * QR_QUIET_ZONE));
}

/**
 * Read the QR matrix width (modules, without quiet zone) and the quiet zone
 * from `generate_qr_svg` markup: canvas width / module unit, where the first
 * dark module (finder corner) sits at quietZone × unit. Lets the controller
 * know the code density without a separate WASM export. Null if unparsable.
 */
export function svgModuleGeometry(svg: string): { modules: number; quietZone: number } | null {
  const w = /<svg[^>]*\swidth="(\d+)"/.exec(svg);
  const first = /<path[^>]*\sd="M(\d+) (\d+)h(\d+)v/.exec(svg);
  if (!w || !first) return null;
  const width = Number(w[1]);
  const offset = Number(first[1]);
  const unit = Number(first[3]);
  if (!(unit > 0) || width % unit !== 0 || offset % unit !== 0) return null;
  const quietZone = offset / unit;
  const modules = width / unit - 2 * quietZone;
  return modules > 0 ? { modules, quietZone } : null;
}

/**
 * Latest-request gate for live preview: `begin()` issues a new id and makes
 * every older id stale, so a slow earlier generation can never overwrite a
 * newer result (out-of-order async). `invalidate()` drops all in-flight work
 * (e.g. input cleared).
 */
export function createLatestGate(): { begin(): number; isCurrent(id: number): boolean; invalidate(): void } {
  let latest = 0;
  return {
    begin: () => ++latest,
    isCurrent: (id) => id === latest,
    invalidate: () => { latest++; },
  };
}
