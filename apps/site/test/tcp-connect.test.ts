import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTcpText, parseTcpConnectSettings } from "../src/tools/tcp-connect.ts";
import type { TcpConnectResult } from "../src/scripts/local-agent.ts";

test("parseTcpConnectSettings keeps only an in-range timeout", () => {
  assert.deepEqual(parseTcpConnectSettings(null), { v: 1, timeoutMs: 3000 });
  assert.deepEqual(parseTcpConnectSettings({ v: 1, timeoutMs: 5000, host: "example.com", port: 443 }), {
    v: 1,
    timeoutMs: 5000,
  });
  assert.deepEqual(parseTcpConnectSettings({ timeoutMs: 199 }), { v: 1, timeoutMs: 3000 });
  assert.deepEqual(parseTcpConnectSettings({ timeoutMs: 10_001 }), { v: 1, timeoutMs: 3000 });
  assert.deepEqual(parseTcpConnectSettings({ timeoutMs: 3000.5 }), { v: 1, timeoutMs: 3000 });
});

test("formatTcpText is one line", () => {
  const result: TcpConnectResult = {
    host: "127.0.0.1",
    port: 443,
    address: "127.0.0.1",
    status: "open",
    elapsedMs: 4,
  };
  assert.equal(formatTcpText(result), "127.0.0.1 443 open 127.0.0.1 4");
});
