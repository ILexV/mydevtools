import type { WasmErrorCode } from "@/scripts/wasm/worker-protocol";
import type { ParquetColumn, ParquetFileSummary } from "@/tools/parquet-explorer-io";

export interface ParquetSessionSummary extends ParquetFileSummary {
  sessionId: number;
  fileName: string;
}

export type ParquetExplorerRequest =
  | { type: "open"; file: File }
  | { type: "read"; sessionId: number; start: number; count: number; columns: number[]; maxChars: number }
  | { type: "export"; sessionId: number; format: "csv" | "jsonl"; columns: number[]; includeHeader: boolean; protectFormulas: boolean; bom: boolean };

export type ParquetExplorerSuccess =
  | ({ kind: "open" } & ParquetSessionSummary)
  | { kind: "read"; sessionId: number; start: number; rows: string[][] }
  | { kind: "export"; sessionId: number; blob: Blob; extension: "csv" | "jsonl"; mime: string; rowCount: number };

export type ParquetExplorerWorkerMessage =
  | ({ id: number; ok: true } & ParquetExplorerSuccess)
  | { id: number; ok: false; message: string; code?: WasmErrorCode }
  | { id: number; type: "progress"; processed: number; total: number; elapsedMs: number };

export type { ParquetColumn };
