import assert from "node:assert/strict";
import test from "node:test";

import type { AnalyticsReport } from "../../../apps/site/src/scripts/analytics/reports.ts";
import { handleRequest, type Env } from "../src/index.ts";

const REPORT_ENDPOINT = "https://mydevtools.app/api/analytics/reports/summary";
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

function reportRequest(query = "?days=30", init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("Origin")) headers.set("Origin", PRODUCTION_ORIGIN);
  if (!headers.has("Sec-Fetch-Site")) headers.set("Sec-Fetch-Site", "same-origin");
  return new Request(`${REPORT_ENDPOINT}${query}`, {
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

test("denies missing, forged, and wrong-audience Access context without querying", async (t) => {
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches += 1;
    return Response.json({ data: [] });
  });

  const forgedHeaders = {
    "Cf-Access-Jwt-Assertion": "user-controlled-jwt",
    Cookie: "CF_Authorization=user-controlled-cookie",
  };
  const cases: Array<[Request, Pick<ExecutionContext, "access"> | undefined]> = [
    [reportRequest("?days=30", { headers: forgedHeaders }), undefined],
    [reportRequest(), accessContext("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")],
  ];

  for (const [request, context] of cases) {
    const response = await handleRequest(request, createEnv(), context);
    assert.equal(response.status, 403);
    assertReportHeaders(response);
  }
  assert.equal(fetches, 0);
});

test("fails closed when private report configuration is absent or malformed", async (t) => {
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches += 1;
    return Response.json({ data: [] });
  });

  const configurations: Partial<Env>[] = [
    { ANALYTICS_READ_TOKEN: undefined },
    { ANALYTICS_ACCESS_AUD: undefined },
    { ANALYTICS_ACCOUNT_ID: "00000000000000000000000000000000" },
    { ANALYTICS_REPORT_DATASET: "another_dataset" },
  ];
  for (const configuration of configurations) {
    const response = await handleRequest(
      reportRequest(),
      createEnv(configuration),
      accessContext(),
    );
    assert.equal(response.status, 503);
    assertReportHeaders(response);
  }
  assert.equal(fetches, 0);
});

test("rejects foreign browser sources even with valid Access context", async (t) => {
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches += 1;
    return Response.json({ data: [] });
  });

  const response = await handleRequest(
    reportRequest("?days=7", {
      headers: { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" },
    }),
    createEnv(),
    accessContext(),
  );
  assert.equal(response.status, 403);
  assertReportHeaders(response);
  assert.equal(fetches, 0);
});

test("rejects invalid, duplicate, and injection-shaped periods before querying", async (t) => {
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches += 1;
    return Response.json({ data: [] });
  });

  const queries = [
    "",
    "?days=0",
    "?days=7&days=30",
    "?days=30&format=raw",
    "?days=7%20OR%201%3D1",
    "?days=90%27%3BSELECT%20*%20FROM%20secrets",
  ];
  for (const query of queries) {
    const response = await handleRequest(reportRequest(query), createEnv(), accessContext());
    assert.equal(response.status, 400);
    assertReportHeaders(response);
  }

  const bodyResponse = await handleRequest(
    reportRequest("?days=7", { body: "SELECT * FROM another_dataset" }),
    createEnv(),
    accessContext(),
  );
  assert.equal(bodyResponse.status, 400);
  assertReportHeaders(bodyResponse);
  assert.equal(fetches, 0);
});

test("returns weighted counts, normalized UTC dates, and failure-only tools", async (t) => {
  const results = [
    {
      data: [
        {
          tool: "hash-calculator",
          event: "tool_started",
          operations: "6",
          maximum_sample_interval: "3",
        },
        {
          tool: "hash-calculator",
          event: "tool_completed",
          operations: 4,
          maximum_sample_interval: 2,
        },
        {
          tool: "hash-calculator",
          event: "tool_failed",
          operations: 1,
          maximum_sample_interval: 1,
        },
        {
          tool: "base64-encoder",
          event: "tool_failed",
          operations: "5.0",
          maximum_sample_interval: "5",
        },
      ],
    },
    {
      data: [
        {
          day: "2026-10-08 00:00:00",
          event: "tool_started",
          operations: "3",
          maximum_sample_interval: 3,
        },
        {
          day: "2026-10-08T00:00:00Z",
          event: "tool_completed",
          operations: "2.0",
          maximum_sample_interval: "2",
        },
        {
          day: "2026-10-09 00:00:00",
          event: "tool_started",
          operations: 3,
          maximum_sample_interval: 1,
        },
        {
          day: "2026-10-09T00:00:00Z",
          event: "tool_failed",
          operations: 6,
          maximum_sample_interval: 5,
        },
      ],
    },
  ];
  let call = 0;
  t.mock.method(globalThis, "fetch", async () => Response.json(results[call++]));

  const response = await handleRequest(reportRequest(), createEnv(), accessContext());
  assert.equal(response.status, 200);
  assertReportHeaders(response);
  const report = (await response.json()) as AnalyticsReport;
  assert.equal(report.periodDays, 30);
  assert.equal(report.dataset, "mydevtools_tool_usage");
  assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(report.summary, { started: 6, completed: 4, failed: 6 });
  assert.deepEqual(report.tools, [
    {
      tool: "hash-calculator",
      started: 6,
      completed: 4,
      failed: 1,
      maximumSampleInterval: 3,
    },
    {
      tool: "base64-encoder",
      started: 0,
      completed: 0,
      failed: 5,
      maximumSampleInterval: 5,
    },
  ]);
  assert.deepEqual(report.daily, [
    { day: "2026-10-08", started: 3, completed: 2, failed: 0 },
    { day: "2026-10-09", started: 3, completed: 0, failed: 6 },
  ]);
  assert.equal(report.maximumSampleInterval, 5);
});

test("sanitizes upstream rejection and malformed aggregate data", async (t) => {
  const leakedUpstreamBody = `provider details ${PRIVATE_TOKEN}`;
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(leakedUpstreamBody, { status: 403 }),
  );

  const rejected = await handleRequest(reportRequest(), createEnv(), accessContext());
  assert.equal(rejected.status, 502);
  assertReportHeaders(rejected);
  const rejectedText = await rejected.text();
  assert.equal(rejectedText.includes(PRIVATE_TOKEN), false);

  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      data: [
        {
          tool: "hash-calculator",
          event: "tool_started",
          operations: "not-a-count",
          maximum_sample_interval: 1,
        },
      ],
    }),
  );
  const malformed = await handleRequest(reportRequest(), createEnv(), accessContext());
  assert.equal(malformed.status, 502);
  assertReportHeaders(malformed);
});
