/**
 * File diff worker messages. Both Files are structured-cloned (the bytes stay in the blob store);
 * line hashes, regions and binary ranges live in the worker session and the page reads windows.
 */
import type { WasmErrorCode } from "@/scripts/wasm/worker-protocol";
import type { FileDiffTextOptions } from "@/tools/large-file-diff";

export type FileDiffMode = "auto" | "text" | "binary";

export interface FileDiffSideSummary {
  name: string;
  size: number;
  lines: number;
  encoding: string;
  lf: number;
  crlf: number;
  finalNewline: boolean;
}

export interface FileDiffTextSummary {
  a: FileDiffSideSummary;
  b: FileDiffSideSummary;
  removed: number;
  added: number;
  hunks: number;
  rows: number;
  approximate: boolean;
}

export interface FileDiffBinarySummary {
  sizeA: number;
  sizeB: number;
  rangeCount: number;
  keptRanges: number;
  differingBytes: number;
  firstDifference: number;
}

export type FileDiffCompareResult =
  | { mode: "text"; sessionId: number; identical: boolean; text: FileDiffTextSummary }
  | { mode: "binary"; sessionId: number; identical: boolean; binary: FileDiffBinarySummary };

/** One table row. Text: kind 0 header, 1 context, 2 removed, 3 added; line numbers are 1-based, 0 = none. */
export interface FileDiffTextRow {
  kind: number;
  a: number;
  b: number;
  text: string;
  /** The line is the last one of its file and has no newline. */
  noNewline: boolean;
}

export interface FileDiffBinaryRow {
  offset: number;
  length: number;
  a: string;
  b: string;
}

export type FileDiffRequest =
  | { type: "compare"; fileA: File; fileB: File; mode: FileDiffMode; text: FileDiffTextOptions; context: number }
  | { type: "layout"; sessionId: number; context: number }
  | { type: "rows"; sessionId: number; start: number; count: number }
  | { type: "hunk-row"; sessionId: number; hunk: number }
  | { type: "export"; sessionId: number; stream: MessagePort };

export type FileDiffSuccess =
  | ({ kind: "compare" } & FileDiffCompareResult)
  | { kind: "layout"; sessionId: number; hunks: number; rows: number }
  | { kind: "rows"; sessionId: number; start: number; text?: FileDiffTextRow[]; binary?: FileDiffBinaryRow[] }
  | { kind: "hunk-row"; sessionId: number; row: number }
  | { kind: "export"; sessionId: number; extension: "diff" | "csv"; rowCount: number };

export type FileDiffWorkerMessage =
  | ({ id: number; ok: true } & FileDiffSuccess)
  | { id: number; ok: false; message: string; code?: WasmErrorCode }
  | { id: number; type: "progress"; processed: number; total: number; elapsedMs: number };
