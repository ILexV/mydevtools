import assert from "node:assert/strict";
import test from "node:test";

import { validateToolEvent } from "../src/validation.ts";

test("parses either exact-field order and JSON escapes", () => {
  assert.deepEqual(
    validateToolEvent('{ "event": "tool_started", "to\\u006fl": "base64-encoder" }'),
    { tool: "base64-encoder", event: "tool_started" },
  );
});

test("rejects duplicate decoded keys and trailing documents", () => {
  assert.equal(
    validateToolEvent(
      '{"tool":"base64-encoder","to\\u006fl":"hash-calculator","event":"tool_started"}',
    ),
    null,
  );
  assert.equal(
    validateToolEvent(
      '{"tool":"base64-encoder","event":"tool_started"}{"tool":"base64-encoder","event":"tool_failed"}',
    ),
    null,
  );
});
