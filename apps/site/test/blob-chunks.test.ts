import { test } from "node:test";
import assert from "node:assert/strict";
import { readBlobChunks } from "../src/scripts/blob-chunks.ts";

test("readBlobChunks bounds reads and preserves absolute offsets", async () => {
  const blob = new Blob([new Uint8Array([0, 1, 2, 3, 4, 5])]);
  const chunks = [];
  for await (const chunk of readBlobChunks(blob, { chunkBytes: 2, start: 1, end: 5 })) {
    chunks.push({ bytes: [...chunk.bytes], offset: chunk.offset, end: chunk.end });
  }
  assert.deepEqual(chunks, [
    { bytes: [1, 2], offset: 1, end: 3 },
    { bytes: [3, 4], offset: 3, end: 5 },
  ]);
});

test("readBlobChunks stops before the next read after cancellation", async () => {
  const controller = new AbortController();
  const iterator = readBlobChunks(new Blob([new Uint8Array([0, 1, 2])]), {
    chunkBytes: 1,
    signal: controller.signal,
  });
  assert.deepEqual([...(await iterator.next()).value!.bytes], [0]);
  controller.abort();
  await assert.rejects(iterator.next(), (error: unknown) => error instanceof DOMException && error.name === "AbortError");
});
