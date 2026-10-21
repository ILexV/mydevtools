import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultPathTraceSettings,
  escapeHtml,
  formatPathTraceHtml,
  formatPathTraceText,
  formatSpreadMs,
  hopHostname,
  normalizeTarget,
  parseBoundedInteger,
  parsePathTraceSettings,
  rememberTarget,
  TRACE_INTERVAL_MS,
  type PathTraceReportLabels,
} from "../src/tools/path-trace.ts";

const labels: PathTraceReportLabels = {
  title: "Path trace",
  target: "Target",
  resolved: "Resolved",
  hostname: "Host",
  nr: "Nr",
  loss: "Loss %",
  sent: "Sent",
  recv: "Recv",
  best: "Best",
  avg: "Avg",
  worst: "Worst",
  last: "Last",
  stdev: "StDev",
  jitter: "Jitter",
  status: "Status",
  noResponse: "No response",
  statusText: (code) => ({ echo_reply: "Echo reply", dest_host_unreachable: "Host unreachable" })[code] ?? code,
};

test("normalizeTarget accepts a host or IPv6 literal and rejects a URL", () => {
  assert.equal(normalizeTarget("  example.com "), "example.com");
  assert.equal(normalizeTarget("2001:db8::1"), "2001:db8::1");
  assert.equal(normalizeTarget("http://example.com"), null);
  assert.equal(normalizeTarget("example.com/path"), null);
  assert.equal(normalizeTarget("a b"), null);
  assert.equal(normalizeTarget("user@host"), null);
  assert.equal(normalizeTarget(""), null);
});

test("parseBoundedInteger keeps the agent limits inclusive", () => {
  assert.equal(parseBoundedInteger("200", TRACE_INTERVAL_MS.min, TRACE_INTERVAL_MS.max), 200);
  assert.equal(parseBoundedInteger("60000", TRACE_INTERVAL_MS.min, TRACE_INTERVAL_MS.max), 60000);
  assert.equal(parseBoundedInteger("199", TRACE_INTERVAL_MS.min, TRACE_INTERVAL_MS.max), null);
  assert.equal(parseBoundedInteger("1.5", TRACE_INTERVAL_MS.min, TRACE_INTERVAL_MS.max), null);
  assert.equal(parseBoundedInteger("0", 0, 1472), 0);
});

test("parsePathTraceSettings ignores hop results and repairs bad fields", () => {
  const parsed = parsePathTraceSettings({
    v: 1,
    targets: ["example.com", "http://nope", "1.1.1.1"],
    intervalMs: 50,
    payloadBytes: 64,
    maxHops: 30,
    timeoutMs: 5000,
    resolveNames: false,
    hops: [{ address: "10.0.0.1" }],
  });
  assert.deepEqual(parsed.targets, ["example.com", "1.1.1.1"]);
  assert.equal(parsed.intervalMs, defaultPathTraceSettings().intervalMs);
  assert.equal(parsed.payloadBytes, 64);
  assert.equal(parsed.resolveNames, false);
  assert.equal(parsed.sourceAddress, "");
  assert.equal(parsed.sourceInterface, "");
  assert.equal("hops" in parsed, false);

  const kept = parsePathTraceSettings({
    v: 1,
    sourceAddress: "127.0.0.1",
    sourceInterface: "Ethernet 2",
  });
  assert.equal(kept.sourceAddress, "127.0.0.1");
  assert.equal(kept.sourceInterface, "Ethernet 2");
  const broken = parsePathTraceSettings({
    v: 1,
    sourceAddress: "127.0.0.1",
    sourceInterface: "lo\n",
  });
  assert.equal(broken.sourceAddress, "");
  assert.equal(broken.sourceInterface, "");
  const half = parsePathTraceSettings({ v: 1, sourceAddress: "::1" });
  assert.equal(half.sourceAddress, "");
  assert.equal(half.sourceInterface, "");
});

test("rememberTarget keeps the newest name first and caps the list at 20", () => {
  const existing = Array.from({ length: 20 }, (_, index) => `h${index}.example`);
  const next = rememberTarget(existing, "new.example");
  assert.equal(next[0], "new.example");
  assert.equal(next.length, 20);
  assert.equal(next.includes("h19.example"), false);
  assert.deepEqual(rememberTarget(["a.example", "b.example"], "b.example"), ["b.example", "a.example"]);
});

test("hop hostname prefers a name, then an address, then no response", () => {
  assert.equal(hopHostname({ name: "gw.home", address: "192.168.1.1", status: "ttl_expired" }, labels), "gw.home");
  assert.equal(hopHostname({ name: null, address: "192.168.1.1", status: "ttl_expired" }, labels), "192.168.1.1");
  assert.equal(hopHostname({ name: null, address: null, status: "timeout" }, labels), "No response");
  assert.equal(hopHostname({ name: null, address: null, status: "dest_host_unreachable" }, labels), "Host unreachable");
});

test("reports escape HTML and render a missing round-trip time as a dash", () => {
  const report = {
    targetInput: `a<b>&"'`,
    target: "203.0.113.5",
    hops: [{
      hop: 1,
      address: "100.64.0.1",
      name: null,
      sent: 2,
      received: 1,
      lossPercent: 50,
      lastMs: null,
      bestMs: 3,
      avgMs: 3,
      worstMs: 3,
      stdevMs: null,
      jitterMs: null,
      status: "echo_reply",
    }],
  };
  const text = formatPathTraceText(report, labels);
  const html = formatPathTraceHtml(report, labels);
  assert.match(text, /100\.64\.0\.1\t1\t50\t2\t1\t3\t3\t3\t\u2014\t\u2014\t\u2014\tEcho reply/);
  assert.equal(formatSpreadMs(54.74), "54.7");
  assert.equal(formatSpreadMs(63), "63.0");
  assert.equal(formatSpreadMs(null), "\u2014");
  assert.match(text, /a<b>&"'/);
  assert.match(html, /a&lt;b&gt;&amp;&quot;&#39;/);
  assert.doesNotMatch(html, /a<b>/);
  assert.match(html, /\u2014/);
  assert.equal(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
});
