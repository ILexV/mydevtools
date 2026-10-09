/// <reference lib="webworker" />
import { encodeCsvRow } from "@/tools/explorer-delimited";
import {
  addDiscoveredColumns,
  JSON_EXPLORER_LIMITS,
  JsonExplorerError,
  JsonlLineDecoder,
  normalizePointers,
  parseJsonLossless,
  parseJsonPointer,
  projectedCells,
  projectedJson,
  rawJson,
  recordMatches,
  resolveJsonPointer,
  treeChildren,
  type JsonlDecodedLine,
  type JsonNode,
  type JsonViewFilter,
} from "@/tools/json-explorer-core";
import type {
  ApplyJsonViewResult,
  ExportJsonChunkRequest,
  ExportJsonChunkResult,
  InspectJsonRowResult,
  JsonColumnInfo,
  JsonExplorerRequest,
  JsonExplorerWorkerResult,
  JsonExplorerSettings,
  JsonExportCursor,
  OpenJsonResult,
  ReadJsonRowsResult,
  ReadJsonTreeResult,
  ResolvedJsonFormat,
} from "@/tools/json-explorer-protocol";
import type { WasmErrorCode } from "@/scripts/wasm/worker-protocol";

interface SourceCheckpoint {
  sourceIndex: number;
  byteOffset: number;
  physicalLine: number;
}

interface ViewCheckpoint extends SourceCheckpoint {
  viewIndex: number;
}

interface CommonSession {
  format: ResolvedJsonFormat;
  fileBytes: number;
  sourceRows: number;
  settings: JsonExplorerSettings;
  columns: string[];
  columnsTruncated: boolean;
  filter: JsonViewFilter;
  projection: string[];
  viewRows: number;
  viewCheckpoints: ViewCheckpoint[];
}

interface JsonlSession extends CommonSession {
  format: "jsonl";
  file: File;
}

interface OrdinarySession extends CommonSession {
  format: "json";
  source: string;
  root: JsonNode;
  records: JsonNode[];
}

type Session = JsonlSession | OrdinarySession;


const EMPTY_FILTER: JsonViewFilter = {
  query: "",
  scope: "both",
  fieldPath: "",
  fieldValue: "",
  caseSensitive: false,
};

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
let session: Session | null = null;
let queue: Promise<void> = Promise.resolve();

function postProgress(id: number, processed: number, total: number, started: number): void {
  (self as DedicatedWorkerGlobalScope).postMessage({ id, type: "progress", processed, total, elapsedMs: performance.now() - started });
}

function postResult(id: number, result: JsonExplorerWorkerResult, transfer: Transferable[] = []): void {
  (self as DedicatedWorkerGlobalScope).postMessage({ id, ok: true, ...result }, transfer);
}

function postInfrastructureError(id: number, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const code: WasmErrorCode = "unknown";
  (self as DedicatedWorkerGlobalScope).postMessage({ id, ok: false, message, code });
}

function checkedSettings(settings: JsonExplorerSettings): JsonExplorerSettings {
  const ordinaryJsonBytes = Math.trunc(settings.ordinaryJsonBytes);
  const recordBytes = Math.trunc(settings.recordBytes);
  const maxDepth = Math.trunc(settings.maxDepth);
  if (ordinaryJsonBytes < 1024 * 1024 || ordinaryJsonBytes > 64 * 1024 * 1024) {
    throw new JsonExplorerError("Ordinary JSON limit must be between 1 MiB and 64 MiB", "ordinary-limit", null, { limitBytes: 64 * 1024 * 1024 });
  }
  if (recordBytes < 64 * 1024 || recordBytes > 8 * 1024 * 1024) {
    throw new JsonExplorerError("Record limit must be between 64 KiB and 8 MiB", "record-limit", null, { limitBytes: 8 * 1024 * 1024 });
  }
  if (maxDepth < 8 || maxDepth > JSON_EXPLORER_LIMITS.maxDepth) {
    throw new JsonExplorerError(`Depth limit must be between 8 and ${JSON_EXPLORER_LIMITS.maxDepth}`, "depth-limit", null, { maxDepth: JSON_EXPLORER_LIMITS.maxDepth });
  }
  return { ordinaryJsonBytes, recordBytes, maxDepth };
}

async function* scanLines(
  file: File,
  recordLimit: number,
  startOffset = 0,
  startPhysicalLine = 1,
): AsyncGenerator<JsonlDecodedLine> {
  const lines = new JsonlLineDecoder(recordLimit, startOffset, startPhysicalLine);
  let readOffset = startOffset;
  while (readOffset < file.size) {
    const end = Math.min(file.size, readOffset + JSON_EXPLORER_LIMITS.chunkBytes);
    const chunk = new Uint8Array(await file.slice(readOffset, end).arrayBuffer());
    for (const line of lines.push(chunk)) yield line;
    readOffset = end;
  }
  for (const line of lines.finish(file.size)) yield line;
}

function sourceLocation(source: string, position: number | null): { line: number; column: number } {
  if (position === null) return { line: 1, column: 1 };
  const before = source.slice(0, position);
  const line = before.split("\n").length;
  const lastBreak = before.lastIndexOf("\n");
  return { line, column: position - lastBreak };
}

function parseRecord(line: JsonlDecodedLine, settings: JsonExplorerSettings): JsonNode | null {
  if (!line.text.trim()) return null;
  try {
    return parseJsonLossless(line.text, settings.maxDepth);
  } catch (error) {
    if (error instanceof JsonExplorerError && error.code === "depth-limit") {
      throw new JsonExplorerError(error.message, "depth-limit", error.position, { line: line.physicalLine, maxDepth: settings.maxDepth });
    }
    const position = error instanceof JsonExplorerError ? error.position : null;
    throw new JsonExplorerError("Malformed JSONL record", "malformed-jsonl", position, {
      line: line.physicalLine,
      column: position === null ? 1 : position + 1,
    });
  }
}

async function detectFormat(file: File, requested: "auto" | "json" | "jsonl", settings: JsonExplorerSettings): Promise<ResolvedJsonFormat> {
  if (requested !== "auto") return requested;
  const lower = file.name.toLocaleLowerCase();
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) return "jsonl";
  if (lower.endsWith(".json")) return "json";
  const probe = await file.slice(0, Math.min(file.size, JSON_EXPLORER_LIMITS.chunkBytes)).text();
  const lines = probe.replace(/^\ufeff/u, "").split(/\r?\n/u).filter((line) => line.trim());
  if (lines.length >= 2) {
    try {
      parseJsonLossless(lines[0], settings.maxDepth);
      parseJsonLossless(lines[1], settings.maxDepth);
      return "jsonl";
    } catch {
      return "json";
    }
  }
  return "json";
}


function columnInfo(current: Session): JsonColumnInfo[] {
  const pointers = current.projection.length > 0 ? current.projection : current.columns;
  return pointers.map((pointer) => ({ key: pointer, label: pointer || "$" }));
}

async function openJsonl(file: File, settings: JsonExplorerSettings, id: number, started: number): Promise<JsonlSession> {
  const columns = new Set<string>();
  const columnState = { truncated: false, retainedChars: 0 };
  const viewCheckpoints: ViewCheckpoint[] = [];
  let sourceRows = 0;
  let lastProgress = 0;
  for await (const line of scanLines(file, settings.recordBytes)) {
    const node = parseRecord(line, settings);
    if (node) {
      if (sourceRows % JSON_EXPLORER_LIMITS.sparseStride === 0) {
        viewCheckpoints.push({ viewIndex: sourceRows, sourceIndex: sourceRows, byteOffset: line.byteOffset, physicalLine: line.physicalLine });
      }
      if (sourceRows < JSON_EXPLORER_LIMITS.columnSampleRecords) addDiscoveredColumns(node, columns, columnState);
      else columnState.truncated = true;
      sourceRows++;
    }
    if (line.nextOffset - lastProgress >= JSON_EXPLORER_LIMITS.chunkBytes || line.nextOffset === file.size) {
      postProgress(id, line.nextOffset, file.size, started);
      lastProgress = line.nextOffset;
    }
  }
  if (file.size === 0) postProgress(id, 0, 0, started);
  if (columns.size === 0 && sourceRows > 0) columns.add("");
  return {
    format: "jsonl",
    file,
    fileBytes: file.size,
    sourceRows,
    settings,
    columns: [...columns],
    columnsTruncated: columnState.truncated,
    filter: { ...EMPTY_FILTER },
    projection: [],
    viewRows: sourceRows,
    viewCheckpoints,
  };
}

async function openOrdinary(file: File, settings: JsonExplorerSettings, id: number, started: number): Promise<OrdinarySession> {
  if (file.size > settings.ordinaryJsonBytes) {
    throw new JsonExplorerError(`Ordinary JSON is limited to ${settings.ordinaryJsonBytes} bytes; choose JSONL for streaming records`, "ordinary-limit", null, { limitBytes: settings.ordinaryJsonBytes });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  postProgress(id, bytes.length, file.size, started);
  let source: string;
  try {
    source = decoder.decode(bytes);
  } catch {
    throw new JsonExplorerError("The file is not valid UTF-8", "invalid-utf8", null, { line: 1 });
  }
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  let root: JsonNode;
  try {
    root = parseJsonLossless(source, settings.maxDepth);
  } catch (error) {
    if (!(error instanceof JsonExplorerError)) throw error;
    if (error.code === "invalid-json") {
      throw new JsonExplorerError(error.message, "invalid-json", error.position, sourceLocation(source, error.position));
    }
    throw error;
  }
  const records = root.kind === "array" ? root.elements : [root];
  const columns = new Set<string>();
  const columnState = { truncated: records.length > JSON_EXPLORER_LIMITS.columnSampleRecords, retainedChars: 0 };
  for (let index = 0; index < Math.min(records.length, JSON_EXPLORER_LIMITS.columnSampleRecords); index++) {
    addDiscoveredColumns(records[index], columns, columnState);
  }
  if (columns.size === 0 && records.length > 0) columns.add("");
  const viewCheckpoints: ViewCheckpoint[] = [];
  for (let sourceIndex = 0; sourceIndex < records.length; sourceIndex += JSON_EXPLORER_LIMITS.sparseStride) {
    viewCheckpoints.push({ viewIndex: sourceIndex, sourceIndex, byteOffset: 0, physicalLine: 1 });
  }
  return {
    format: "json",
    fileBytes: file.size,
    sourceRows: records.length,
    settings,
    columns: [...columns],
    columnsTruncated: columnState.truncated,
    filter: { ...EMPTY_FILTER },
    projection: [],
    viewRows: records.length,
    viewCheckpoints,
    source,
    root,
    records,
  };
}

function openResult(current: Session): OpenJsonResult {
  const root = current.format === "json" ? current.root : null;
  return {
    format: current.format,
    fileBytes: current.fileBytes,
    sourceRows: current.sourceRows,
    viewRows: current.viewRows,
    columns: columnInfo(current),
    columnsTruncated: current.columnsTruncated,
    rootKind: root?.kind ?? null,
    rootChildren: root?.kind === "array" ? root.elements.length : root?.kind === "object" ? root.entries.length : 0,
    tableAvailable: current.format === "jsonl" || current.sourceRows > 0,
  };
}

function requireSession(): Session {
  if (!session) throw new JsonExplorerError("Open a file before requesting explorer data", "session-missing");
  return session;
}

async function applyView(current: Session, filter: JsonViewFilter, projection: string[], id: number, started: number): Promise<ApplyJsonViewResult> {
  parseJsonPointer(filter.fieldPath);
  const selected = normalizePointers(projection.join("\n"));
  if (selected.length > JSON_EXPLORER_LIMITS.detectedColumns) {
    throw new JsonExplorerError(`A projection is limited to ${JSON_EXPLORER_LIMITS.detectedColumns} fields`, "field-limit", null, { maxFields: JSON_EXPLORER_LIMITS.detectedColumns });
  }
  current.filter = filter;
  current.projection = selected;
  current.viewRows = 0;
  current.viewCheckpoints = [];
  if (current.format === "json") {
    for (let sourceIndex = 0; sourceIndex < current.records.length; sourceIndex++) {
      const node = current.records[sourceIndex];
      if (recordMatches(node, current.source, filter)) {
        if (current.viewRows % JSON_EXPLORER_LIMITS.sparseStride === 0) {
          current.viewCheckpoints.push({ viewIndex: current.viewRows, sourceIndex, byteOffset: 0, physicalLine: 1 });
        }
        current.viewRows++;
      }
      if (sourceIndex % 4096 === 0 || sourceIndex + 1 === current.records.length) {
        postProgress(id, node.end, current.source.length, started);
        await Promise.resolve();
      }
    }
  } else {
    let sourceIndex = 0;
    let lastProgress = 0;
    for await (const line of scanLines(current.file, current.settings.recordBytes)) {
      const node = parseRecord(line, current.settings);
      if (node) {
        if (recordMatches(node, line.text, filter)) {
          if (current.viewRows % JSON_EXPLORER_LIMITS.sparseStride === 0) {
            current.viewCheckpoints.push({ viewIndex: current.viewRows, sourceIndex, byteOffset: line.byteOffset, physicalLine: line.physicalLine });
          }
          current.viewRows++;
        }
        sourceIndex++;
      }
      if (line.nextOffset - lastProgress >= JSON_EXPLORER_LIMITS.chunkBytes || line.nextOffset === current.file.size) {
        postProgress(id, line.nextOffset, current.file.size, started);
        lastProgress = line.nextOffset;
      }
    }
  }
  return { viewRows: current.viewRows, columns: columnInfo(current) };
}

function checkpointFor(current: Session, viewIndex: number): ViewCheckpoint | null {
  let found: ViewCheckpoint | null = null;
  for (const checkpoint of current.viewCheckpoints) {
    if (checkpoint.viewIndex > viewIndex) break;
    found = checkpoint;
  }
  return found;
}

async function readRows(current: Session, start: number, count: number): Promise<ReadJsonRowsResult> {
  const safeStart = Math.max(0, Math.trunc(start));
  const safeCount = Math.max(0, Math.min(500, Math.trunc(count)));
  if (safeCount === 0 || safeStart >= current.viewRows) return { rows: [] };
  const checkpoint = checkpointFor(current, safeStart);
  if (!checkpoint) return { rows: [] };
  const rows: string[][] = [];
  const pointers = current.projection.length > 0 ? current.projection : current.columns;
  let viewIndex = checkpoint.viewIndex;
  if (current.format === "json") {
    for (let sourceIndex = checkpoint.sourceIndex; sourceIndex < current.records.length && rows.length < safeCount; sourceIndex++) {
      const node = current.records[sourceIndex];
      if (!recordMatches(node, current.source, current.filter)) continue;
      if (viewIndex >= safeStart) rows.push(projectedCells(node, current.source, pointers));
      viewIndex++;
    }
  } else {
    for await (const line of scanLines(current.file, current.settings.recordBytes, checkpoint.byteOffset, checkpoint.physicalLine)) {
      const node = parseRecord(line, current.settings);
      if (!node || !recordMatches(node, line.text, current.filter)) continue;
      if (viewIndex >= safeStart) rows.push(projectedCells(node, line.text, pointers));
      viewIndex++;
      if (rows.length >= safeCount) break;
    }
  }
  return { rows };
}

async function inspectRow(current: Session, index: number): Promise<InspectJsonRowResult> {
  const wanted = Math.trunc(index);
  if (wanted < 0 || wanted >= current.viewRows) throw new JsonExplorerError("Record index is outside the current result", "row-range", null, { row: wanted + 1 });
  const checkpoint = checkpointFor(current, wanted);
  if (!checkpoint) throw new JsonExplorerError("Record index is not indexed", "row-range", null, { row: wanted + 1 });
  let viewIndex = checkpoint.viewIndex;
  if (current.format === "json") {
    for (let sourceIndex = checkpoint.sourceIndex; sourceIndex < current.records.length; sourceIndex++) {
      const node = current.records[sourceIndex];
      if (!recordMatches(node, current.source, current.filter)) continue;
      if (viewIndex === wanted) return { sourceIndex, physicalLine: null, json: rawJson(node, current.source) };
      viewIndex++;
    }
  } else {
    let sourceIndex = checkpoint.sourceIndex;
    for await (const line of scanLines(current.file, current.settings.recordBytes, checkpoint.byteOffset, checkpoint.physicalLine)) {
      const node = parseRecord(line, current.settings);
      if (!node) continue;
      if (recordMatches(node, line.text, current.filter)) {
        if (viewIndex === wanted) return { sourceIndex, physicalLine: line.physicalLine, json: rawJson(node, line.text) };
        viewIndex++;
      }
      sourceIndex++;
    }
  }
  throw new JsonExplorerError("Record was not found", "row-range", null, { row: wanted + 1 });
}

function exportCell(node: JsonNode | undefined, source: string): string {
  if (!node) return "";
  return node.kind === "string" ? node.value : rawJson(node, source);
}

function exportLine(current: Session, node: JsonNode, source: string, request: ExportJsonChunkRequest): string {
  if (request.format === "jsonl") return `${projectedJson(node, source, current.projection)}\n`;
  const pointers = current.projection.length > 0 ? current.projection : current.columns;
  return `${encodeCsvRow(pointers.map((pointer) => exportCell(resolveJsonPointer(node, pointer), source)), request.protectFormulas)}\r\n`;
}

function joinBytes(parts: Uint8Array[], total: number): Uint8Array {
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

async function exportChunk(current: Session, request: ExportJsonChunkRequest): Promise<ExportJsonChunkResult> {
  const maxBytes = Math.max(64 * 1024, Math.min(JSON_EXPLORER_LIMITS.exportChunkBytes, Math.trunc(request.maxBytes)));
  const initial: JsonExportCursor = request.cursor ?? { sourceIndex: 0, byteOffset: 0, physicalLine: 1, recordIndex: 0, headerWritten: false };
  const parts: Uint8Array[] = [];
  let total = 0;
  let emittedRows = 0;
  let cursor = { ...initial };
  if (request.format === "csv" && !cursor.headerWritten) {
    const pointers = current.projection.length > 0 ? current.projection : current.columns;
    const header = encoder.encode(`\ufeff${encodeCsvRow(pointers.map((pointer) => pointer || "$"), false)}\r\n`);
    parts.push(header);
    total += header.length;
    cursor.headerWritten = true;
  }

  if (current.format === "json") {
    let sourceIndex = cursor.sourceIndex;
    for (; sourceIndex < current.records.length; sourceIndex++) {
      const node = current.records[sourceIndex];
      if (!recordMatches(node, current.source, current.filter)) continue;
      const bytes = encoder.encode(exportLine(current, node, current.source, request));
      if (total > 0 && total + bytes.length > maxBytes) break;
      parts.push(bytes);
      total += bytes.length;
      emittedRows++;
      if (total >= maxBytes) {
        sourceIndex++;
        break;
      }
    }
    cursor.sourceIndex = sourceIndex;
    cursor.recordIndex = sourceIndex;
    const done = sourceIndex >= current.records.length;
    const bytes = joinBytes(parts, total);
    return { bytes, cursor: done ? null : cursor, done, emittedRows };
  }

  let sourceIndex = cursor.sourceIndex;
  let nextCursor: JsonExportCursor | null = null;
  for await (const line of scanLines(current.file, current.settings.recordBytes, cursor.byteOffset, cursor.physicalLine)) {
    const node = parseRecord(line, current.settings);
    if (!node) {
      cursor.byteOffset = line.nextOffset;
      cursor.physicalLine = line.physicalLine + 1;
      continue;
    }
    if (recordMatches(node, line.text, current.filter)) {
      const bytes = encoder.encode(exportLine(current, node, line.text, request));
      if (total > 0 && total + bytes.length > maxBytes) {
        nextCursor = { ...cursor, sourceIndex, recordIndex: sourceIndex, byteOffset: line.byteOffset, physicalLine: line.physicalLine };
        break;
      }
      parts.push(bytes);
      total += bytes.length;
      emittedRows++;
    }
    sourceIndex++;
    cursor = { ...cursor, sourceIndex, recordIndex: sourceIndex, byteOffset: line.nextOffset, physicalLine: line.physicalLine + 1 };
    if (total >= maxBytes) {
      nextCursor = cursor;
      break;
    }
  }
  const done = nextCursor === null && cursor.byteOffset >= current.file.size;
  const bytes = joinBytes(parts, total);
  return { bytes, cursor: done ? null : (nextCursor ?? cursor), done, emittedRows };
}

async function handle(id: number, request: JsonExplorerRequest): Promise<void> {
  const started = performance.now();
  switch (request.type) {
    case "open": {
      session = null;
      const settings = checkedSettings(request.settings);
      const format = await detectFormat(request.file, request.format, settings);
      session = format === "jsonl"
        ? await openJsonl(request.file, settings, id, started)
        : await openOrdinary(request.file, settings, id, started);
      postResult(id, openResult(session));
      return;
    }
    case "apply-view": {
      const current = requireSession();
      postResult(id, await applyView(current, request.filter, request.projection, id, started));
      return;
    }
    case "read-rows": {
      postResult(id, await readRows(requireSession(), request.start, request.count));
      return;
    }
    case "inspect-row": {
      postResult(id, await inspectRow(requireSession(), request.index));
      return;
    }
    case "read-tree": {
      const current = requireSession();
      if (current.format !== "json") throw new JsonExplorerError("The structure tree is available for ordinary JSON files", "tree-unavailable");
      const result: ReadJsonTreeResult = treeChildren(current.root, current.source, request.pointer, Math.max(0, request.start), Math.min(500, Math.max(0, request.count)));
      postResult(id, result);
      return;
    }
    case "export-chunk": {
      const result = await exportChunk(requireSession(), request);
      postResult(id, result, [result.bytes.buffer as ArrayBuffer]);
    }
  }
}

self.addEventListener("message", (event: MessageEvent<JsonExplorerRequest & { id: number }>) => {
  const { id, ...request } = event.data;
  queue = queue.then(() => handle(id, request as JsonExplorerRequest)).catch((error) => {
    if (error instanceof JsonExplorerError) postResult(id, { explorerError: error.diagnostic() });
    else postInfrastructureError(id, error);
  });
});

export {};
