import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest, type Env } from "../src/index.ts";

const ENDPOINT = "https://mydevtools.app/api/analytics/event";
const PRODUCTION_ORIGIN = "https://mydevtools.app";

type DataPoint = Parameters<AnalyticsEngineDataset["writeDataPoint"]>[0];

function createHarness(write?: (point: DataPoint) => void): {
  env: Env;
  points: DataPoint[];
} {
  const points: DataPoint[] = [];
  return {
    points,
    env: {
      ALLOWED_BROWSER_ORIGIN: PRODUCTION_ORIGIN,
      TOOL_ANALYTICS: {
        writeDataPoint(point): void {
          points.push(point);
          write?.(point);
        },
      },
    },
  };
}

function post(body: BodyInit, headers?: HeadersInit): Request {
  const requestHeaders = new Headers(headers);
  if (!requestHeaders.has("Content-Type")) {
    requestHeaders.set("Content-Type", "application/json");
  }
  return new Request(ENDPOINT, {
    method: "POST",
    headers: requestHeaders,
    body,
  });
}

function validBody(tool = "base64-encoder", event = "tool_completed"): string {
  return JSON.stringify({ tool, event });
}

function assertPrivateResponse(response: Response, expectedStatus: number): void {
  assert.equal(response.status, expectedStatus);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Set-Cookie"), null);
}

test("stores only the two event dimensions, never incoming network identifiers", async () => {
  const { env, points } = createHarness();
  const response = await handleRequest(post(validBody(), {
    Cookie: "session=PRIVATE_COOKIE",
    "CF-Connecting-IP": "192.0.2.1",
    "User-Agent": "PRIVATE_USER_AGENT",
    Referer: "https://mydevtools.app/en/hash-calculator/?private=PRIVATE_INPUT",
  }), env);

  assertPrivateResponse(response, 204);
  assert.equal(await response.text(), "");
  assert.deepEqual(points, [
    {
      blobs: ["base64-encoder", "tool_completed"],
      doubles: [1],
      indexes: ["base64-encoder"],
    },
  ]);
});


test("rejects non-endpoint paths, query strings, and methods without writing", async () => {
  const { env, points } = createHarness();
  const cases: Array<[Request, number]> = [
    [new Request("https://mydevtools.app/", { method: "POST" }), 404],
    [new Request(`${ENDPOINT}/`, { method: "POST" }), 404],
    [new Request(`${ENDPOINT}?read=true`, { method: "POST" }), 404],
    [new Request(ENDPOINT), 405],
    [new Request(ENDPOINT, { method: "PUT" }), 405],
  ];

  for (const [request, status] of cases) {
    const response = await handleRequest(request, env);
    assertPrivateResponse(response, status);
    if (status === 405) assert.equal(response.headers.get("Allow"), "POST");
  }
  assert.deepEqual(points, []);
});

test("rejects missing, ambiguous, and encoded JSON content types", async () => {
  const { env, points } = createHarness();
  const cases: Array<[HeadersInit, number]> = [
    [{ "Content-Type": "text/plain" }, 400],
    [{ "Content-Type": "application/problem+json" }, 400],
    [{ "Content-Type": "application/json, text/plain" }, 400],
    [{ "Content-Type": "application/json; charset=utf-8; x=y" }, 400],
    [{ "Content-Type": "application/json", "Content-Encoding": "gzip" }, 400],
  ];

  const missing = new Request(ENDPOINT, { method: "POST", body: validBody() });
  assertPrivateResponse(await handleRequest(missing, env), 400);
  for (const [headers, status] of cases) {
    assertPrivateResponse(await handleRequest(post(validBody(), headers), env), status);
  }
  assert.deepEqual(points, []);
});

test("accepts the explicit UTF-8 JSON media type", async () => {
  const { env, points } = createHarness();
  const response = await handleRequest(
    post(validBody(), { "Content-Type": "Application/JSON; Charset=\"UTF-8\"" }),
    env,
  );
  assertPrivateResponse(response, 204);
  assert.equal(points.length, 1);
});

test("rejects malformed, smuggled, and non-exact payloads without writing", async () => {
  const { env, points } = createHarness();
  const payloads = [
    "",
    "null",
    "[]",
    "{",
    `${validBody()}${validBody()}`,
    '{"tool":"base64-encoder","tool":"hash-calculator","event":"tool_started"}',
    '{"tool":"base64-encoder","event":"tool_started","details":"secret"}',
    '{"tool":"base64-encoder"}',
    '{"tool":"base64-encoder","event":1}',
    '{"tool":"base64-encoder","event":"tool_started",}',
  ];

  for (const payload of payloads) {
    assertPrivateResponse(await handleRequest(post(payload), env), 400);
  }
  assert.deepEqual(points, []);
});

test("rejects unknown tool and event values without writing", async () => {
  const { env, points } = createHarness();
  assertPrivateResponse(
    await handleRequest(post(validBody("not-in-catalog", "tool_started")), env),
    400,
  );
  assertPrivateResponse(
    await handleRequest(post(validBody("base64-encoder", "tool_cancelled")), env),
    400,
  );
  assert.deepEqual(points, []);
});

test("rejects declared and streamed bodies over 512 bytes", async () => {
  const { env, points } = createHarness();
  const declared = post(validBody(), { "Content-Length": "513" });
  assertPrivateResponse(await handleRequest(declared, env), 413);

  let cancelled = false;
  const chunks = [new Uint8Array(400), new Uint8Array(113)];
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller): void {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel(): void {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const streamed = new Request(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  assertPrivateResponse(await handleRequest(streamed, env), 413);
  assert.equal(cancelled, true);
  assert.deepEqual(points, []);
});

test("accepts a chunked valid body and rejects misleading content lengths", async () => {
  const { env, points } = createHarness();
  const encoded = new TextEncoder().encode(validBody());
  const chunks = [encoded.subarray(0, 5), encoded.subarray(5, 17), encoded.subarray(17)];
  const stream = new ReadableStream<Uint8Array>({
    pull(controller): void {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
  const chunked = new Request(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  assertPrivateResponse(await handleRequest(chunked, env), 204);

  const shortDeclaration = post(validBody(), {
    "Content-Length": String(validBody().length - 1),
  });
  assertPrivateResponse(await handleRequest(shortDeclaration, env), 400);
  const malformedDeclaration = post(validBody(), { "Content-Length": "12, 13" });
  assertPrivateResponse(await handleRequest(malformedDeclaration, env), 400);
  assert.equal(points.length, 1);
});

test("rejects invalid UTF-8", async () => {
  const { env, points } = createHarness();
  const response = await handleRequest(post(new Uint8Array([0xc3, 0x28])), env);
  assertPrivateResponse(response, 400);
  assert.deepEqual(points, []);
});

test("rejects foreign browser origins and fetch sites while allowing configured local smoke", async () => {
  const { env, points } = createHarness();
  const foreignOrigin = post(validBody(), {
    Origin: "https://attacker.example",
    "Sec-Fetch-Site": "cross-site",
  });
  assertPrivateResponse(await handleRequest(foreignOrigin, env), 403);

  const contradictorySite = post(validBody(), {
    Origin: PRODUCTION_ORIGIN,
    "Sec-Fetch-Site": "same-site",
  });
  assertPrivateResponse(await handleRequest(contradictorySite, env), 403);

  const localEnv = { ...env, ALLOWED_BROWSER_ORIGIN: "self" };
  const localRequest = new Request("http://localhost:8787/api/analytics/event", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:8787",
      "Sec-Fetch-Site": "same-origin",
    },
    body: validBody(),
  });
  assertPrivateResponse(await handleRequest(localRequest, localEnv), 204);
  assert.equal(points.length, 1);
});

test("turns Analytics Engine binding failures into private 500 responses", async () => {
  const { env, points } = createHarness(() => {
    throw new Error("binding detail must not escape");
  });
  const response = await handleRequest(post(validBody()), env);

  assertPrivateResponse(response, 500);
  assert.equal(await response.text(), "");
  assert.equal(points.length, 1);
});

test("has no public report route, response cookies, payload reflection, or application logs", async () => {
  const { env, points } = createHarness();
  const messages: unknown[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...values: unknown[]) => messages.push(values);
  console.warn = (...values: unknown[]) => messages.push(values);
  console.error = (...values: unknown[]) => messages.push(values);

  try {
    const report = await handleRequest(
      new Request("https://mydevtools.app/api/analytics/report"),
      env,
    );
    assertPrivateResponse(report, 404);

    const secret = '{"tool":"base64-encoder","event":"tool_started","token":"private"}';
    const rejected = await handleRequest(post(secret), env);
    assertPrivateResponse(rejected, 400);
    assert.equal(await rejected.text(), "");
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }

  assert.deepEqual(messages, []);
  assert.deepEqual(points, []);
});
