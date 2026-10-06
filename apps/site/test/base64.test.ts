import { test } from "node:test";
import assert from "node:assert/strict";
import { detectFileType, isLikelyText } from "../src/tools/base64.ts";

const bytes = (...b: number[]) => new Uint8Array(b);
const ascii = (s: string) => new TextEncoder().encode(s);

test("detectFileType: image signatures (legacy parity)", () => {
  const cases: Array<[Uint8Array, string]> = [
    [bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), "png"],
    [bytes(0xff, 0xd8, 0xff, 0xe0), "jpg"],
    [ascii("GIF89a"), "gif"],
    [ascii("RIFF\0\0\0\0WEBPVP8 "), "webp"],
    [ascii("BM\0\0\0\0"), "bmp"],
    [bytes(0, 0, 1, 0, 1, 0), "ico"],
    [bytes(0x49, 0x49, 0x2a, 0x00), "tiff"],
    [bytes(0x4d, 0x4d, 0x00, 0x2a), "tiff"],
    [ascii('  <svg xmlns="http://www.w3.org/2000/svg"/>'), "svg"],
    [ascii('<?xml version="1.0"?><svg/>'), "svg"],
  ];
  for (const [b, ext] of cases) {
    const d = detectFileType(b);
    assert.equal(d?.kind, "image", ext);
    assert.equal(d?.ext, ext);
  }
});

test("detectFileType: binary signatures", () => {
  const cases: Array<[Uint8Array, string]> = [
    [ascii("%PDF-1.7"), "pdf"],
    [bytes(0x50, 0x4b, 0x03, 0x04), "zip"],
    [bytes(0x1f, 0x8b, 0x08, 0x00), "gz"],
    [bytes(0x7f, 0x45, 0x4c, 0x46), "elf"],
    [ascii("MZ\x90\0"), "exe"],
    [ascii("ID3\x04"), "mp3"],
    [bytes(0xff, 0xfb, 0x90, 0x00), "mp3"],
    [ascii("\0\0\0\x18ftypmp42"), "mp4"],
  ];
  for (const [b, ext] of cases) {
    const d = detectFileType(b);
    assert.equal(d?.kind, "binary", ext);
    assert.equal(d?.ext, ext);
  }
});

test("detectFileType: plain text and short input → null", () => {
  assert.equal(detectFileType(ascii("hello world")), null);
  assert.equal(detectFileType(ascii("<?xml version='1.0'?><root/>")), null);
  assert.equal(detectFileType(bytes(0x89, 0x50)), null);
  assert.equal(detectFileType(new Uint8Array()), null);
});

test("isLikelyText: UTF-8 text, emoji, empty", () => {
  assert.equal(isLikelyText(ascii("Привет, мир 😀\n\tok")), true);
  assert.equal(isLikelyText(new Uint8Array()), true);
});

test("isLikelyText: invalid UTF-8 or many control chars → binary", () => {
  assert.equal(isLikelyText(bytes(0xff, 0xfe, 0x00, 0x41)), false);
  assert.equal(isLikelyText(bytes(1, 2, 3, 4, 5, 65)), false);
});

test("isLikelyText: multi-byte char cut at the 512-byte probe boundary is still text", () => {
  const text = "a".repeat(511) + "é" + "tail";
  assert.equal(isLikelyText(ascii(text)), true);
});
