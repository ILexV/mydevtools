import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultDnsLookupSettings,
  formatDnsText,
  parseDnsLookupSettings,
  type DnsRecordType,
} from "../src/tools/dns-lookup.ts";
import type { DnsLookupResult } from "../src/scripts/local-agent.ts";

test("parseDnsLookupSettings keeps only the record type", () => {
  assert.deepEqual(defaultDnsLookupSettings(), { v: 1, recordType: "A" });
  assert.deepEqual(parseDnsLookupSettings(null), { v: 1, recordType: "A" });
  assert.deepEqual(parseDnsLookupSettings({ v: 1, recordType: "MX", name: "example.com" }), {
    v: 1,
    recordType: "MX",
  });
  for (const recordType of ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "PTR"] as const) {
    const parsed = parseDnsLookupSettings({ v: 1, recordType });
    assert.equal(parsed.recordType, recordType satisfies DnsRecordType);
  }
  assert.deepEqual(parseDnsLookupSettings({ v: 1, recordType: "ANY" }), { v: 1, recordType: "A" });
  assert.deepEqual(parseDnsLookupSettings({ recordType: "ptr" }), { v: 1, recordType: "A" });
  assert.deepEqual(parseDnsLookupSettings({ name: "example.com", records: [] }), { v: 1, recordType: "A" });
});

test("formatDnsText lists the question and each record", () => {
  const result: DnsLookupResult = {
    name: "example.com",
    type: "MX",
    status: "noerror",
    records: [
      {
        name: "example.com",
        type: "MX",
        ttl: 300,
        preference: 10,
        data: "mail.example.com",
      },
      {
        name: "example.com",
        type: "MX",
        ttl: 300,
        preference: null,
        data: "backup.example.com",
      },
    ],
  };
  assert.equal(
    formatDnsText(result),
    [
      "example.com MX noerror",
      "example.com\t300\tMX\t10 mail.example.com",
      "example.com\t300\tMX\tbackup.example.com",
    ].join("\n"),
  );
});
