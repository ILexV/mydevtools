import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assumedZone,
  canonicalZone,
  relativeUnit,
  sameInstantZones,
  utcOffset,
  zonedDateTime,
  zoneName,
} from "../src/tools/date-zones.ts";

const zones = (device: string | undefined) => sameInstantZones(device).map((row) => [row.zone, row.device]);

test("sameInstantZones: UTC, device, New York, Tokyo in order", () => {
  assert.deepEqual(zones("Asia/Omsk"), [
    ["UTC", false],
    ["Asia/Omsk", true],
    ["America/New_York", false],
    ["Asia/Tokyo", false],
  ]);
});

test("sameInstantZones: deduplicates the device zone (incl. aliases)", () => {
  assert.deepEqual(zones("Etc/UTC"), [
    ["UTC", true],
    ["America/New_York", false],
    ["Asia/Tokyo", false],
  ]);
  assert.deepEqual(zones("Asia/Tokyo"), [
    ["UTC", false],
    ["America/New_York", false],
    ["Asia/Tokyo", true],
  ]);
  assert.equal(sameInstantZones("UTC").length, 3);
});

test("sameInstantZones: unknown or missing device zone is skipped", () => {
  assert.deepEqual(zones(undefined).map(([zone]) => zone), ["UTC", "America/New_York", "Asia/Tokyo"]);
  assert.deepEqual(zones("Mars/Olympus").map(([zone]) => zone), ["UTC", "America/New_York", "Asia/Tokyo"]);
  assert.equal(canonicalZone("Mars/Olympus"), null);
  assert.equal(canonicalZone("Etc/GMT"), "UTC");
});

test("utcOffset: numeric offset from the tz database, DST-aware", () => {
  const winter = new Date(Date.UTC(2023, 10, 14, 22, 13, 20));
  const summer = new Date(Date.UTC(2024, 6, 1, 12));
  assert.equal(utcOffset(winter, "UTC"), "UTC+00:00");
  assert.equal(utcOffset(winter, "America/New_York"), "UTC-05:00");
  assert.equal(utcOffset(summer, "America/New_York"), "UTC-04:00");
  assert.equal(utcOffset(winter, "Asia/Tokyo"), "UTC+09:00");
  assert.equal(utcOffset(winter, "Asia/Kolkata"), "UTC+05:30");
});

test("zonedDateTime: same instant, day changes across zones", () => {
  const instant = new Date(Date.UTC(2023, 10, 14, 22, 13, 20));
  assert.match(zonedDateTime(instant, "UTC", "en"), /Nov 14, 2023/);
  assert.match(zonedDateTime(instant, "Asia/Tokyo", "en"), /Wed, Nov 15, 2023/);
  // New Year crosses the year boundary in Tokyo first.
  const newYear = new Date(Date.UTC(2023, 11, 31, 16));
  assert.match(zonedDateTime(newYear, "Asia/Tokyo", "en"), /2024/);
  assert.match(zonedDateTime(newYear, "America/New_York", "en"), /2023/);
});

test("zoneName: localized generic name, empty when Intl only knows an offset", () => {
  const instant = new Date(Date.UTC(2023, 10, 14));
  assert.equal(zoneName(instant, "Asia/Tokyo", "en"), "Japan Standard Time");
  assert.equal(zoneName(instant, "UTC", "en"), "");
});

test("relativeUnit: minute granularity, then hours, days, months, years", () => {
  const now = Date.UTC(2024, 0, 1);
  assert.deepEqual(relativeUnit(now, now), { value: 0, unit: "second" });
  assert.deepEqual(relativeUnit(now - 20_000, now), { value: 0, unit: "second" });
  assert.deepEqual(relativeUnit(now - 120_000, now), { value: -2, unit: "minute" });
  assert.deepEqual(relativeUnit(now - 5 * 60_000, now), { value: -5, unit: "minute" });
  assert.deepEqual(relativeUnit(now + 3 * 3_600_000, now), { value: 3, unit: "hour" });
  assert.deepEqual(relativeUnit(now - 2 * 86_400_000, now), { value: -2, unit: "day" });
  assert.deepEqual(relativeUnit(now + 90 * 86_400_000, now), { value: 3, unit: "month" });
  assert.deepEqual(relativeUnit(Date.UTC(2023, 10, 14), Date.UTC(2026, 10, 14)), { value: -3, unit: "year" });
});

test("assumedZone: epochs and explicit zones are not assumptions", () => {
  assert.equal(assumedZone("1700000000", "auto"), null);
  assert.equal(assumedZone("-86400.5", "auto"), null);
  assert.equal(assumedZone("1700000000", "unix-sec"), null);
  assert.equal(assumedZone("2024-02-29T12:00:00Z", "auto"), null);
  assert.equal(assumedZone("2024-02-29T12:00:00+0300", "iso"), null);
  assert.equal(assumedZone("2024-02-29T12:00:00.123-05:00", "auto"), null);
  assert.equal(assumedZone("Tue, 14 Nov 2023 22:13:20 GMT", "auto"), null);
  assert.equal(assumedZone("Tue, 14 Nov 2023 22:13:20 +0000", "auto"), null);
  assert.equal(assumedZone("Nov 14 2023 10:00 EST", "auto"), null);
  assert.equal(assumedZone("", "auto"), null);
});

test("assumedZone: JS reads date-only ISO as UTC, other zone-less input as local", () => {
  assert.equal(assumedZone("2024-02-29", "auto"), "utc");
  assert.equal(assumedZone("2024-02", "iso"), "utc");
  assert.equal(assumedZone("2024-02-29T12:00", "auto"), "local");
  assert.equal(assumedZone("2024-02-29 12:00:00", "iso"), "local");
  assert.equal(assumedZone("11-14-2023", "auto"), "local");
  assert.equal(assumedZone("Nov 14 2023 10:00 PM", "auto"), "local");
});
