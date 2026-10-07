import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cameraFrameSize,
  classifyCameraError,
  normalizeHexColor,
  classifyGenerateError,
  classifyDecodeError,
  isImageType,
  isDecodableImageType,
  isHttpUrl,
  relativeLuminance,
  assessQrContrast,
  pixelsPerModule,
  svgModuleGeometry,
  createLatestGate,
  QR_MIN_PX_PER_MODULE,
  QR_QUIET_ZONE,
} from "../src/tools/qr-code.ts";

test("normalizeHexColor: accepts 6 hex digits with/without #, uppercases", () => {
  assert.equal(normalizeHexColor("#00ff7f"), "#00FF7F");
  assert.equal(normalizeHexColor("abcdef"), "#ABCDEF");
  assert.equal(normalizeHexColor("  #123ABC "), "#123ABC");
});

test("normalizeHexColor: rejects short, long, non-hex and non-ASCII values", () => {
  for (const bad of ["", "#", "#12345", "#1234567", "#ggg000", "##123456", "#fff", "#aéabc", "١٢٣٤٥٦"]) {
    assert.equal(normalizeHexColor(bad), null, bad);
  }
});

test("classifyGenerateError: maps crate messages to localized kinds", () => {
  assert.equal(classifyGenerateError("QR generation failed: data too long"), "tooLong");
  assert.equal(classifyGenerateError("Invalid hex color: 12"), "invalidColor");
  assert.equal(classifyGenerateError("Invalid red component"), "invalidColor");
  assert.equal(classifyGenerateError("PNG encoding failed: x"), "generic");
  assert.equal(classifyGenerateError(""), "generic");
});

test("classifyDecodeError: load failure vs. no code found", () => {
  assert.equal(classifyDecodeError("Failed to load image: Format error"), "unsupportedImage");
  assert.equal(classifyDecodeError("Decoding failed: NotFoundException"), "noQr");
  assert.equal(classifyDecodeError("unknown"), "noQr");
});

test("image type checks", () => {
  assert.ok(isImageType("image/gif"));
  assert.ok(isImageType("IMAGE/PNG"));
  assert.ok(!isImageType("application/pdf"));
  assert.ok(!isImageType(""));
  assert.ok(isDecodableImageType("image/png"));
  assert.ok(isDecodableImageType("image/jpeg"));
  assert.ok(isDecodableImageType("image/webp"));
  assert.ok(!isDecodableImageType("image/gif"));
  assert.ok(!isDecodableImageType("image/svg+xml"));
});

test("isHttpUrl: only well-formed http(s) URLs", () => {
  assert.ok(isHttpUrl("https://example.com/a?b=1"));
  assert.ok(isHttpUrl("HTTP://EXAMPLE.COM"));
  assert.ok(!isHttpUrl("javascript:alert(1)"));
  assert.ok(!isHttpUrl("ftp://example.com"));
  assert.ok(!isHttpUrl("see https://example.com"));
  assert.ok(!isHttpUrl("https://"));
  assert.ok(!isHttpUrl("Привет 🚀"));
});

test("cameraFrameSize: longest side capped at 1024, aspect kept, no upscaling", () => {
  assert.deepEqual(cameraFrameSize(1920, 1080), { width: 1024, height: 576 });
  assert.deepEqual(cameraFrameSize(1080, 1920), { width: 576, height: 1024 });
  assert.deepEqual(cameraFrameSize(640, 480), { width: 640, height: 480 });
  assert.equal(cameraFrameSize(0, 480), null);
  assert.equal(cameraFrameSize(Number.NaN, 480), null);
});

test("classifyCameraError: getUserMedia exception names → message kinds", () => {
  assert.equal(classifyCameraError("NotAllowedError"), "denied");
  assert.equal(classifyCameraError("SecurityError"), "denied");
  assert.equal(classifyCameraError("NotFoundError"), "notFound");
  assert.equal(classifyCameraError("OverconstrainedError"), "notFound");
  assert.equal(classifyCameraError("NotReadableError"), "inUse");
  assert.equal(classifyCameraError("insecure"), "insecure");
  assert.equal(classifyCameraError("TypeError"), "generic");
  assert.equal(classifyCameraError(undefined), "generic");
});

test("relativeLuminance: black 0, white 1, invalid null", () => {
  assert.equal(relativeLuminance("#000000"), 0);
  assert.equal(relativeLuminance("#FFFFFF"), 1);
  assert.equal(relativeLuminance("#12"), null);
});

test("assessQrContrast: ratio, truncated display and level", () => {
  const bw = assessQrContrast("#000000", "#FFFFFF");
  assert.ok(bw);
  assert.equal(bw.display, 21);
  assert.equal(bw.level, "ok");
  // #777777 on white ≈ 4.48:1 — warned and displayed as 4.4, never 4.5.
  const grey = assessQrContrast("#777777", "#FFFFFF");
  assert.ok(grey);
  assert.equal(grey.level, "low");
  assert.equal(grey.display, 4.4);
  // Light modules on dark background, and equal colours: inverted.
  assert.equal(assessQrContrast("#FFFFFF", "#000000")?.level, "inverted");
  assert.equal(assessQrContrast("#336699", "#336699")?.level, "inverted");
  assert.equal(assessQrContrast("#336699", "#336699")?.display, 1);
  assert.equal(assessQrContrast("#GGGGGG", "#FFFFFF"), null);
});

test("pixelsPerModule: integer module size over code + 8 quiet-zone modules", () => {
  assert.equal(pixelsPerModule(512, 21), 17);
  assert.equal(pixelsPerModule(256, 117), 2);
  assert.equal(pixelsPerModule(2048, 177), 11);
  assert.equal(pixelsPerModule(256, 0), 0);
  assert.ok(pixelsPerModule(256, 57) < QR_MIN_PX_PER_MODULE);
});

test("svgModuleGeometry: matrix width and quiet zone from crate SVG", () => {
  const svg = '<?xml version="1.0" standalone="yes"?><svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="203" height="203" viewBox="0 0 203 203"><rect x="0" y="0" width="203" height="203" fill="#FFFFFF"/><path fill="#000000" d="M28 28h7v7H28V28M35 28h7v7H35V28"/></svg>';
  assert.deepEqual(svgModuleGeometry(svg), { modules: 21, quietZone: QR_QUIET_ZONE });
  assert.equal(svgModuleGeometry("<svg></svg>"), null);
});

test("createLatestGate: only the newest request is current", () => {
  const gate = createLatestGate();
  const a = gate.begin();
  const b = gate.begin();
  assert.ok(!gate.isCurrent(a));
  assert.ok(gate.isCurrent(b));
  gate.invalidate();
  assert.ok(!gate.isCurrent(b));
});
