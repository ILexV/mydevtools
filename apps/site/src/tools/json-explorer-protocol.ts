import type { JsonExplorerDiagnostic, JsonKind, JsonViewFilter, TreeChild } from "@/tools/json-explorer-core";

export type JsonInputFormat = "auto" | "json" | "jsonl";
export type ResolvedJsonFormat = Exclude<JsonInputFormat, "auto">;

export interface JsonExplorerSettings {
  ordinaryJsonBytes: number;
  recordBytes: number;
  maxDepth: number;
}

export interface JsonColumnInfo {
  key: string;
  label: string;
}

export interface OpenJsonRequest {
  type: "open";
  file: File;
  format: JsonInputFormat;
  settings: JsonExplorerSettings;
}

export interface ApplyJsonViewRequest {
  type: "apply-view";
  filter: JsonViewFilter;
  projection: string[];
}

export interface ReadJsonRowsRequest {
  type: "read-rows";
  start: number;
  count: number;
}

export interface InspectJsonRowRequest {
  type: "inspect-row";
  index: number;
}

export interface ReadJsonTreeRequest {
  type: "read-tree";
  pointer: string;
  start: number;
  count: number;
}

export interface JsonExportCursor {
  sourceIndex: number;
  byteOffset: number;
  physicalLine: number;
  recordIndex: number;
  headerWritten: boolean;
}

export interface ExportJsonChunkRequest {
  type: "export-chunk";
  format: "jsonl" | "csv";
  cursor: JsonExportCursor | null;
  maxBytes: number;
  protectFormulas: boolean;
}

export type JsonExplorerRequest =
  | OpenJsonRequest
  | ApplyJsonViewRequest
  | ReadJsonRowsRequest
  | InspectJsonRowRequest
  | ReadJsonTreeRequest
  | ExportJsonChunkRequest;

export interface OpenJsonResult {
  format: ResolvedJsonFormat;
  fileBytes: number;
  sourceRows: number;
  viewRows: number;
  columns: JsonColumnInfo[];
  columnsTruncated: boolean;
  rootKind: JsonKind | null;
  rootChildren: number;
  tableAvailable: boolean;
}

export interface ApplyJsonViewResult {
  viewRows: number;
  columns: JsonColumnInfo[];
}

export interface ReadJsonRowsResult {
  rows: string[][];
}

export interface InspectJsonRowResult {
  sourceIndex: number;
  physicalLine: number | null;
  json: string;
}

export interface ReadJsonTreeResult {
  total: number;
  children: TreeChild[];
}

export interface ExportJsonChunkResult {
  bytes: Uint8Array;
  cursor: JsonExportCursor | null;
  done: boolean;
  emittedRows: number;
}

export interface JsonExplorerFailureResult {
  explorerError: JsonExplorerDiagnostic;
}

export type JsonExplorerResult =
  | OpenJsonResult
  | ApplyJsonViewResult
  | ReadJsonRowsResult
  | InspectJsonRowResult
  | ReadJsonTreeResult
  | ExportJsonChunkResult;

export type JsonExplorerWorkerResult = JsonExplorerResult | JsonExplorerFailureResult;
