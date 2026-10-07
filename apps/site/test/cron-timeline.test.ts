import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TIMELINE_MAX,
  cronFieldValues,
  relativeTimeParts,
  timelineView,
  utcOffsetLabel,
} from "../src/tools/cron-timeline.ts";

test("timelineView: five first, Show next 5, capped at ten", () => {
  assert.deepEqual(timelineView(10, 0), { visible: 5, more: 5, shortfall: false });
  assert.deepEqual(timelineView(10, 1), { visible: 10, more: 0, shortfall: false });
  // Extra clicks never exceed the cap.
  assert.deepEqual(timelineView(10, 5), { visible: TIMELINE_MAX, more: 0, shortfall: false });
});

test("timelineView: search horizon shortfall is reported only once more runs were asked for", () => {
  assert.deepEqual(timelineView(7, 0), { visible: 5, more: 2, shortfall: false });
  assert.deepEqual(timelineView(7, 1), { visible: 7, more: 0, shortfall: true });
  assert.deepEqual(timelineView(5, 0), { visible: 5, more: 0, shortfall: false });
  assert.deepEqual(timelineView(3, 0), { visible: 3, more: 0, shortfall: true });
  assert.deepEqual(timelineView(0, 0), { visible: 0, more: 0, shortfall: true });
});

test("relativeTimeParts picks a readable unit and never 0", () => {
  const now = Date.UTC(2026, 0, 1);
  const sec = 1000;
  assert.deepEqual(relativeTimeParts(now, now + 200), { value: 1, unit: "second" });
  assert.deepEqual(relativeTimeParts(now, now + 42 * sec), { value: 42, unit: "second" });
  assert.deepEqual(relativeTimeParts(now, now + 15 * 60 * sec), { value: 15, unit: "minute" });
  assert.deepEqual(relativeTimeParts(now, now + 80 * 60 * sec), { value: 80, unit: "minute" });
  assert.deepEqual(relativeTimeParts(now, now + 150 * 60 * sec), { value: 3, unit: "hour" });
  assert.deepEqual(relativeTimeParts(now, now + 30 * 3600 * sec), { value: 30, unit: "hour" });
  assert.deepEqual(relativeTimeParts(now, now + 3 * 86400 * sec), { value: 3, unit: "day" });
  assert.deepEqual(relativeTimeParts(now, now + 90 * 86400 * sec), { value: 3, unit: "month" });
  assert.deepEqual(relativeTimeParts(now, now + 4 * 365.25 * 86400 * sec), { value: 4, unit: "year" });
  // A run in the past (clock skew) is clamped, not negative.
  assert.deepEqual(relativeTimeParts(now, now - 5000), { value: 1, unit: "second" });
});

test("utcOffsetLabel formats minutes east of UTC", () => {
  assert.equal(utcOffsetLabel(0), "UTC");
  assert.equal(utcOffsetLabel(360), "UTC+06:00");
  assert.equal(utcOffsetLabel(330), "UTC+05:30");
  assert.equal(utcOffsetLabel(-210), "UTC−03:30");
});

test("cronFieldValues splits an expanded expression into five fields", () => {
  assert.deepEqual(cronFieldValues("*/15  * * * *"), ["*/15", "*", "*", "*", "*"]);
  assert.deepEqual(cronFieldValues(" 0 9 * * 1-5 "), ["0", "9", "*", "*", "1-5"]);
  assert.equal(cronFieldValues(null), null);
  assert.equal(cronFieldValues("0 0 * *"), null);
});
