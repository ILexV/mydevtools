import assert from "node:assert/strict";
import test from "node:test";

import { TOOLS } from "../../../apps/site/src/registry/tools.ts";
import {
  VOTE_CHOICES,
} from "../../../apps/site/src/scripts/analytics/events.ts";
import type { AnalyticsReport } from "../../../apps/site/src/scripts/analytics/reports.ts";
import {
  collectPeriodMetrics,
} from "../src/reports.ts";
import { handleRequest, type Env } from "../src/index.ts";

const SUMMARY_ENDPOINT = "https://mydevtools.app/api/analytics/reports/summary";
const HISTORY_ENDPOINT = "https://mydevtools.app/api/analytics/reports/history";
const ARCHIVE_ENDPOINT = "https://mydevtools.app/api/analytics/reports/archive";
const PRODUCTION_ORIGIN = "https://mydevtools.app";
const ACCESS_AUDIENCE = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PRIVATE_TOKEN = "private-read-token-must-never-escape";

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    ALLOWED_BROWSER_ORIGIN: PRODUCTION_ORIGIN,
    ANALYTICS_READ_TOKEN: PRIVATE_TOKEN,
    ANALYTICS_ACCESS_AUD: ACCESS_AUDIENCE,
    ANALYTICS_ACCOUNT_ID: "5aeb7e01c612a208baf33ac1c646a048",
    ANALYTICS_REPORT_DATASET: "mydevtools_tool_usage",
    TOOL_ANALYTICS: {
      writeDataPoint(): void {
        throw new Error("Report requests must not write ingestion data");
      },
    },
    ...overrides,
  };
}

function accessContext(audience = ACCESS_AUDIENCE): Pick<ExecutionContext, "access"> {
  return {
    access: {
      aud: audience,
      async getIdentity(): Promise<CloudflareAccessIdentity> {
        return { email: "owner@example.com" };
      },
    },
  };
}

function privateRequest(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("Origin")) headers.set("Origin", PRODUCTION_ORIGIN);
  if (!headers.has("Sec-Fetch-Site")) headers.set("Sec-Fetch-Site", "same-origin");
  return new Request(url, {
    ...init,
    method: init.method ?? "POST",
    headers,
  });
}

function assertReportHeaders(response: Response): void {
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex");
  assert.equal(response.headers.get("Set-Cookie"), null);
}

function operationRows(): Record<string, unknown>[] {
  return [
    {
      tool: "hash-calculator",
      event: "tool_started",
      duration: "",
      reason: "",
      operations: "6",
      maximum_sample_interval: "3",
    },
    {
      tool: "hash-calculator",
      event: "tool_completed",
      duration: "1s_5s",
      reason: "",
      operations: 4,
      maximum_sample_interval: 2,
    },
    {
      tool: "hash-calculator",
      event: "tool_completed",
      operations: 3,
      maximum_sample_interval: 1,
    },
    {
      tool: "base64-encoder",
      event: "tool_failed",
      duration: "",
      reason: "invalid_input",
      operations: 1,
      maximum_sample_interval: 1,
    },
    {
      tool: "base64-encoder",
      event: "tool_failed",
      operations: "3.0",
      maximum_sample_interval: 3,
    },
    {
      tool: "base64-encoder",
      event: "tool_cancelled",
      duration: "",
      reason: "",
      operations: 2,
      maximum_sample_interval: 2,
    },
  ];
}
test("all private report routes fail closed on Access, source, and configuration", async (t) => {
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches += 1;
    return Response.json({ data: [] });
  });

  for (const url of [`${SUMMARY_ENDPOINT}?days=30`, HISTORY_ENDPOINT, ARCHIVE_ENDPOINT]) {
    const missingAccess = await handleRequest(privateRequest(url), createEnv());
    assert.equal(missingAccess.status, 403);
    assertReportHeaders(missingAccess);

    const wrongAudience = await handleRequest(
      privateRequest(url),
      createEnv(),
      accessContext("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
    );
    assert.equal(wrongAudience.status, 403);

    const foreign = await handleRequest(
      privateRequest(url, {
        headers: { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" },
      }),
      createEnv(),
      accessContext(),
    );
    assert.equal(foreign.status, 403);

    const unavailable = await handleRequest(
      privateRequest(url),
      createEnv({ ANALYTICS_READ_TOKEN: undefined }),
      accessContext(),
    );
    assert.equal(unavailable.status, 503);
  }
  assert.equal(fetches, 0);
});

test("summary returns weighted classified metrics, zero catalogs, votes, and exact adjacent ranges", async (t) => {
  const results = [
    { data: operationRows() },
    {
      data: [{
        vote: "vote:batch-conversion",
        votes: "5",
        maximum_sample_interval: 4,
      }],
    },
    { data: operationRows() },
    {
      data: [{
        vote: "vote:batch-conversion",
        votes: "5",
        maximum_sample_interval: 4,
      }],
    },
    { data: [] },
  ];
  let call = 0;
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(results[call++]!));

  const response = await handleRequest(
    privateRequest(`${SUMMARY_ENDPOINT}?days=7`),
    createEnv(),
    accessContext(),
  );
  assert.equal(response.status, 200);
  assertReportHeaders(response);
  const report = (await response.json()) as AnalyticsReport;

  assert.deepEqual(report.summary, { started: 6, completed: 7, failed: 4, cancelled: 2 });
  assert.equal(report.tools.length, TOOLS.length);
  const hash = report.tools.find(({ tool }) => tool === "hash-calculator")!;
  assert.deepEqual(hash.durations, {
    lt_100ms: 0,
    "100ms_1s": 0,
    "1s_5s": 4,
    "5s_30s": 0,
    gte_30s: 0,
    unclassified: 3,
  });
  const base64 = report.tools.find(({ tool }) => tool === "base64-encoder")!;
  assert.equal(base64.failed, 4);
  assert.equal(base64.cancelled, 2);
  assert.deepEqual(base64.errors, {
    invalid_input: 1,
    unsupported_format: 0,
    wasm_unavailable: 0,
    processing_error: 0,
    unclassified: 3,
  });
  assert.deepEqual(report.durations, hash.durations);
  assert.deepEqual(report.errors, base64.errors);
  assert.equal(report.votes.length, VOTE_CHOICES.length);
  assert.equal(report.votes.find(({ choice }) => choice === "batch-conversion")?.votes, 5);
  assert.equal(report.maximumSampleInterval, 4);
  assert.deepEqual(report.comparison?.summary, report.summary);
  assert.equal(report.comparison?.rangeTo, report.rangeFrom);
  assert.equal(
    new Date(report.rangeFrom).getTime() - new Date(report.comparison!.rangeFrom).getTime(),
    7 * 24 * 60 * 60 * 1_000,
  );
  assert.equal(
    new Date(report.rangeTo).getTime() - new Date(report.rangeFrom).getTime(),
    7 * 24 * 60 * 60 * 1_000,
  );
  assert.ok(report.daily.length >= 7);
  assert.ok(report.daily.every(({ started, completed, failed, cancelled }) =>
    started === 0 && completed === 0 && failed === 0 && cancelled === 0));

});

test("90-day summary has no unsupported comparison and still exposes zero catalogs", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [] }));

  const response = await handleRequest(
    privateRequest(`${SUMMARY_ENDPOINT}?days=90`),
    createEnv(),
    accessContext(),
  );
  assert.equal(response.status, 200);
  const report = (await response.json()) as AnalyticsReport;
  assert.equal(report.comparison, null);
  assert.deepEqual(report.summary, { started: 0, completed: 0, failed: 0, cancelled: 0 });
  assert.equal(report.tools.length, TOOLS.length);
  assert.equal(report.votes.length, VOTE_CHOICES.length);
});

test("rejects invalid route parameters and bodies before private storage or SQL", async (t) => {
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches += 1;
    return Response.json({ data: [] });
  });

  const invalidRequests = [
    privateRequest(SUMMARY_ENDPOINT),
    privateRequest(`${SUMMARY_ENDPOINT}?days=7&days=30`),
    privateRequest(`${SUMMARY_ENDPOINT}?days=7`, { body: "private" }),
    privateRequest(`${HISTORY_ENDPOINT}?year=1999`),
    privateRequest(`${HISTORY_ENDPOINT}?year=2026&year=2025`),
    privateRequest(HISTORY_ENDPOINT, { body: "private" }),
    privateRequest(`${ARCHIVE_ENDPOINT}?year=2026`),
    privateRequest(ARCHIVE_ENDPOINT, { body: "private" }),
  ];
  for (const request of invalidRequests) {
    const response = await handleRequest(request, createEnv(), accessContext());
    assert.equal(response.status, 400);
    assertReportHeaders(response);
  }
  assert.equal(fetches, 0);
});

test("history and archive report missing aggregate storage as unavailable, never empty data", async () => {
  for (const url of [HISTORY_ENDPOINT, ARCHIVE_ENDPOINT]) {
    const response = await handleRequest(privateRequest(url), createEnv(), accessContext());
    assert.equal(response.status, 503);
    assertReportHeaders(response);
    const body = await response.json() as { error?: string };
    assert.equal(typeof body.error, "string");
    assert.equal("months" in body, false);
  }
});

test("query failures and malformed dimensions never masquerade as zero analytics", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(`provider details ${PRIVATE_TOKEN}`, { status: 403 }));
  const rejected = await handleRequest(
    privateRequest(`${SUMMARY_ENDPOINT}?days=30`),
    createEnv(),
    accessContext(),
  );
  assert.equal(rejected.status, 502);
  assert.equal((await rejected.text()).includes(PRIVATE_TOKEN), false);

  t.mock.restoreAll();
  let call = 0;
  t.mock.method(globalThis, "fetch", async () => {
    call += 1;
    return Response.json(call === 1
      ? {
          data: [{
            tool: "hash-calculator",
            event: "tool_completed",
            duration: "invented_bucket",
            reason: "",
            operations: 1,
            maximum_sample_interval: 1,
          }],
        }
      : { data: [] });
  });
  const malformed = await handleRequest(
    privateRequest(`${SUMMARY_ENDPOINT}?days=90`),
    createEnv(),
    accessContext(),
  );
  assert.equal(malformed.status, 502);
});

test("archive collector retains weighted rows for retired catalog IDs", async (t) => {
  const retiredTool = "retired-audio-tool";
  const retiredChoice = "retired-proposal";

  const results = [
    {
      data: [
        {
          tool: retiredTool,
          event: "tool_started",
          duration: "",
          reason: "",
          operations: "12",
          maximum_sample_interval: "4",
        },
        {
          tool: retiredTool,
          event: "tool_completed",
          duration: "100ms_1s",
          reason: "",
          operations: "7",
          maximum_sample_interval: "3",
        },
        {
          tool: retiredTool,
          event: "tool_failed",
          duration: "",
          reason: "processing_error",
          operations: "3",
          maximum_sample_interval: "3",
        },
        {
          tool: retiredTool,
          event: "tool_cancelled",
          duration: "",
          reason: "",
          operations: "2",
          maximum_sample_interval: "2",
        },
      ],
    },
    {
      data: [{
        vote: `vote:${retiredChoice}`,
        votes: "9",
        maximum_sample_interval: "5",
      }],
    },
  ];
  let call = 0;
  t.mock.method(globalThis, "fetch", async () => Response.json(results[call++]!));

  const collected = await collectPeriodMetrics(
    createEnv(),
    new Date("2026-08-01T00:00:00.000Z"),
    new Date("2026-09-01T00:00:00.000Z"),
  );

  assert.deepEqual(collected.summary, {
    started: 12,
    completed: 7,
    failed: 3,
    cancelled: 2,
  });
  assert.equal(collected.tools.length, 1);
  assert.equal(collected.tools[0]?.tool, retiredTool);
  assert.equal(collected.tools[0]?.durations["100ms_1s"], 7);
  assert.equal(collected.tools[0]?.errors.processing_error, 3);
  assert.deepEqual(collected.votes, [{
    choice: retiredChoice,
    votes: 9,
    maximumSampleInterval: 5,
  }]);
  assert.equal(collected.maximumSampleInterval, 5);
  assert.equal(call, 2);
});

test("fixed collector handles an empty interval and rejects unsafe bounds without querying", async (t) => {
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches += 1;
    return Response.json({ data: [] });
  });
  const env = createEnv();
  const boundary = new Date("2026-10-01T00:00:00.000Z");
  const empty = await collectPeriodMetrics(env, boundary, boundary);
  assert.deepEqual(empty.summary, {
    started: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  });
  assert.deepEqual(empty.tools, []);
  assert.deepEqual(empty.votes, []);
  assert.equal(empty.maximumSampleInterval, 0);
  await assert.rejects(() =>
    collectPeriodMetrics(env, new Date("invalid"), new Date("2026-10-01T00:00:00.000Z")));
  await assert.rejects(() =>
    collectPeriodMetrics(
      env,
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-10-01T00:00:00.000Z"),
    ));
  assert.equal(fetches, 0);
});
