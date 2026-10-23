import type { WasmErrorCode } from "@/scripts/wasm/worker-protocol";
import type { ParquetColumn, ParquetFileSummary } from "@/tools/parquet-explorer-io";
import type { ParquetAggregateRequest, ParquetFilter } from "@/tools/parquet-explorer-query";

export interface ParquetSessionSummary extends ParquetFileSummary {
  sessionId: number;
  fileName: string;
}

export type ParquetExplorerRequest =
  | { type: "open"; file: File }
  | { type: "read"; sessionId: number; start: number; count: number; columns: number[]; maxChars: number }
  | { type: "filter"; sessionId: number; filter: ParquetFilter | null }
  | { type: "aggregate"; sessionId: number; request: ParquetAggregateRequest }
  | { type: "read-groups"; sessionId: number; start: number; count: number }
  | { type: "export"; sessionId: number; source: "rows" | "groups"; format: "csv" | "jsonl"; columns: number[]; includeHeader: boolean; protectFormulas: boolean; bom: boolean; stream: MessagePort };

export type ParquetExplorerSuccess =
  | ({ kind: "open" } & ParquetSessionSummary)
  | { kind: "read"; sessionId: number; start: number; rows: string[][] }
  | { kind: "filter"; sessionId: number; rowCount: number }
  | { kind: "aggregate"; sessionId: number; columns: string[]; groupCount: number; inputRows: number }
  | { kind: "read-groups"; sessionId: number; start: number; rows: (string | null)[][] }
  | { kind: "export"; sessionId: number; extension: "csv" | "jsonl"; mime: string; rowCount: number };

export type ParquetExplorerWorkerMessage =
  | ({ id: number; ok: true } & ParquetExplorerSuccess)
  | { id: number; ok: false; message: string; code?: WasmErrorCode }
  | { id: number; type: "progress"; processed: number; total: number; elapsedMs: number };

export type { ParquetColumn };
