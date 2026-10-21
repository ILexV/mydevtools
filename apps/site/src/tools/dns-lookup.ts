/**
 * DNS lookup settings and the text report. The selected record type is a
 * setting. The query name and the answer are not stored.
 */
import type { DnsLookupResult } from "@/scripts/local-agent";

export const DNS_LOOKUP_STORAGE_KEY = "mdt.dns-lookup.v1";

export const DNS_RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "PTR"] as const;

export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

export interface DnsLookupSettings {
  v: 1;
  recordType: DnsRecordType;
}

export function defaultDnsLookupSettings(): DnsLookupSettings {
  return { v: 1, recordType: "A" };
}

/** Keeps a known record type. Anything else, including a saved name, is dropped. */
export function parseDnsLookupSettings(value: unknown): DnsLookupSettings {
  if (!value || typeof value !== "object") return defaultDnsLookupSettings();
  const recordType = (value as { recordType?: unknown }).recordType;
  if (typeof recordType !== "string" || !isDnsRecordType(recordType)) return defaultDnsLookupSettings();
  return { v: 1, recordType };
}

export function isDnsRecordType(value: string): value is DnsRecordType {
  return (DNS_RECORD_TYPES as readonly string[]).includes(value);
}

/** One plain-text answer. The first line is the question; each later line is one record. */
export function formatDnsText(result: DnsLookupResult): string {
  const lines = [`${result.name} ${result.type} ${result.status}`];
  for (const record of result.records) {
    const preference = record.preference === null ? "" : `${record.preference} `;
    lines.push(`${record.name}\t${record.ttl}\t${record.type}\t${preference}${record.data}`);
  }
  return lines.join("\n");
}
