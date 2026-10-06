import { test } from "node:test";
import assert from "node:assert/strict";
import { base64Utf8, computeLab, hexUtf8, percentEncodeUtf8, utf8Bytes } from "../src/lib/hero-lab.ts";

const samples = ["hello, browser", "привет, браузер", "café ☕ 東京 🚀", "?q=dev tools&page=2", "a!b~c*'()", ""];

test("hero lab: Base64 matches Buffer for UTF-8 text", () => {
  for (const s of samples) {
    assert.equal(base64Utf8(utf8Bytes(s)), Buffer.from(s, "utf8").toString("base64"), s);
  }
});

test("hero lab: percent-encoding matches encodeURIComponent", () => {
  for (const s of samples) {
    assert.equal(percentEncodeUtf8(utf8Bytes(s)), encodeURIComponent(s), s);
  }
});

test("hero lab: lone surrogate is encoded as U+FFFD instead of throwing", () => {
  assert.throws(() => encodeURIComponent("\uD800"));
  assert.equal(percentEncodeUtf8(utf8Bytes("\uD800")), "%EF%BF%BD");
});

test("hero lab: hex is space-separated lowercase bytes", () => {
  assert.equal(hexUtf8(utf8Bytes("Hé")), "48 c3 a9");
});

test("hero lab: computeLab gives byte count and SHA-256", async () => {
  const r = await computeLab("hello, browser");
  assert.equal(r.bytes, 14);
  assert.match(r.sha256 ?? "", /^[0-9a-f]{64}$/);
  const empty = await computeLab("");
  assert.deepEqual(empty, { bytes: 0, base64: "", url: "", hex: "", sha256: "" });
});

test("hero lab: SHA-256 of 'abc' is the FIPS 180-2 vector", async () => {
  const r = await computeLab("abc");
  assert.equal(r.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
