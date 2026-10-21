import assert from "node:assert/strict";
import { test } from "node:test";
import type { TlsInspectResult } from "../src/scripts/local-agent.ts";
import { formatTlsText, parseTlsInspectSettings } from "../src/tools/tls-inspect.ts";

test("parseTlsInspectSettings keeps only an in-range timeout", () => {
  assert.deepEqual(parseTlsInspectSettings(null), { v: 1, timeoutMs: 5000 });
  assert.deepEqual(parseTlsInspectSettings({ v: 1, timeoutMs: 2500, host: "example.com", port: 443, certificates: [] }), {
    v: 1,
    timeoutMs: 2500,
  });
  assert.deepEqual(parseTlsInspectSettings({ timeoutMs: 199 }), { v: 1, timeoutMs: 5000 });
  assert.deepEqual(parseTlsInspectSettings({ timeoutMs: 10_001 }), { v: 1, timeoutMs: 5000 });
  assert.deepEqual(parseTlsInspectSettings({ timeoutMs: 5000.5 }), { v: 1, timeoutMs: 5000 });
});

test("formatTlsText lists the handshake and each certificate", () => {
  const result: TlsInspectResult = {
    host: "127.0.0.1",
    port: 443,
    address: "127.0.0.1",
    status: "ok",
    elapsedMs: 4,
    protocol: "TLSv1.3",
    cipher: "TLS13_AES_128_GCM_SHA256",
    trusted: false,
    certificates: [{
      subject: "CN=localhost",
      issuer: "CN=localhost",
      notBefore: "2026-10-21T00:00:00Z",
      notAfter: "2026-10-23T00:00:00Z",
      sha256: "ab".repeat(32),
    }],
  };
  const text = formatTlsText(result);
  assert.equal(text.split("\n").length, 2);
  assert.match(text, /^127\.0\.0\.1 443 ok 127\.0\.0\.1 4 TLSv1\.3 TLS13_AES_128_GCM_SHA256 false\nCN=localhost\tCN=localhost\t2026-10-21T00:00:00Z\t2026-10-23T00:00:00Z\t[0-9a-f]{64}$/);
});
