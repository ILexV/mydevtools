import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSplitPrefix, maxPrefix, parseSplitPrefix } from "../src/tools/ip-subnet.ts";

test("maxPrefix: 32 for IPv4, 128 for IPv6", () => {
  assert.equal(maxPrefix(false), 32);
  assert.equal(maxPrefix(true), 128);
});

test("defaultSplitPrefix: IPv4 +2, IPv6 → /64 or +1, clamped", () => {
  assert.equal(defaultSplitPrefix(24, false), 26);
  assert.equal(defaultSplitPrefix(31, false), 32);
  assert.equal(defaultSplitPrefix(32, false), 32);
  assert.equal(defaultSplitPrefix(0, false), 2);
  assert.equal(defaultSplitPrefix(48, true), 64);
  assert.equal(defaultSplitPrefix(0, true), 64);
  assert.equal(defaultSplitPrefix(64, true), 65);
  assert.equal(defaultSplitPrefix(128, true), 128);
});

test("parseSplitPrefix: accepts N and /N within prefix..max", () => {
  assert.equal(parseSplitPrefix("26", 24, false), 26);
  assert.equal(parseSplitPrefix(" /26 ", 24, false), 26);
  assert.equal(parseSplitPrefix("24", 24, false), 24);
  assert.equal(parseSplitPrefix("32", 24, false), 32);
  assert.equal(parseSplitPrefix("128", 48, true), 128);
  assert.equal(parseSplitPrefix("64", 48, true), 64);
});

test("parseSplitPrefix: rejects out of range and garbage", () => {
  for (const raw of ["23", "33", "", "/", "26.5", "-1", "abc", "2 6", "0026x"]) {
    assert.equal(parseSplitPrefix(raw, 24, false), null, raw);
  }
  assert.equal(parseSplitPrefix("129", 48, true), null);
  assert.equal(parseSplitPrefix("47", 48, true), null);
});
