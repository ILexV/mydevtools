import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeHexColor,
  classifyGenerateError,
  classifyDecodeError,
  isImageType,
  isDecodableImageType,
  isHttpUrl,
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
