import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEncodingError, previewText, outputFileName } from "../src/tools/encoding-ui.ts";

// Messages exactly as produced by wasm/encoding (lib.rs) and its crates.
test("classifyEncodingError: crate messages → locale keys", () => {
  const cases: Array<[string, string, number | undefined]> = [
    ["Invalid hex character 'z' at position 6", "Error_InvalidChar", 6],
    ["Invalid hex length (must be even)", "Error_InvalidLength", undefined],
    ["Non-ASCII character at position 2", "Error_NotRepresentable", 2],
    ["Character not representable in Latin-1 at position 5", "Error_NotRepresentable", 5],
    ["Invalid UTF-8: invalid utf-8 sequence of 1 bytes from index 0", "Error_NotText", undefined],
    ["Odd number of bytes for UTF-16LE", "Error_NotText", undefined],
    ["Byte not representable in ASCII: 0xff", "Error_NotText", undefined],
    ["Whitespace not allowed", "Error_Whitespace", undefined],
    ["Padding '=' is not allowed", "Error_Padding", undefined],
    ["Invalid Base64 length (padding required)", "Error_InvalidLength", undefined],
    ["Base64 decode error: Invalid padding", "Error_InvalidLength", undefined],
    ["Base64 decode error: Invalid symbol 33, offset 4.", "Error_InvalidData", undefined],
    ["Base32 decode error: invalid length at 5", "Error_InvalidLength", undefined],
    ["Base32 decode error: invalid symbol at 2", "Error_InvalidData", undefined],
    ["Base58 decode error: provided string contained invalid character '0' at byte 3", "Error_InvalidData", undefined],
    ["Truncated % encoding", "Error_InvalidLength", undefined],
    ["Invalid hex in % encoding: zz", "Error_InvalidData", undefined],
    ["something unexpected", "Error_InvalidData", undefined],
  ];
  for (const [msg, key, position] of cases) {
    const got = classifyEncodingError(msg);
    assert.equal(got.key, key, msg);
    assert.equal(got.position, position, msg);
  }
});

test("previewText: preview mode truncates with suffix, full mode never does", () => {
  assert.deepEqual(previewText("abcdef", "preview", 3, "(cut)"), { text: "abc\n…(cut)", truncated: true });
  assert.deepEqual(previewText("abcdef", "full", 3, "(cut)"), { text: "abcdef", truncated: false });
  assert.deepEqual(previewText("abc", "preview", 3, "(cut)"), { text: "abc", truncated: false });
  assert.deepEqual(previewText("", "preview", 3, "(cut)"), { text: "", truncated: false });
});

test("outputFileName: source name + ext, fallback for text input", () => {
  assert.equal(outputFileName("photo.png", "b64"), "photo.png.b64");
  assert.equal(outputFileName(null, "hex"), "text.hex");
  assert.equal(outputFileName("  ", "b32"), "text.b32");
  assert.equal(outputFileName(undefined, "bin", "decoded"), "decoded.bin");
});
