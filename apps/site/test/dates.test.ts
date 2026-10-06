// Fixed zone with DST so local-time formatting is deterministic.
process.env.TZ = "Europe/Berlin";

import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, format, formatCustom } from "../src/tools/dates.ts";

const ms = (d: Date | null) => d?.getTime();

test("parse: empty / whitespace → null", () => {
  assert.equal(parse("", "auto"), null);
  assert.equal(parse("   \n", "unix-sec"), null);
});

test("parse auto: ≤11 integer digits = seconds, longer = milliseconds", () => {
  assert.equal(ms(parse("0", "auto")), 0);
  assert.equal(ms(parse("1700000000", "auto")), 1700000000000);
  assert.equal(ms(parse("99999999999", "auto")), 99999999999000); // 11 digits → seconds
  assert.equal(ms(parse("1700000000000", "auto")), 1700000000000); // 13 digits → ms
  assert.equal(ms(parse(" 1700000000 ", "auto")), 1700000000000);
});

test("parse auto: negative and fractional epochs", () => {
  assert.equal(ms(parse("-86400", "auto")), -86400000);
  assert.equal(ms(parse("1700000000.5", "auto")), 1700000000500);
  assert.equal(format(parse("-1", "auto")!, "iso"), "1969-12-31T23:59:59.000Z");
});

test("parse auto: ISO and RFC strings", () => {
  assert.equal(ms(parse("2024-02-29T12:00:00Z", "auto")), Date.UTC(2024, 1, 29, 12));
  assert.equal(ms(parse("2024-01-15", "auto")), Date.UTC(2024, 0, 15)); // date-only = UTC
  assert.equal(ms(parse("2024-01-15T10:00:00+06:00", "auto")), Date.UTC(2024, 0, 15, 4));
  assert.equal(ms(parse("Tue, 14 Nov 2023 22:13:20 GMT", "auto")), 1700000000000);
});

test("parse explicit unix types: seconds vs ms, strict numeric", () => {
  assert.equal(ms(parse("1700000000", "unix-sec")), 1700000000000);
  assert.equal(ms(parse("1700000000", "unix-ms")), 1700000000);
  assert.equal(ms(parse("1.5", "unix-sec")), 1500);
  for (const bad of ["abc", "0x10", "1e3", "12:00", "1,5", "--1"]) {
    assert.ok(Number.isNaN(parse(bad, "unix-sec")!.getTime()), bad);
    assert.ok(Number.isNaN(parse(bad, "unix-ms")!.getTime()), bad);
  }
});

test("parse: invalid / out-of-range dates are Invalid Date", () => {
  for (const [v, t] of [
    ["not a date", "auto"], ["2024-13-45", "iso"], ["😀", "auto"],
    ["99999999999999", "auto"], // 14 digits as ms is fine…
  ] as const) {
    const d = parse(v, t)!;
    if (v === "99999999999999") assert.equal(d.getTime(), 99999999999999);
    else assert.ok(Number.isNaN(d.getTime()), v);
  }
  // …but beyond ±8.64e15 ms the ECMAScript range is exceeded.
  assert.ok(Number.isNaN(parse("8640000000001", "unix-sec")!.getTime()));
  assert.equal(format(parse("8640000000001", "unix-sec")!, "iso"), null);
});

test("format: fixed outputs for 1700000000 (2023-11-14 22:13:20 UTC)", () => {
  const d = new Date(1700000000000);
  assert.equal(format(d, "iso"), "2023-11-14T22:13:20.000Z");
  assert.equal(format(d, "utc"), "Tue, 14 Nov 2023 22:13:20 GMT");
  assert.equal(format(d, "rfc"), "Tue, 14 Nov 2023 22:13:20 +0000");
  // The RFC 5322 output parses back to the same instant.
  assert.equal(ms(parse(format(d, "rfc")!, "auto")), d.getTime());
  assert.equal(format(d, "unix-sec"), "1700000000");
  assert.equal(format(d, "unix-ms"), "1700000000000");
  // Berlin = UTC+1 in November.
  assert.equal(format(d, "euro"), "14.11.2023 23:13:20");
  assert.equal(format(d, "custom", ""), "14.11.2023");
  assert.equal(format(new Date(NaN), "iso"), null);
});

test("format unix-sec floors toward -∞ for pre-1970 ms", () => {
  assert.equal(format(new Date(-1500), "unix-sec"), "-2");
  assert.equal(format(new Date(1999), "unix-sec"), "1");
});

test("formatCustom: all tokens, every occurrence, literal text kept", () => {
  const d = new Date(2024, 0, 5, 7, 8, 9, 45); // local
  assert.equal(formatCustom(d, "yyyy-MM-dd HH:mm:ss.SSS"), "2024-01-05 07:08:09.045");
  assert.equal(formatCustom(d, "dd/MM/yyyy (dd)"), "05/01/2024 (05)");
  assert.equal(formatCustom(d, "T: HHmm"), "T: 0708");
  assert.equal(formatCustom(d, "no tokens"), "no tokens");
  assert.equal(formatCustom(new Date(-62135596800000 + 86400000 * 400), "yyyy"), "0002");
});

test("DST: local time components follow the zone (Europe/Berlin)", () => {
  // 2024-03-31 01:30 UTC = 03:30 CEST (after spring-forward at 02:00 local).
  assert.equal(format(new Date(Date.UTC(2024, 2, 31, 1, 30)), "euro"), "31.03.2024 03:30:00");
  // 2024-03-31 00:30 UTC = 01:30 CET (before the switch).
  assert.equal(format(new Date(Date.UTC(2024, 2, 31, 0, 30)), "euro"), "31.03.2024 01:30:00");
  // Autumn fall-back: 00:30 UTC and 01:30 UTC both show 02:30 / 02:30 local.
  assert.equal(format(new Date(Date.UTC(2024, 9, 27, 0, 30)), "euro"), "27.10.2024 02:30:00");
  assert.equal(format(new Date(Date.UTC(2024, 9, 27, 1, 30)), "euro"), "27.10.2024 02:30:00");
});

test("format local: page locale + time-zone name, fallback without locale", () => {
  const d = new Date(1700000000000);
  const en = format(d, "local", undefined, "en")!;
  assert.match(en, /November 14, 2023/);
  assert.match(en, /11:13:20 PM/);
  assert.match(format(d, "local", undefined, "ru")!, /14 ноября 2023/);
  assert.match(format(d, "local", undefined, "de")!, /14\. November 2023/);
  assert.match(format(d, "local", undefined, "ja")!, /2023年11月14日/);
  assert.match(format(d, "local")!, /^Tue Nov 14 2023 23:13:20 GMT\+0100/);
});
