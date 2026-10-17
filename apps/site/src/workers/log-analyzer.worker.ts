/// <reference lib="webworker" />
import { readBlobChunks } from "@/scripts/blob-chunks";
import { classifyWorkerError, createWorkerByteWriter } from "@/scripts/wasm/worker-protocol";
import {
  LOG_ANALYZER_LIMITS,
  LogAnalysisAccumulator,
  LogAnalyzerError,
  LogLineDecoder,
  detectLogPreset,
  encodeOriginalLogLine,
  logRecordMatches,
  parseLogRecord,
  previewLogValue,
  prepareLogFilter,
  type PreparedLogFilter,
  type LogPreset,
  type ParsedLogRecord,
  type ResolvedLogPreset,
} from "@/tools/log-analyzer";
import type {
  LogAnalyzerRequest,
  LogAnalyzerSuccess,
  LogAnalyzerWorkerMessage,
  LogInspection,
  LogSessionSummary,
  LogTableRecord,
} from "@/tools/log-analyzer-protocol";
import type { JsonlDecodedLine } from "@/tools/json-explorer-core";

interface Checkpoint {
  index: number;
  offset: number;
  physicalLine: number;
}

interface LogSession {
  id: number;
  file: File;
  preset: ResolvedLogPreset;
  /** Serilog JSON is strict per line; .NET plaintext accepts continuation and unstructured lines. */
  serilogJson: boolean;
  rowCount: number;
  rawRowCount: number;
  checkpoints: Checkpoint[];
  filter: PreparedLogFilter | null;
  filterCheckpoints: Checkpoint[];
  sourceAnalysis: LogSessionSummary["analysis"];
  analysis: LogSessionSummary["analysis"];
}

let session: LogSession | null = null;
let nextSessionId = 1;

function post(message: LogAnalyzerWorkerMessage): void {
  (self as DedicatedWorkerGlobalScope).postMessage(message);
}

function progress(id: number, processed: number, total: number, started: number): void {
  post({ id, type: "progress", processed, total, elapsedMs: performance.now() - started });
}

async function scanFile(
  file: File,
  startOffset: number,
  startPhysicalLine: number,
  onLine: (line: JsonlDecodedLine) => boolean | void,
  onBytes?: (processed: number) => void,
  afterChunk?: () => Promise<void>,
): Promise<void> {
  const decoder = new LogLineDecoder(startOffset, startPhysicalLine);
  let keepGoing = true;
  for await (const chunk of readBlobChunks(file, {
    chunkBytes: LOG_ANALYZER_LIMITS.chunkBytes,
    start: startOffset,
  })) {
    for (const line of decoder.push(chunk.bytes)) {
      if (onLine(line) === false) {
        keepGoing = false;
        break;
      }
    }
    onBytes?.(chunk.end);
    await afterChunk?.();
    if (!keepGoing) break;
  }
  if (keepGoing) {
    for (const line of decoder.finish(file.size)) onLine(line);
    onBytes?.(file.size);
    await afterChunk?.();
  }
}

function requireSession(id: number): LogSession {
  if (!session || session.id !== id) throw new LogAnalyzerError("session-missing", "The log session is no longer available");
  return session;
}

function nearestCheckpoint(checkpoints: readonly Checkpoint[], index: number): Checkpoint {
  let low = 0;
  let high = checkpoints.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (checkpoints[middle].index <= index) low = middle;
    else high = middle - 1;
  }
  return checkpoints[low];
}

function tableRecord(record: ParsedLogRecord): LogTableRecord {
  return {
    line: record.line,
    timestamp: record.timestampText,
    severity: record.severity,
    source: previewLogValue(record.source, 256),
    correlationId: previewLogValue(record.correlationId, 256),
    message: previewLogValue(record.message),
    malformed: record.malformed,
  };
}
function parseSessionRecord(current: LogSession, line: JsonlDecodedLine): ParsedLogRecord {
  const preset = current.preset === "serilog" && !current.serilogJson ? "text" : current.preset;
  return parseLogRecord(line.text, line.physicalLine, preset);
}


async function openSession(id: number, file: File, requestedPreset: LogPreset): Promise<LogAnalyzerSuccess> {
  session = null;
  if (file.size === 0) throw new LogAnalyzerError("empty", "The file is empty");
  const started = performance.now();
  const checkpoints: Checkpoint[] = [];
  const analysis = new LogAnalysisAccumulator();
  let count = 0;
  let preset: ResolvedLogPreset | null = requestedPreset === "auto" ? null : requestedPreset;
  let serilogJson: boolean | null = null;

  await scanFile(file, 0, 1, (line) => {
    if (count >= LOG_ANALYZER_LIMITS.maxRecords) {
      throw new LogAnalyzerError("record-limit", "The file exceeds the configured record limit");
    }
    if (!preset && line.text.trim().length > 0) preset = detectLogPreset(line.text);
    if (serilogJson === null && preset === "serilog" && line.text.trim().length > 0) {
      serilogJson = line.text.trimStart().startsWith("{");
    }
    const effective = preset === "serilog" && serilogJson !== true ? "text" : (preset ?? "text");
    if (count % LOG_ANALYZER_LIMITS.sourceCheckpointStride === 0) {
      checkpoints.push({ index: count, offset: line.byteOffset, physicalLine: line.physicalLine });
    }
    analysis.add(parseLogRecord(line.text, line.physicalLine, effective));
    count++;
  }, (processed) => progress(id, processed, file.size, started));

  if (count === 0) throw new LogAnalyzerError("empty", "The file contains no log records");
  const sourceAnalysis = analysis.finish();
  const created: LogSession = {
    id: nextSessionId++,
    file,
    preset: preset ?? "text",
    serilogJson: serilogJson ?? false,
    rowCount: count,
    rawRowCount: count,
    checkpoints,
    filter: null,
    filterCheckpoints: [],
    sourceAnalysis,
    analysis: sourceAnalysis,
  };
  session = created;
  return {
    kind: "open",
    sessionId: created.id,
    fileName: file.name,
    fileSize: file.size,
    preset: created.preset,
    rowCount: count,
    unfilteredRowCount: count,
    analysis: sourceAnalysis,
  };
}

async function filterSession(
  id: number,
  request: Extract<LogAnalyzerRequest, { type: "filter" }>,
): Promise<LogAnalyzerSuccess> {
  const current = requireSession(request.sessionId);
  if (!request.filter) {
    current.filter = null;
    current.filterCheckpoints = [];
    current.rowCount = current.rawRowCount;
    current.analysis = current.sourceAnalysis;
    return { kind: "filter", sessionId: current.id, rowCount: current.rowCount, analysis: current.analysis };
  }
  const filter = prepareLogFilter(request.filter);
  const checkpoints: Checkpoint[] = [];
  const analysis = new LogAnalysisAccumulator();
  const started = performance.now();
  let matches = 0;

  await scanFile(current.file, 0, 1, (line) => {
    const record = parseSessionRecord(current, line);
    if (!logRecordMatches(record, filter)) return;
    if (matches % LOG_ANALYZER_LIMITS.filterCheckpointStride === 0) {
      checkpoints.push({ index: matches, offset: line.byteOffset, physicalLine: line.physicalLine });
    }
    analysis.add(record);
    matches++;
  }, (processed) => progress(id, processed, current.file.size, started));

  current.filter = filter;
  current.filterCheckpoints = checkpoints;
  current.rowCount = matches;
  current.analysis = analysis.finish();
  return { kind: "filter", sessionId: current.id, rowCount: matches, analysis: current.analysis };
}

async function readRecords(current: LogSession, start: number, count: number): Promise<LogTableRecord[]> {
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(count) || count < 0 || count > LOG_ANALYZER_LIMITS.maxRangeRecords) {
    throw new LogAnalyzerError("record-limit", "The requested log range is invalid");
  }
  if (count === 0 || start >= current.rowCount) return [];
  const checkpoints = current.filter ? current.filterCheckpoints : current.checkpoints;
  if (checkpoints.length === 0) return [];
  const checkpoint = nearestCheckpoint(checkpoints, start);
  let viewIndex = checkpoint.index;
  const records: LogTableRecord[] = [];
  await scanFile(current.file, checkpoint.offset, checkpoint.physicalLine, (line) => {
    const record = parseSessionRecord(current, line);
    if (!logRecordMatches(record, current.filter)) return;
    if (viewIndex >= start) records.push(tableRecord(record));
    viewIndex++;
    return records.length < count;
  });
  return records;
}

async function inspectRecord(current: LogSession, index: number): Promise<LogInspection> {
  if (!Number.isInteger(index) || index < 0 || index >= current.rowCount) {
    throw new LogAnalyzerError("record-limit", "The selected record is outside the current result");
  }
  const checkpoints = current.filter ? current.filterCheckpoints : current.checkpoints;
  const checkpoint = nearestCheckpoint(checkpoints, index);
  let viewIndex = checkpoint.index;
  let inspection: LogInspection | null = null;
  await scanFile(current.file, checkpoint.offset, checkpoint.physicalLine, (line) => {
    const record = parseSessionRecord(current, line);
    if (!logRecordMatches(record, current.filter)) return;
    if (viewIndex === index) {
      const truncated = record.raw.length > LOG_ANALYZER_LIMITS.maxInspectorChars;
      inspection = {
        line: record.line,
        raw: truncated ? previewLogValue(record.raw, LOG_ANALYZER_LIMITS.maxInspectorChars) : record.raw,
        truncated,
      };
      return false;
    }
    viewIndex++;
  });
  if (!inspection) throw new LogAnalyzerError("record-limit", "The selected record could not be read");
  return inspection;
}

async function exportRecords(
  id: number,
  current: LogSession,
  request: Extract<LogAnalyzerRequest, { type: "export" }>,
): Promise<LogAnalyzerSuccess> {
  const writer = createWorkerByteWriter(request.stream);
  const queued: Uint8Array[] = [];
  let exported = 0;
  const started = performance.now();
  const drain = async () => {
    for (const bytes of queued) await writer.write(bytes);
    queued.length = 0;
  };

  await scanFile(current.file, 0, 1, (line) => {
    const record = parseSessionRecord(current, line);
    if (!logRecordMatches(record, current.filter)) return;
    queued.push(encodeOriginalLogLine(line));
    exported++;
  }, (processed) => progress(id, processed, current.file.size, started), drain);
  await drain();
  writer.close();
  return {
    kind: "export",
    sessionId: current.id,
    rowCount: exported,
    extension: "log",
    mime: "text/plain;charset=utf-8",
  };
}

async function handle(id: number, request: LogAnalyzerRequest): Promise<void> {
  try {
    let result: LogAnalyzerSuccess;
    switch (request.type) {
      case "open": result = await openSession(id, request.file, request.preset); break;
      case "filter": result = await filterSession(id, request); break;
      case "read": {
        const current = requireSession(request.sessionId);
        result = { kind: "read", sessionId: current.id, start: request.start, records: await readRecords(current, request.start, request.count) };
        break;
      }
      case "inspect": {
        const current = requireSession(request.sessionId);
        result = { kind: "inspect", sessionId: current.id, index: request.index, inspection: await inspectRecord(current, request.index) };
        break;
      }
      case "export": result = await exportRecords(id, requireSession(request.sessionId), request); break;
    }
    post({ id, ok: true, ...result });
  } catch (error) {
    if (request.type === "open") session = null;
    const logError = error instanceof LogAnalyzerError ? error : null;
    const limited = logError?.code === "line-too-large" || logError?.code === "record-limit" || logError?.code === "filter-too-large";
    const classified = classifyWorkerError(error, logError ? (limited ? "input-too-large" : "unknown") : "worker-failed");
    post({ id, ok: false, code: classified.code, message: logError?.code ?? classified.message });
  }
}

let queue = Promise.resolve();
self.addEventListener("message", (event: MessageEvent<LogAnalyzerRequest & { id: number }>) => {
  const { id, ...request } = event.data;
  queue = queue.then(() => handle(id, request as LogAnalyzerRequest));
});

export {};
