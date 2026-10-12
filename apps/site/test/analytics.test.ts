import assert from "node:assert/strict";
import test from "node:test";

import { createAutomaticToolUse } from "../src/scripts/analytics/automatic-use.ts";
import type { ToolEvent } from "../src/scripts/analytics/events.ts";
import { createToolOperation, durationBucket } from "../src/scripts/analytics/instrumentation.ts";
import { sendToolEvent } from "../src/scripts/analytics/transport.ts";

test("successful duration buckets use exact lower boundaries", () => {
  assert.deepEqual(
    [-1, 0, 99.999, 100, 999.999, 1_000, 4_999.999, 5_000, 29_999.999, 30_000].map(durationBucket),
    ["lt_100ms", "lt_100ms", "lt_100ms", "100ms_1s", "100ms_1s", "1s_5s", "1s_5s", "5s_30s", "5s_30s", "gte_30s"],
  );
});

test("an operation emits one terminal event and cancellation is not failure", () => {
  const events: ToolEvent[] = [];
  let now = 10;
  const completed = createToolOperation("word-counter", (event) => events.push(event), () => now);
  now = 110;
  completed.complete();
  completed.fail("processing_error");
  completed.cancel();

  const cancelled = createToolOperation("word-counter", (event) => events.push(event), () => now);
  cancelled.cancel();
  cancelled.complete();

  assert.deepEqual(events, [
    { tool: "word-counter", event: "tool_started" },
    { tool: "word-counter", event: "tool_completed", duration: "100ms_1s" },
    { tool: "word-counter", event: "tool_started" },
    { tool: "word-counter", event: "tool_cancelled" },
  ]);
});

test("automatic-use telemetry keeps only the final settled human edit", () => {
  const events: ToolEvent[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  let now = 0;
  const telemetry = createAutomaticToolUse("regex-tester", 600, {
    emit: (event) => events.push(event),
    clock: () => now,
    schedule: (callback) => {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    unschedule: (handle) => {
      if (typeof handle === "number") timers.delete(handle);
    },
  });

  telemetry.changed();
  const superseded = telemetry.start();
  now = 250;
  superseded?.complete();
  telemetry.changed();
  now = 300;
  const final = telemetry.start();
  now = 320;
  final?.complete();
  for (const callback of timers.values()) callback();

  assert.deepEqual(events, [
    { tool: "regex-tester", event: "tool_started" },
    { tool: "regex-tester", event: "tool_completed", duration: "lt_100ms" },
  ]);
});

test("automatic-use telemetry ignores overlapping same-edit runs and late stale completion", () => {
  const events: ToolEvent[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  let now = 0;
  const telemetry = createAutomaticToolUse("markdown-preview", 600, {
    emit: (event) => events.push(event),
    clock: () => now,
    schedule: (callback) => {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    unschedule: (handle) => {
      if (typeof handle === "number") timers.delete(handle);
    },
  });

  telemetry.changed();
  const pending = telemetry.start();
  now = 10;
  pending?.complete();

  const stale = telemetry.start();
  now = 20;
  const latest = telemetry.start();
  now = 50;
  latest?.complete();
  now = 100;
  stale?.complete();

  for (const callback of [...timers.values()]) callback();

  assert.deepEqual(events, [
    { tool: "markdown-preview", event: "tool_started" },
    { tool: "markdown-preview", event: "tool_completed", duration: "lt_100ms" },
  ]);
});

test("transport strips excess runtime fields before serialization", async () => {
  const originalFetch = globalThis.fetch;
  let body = "";
  globalThis.fetch = (_input, init) => {
    body = String(init?.body ?? "");
    return Promise.resolve(new Response(null, { status: 202 }));
  };
  try {
    sendToolEvent({
      tool: "word-counter",
      event: "tool_failed",
      reason: "invalid_input",
      input: "private text",
      error: "private stack",
    } as unknown as ToolEvent);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(JSON.parse(body), {
      tool: "word-counter",
      event: "tool_failed",
      reason: "invalid_input",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
