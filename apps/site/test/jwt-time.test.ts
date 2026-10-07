import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_NUMERIC_DATE,
  nextRefreshDelay,
  readTemporalClaims,
  relativeParts,
  temporalReport,
} from "../src/tools/jwt-time.ts";

const NOW = 1_800_000_000;
const report = (payload: Record<string, unknown>, now = NOW) => {
  const claims = readTemporalClaims(JSON.stringify(payload));
  assert.ok(claims);
  return temporalReport(claims, now);
};

test("readTemporalClaims: exp → nbf → iat order, fractions kept, non-objects rejected", () => {
  const claims = readTemporalClaims('{"iat":1.5,"sub":"x","nbf":2,"exp":3}');
  assert.deepEqual(
    claims?.map((c) => [c.claim, c.seconds, c.problem]),
    [["exp", 3, null], ["nbf", 2, null], ["iat", 1.5, null]],
  );
  assert.deepEqual(readTemporalClaims('{"sub":"x"}'), []);
  assert.equal(readTemporalClaims('"string payload"'), null);
  assert.equal(readTemporalClaims("[1]"), null);
  assert.equal(readTemporalClaims("not json"), null);
});

test("readTemporalClaims: non-numbers and out-of-range values are diagnosed, not dropped", () => {
  const claims = readTemporalClaims(
    JSON.stringify({ exp: "1800000000", nbf: null, iat: MAX_NUMERIC_DATE + 1 }),
  );
  assert.deepEqual(
    claims?.map((c) => [c.claim, c.seconds, c.problem, c.raw]),
    [
      ["exp", null, "type", '"1800000000"'],
      ["nbf", null, "type", "null"],
      ["iat", null, "range", String(MAX_NUMERIC_DATE + 1)],
    ],
  );
  // 1e400 parses to Infinity → not a finite NumericDate.
  assert.equal(readTemporalClaims('{"exp":1e400}')?.[0]?.problem, "type");
});

test("temporalReport: status precedence", () => {
  assert.equal(report({ exp: NOW }).status, "expired"); // now ≥ exp
  assert.equal(report({ exp: NOW - 10, nbf: NOW + 10 }).status, "expired"); // expired wins
  assert.equal(report({ nbf: NOW + 1, exp: NOW + 100 }).status, "not-yet-valid");
  assert.equal(report({ nbf: NOW + 1, exp: NOW + 7200 }).status, "not-yet-valid");
  assert.equal(report({ exp: NOW + 300 }).status, "expires-soon"); // inclusive 5 min
  assert.equal(report({ exp: NOW + 301 }).status, "valid");
  assert.equal(report({ nbf: NOW }).status, "valid"); // nbf reached
  assert.equal(report({ iat: NOW - 60 }).status, "unbounded"); // iat is not valid-from
  assert.equal(report({}).status, "unbounded");
});

test("temporalReport: any invalid claim yields 'invalid', never a positive status", () => {
  assert.equal(report({ exp: "tomorrow" }).status, "invalid");
  assert.equal(report({ exp: NOW + 3600, iat: true }).status, "invalid");
  assert.equal(report({ nbf: MAX_NUMERIC_DATE * 2 }).status, "invalid");
});

test("temporalReport: inconsistent bounds and suspicious values are flagged", () => {
  assert.deepEqual(report({ exp: NOW - 100, nbf: NOW - 50 }).warnings, [{ code: "nbf-after-exp" }]);
  assert.deepEqual(report({ exp: NOW + 100, nbf: NOW + 100 }).warnings, [{ code: "nbf-after-exp" }]);
  assert.deepEqual(report({ exp: NOW + 100, iat: NOW + 200 }).warnings, [
    { code: "iat-after-exp" },
    { code: "iat-in-future" },
  ]);
  assert.deepEqual(report({ exp: NOW * 1000 }).warnings, [{ code: "milliseconds", claim: "exp" }]);
  assert.deepEqual(report({ exp: NOW + 3600, nbf: NOW - 10, iat: NOW - 10 }).warnings, []);
});

test("nextRefreshDelay: 1 s near exp / nbf / expires-soon edge / iat, else 60 s", () => {
  const delay = (payload: Record<string, unknown>) =>
    nextRefreshDelay(readTemporalClaims(JSON.stringify(payload)) ?? [], NOW);
  assert.equal(delay({ exp: NOW + 30 }), 1000);
  assert.equal(delay({ exp: NOW + 300 + 60 }), 1000); // approaching the 5-min warning
  assert.equal(delay({ nbf: NOW - 90 }), 1000);
  assert.equal(delay({ iat: NOW - 5 }), 1000);
  assert.equal(delay({ exp: NOW + 3600, iat: NOW - 3600 }), 60_000);
  assert.equal(delay({ exp: "bad" }), 60_000);
  assert.equal(delay({}), 60_000);
});

test("relativeParts: largest unit, rounded, signed", () => {
  assert.deepEqual(relativeParts(0), { value: 0, unit: "second" });
  assert.deepEqual(relativeParts(-0.4), { value: 0, unit: "second" });
  assert.deepEqual(relativeParts(-45), { value: -45, unit: "second" });
  assert.deepEqual(relativeParts(90), { value: 2, unit: "minute" });
  assert.deepEqual(relativeParts(-3 * 3600), { value: -3, unit: "hour" });
  assert.deepEqual(relativeParts(2 * 86_400), { value: 2, unit: "day" });
  assert.deepEqual(relativeParts(90 * 86_400), { value: 3, unit: "month" });
  assert.deepEqual(relativeParts(74 * 365.2425 * 86_400), { value: 74, unit: "year" });
});
