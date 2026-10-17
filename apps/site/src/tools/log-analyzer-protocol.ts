import type { WasmErrorCode } from "@/scripts/wasm/worker-protocol";
import type { LogAnalysis, LogFilter, LogPreset, LogSeverity, ResolvedLogPreset } from "@/tools/log-analyzer";

export interface LogSessionSummary {
  sessionId: number;
  fileName: string;
  fileSize: number;
  preset: ResolvedLogPreset;
  rowCount: number;
  unfilteredRowCount: number;
  analysis: LogAnalysis;
}

export interface LogTableRecord {
  line: number;
  timestamp: string;
  severity: LogSeverity;
  source: string;
  correlationId: string;
  message: string;
  malformed: boolean;
}

export interface LogInspection {
  line: number;
  raw: string;
  truncated: boolean;
}

export type LogAnalyzerRequest =
  | { type: "open"; file: File; preset: LogPreset }
  | { type: "filter"; sessionId: number; filter: LogFilter | null }
  | { type: "read"; sessionId: number; start: number; count: number }
  | { type: "inspect"; sessionId: number; index: number }
  | { type: "export"; sessionId: number; stream: MessagePort };

export type LogAnalyzerSuccess =
  | ({ kind: "open" } & LogSessionSummary)
  | { kind: "filter"; sessionId: number; rowCount: number; analysis: LogAnalysis }
  | { kind: "read"; sessionId: number; start: number; records: LogTableRecord[] }
  | { kind: "inspect"; sessionId: number; index: number; inspection: LogInspection }
  | { kind: "export"; sessionId: number; rowCount: number; extension: "log"; mime: "text/plain;charset=utf-8" };

export type LogAnalyzerWorkerMessage =
  | ({ id: number; ok: true } & LogAnalyzerSuccess)
  | { id: number; ok: false; message: string; code?: WasmErrorCode }
  | { id: number; type: "progress"; processed: number; total: number; elapsedMs: number };
