import type { HashResult } from "../scripts/wasm/worker-protocol.ts";

/** In-memory result snapshot; never contains the original text or File. */
export interface HashResultGroup {
  source: "text" | "file";
  name: string | null;
  /** Unknown only when text hashing stops before the worker measures its UTF-8 size. */
  bytes: number | null;
  status: "ready" | "hashing" | "done" | "error" | "canceled";
  elapsedMs: number;
  hashes: HashResult[];
  error?: string;
}

export type HashExportFormat = "txt" | "csv" | "json";

export const HASH_EXPORT_TYPES: Record<HashExportFormat, string> = {
  txt: "text/plain;charset=utf-8",
  csv: "text/csv;charset=utf-8",
  json: "application/json;charset=utf-8",
};

/** Stable metadata/digests only; CSV text cells cannot become spreadsheet formulas. */
export function exportHashResults(groups: readonly HashResultGroup[], format: HashExportFormat): string {
  if (format === "json") {
    return JSON.stringify({
      version: 1,
      results: groups.map(({ source, name, bytes, status, elapsedMs, hashes, error }) => ({
        source, name, bytes, status, elapsedMs, hashes, error,
      })),
    }, null, 2) + "\n";
  }
  if (format === "txt") {
    return groups.map((group) => [
      `# source=${group.source}`,
      `# name=${JSON.stringify(group.name)}`,
      `# bytes=${group.bytes}`,
      `# status=${group.status}`,
      `# elapsed_ms=${group.elapsedMs.toFixed(3)}`,
      ...group.hashes.map((hash) => `${hash.id}: ${hash.hex}`),
      ...(group.error ? [`# error=${JSON.stringify(group.error)}`] : []),
    ].join("\n")).join("\n\n") + "\n";
  }

  const rows = ["source,name,bytes,status,elapsed_ms,algorithm,digest,error"];
  for (const group of groups) {
    const prefix = [group.source, group.name ?? "", group.bytes ?? "", group.status, group.elapsedMs];
    const records = group.hashes.map((hash) => [...prefix, hash.id, hash.hex, group.error ?? ""]);
    if (records.length === 0) records.push([...prefix, "", "", group.error ?? ""]);
    for (const fields of records) {
      rows.push(fields.map((value) => {
        if (typeof value === "number") return String(value);
        const safe = /^\s*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
        return `"${safe.replaceAll('"', '""')}"`;
      }).join(","));
    }
  }
  // Excel recognizes UTF-8 file names reliably when the CSV starts with a BOM.
  return "\uFEFF" + rows.join("\r\n") + "\r\n";
}
