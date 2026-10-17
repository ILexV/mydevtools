import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOG_ANALYZER_LIMITS,
  LogAnalysisAccumulator,
  LogAnalyzerError,
  LogLineDecoder,
  detectLogPreset,
  encodeOriginalLogLine,
  logRecordMatches,
  parseLogRecord,
  prepareLogFilter,
  validateLogFilter,
  type LogFilter,
  type ParsedLogRecord,
} from "../src/tools/log-analyzer.ts";

const encoder = new TextEncoder();

function decodedInChunks(source: string, chunkSizes: readonly number[]) {
  const bytes = encoder.encode(source);
  const lines = [];
  const parser = new LogLineDecoder();
  let offset = 0;
  for (const size of chunkSizes) {
    if (offset >= bytes.length) break;
    const end = Math.min(bytes.length, offset + size);
    lines.push(...parser.push(bytes.subarray(offset, end)));
    offset = end;
  }
  if (offset < bytes.length) lines.push(...parser.push(bytes.subarray(offset)));
  lines.push(...parser.finish(bytes.length));
  return lines;
}

const CLEF_LINES = [
  '{"@t":"2026-10-17T10:00:00Z","@l":"Information","@mt":"Request {RequestId} started","@m":"Request req-1 started","SourceContext":"Checkout.Api","RequestId":"req-1"}',
  '{"@t":"2026-10-17T10:01:00Z","@l":"Error","@mt":"Payment failed for {OrderId}","@m":"Payment failed for 17","@x":"System.TimeoutException: gateway timed out","SourceContext":"Checkout.Api","RequestId":"req-1","OrderId":17}',
  '{"@t":"2026-10-17T10:02:00Z","@l":"Warning","@m":"Slow request","SourceContext":"Checkout.Api","RequestId":"req-2"}',
  '{"@t":"2026-10-17T10:03:00Z","@l":"Error","@mt":"Payment failed for {OrderId}","@m":"Payment failed for 18","@x":"System.TimeoutException: gateway timed out","SourceContext":"Checkout.Api","RequestId":"req-3","OrderId":18}',
  '{"@t":"2026-10-17T10:04:00Z","@l":"Fatal","@m":"Worker stopped","@x":"System.InvalidOperationException: unavailable","SourceContext":"Jobs.Worker","RequestId":"req-4"}',
  "not valid json",
  '{"@t":"2026-10-17T10:05:00Z","@l":"Information","@m":"<script>window.__logInjected=true</script> Привет 世界","SourceContext":"Checkout.Api","RequestId":"req-5"}',
];

test("line decoder is deterministic across UTF-8 and line-ending chunk boundaries", () => {
  const source = `\ufeff${CLEF_LINES[0]}\r\n${CLEF_LINES[1]}\nПривет 世界\r`;
  const expected = decodedInChunks(source, [encoder.encode(source).length]);
  for (let split = 1; split < encoder.encode(source).length; split++) {
    const actual = decodedInChunks(source, [split]);
    assert.deepEqual(actual, expected, `split at byte ${split}`);
  }
  assert.deepEqual(expected.map((line) => line.terminator), ["\r\n", "\n", "\r"]);
  assert.equal(expected[0].leadingBom, true);
  assert.equal(expected[1].leadingBom, false);
  const rebuilt = new Uint8Array(expected.reduce((total, line) => total + encodeOriginalLogLine(line).length, 0));
  let offset = 0;
  for (const line of expected) {
    const bytes = encodeOriginalLogLine(line);
    rebuilt.set(bytes, offset);
    offset += bytes.length;
  }
  assert.deepEqual(rebuilt, encoder.encode(source));
});

test("line byte limit accepts the boundary and rejects one byte beyond it", () => {
  const atLimit = new Uint8Array(LOG_ANALYZER_LIMITS.maxLineBytes + 1);
  atLimit.fill(0x61, 0, LOG_ANALYZER_LIMITS.maxLineBytes);
  atLimit[atLimit.length - 1] = 0x0a;
  assert.equal(new LogLineDecoder().push(atLimit)[0].text.length, LOG_ANALYZER_LIMITS.maxLineBytes);
  const beyond = new Uint8Array(LOG_ANALYZER_LIMITS.maxLineBytes + 1).fill(0x61);
  assert.throws(
    () => new LogLineDecoder().push(beyond),
    (error) => error instanceof LogAnalyzerError && error.code === "line-too-large",
  );
});

test("CLEF parsing keeps rendered messages, groups by template and counts malformed lines", () => {
  assert.equal(detectLogPreset(CLEF_LINES[0]), "serilog");
  const records = CLEF_LINES.map((line, index) => parseLogRecord(line, index + 1, "serilog"));
  assert.equal(records[1].message, "Payment failed for 17");
  assert.equal(records[1].messageTemplate, "Payment failed for {OrderId}");
  assert.equal(records[1].errorType, "System.TimeoutException");
  assert.equal(records[1].correlationId, "req-1");
  assert.equal(records[4].errorType, "System.InvalidOperationException");
  assert.equal(records[5].malformed, true);
  assert.equal(records[6].message, "<script>window.__logInjected=true</script> Привет 世界");
  const compact = parseLogRecord('{"@t":"2026-10-17T10:00:00Z","@mt":"Started","@tr":"trace-42"}', 1, "serilog");
  assert.equal(compact.severity, "info");
  assert.equal(compact.correlationId, "trace-42");
  assert.equal(parseLogRecord('{"message":"No level"}', 1, "jsonl").severity, "unknown");

  const analysis = new LogAnalysisAccumulator();
  records.forEach((record) => analysis.add(record));
  const result = analysis.finish();
  assert.equal(result.recordCount, 7);
  assert.equal(result.malformedCount, 1);
  assert.equal(result.severityCounts.error + result.severityCounts.fatal, 3);
  assert.deepEqual(result.errorTypes, [
    { value: "System.TimeoutException", count: 2 },
    { value: "System.InvalidOperationException", count: 1 },
  ]);
  assert.deepEqual(result.topMessages.find((item) => item.value === "Payment failed for {OrderId}"), {
    value: "Payment failed for {OrderId}",
    count: 2,
  });
});

test("Serilog properties provide source and correlation fields without overriding root values", () => {
  const nested = parseLogRecord(JSON.stringify({
    Timestamp: "2026-10-17T10:00:00Z",
    Level: "Error",
    MessageTemplate: "Nested {Id}",
    RenderedMessage: "Nested 7",
    Properties: { SourceContext: "Nested.Source", CorrelationId: "corr-7" },
  }), 1, "serilog");
  assert.equal(nested.source, "Nested.Source");
  assert.equal(nested.correlationId, "corr-7");
  assert.equal(nested.message, "Nested 7");
  assert.equal(nested.messageTemplate, "Nested {Id}");

  const root = parseLogRecord(JSON.stringify({
    "@t": "2026-10-17T10:00:00Z",
    "@m": "Root",
    SourceContext: "Root.Source",
    RequestId: "root-id",
    Properties: { SourceContext: "Nested.Source", RequestId: "nested-id" },
  }), 1, "serilog");
  assert.equal(root.source, "Root.Source");
  assert.equal(root.correlationId, "root-id");
});

test("time, severity, source, correlation and raw-text filters combine exactly", () => {
  const record = parseLogRecord(CLEF_LINES[1], 2, "serilog");
  const matching: LogFilter = {
    from: Date.parse("2026-10-17T10:00:00Z"),
    to: Date.parse("2026-10-17T10:01:00Z"),
    severities: ["error"],
    source: "checkout",
    correlationId: "REQ-1",
    search: "ORDERID",
  };
  const matches = (filter: LogFilter) => logRecordMatches(record, prepareLogFilter(filter));
  assert.equal(matches(matching), true);
  assert.equal(matches({ ...matching, to: Date.parse("2026-10-17T10:00:59.999Z") }), false);
  assert.equal(matches({ ...matching, severities: ["fatal"] }), false);
  assert.equal(matches({ ...matching, severities: [] }), false);
  assert.equal(matches({ ...matching, source: "jobs" }), false);
  assert.equal(matches({ ...matching, correlationId: "req-3" }), false);
  assert.equal(matches({ ...matching, search: "not present" }), false);
});

test("preset parsers cover Nginx access/error, .NET plaintext, JSONL and generic text", () => {
  const accessRaw = '127.0.0.1 - user [17/Oct/2026:10:00:00 +0000] "GET /checkout HTTP/1.1" 503 12 "-" "agent" request_id=req-9';
  const access = parseLogRecord(accessRaw, 1, "nginx-access");
  assert.equal(detectLogPreset(accessRaw), "nginx-access");
  assert.equal(access.severity, "error");
  assert.equal(access.errorType, "HTTP 5xx");
  assert.equal(access.correlationId, "req-9");

  const nginxErrorRaw = "2026/10/17 10:02:03 [error] 12#12: *77 upstream timed out, server: api.local, request: \"GET /\", request_id: req-10";
  const nginxError = parseLogRecord(nginxErrorRaw, 2, "nginx-error");
  assert.equal(detectLogPreset(nginxErrorRaw), "nginx-error");
  assert.equal(nginxError.severity, "error");
  assert.equal(nginxError.source, "api.local");
  assert.equal(nginxError.correlationId, "req-10");

  const dotnet = parseLogRecord("2026-10-17T10:03:00Z fail: Checkout.Api[17] Payment failed", 3, "serilog");
  assert.equal(detectLogPreset("2026-10-17T10:03:00Z fail: Checkout.Api[17] Payment failed"), "serilog");
  assert.equal(dotnet.severity, "error");
  assert.equal(dotnet.source, "Checkout.Api");
  assert.equal(dotnet.message, "Payment failed");

  assert.equal(parseLogRecord('{"time":"2026-10-17T10:04:00Z","severity":"warn","message":"generic"}', 4, "jsonl").severity, "warn");
  assert.equal(parseLogRecord("\"scalar\"", 5, "jsonl").malformed, false);
  assert.equal(parseLogRecord("arbitrary valid UTF-8 text", 5, "text").malformed, false);
  assert.equal(parseLogRecord("arbitrary text", 6, "jsonl").malformed, true);
});

test("filter and aggregate cardinality limits are explicit and bounded", () => {
  assert.throws(
    () => validateLogFilter({ from: null, to: null, severities: [], source: "x".repeat(513), correlationId: "", search: "" }),
    (error) => error instanceof LogAnalyzerError && error.code === "filter-too-large",
  );
  const analysis = new LogAnalysisAccumulator();
  for (let index = 0; index <= LOG_ANALYZER_LIMITS.maxAggregateKeys; index++) {
    const record: ParsedLogRecord = {
      line: index + 1,
      raw: `message-${index}`,
      timestamp: index * 60_000,
      timestampText: new Date(index * 60_000).toISOString(),
      severity: "info",
      source: "",
      correlationId: "",
      message: `message-${index}`,
      messageTemplate: `template-${index}`,
      errorType: `Error${index}`,
      malformed: false,
    };
    analysis.add(record);
  }
  const result = analysis.finish();
  assert.equal(result.recordCount, LOG_ANALYZER_LIMITS.maxAggregateKeys + 1);
  assert.equal(result.aggregateLimitReached, true);
  assert.ok(result.errorTypes.length <= LOG_ANALYZER_LIMITS.maxTopItems);
  assert.ok(result.topMessages.length <= LOG_ANALYZER_LIMITS.maxTopItems);
  assert.ok(result.temporal.length <= LOG_ANALYZER_LIMITS.maxChartBuckets);
});
