/**
 * Pure helpers shared by the QR code generator and scanner controllers:
 * hex color normalization (text field ↔ color picker), mapping raw WASM error
 * messages (English, from the `qrcode` crate) to localized-message kinds,
 * image MIME checks for the formats the crate can decode, and the URL test
 * for the scanner's "Open link" action. No DOM access — unit tested.
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
