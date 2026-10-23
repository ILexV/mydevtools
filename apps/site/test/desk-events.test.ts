import assert from "node:assert/strict";
import test from "node:test";

import {
  DESK_EVENTS,
  trackDeskEvent,
  windowCountBucket,
  type DeskEvent,
} from "../src/scripts/analytics/desk-events.ts";
import {
  ANALYTICS_DESK_ENDPOINT,
  DESK_EVENT_PAIRS,
  deskEventBody,
  isDeskEvent,
} from "../src/scripts/analytics/events.ts";
import { sendDeskEvent } from "../src/scripts/analytics/transport.ts";

type Captured = { url: string; init: RequestInit | undefined };

async function captureFetch(run: () => void): Promise<Captured[]> {
  const originalFetch = globalThis.fetch;
  const calls: Captured[] = [];
  globalThis.fetch = (input, init) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(new Response(null, { status: 204 }));
  };
  try {
    run();
    await Promise.resolve();
    await Promise.resolve();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return calls;
}

test("window count buckets use exact boundaries and reject empty desks", () => {
  assert.deepEqual(
    [-1, 0, 0.5, Number.NaN, 1, 2, 3, 4, 5, 6, 7, 40, Number.POSITIVE_INFINITY].map(windowCountBucket),
    [null, null, null, null, "1", "2", "3", "4_5", "4_5", "6_plus", "6_plus", "6_plus", null],
  );
  for (const count of [1, 2, 3, 4, 6]) {
    assert.ok(isDeskEvent("desk_windows", windowCountBucket(count)));
  }
});

test("canonical body omits an empty detail and keeps a fixed one", () => {
  assert.deepEqual(deskEventBody({ event: "desk_opened", detail: "" }), { event: "desk_opened" });
  assert.deepEqual(deskEventBody({ event: "desk_windows", detail: "3" }), { event: "desk_windows", detail: "3" });
  assert.equal(DESK_EVENT_PAIRS.length, Object.values(DESK_EVENTS).reduce((sum, list) => sum + list.length, 0));
  for (const pair of DESK_EVENT_PAIRS) assert.ok(isDeskEvent(pair.event, pair.detail));
  assert.equal(isDeskEvent("desk_opened", "x"), false);
  assert.equal(isDeskEvent("desk_windows", ""), false);
  assert.equal(isDeskEvent("toString", ""), false);
});

test("transport posts only the canonical event/detail pair to the desk endpoint", async () => {
  const calls = await captureFetch(() => {
    sendDeskEvent({ event: "desk_windows", detail: "4_5", tool: "secret", input: "private" } as unknown as DeskEvent);
    sendDeskEvent({ event: "desk_opened", detail: "" });
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, ANALYTICS_DESK_ENDPOINT);
  assert.equal(calls[0]!.init?.method, "POST");
  assert.equal(calls[0]!.init?.credentials, "omit");
  assert.equal(calls[0]!.init?.body, '{"event":"desk_windows","detail":"4_5"}');
  assert.equal(calls[1]!.init?.body, '{"event":"desk_opened"}');
});

test("transport drops uncatalogued events instead of sending them", async () => {
  const calls = await captureFetch(() => {
    sendDeskEvent({ event: "desk_windows", detail: "99" } as unknown as DeskEvent);
    sendDeskEvent({ event: "desk_unknown", detail: "" } as unknown as DeskEvent);
    sendDeskEvent(null as unknown as DeskEvent);
  });
  assert.deepEqual(calls, []);
});

test("trackDeskEvent is a silent no-op when analytics is not enabled at build time", async () => {
  // Node has no Vite-injected import.meta.env, so ANALYTICS_ENABLED is not true here.
  const calls = await captureFetch(() => {
    assert.doesNotThrow(() => trackDeskEvent({ event: "desk_opened", detail: "" }));
    assert.doesNotThrow(() => trackDeskEvent(undefined as unknown as DeskEvent));
  });
  assert.deepEqual(calls, []);
});
