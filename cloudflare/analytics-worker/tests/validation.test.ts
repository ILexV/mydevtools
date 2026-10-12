import assert from "node:assert/strict";
import test from "node:test";

import { validateToolEvent, validateToolVote } from "../src/validation.ts";

test("accepts every exact event variant independent of field order", () => {
  assert.deepEqual(
    validateToolEvent('{ "event": "tool_started", "to\\u006fl": "base64-encoder" }'),
    { tool: "base64-encoder", event: "tool_started" },
  );
  assert.deepEqual(
    validateToolEvent('{"duration":"1s_5s","tool":"hash-calculator","event":"tool_completed"}'),
    { tool: "hash-calculator", event: "tool_completed", duration: "1s_5s" },
  );
  assert.deepEqual(
    validateToolEvent('{"reason":"unsupported_format","event":"tool_failed","tool":"image-converter"}'),
    { tool: "image-converter", event: "tool_failed", reason: "unsupported_format" },
  );
  assert.deepEqual(
    validateToolEvent('{"tool":"qr-scanner","event":"tool_cancelled"}'),
    { tool: "qr-scanner", event: "tool_cancelled" },
  );
});

test("rejects unknown values, missing discriminated fields, and every extra field", () => {
  const invalid = [
    '{"tool":"unknown","event":"tool_started"}',
    '{"tool":"base64-encoder","event":"unknown"}',
    '{"tool":"base64-encoder","event":"tool_completed"}',
    '{"tool":"base64-encoder","event":"tool_completed","duration":"fast"}',
    '{"tool":"base64-encoder","event":"tool_failed"}',
    '{"tool":"base64-encoder","event":"tool_failed","reason":"raw error text"}',
    '{"tool":"base64-encoder","event":"tool_started","duration":"lt_100ms"}',
    '{"tool":"base64-encoder","event":"tool_cancelled","reason":"processing_error"}',
    '{"tool":"base64-encoder","event":"tool_failed","reason":"processing_error","message":"secret"}',
  ];
  for (const payload of invalid) assert.equal(validateToolEvent(payload), null);
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
      '{"tool":"base64-encoder","event":"tool_started"}{"tool":"base64-encoder","event":"tool_failed","reason":"processing_error"}',
    ),
    null,
  );
});

test("accepts only a single fixed vote choice field", () => {
  assert.deepEqual(validateToolVote('{"choice":"sql-formatter"}'), {
    choice: "sql-formatter",
  });
  for (const payload of [
    '{}',
    '{"choice":"other"}',
    '{"choice":"sql-formatter","input":"SELECT secret"}',
    '{"choice":"sql-formatter","choice":"batch-conversion"}',
  ]) {
    assert.equal(validateToolVote(payload), null);
  }
});
