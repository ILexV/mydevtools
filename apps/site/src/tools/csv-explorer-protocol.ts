import type { WasmErrorCode } from "@/scripts/wasm/worker-protocol";
import type { CsvDelimiter, CsvEncoding, CsvFilter } from "@/tools/csv-explorer";

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

export type CsvExplorerRequest =
  | { type: "open"; file: File; options: CsvOpenOptions }
  | { type: "filter"; sessionId: number; filter: CsvFilter | null }
  | { type: "read"; sessionId: number; start: number; count: number; columns: number[] }
  | { type: "inspect"; sessionId: number; index: number }
  | {
      type: "export";
      sessionId: number;
      format: "csv" | "jsonl";
      columns: number[];
      includeHeader: boolean;
      protectFormulas: boolean;
      bom: boolean;
    };

export type CsvExplorerSuccess =
  | ({ kind: "open" } & CsvSessionSummary)
  | { kind: "filter"; sessionId: number; rowCount: number }
  | { kind: "read"; sessionId: number; start: number; rows: string[][] }
  | { kind: "inspect"; sessionId: number; index: number; values: string[] }
  | { kind: "export"; sessionId: number; blob: Blob; extension: "csv" | "jsonl"; mime: string; rowCount: number };

export type CsvExplorerWorkerMessage =
  | ({ id: number; ok: true } & CsvExplorerSuccess)
  | { id: number; ok: false; message: string; code?: WasmErrorCode }
  | { id: number; type: "progress"; processed: number; total: number; elapsedMs: number };
