import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateUuid,
  generateBatch,
  randomUuidBytes,
  UUID_RE,
  v7Timestamp,
  MAX_BATCH,
} from "../src/tools/uuid.ts";

const strip = (u: string) => u.replace(/^urn:uuid:|[{}-]/gi, "").toLowerCase();

test("v4: canonical format, version nibble 4, variant 10xx", () => {
  for (let i = 0; i < 500; i++) {
    const u = generateUuid("v4", "hyphenated", "lower");
    assert.match(u, UUID_RE);
    assert.equal(u[14], "4");
    assert.ok("89ab".includes(u[19]), u);
  }
});

test("v7: version nibble 7, variant, embedded timestamp ≈ now", () => {
  const before = Date.now();
  const u = generateUuid("v7", "hyphenated", "lower");
  const after = Date.now();
  assert.match(u, UUID_RE);
  assert.equal(u[14], "7");
  assert.ok("89ab".includes(u[19]));
  const ts = v7Timestamp(u)!;
  assert.ok(ts >= before && ts <= after + 1, `${ts} in [${before}, ${after}]`);
});

test("v7: 48-bit timestamp layout for a fixed clock (big-endian)", () => {
  // Far-future clock (year ~2500) so it is ahead of the module's last timestamp.
  const now = 0x0fedcba98765;
  const b = randomUuidBytes("v7", now);
  const ts = Number(BigInt("0x" + Array.from(b.slice(0, 6), (x) => x.toString(16).padStart(2, "0")).join("")));
  assert.equal(ts, now);
  assert.deepEqual(Array.from(b.slice(0, 6)), [0x0f, 0xed, 0xcb, 0xa9, 0x87, 0x65]);
  assert.equal(b[6] >> 4, 7);
  assert.equal(b[8] >> 6, 0b10);
});

test("v7: strictly increasing within one millisecond and across a batch", () => {
  const batch = generateBatch("v7", "hyphenated", "lower", MAX_BATCH);
  for (let i = 1; i < batch.length; i++) assert.ok(batch[i - 1] < batch[i], `${batch[i - 1]} < ${batch[i]}`);
  // Same fixed clock value many times → counter increments, then timestamp bumps.
  const t = Date.now() + 10_000_000;
  let prev = "";
  for (let i = 0; i < 5000; i++) {
    const hex = Array.from(randomUuidBytes("v7", t), (x) => x.toString(16).padStart(2, "0")).join("");
    assert.ok(hex > prev, `monotonic at ${i}`);
    prev = hex;
  }
  // Clock going backwards still yields increasing ids.
  const back = Array.from(randomUuidBytes("v7", t - 5000), (x) => x.toString(16).padStart(2, "0")).join("");
  assert.ok(back > prev);
});

test("formats and case", () => {
  assert.match(generateUuid("v4", "plain", "lower"), /^[0-9a-f]{32}$/);
  assert.match(generateUuid("v4", "braces", "lower"), /^\{[0-9a-f-]{36}\}$/);
  assert.match(generateUuid("v4", "urn", "lower"), /^urn:uuid:[0-9a-f-]{36}$/);
  assert.match(generateUuid("v4", "hyphenated", "upper"), /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
  // URN uppercase uppercases the prefix too (legacy behaviour).
  assert.match(generateUuid("v7", "urn", "upper"), /^URN:UUID:[0-9A-F-]{36}$/);
  for (const f of ["plain", "braces", "urn"] as const) assert.equal(strip(generateUuid("v4", f, "lower")).length, 32);
});

test("batch: count clamped to 1..100, non-finite → 1", () => {
  assert.equal(generateBatch("v4", "hyphenated", "lower", 0).length, 1);
  assert.equal(generateBatch("v4", "hyphenated", "lower", -5).length, 1);
  assert.equal(generateBatch("v4", "hyphenated", "lower", 7.9).length, 7);
  assert.equal(generateBatch("v4", "hyphenated", "lower", 1e9).length, 100);
  assert.equal(generateBatch("v4", "hyphenated", "lower", NaN).length, 1);
});

test("uniqueness: 20 000 v4 + 20 000 v7 ids have no duplicates", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    for (const u of generateBatch("v4", "plain", "lower", 100)) seen.add(u);
    for (const u of generateBatch("v7", "plain", "lower", 100)) seen.add(u);
  }
  assert.equal(seen.size, 40_000);
});

test("v4 randomness sanity: every hex digit appears in random positions", () => {
  const counts = new Map<string, number>();
  for (let i = 0; i < 2000; i++) for (const ch of strip(generateUuid("v4", "plain", "lower")).slice(0, 12)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  assert.equal(counts.size, 16);
  for (const n of counts.values()) assert.ok(n > 1000 && n < 2000, String(n)); // expected 1500
});

test("v7Timestamp rejects non-v7 / malformed", () => {
  assert.equal(v7Timestamp(generateUuid("v4", "hyphenated", "lower")), null);
  assert.equal(v7Timestamp("not-a-uuid"), null);
  assert.equal(v7Timestamp("0189f7e2-3c4a-7000-8000-000000000000"), 0x0189f7e23c4a);
  assert.equal(v7Timestamp("{0189F7E2-3C4A-7000-8000-000000000000}"), 0x0189f7e23c4a);
});
