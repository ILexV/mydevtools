import { test } from "node:test";
import assert from "node:assert/strict";
import { matchingDigests, parseExpectedHash } from "../src/tools/hash-compare.ts";

const FOX_MD5 = "9e107d9d372bb6826bd81d3542a419d6";
const FOX_SHA1 = "2fd4e1c67a2d28fced849ee1bb76e7391b93eb12";

test("parseExpectedHash: empty, outer trim, case-insensitive", () => {
  assert.deepEqual(parseExpectedHash(""), { kind: "empty" });
  assert.deepEqual(parseExpectedHash("  \n\t "), { kind: "empty" });
  assert.deepEqual(parseExpectedHash(`  ${FOX_MD5.toUpperCase()}\n`), { kind: "ok", hex: FOX_MD5 });
});

test("parseExpectedHash: inner whitespace and non-hex are rejected, not normalized", () => {
  assert.deepEqual(parseExpectedHash(`${FOX_MD5}  fox.txt`), { kind: "invalid", reason: "whitespace" });
  assert.deepEqual(parseExpectedHash("9e10 7d9d"), { kind: "invalid", reason: "whitespace" });
  assert.deepEqual(parseExpectedHash(`0x${FOX_MD5}`), { kind: "invalid", reason: "non-hex" });
  assert.deepEqual(parseExpectedHash("sha256:abcd"), { kind: "invalid", reason: "non-hex" });
  assert.deepEqual(parseExpectedHash("abcg"), { kind: "invalid", reason: "non-hex" });
});

test("matchingDigests: compares only the given (selected) digests, case-insensitively", () => {
  const digests = [
    { id: "md5", hex: FOX_MD5 },
    { id: "sha1", hex: FOX_SHA1.toUpperCase() },
    { id: "dup", hex: FOX_MD5 },
  ];
  assert.deepEqual(matchingDigests(FOX_MD5, digests), ["md5", "dup"]);
  assert.deepEqual(matchingDigests(FOX_SHA1, digests), ["sha1"]);
  // Same length as MD5 but different value: a valid mismatch, no length guessing.
  assert.deepEqual(matchingDigests("0".repeat(32), digests), []);
  assert.deepEqual(matchingDigests(FOX_MD5, []), []);
});
