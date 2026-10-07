import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addressCount,
  addressSpaceBar,
  broadcastKind,
  digitCount,
  separatorChunks,
  defaultSplitPrefix,
  maxPrefix,
  parseSplitPrefix,
  ratio,
  splitBar,
  SPECTRUM_SIZE,
  TINY_FRACTION,
} from "../src/tools/ip-subnet.ts";

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

/** Sum of exact segment counts must equal the address count (no inflation). */
const sumCounts = (segs: { count: bigint }[]) => segs.reduce((a, s) => a + s.count, 0n);

test("addressCount: exact BigInt powers of two", () => {
  assert.equal(addressCount(0, false), 4294967296n);
  assert.equal(addressCount(32, false), 1n);
  assert.equal(addressCount(0, true), 1n << 128n);
  assert.equal(addressCount(64, true), 18446744073709551616n);
});

test("ratio: bounded 0..1, exact for small parts", () => {
  assert.equal(ratio(1n, 4n), 0.25);
  assert.equal(ratio(0n, 4n), 0);
  assert.equal(ratio(5n, 4n), 1);
  assert.equal(ratio(1n, 0n), 0);
  assert.ok(ratio(1n, 1n << 128n) >= 0);
});

test("addressSpaceBar /24: 1 + 254 + 1, endpoints are ticks", () => {
  const { total, segments } = addressSpaceBar(24, false);
  assert.equal(total, 256n);
  assert.deepEqual(segments.map((s) => s.kind), ["network", "usable", "broadcast"]);
  assert.deepEqual(segments.map((s) => s.count), [1n, 254n, 1n]);
  assert.equal(sumCounts(segments), total);
  assert.equal(segments[0].width, 1 / 256); // never inflated
  assert.equal(segments[0].tiny, true);
  assert.equal(segments[2].tiny, true);
  assert.equal(segments[1].tiny, false);
  assert.equal(segments[2].start, 255 / 256);
});

test("addressSpaceBar /0 and /8: exact counts, endpoints tiny", () => {
  const zero = addressSpaceBar(0, false);
  assert.equal(zero.total, 4294967296n);
  assert.equal(zero.segments[1].count, 4294967294n);
  assert.equal(sumCounts(zero.segments), zero.total);
  assert.ok(zero.segments[0].width < TINY_FRACTION && zero.segments[0].tiny);
  const eight = addressSpaceBar(8, false);
  assert.equal(eight.segments[1].count, 16777214n);
  assert.equal(eight.segments[2].start, ratio(16777215n, 16777216n));
});

test("addressSpaceBar /30: four addresses, all segments visible", () => {
  const { segments } = addressSpaceBar(30, false);
  assert.deepEqual(segments.map((s) => [s.count, s.width, s.tiny]), [
    [1n, 0.25, false],
    [2n, 0.5, false],
    [1n, 0.25, false],
  ]);
});

test("addressSpaceBar /31 = two usable, /32 = single address", () => {
  const p2p = addressSpaceBar(31, false);
  assert.deepEqual(p2p.segments.map((s) => [s.kind, s.count, s.width]), [["p2p", 2n, 1]]);
  const one = addressSpaceBar(32, false);
  assert.deepEqual(one.segments.map((s) => [s.kind, s.count, s.width]), [["single", 1n, 1]]);
});

test("addressSpaceBar IPv6 /64 and /127: one prefix range, no broadcast", () => {
  const v64 = addressSpaceBar(64, true);
  assert.deepEqual(v64.segments.map((s) => [s.kind, s.count, s.width]), [["range", 18446744073709551616n, 1]]);
  const v127 = addressSpaceBar(127, true);
  assert.deepEqual(v127.segments.map((s) => [s.kind, s.count]), [["range", 2n]]);
  assert.ok(!v127.segments.some((s) => s.kind === "broadcast"));
});

test("splitBar /24 → /26: four equal segments, no remainder", () => {
  const r = splitBar(4n);
  assert.equal(r.listed, 4);
  assert.equal(r.remainder, 0n);
  assert.deepEqual(r.segments.map((s) => [s.index, s.start, s.width, s.hue]), [
    [1, 0, 0.25, 0],
    [2, 0.25, 0.25, 1],
    [3, 0.5, 0.25, 2],
    [4, 0.75, 0.25, 3],
  ]);
});

test("splitBar /24 → /28: sixteen labelled segments, hues cycle", () => {
  const r = splitBar(16n);
  assert.equal(r.listed, 16);
  assert.equal(r.remainder, 0n);
  assert.equal(r.segments.length, 16);
  assert.equal(r.segments[SPECTRUM_SIZE].hue, 0);
  assert.equal(r.segments[15].start, 15 / 16);
  assert.equal(r.listedTiny, false);
});

test("splitBar /24 → /29: 16 segments + remainder of 16 at half width", () => {
  const r = splitBar(32n);
  assert.equal(r.listed, 16);
  assert.equal(r.remainder, 16n);
  const rest = r.segments.at(-1)!;
  assert.deepEqual([rest.index, rest.subnets, rest.start, rest.width, rest.hue], [null, 16n, 0.5, 0.5, null]);
});

test("splitBar huge IPv6 split: exact remainder, listed segments tiny", () => {
  const count = 1n << 64n;
  const r = splitBar(count);
  assert.equal(r.remainder, count - 16n);
  assert.equal(r.listedTiny, true);
  assert.equal(r.segments.length, 17);
  assert.deepEqual(splitBar(0n).segments, []);
  assert.equal(splitBar(1n).segments.length, 1);
});

test("broadcastKind: /0–/30 have a broadcast, /31 is point-to-point, /32 a single host", () => {
  assert.equal(broadcastKind(0), "address");
  assert.equal(broadcastKind(24), "address");
  assert.equal(broadcastKind(30), "address");
  assert.equal(broadcastKind(31), "p2p");
  assert.equal(broadcastKind(32), "single");
  // Stays consistent with the address bar: no broadcast segment exactly when there is no broadcast.
  for (const prefix of [0, 8, 24, 30, 31, 32]) {
    const hasSegment = addressSpaceBar(prefix, false).segments.some((seg) => seg.kind === "broadcast");
    assert.equal(hasSegment, broadcastKind(prefix) === "address", `/${prefix}`);
  }
});

test("separatorChunks: break opportunities only after separators", () => {
  assert.deepEqual(separatorChunks("2001:db8::1"), ["2001:", "db8::", "1"]);
  assert.deepEqual(separatorChunks("18,446,744,073,709,551,616"), ["18,", "446,", "744,", "073,", "709,", "551,", "616"]);
  assert.deepEqual(separatorChunks("18\u202f446\u202f744"), ["18\u202f", "446\u202f", "744"]);
  assert.equal(separatorChunks("2001:0db8:0000:0000:0000:0000:0000:0001").join(""), "2001:0db8:0000:0000:0000:0000:0000:0001");
  assert.deepEqual(separatorChunks(""), []);
});

test("digitCount: counts digits, ignores group separators", () => {
  assert.equal(digitCount("18,446,744,073,709,551,616"), 20);
  assert.equal(digitCount("254"), 3);
});
