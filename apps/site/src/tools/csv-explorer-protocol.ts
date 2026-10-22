import type { WasmErrorCode } from "@/scripts/wasm/worker-protocol";
import type { CsvDelimiter, CsvEncoding, CsvFilter } from "@/tools/csv-explorer";
import type { CsvAggregateRequest, CsvColumnType, CsvInvalidPolicy } from "@/tools/csv-explorer-types";

export type CsvEncodingOption = "auto" | CsvEncoding;
export type CsvDelimiterOption = "auto" | CsvDelimiter;

export interface CsvOpenOptions {
  encoding: CsvEncodingOption;
  delimiter: CsvDelimiterOption;
  header: boolean;
}

export interface CsvColumn {
  key: string;
  label: string;
  index: number;
}

export interface CsvSessionSummary {
  sessionId: number;
  rowCount: number;
  unfilteredRowCount: number;
  columns: CsvColumn[];
  encoding: CsvEncoding;
  delimiter: CsvDelimiter;
  hasHeader: boolean;
  blankHeaderCount: number;
  duplicateHeaderCount: number;
  fileSize: number;
  fileName: string;
}

export type CsvExportFormat = "csv" | "jsonl" | "parquet";
export type CsvExportSource = "rows" | "groups";
export type CsvSortDirection = "asc" | "desc";

export interface CsvSort {
  column: number;
  direction: CsvSortDirection;
}

export interface CsvAggregateSummary {
  columns: string[];
  groupCount: number;
  inputRows: number;
}

export const CSV_EXPORT_MIME: Readonly<Record<CsvExportFormat, string>> = {
  csv: "text/csv;charset=utf-8",
  jsonl: "application/x-ndjson;charset=utf-8",
  parquet: "application/vnd.apache.parquet",
};

const CONVERSION_PREFIX = "conversion-failed:";

/** A conversion error crosses the worker boundary as a prefixed JSON message. */
export function encodeCsvConversionError(column: number, row: number, value: string): string {
  return `${CONVERSION_PREFIX}${JSON.stringify({ column, row, value: value.slice(0, 80) })}`;
}

export function decodeCsvConversionError(message: string): { column: number; row: number; value: string } | null {
  if (!message.startsWith(CONVERSION_PREFIX)) return null;
  try {
    const parsed = JSON.parse(message.slice(CONVERSION_PREFIX.length)) as { column: unknown; row: unknown; value: unknown };
    if (typeof parsed.column !== "number" || typeof parsed.row !== "number" || typeof parsed.value !== "string") return null;
    return { column: parsed.column, row: parsed.row, value: parsed.value };
  } catch {
    return null;
  }
}

export type CsvExplorerRequest =
  | { type: "open"; file: File; options: CsvOpenOptions }
  | { type: "filter"; sessionId: number; filter: CsvFilter | null }
  | { type: "types"; sessionId: number; types: CsvColumnType[]; invalid: CsvInvalidPolicy }
  | { type: "detect"; sessionId: number }
  | { type: "sort"; sessionId: number; sort: CsvSort | null }
  | { type: "aggregate"; sessionId: number; request: CsvAggregateRequest }
  | { type: "read-groups"; sessionId: number; start: number; count: number }
  | { type: "read"; sessionId: number; start: number; count: number; columns: number[] }
  | { type: "inspect"; sessionId: number; index: number }
  | {
      type: "export";
      sessionId: number;
      format: CsvExportFormat;
      source: CsvExportSource;
      columns: number[];
      includeHeader: boolean;
      protectFormulas: boolean;
      bom: boolean;
      stream: MessagePort;
    };

export type CsvExplorerSuccess =
  | ({ kind: "open" } & CsvSessionSummary)
  | { kind: "filter"; sessionId: number; rowCount: number }
  | { kind: "types"; sessionId: number }
  | { kind: "detect"; sessionId: number; types: CsvColumnType[] }
  | { kind: "sort"; sessionId: number; sorted: boolean }
  | ({ kind: "aggregate"; sessionId: number } & CsvAggregateSummary)
  | { kind: "read-groups"; sessionId: number; start: number; rows: (string | null)[][] }
  | { kind: "read"; sessionId: number; start: number; rows: string[][] }
  | { kind: "inspect"; sessionId: number; index: number; values: string[] }
  | { kind: "export"; sessionId: number; extension: CsvExportFormat; mime: string; rowCount: number };

export type CsvExplorerWorkerMessage =
  | ({ id: number; ok: true } & CsvExplorerSuccess)
  | { id: number; ok: false; message: string; code?: WasmErrorCode }
  | { id: number; type: "progress"; processed: number; total: number; elapsedMs: number };
