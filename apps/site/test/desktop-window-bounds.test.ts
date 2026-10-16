import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WINDOW_BOUNDS_KEY,
  parseWindowBounds,
  serializeWindowBounds,
} from "../src/desktop/persistence.ts";
import type { Bounds } from "../src/desktop/types.ts";

const slugs = new Set(["uuid-generator", "hash-calculator"]);

test("window bounds use a separate versioned storage key", () => {
  assert.equal(WINDOW_BOUNDS_KEY, "mdt.desktop.window-bounds.v1");
});

test("known bounds round-trip in exact CSS pixels independently of open windows", () => {
  const bounds = {
    "uuid-generator": { x: 137.25, y: 48.5, width: 843.75, height: 611.125 },
    "hash-calculator": { x: 0, y: 0, width: 520, height: 360 },
  } satisfies Record<string, Bounds>;

  assert.deepEqual(parseWindowBounds(null, slugs), {});
  assert.deepEqual(parseWindowBounds(serializeWindowBounds(bounds), slugs), bounds);
});

test("unusable window-bound envelopes produce an empty record", () => {
  const unusable = [
    "not json",
    "null",
    "[]",
    JSON.stringify({ v: 2, bounds: { "uuid-generator": { x: 1, y: 2, width: 3, height: 4 } } }),
    JSON.stringify({ v: 1 }),
    JSON.stringify({ v: 1, bounds: [] }),
  ];

  for (const raw of unusable) assert.deepEqual(parseWindowBounds(raw, slugs), {});
});

test("parser ignores unknown tools and invalid or nonfinite geometry", () => {
  const raw = `{"v":1,"bounds":{
    "uuid-generator":{"x":12,"y":34,"width":720,"height":520,"toolInput":"private"},
    "unknown-tool":{"x":1,"y":2,"width":300,"height":200},
    "negative-x":{"x":-1,"y":0,"width":300,"height":200},
    "negative-y":{"x":0,"y":-1,"width":300,"height":200},
    "zero-width":{"x":0,"y":0,"width":0,"height":200},
    "zero-height":{"x":0,"y":0,"width":300,"height":0},
    "infinite-x":{"x":1e400,"y":0,"width":300,"height":200},
    "infinite-width":{"x":0,"y":0,"width":1e400,"height":200}
  }}`;
  const allNamedSlugs = new Set([
    ...slugs,
    "negative-x",
    "negative-y",
    "zero-width",
    "zero-height",
    "infinite-x",
    "infinite-width",
  ]);

  assert.deepEqual(parseWindowBounds(raw, allNamedSlugs), {
    "uuid-generator": { x: 12, y: 34, width: 720, height: 520 },
  });
});

test("serializer copies geometry only and parser strips extra stored fields", () => {
  const privateBounds = {
    x: 9,
    y: 11,
    width: 801,
    height: 602,
    input: "secret text",
    result: "secret output",
  } as Bounds & { input: string; result: string };
  const serialized = serializeWindowBounds({ "uuid-generator": privateBounds });
  const envelope = JSON.parse(serialized);

  assert.deepEqual(envelope, {
    v: 1,
    bounds: { "uuid-generator": { x: 9, y: 11, width: 801, height: 602 } },
  });
  assert.deepEqual(parseWindowBounds(serialized, slugs), {
    "uuid-generator": { x: 9, y: 11, width: 801, height: 602 },
  });
});
