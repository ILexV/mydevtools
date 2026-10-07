import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RESIZE_DIMENSION,
  baseName,
  compressedName,
  convertedName,
  extensionFor,
  guessResizeFormat,
  isDecodableImage,
  isImageDecodeError,
  isImageFile,
  lockedDimension,
  mimeFor,
  parseResizeDimensions,
  resizedName,
  resolveCompressFormat,
  savingsPercent,
} from "../src/tools/image-tools.ts";

test("download names: compressor _min, converter new ext, resizer _WxH (jpeg → jpg)", () => {
  assert.equal(compressedName("photo.png", "jpeg"), "photo_min.jpg");
  assert.equal(compressedName("archive.tar.png", "webp"), "archive.tar_min.webp");
  assert.equal(convertedName("icon.png", "ico"), "icon.ico");
  assert.equal(convertedName("noext", "tiff"), "noext.tiff");
  assert.equal(resizedName("cat.JPG", 320, 200, "jpeg"), "cat_320x200.jpg");
  assert.equal(resizedName("Фото отпуска 🌴.webp", 10, 20, "png"), "Фото отпуска 🌴_10x20.png");
});

test("baseName keeps dotfiles and extension-less names intact", () => {
  assert.equal(baseName(".png"), ".png");
  assert.equal(baseName("README"), "README");
  assert.equal(baseName("a.b.c"), "a.b");
});

test("extension and MIME per target format", () => {
  assert.equal(extensionFor("JPEG"), "jpg");
  assert.equal(extensionFor("png"), "png");
  assert.equal(mimeFor("jpg"), "image/jpeg");
  assert.equal(mimeFor("jpeg"), "image/jpeg");
  assert.equal(mimeFor("ico"), "image/x-icon");
  assert.equal(mimeFor("tga"), "image/x-tga");
  assert.equal(mimeFor("webp"), "image/webp");
  assert.equal(mimeFor("tiff"), "image/tiff");
});

test("compressor 'original' format: jpeg → jpeg, png → png, else → webp", () => {
  assert.equal(resolveCompressFormat("original", "image/jpeg"), "jpeg");
  assert.equal(resolveCompressFormat("original", "image/png"), "png");
  assert.equal(resolveCompressFormat("original", "image/webp"), "webp");
  assert.equal(resolveCompressFormat("original", "image/gif"), "webp");
  assert.equal(resolveCompressFormat("original", ""), "webp");
  assert.equal(resolveCompressFormat("png", "image/jpeg"), "png");
});

test("resizer guesses output format from extension", () => {
  assert.equal(guessResizeFormat("a.jpg"), "jpeg");
  assert.equal(guessResizeFormat("a.JPEG"), "jpeg");
  assert.equal(guessResizeFormat("a.webp"), "webp");
  assert.equal(guessResizeFormat("a.gif"), "png");
  assert.equal(guessResizeFormat("noext"), "png");
});

test("image type checks: decodable formats, extension fallback for empty MIME", () => {
  assert.ok(isImageFile({ type: "image/svg+xml" }));
  assert.ok(!isImageFile({ type: "application/pdf" }));
  for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/x-icon", "image/tiff"]) {
    assert.ok(isDecodableImage({ type }), type);
  }
  assert.ok(!isDecodableImage({ type: "image/svg+xml", name: "a.svg" }));
  assert.ok(!isDecodableImage({ type: "image/avif", name: "a.avif" }));
  assert.ok(!isDecodableImage({ type: "text/plain", name: "a.png" }));
  assert.ok(isDecodableImage({ type: "", name: "sprite.TGA" }));
  assert.ok(!isDecodableImage({ type: "", name: "notes.txt" }));
});

test("savingsPercent: rounded, negative when output grows, 0 for empty source", () => {
  assert.equal(savingsPercent(1000, 250), 75);
  assert.equal(savingsPercent(1000, 1500), -50);
  assert.equal(savingsPercent(0, 10), 0);
  assert.equal(savingsPercent(3, 2), 33);
});

test("lockedDimension keeps the original aspect ratio", () => {
  assert.equal(lockedDimension("width", 320, 640, 480), 240);
  assert.equal(lockedDimension("height", 240, 640, 480), 320);
  assert.equal(lockedDimension("width", 1, 1000, 10), 1, "never rounds down to 0");
  assert.equal(lockedDimension("width", 0, 640, 480), null);
  assert.equal(lockedDimension("width", Number.NaN, 640, 480), null);
  assert.equal(lockedDimension("width", 100, 0, 0), null, "unknown original size");
});

test("parseResizeDimensions accepts positive integers within limits only", () => {
  assert.deepEqual(parseResizeDimensions("320", " 200 "), { width: 320, height: 200 });
  assert.deepEqual(parseResizeDimensions("", "200"), { error: "invalid" });
  assert.deepEqual(parseResizeDimensions("0", "200"), { error: "invalid" });
  assert.deepEqual(parseResizeDimensions("-5", "200"), { error: "invalid" }, "negative would wrap to a huge u32");
  assert.deepEqual(parseResizeDimensions("12.5", "200"), { error: "invalid" });
  assert.deepEqual(parseResizeDimensions("1e3", "200"), { error: "invalid" });
  assert.deepEqual(parseResizeDimensions(String(MAX_RESIZE_DIMENSION), "1"), { width: MAX_RESIZE_DIMENSION, height: 1 });
  assert.deepEqual(parseResizeDimensions(String(MAX_RESIZE_DIMENSION + 1), "1"), { error: "too-large" });
  assert.deepEqual(parseResizeDimensions("16384", "16384"), { error: "too-large" }, "pixel budget");
  assert.deepEqual(parseResizeDimensions("8192", "8192"), { width: 8192, height: 8192 });
});

test("isImageDecodeError: WASM decode / browser decode failures, not encoder errors", () => {
  assert.equal(isImageDecodeError("Failed to load image: The encoder or decoder for Tga does not support the color type `Unknown(109)`"), true);
  assert.equal(isImageDecodeError("Failed to load image: empty input"), true);
  assert.equal(isImageDecodeError("InvalidStateError: The source image could not be decoded."), true);
  assert.equal(isImageDecodeError("Failed to encode PNG: out of memory"), false);
  assert.equal(isImageDecodeError(""), false);
});
