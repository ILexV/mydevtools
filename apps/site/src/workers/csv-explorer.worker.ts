/// <reference lib="webworker" />
import { encodeCsvRow } from "@/tools/explorer-delimited";
import {
  CSV_CHECKPOINT_STRIDE,
  CSV_CHUNK_BYTES,
  CSV_FILTER_CHECKPOINT_STRIDE,
  CSV_MAX_EXPORT_BYTES,
  CSV_MAX_RANGE_ROWS,
  CSV_MAX_RECORDS,
  CsvByteParser,
  CsvParserError,
  csvRecordMatchesPrepared,
  decodeCsvSample,
  detectCsvDelimiter,
  detectCsvEncoding,
  normalizeCsvHeaders,
  prepareCsvFilter,
  type CsvDelimiter,
  type CsvEncoding,
  type PreparedCsvFilter,
  type CsvParsedRecord,
} from "@/tools/csv-explorer";
import type {
  CsvColumn,
  CsvExplorerRequest,
  CsvExplorerSuccess,
  CsvExplorerWorkerMessage,
  CsvOpenOptions,
} from "@/tools/csv-explorer-protocol";

const SAMPLE_BYTES = 256 * 1024;
const EXPORT_PART_CHARS = 256 * 1024;
const TABLE_CELL_CHARS = 512;

function tableCellPreview(value: string): string {
  if (value.length <= TABLE_CELL_CHARS) return value;
  const last = value.charCodeAt(TABLE_CELL_CHARS - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? TABLE_CELL_CHARS - 1 : TABLE_CELL_CHARS;
  return `${value.slice(0, end)}…`;
}

interface Checkpoint {
  row: number;
  offset: number;
}

interface CsvSession {
  id: number;
  file: File;
  encoding: CsvEncoding;
  delimiter: CsvDelimiter;
  bomBytes: number;
  hasHeader: boolean;
  columns: CsvColumn[];
  rowCount: number;
  rawRowCount: number;
  checkpoints: Checkpoint[];
  filter: PreparedCsvFilter | null;
  filterCheckpoints: Checkpoint[];
  blankHeaderCount: number;
  duplicateHeaderCount: number;
}

let session: CsvSession | null = null;
let nextSessionId = 1;

function post(message: CsvExplorerWorkerMessage): void {
  (self as DedicatedWorkerGlobalScope).postMessage(message);
}

function progress(id: number, processed: number, total: number, started: number): void {
  post({ id, type: "progress", processed, total, elapsedMs: performance.now() - started });
}

function matchingBomLength(bytes: Uint8Array, encoding: CsvEncoding): number {
  const detected = detectCsvEncoding(bytes);
  return detected.encoding === encoding ? detected.bomBytes : 0;
}

async function scanFile(
  file: File,
  encoding: CsvEncoding,
  delimiter: CsvDelimiter,
  startOffset: number,
  onRecord: (record: CsvParsedRecord) => boolean | void,
  onBytes?: (processed: number) => void,
): Promise<void> {
  const parser = new CsvByteParser(encoding, delimiter, startOffset, onRecord);
  let offset = startOffset;
  let keepGoing = true;
  while (offset < file.size && keepGoing) {
    const end = Math.min(file.size, offset + CSV_CHUNK_BYTES);
    const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    keepGoing = parser.push(bytes, offset);
    offset = end;
    onBytes?.(offset);
  }
  if (keepGoing) parser.finish(file.size);
}

async function resolveFormat(file: File, options: CsvOpenOptions): Promise<{
  encoding: CsvEncoding;
  delimiter: CsvDelimiter;
  bomBytes: number;
}> {
  const sample = new Uint8Array(await file.slice(0, Math.min(file.size, SAMPLE_BYTES)).arrayBuffer());
  const detected = detectCsvEncoding(sample);
  const encoding = options.encoding === "auto" ? detected.encoding : options.encoding;
  const bomBytes = options.encoding === "auto" ? detected.bomBytes : matchingBomLength(sample, encoding);
  const sampleText = decodeCsvSample(sample, encoding, bomBytes);
  const delimiter = options.delimiter === "auto" ? detectCsvDelimiter(sampleText) : options.delimiter;
  return { encoding, delimiter, bomBytes };
}

function requireSession(id: number): CsvSession {
  if (!session || session.id !== id) throw new CsvParserError("session-missing", "The CSV session is no longer available");
  return session;
}

function validateColumns(current: CsvSession, columns: readonly number[]): void {
  if (columns.length === 0 || columns.some((column) => !Number.isInteger(column) || column < 0 || column >= current.columns.length)) {
    throw new CsvParserError("too-many-columns", "Select at least one valid column");
  }
}

function nearestCheckpoint(checkpoints: readonly Checkpoint[], row: number): Checkpoint {
  let low = 0;
  let high = checkpoints.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (checkpoints[middle].row <= row) low = middle;
    else high = middle - 1;
  }
  return checkpoints[low];
}

async function openSession(id: number, file: File, options: CsvOpenOptions): Promise<CsvExplorerSuccess> {
  session = null;
  if (file.size === 0) throw new CsvParserError("malformed-csv", "The file is empty");
  const started = performance.now();
  const { encoding, delimiter, bomBytes } = await resolveFormat(file, options);
  const checkpoints: Checkpoint[] = [];
  let physicalRows = 0;
  let dataRows = 0;
  let maxColumns = 0;
  let rawHeaders: readonly string[] = [];

  await scanFile(file, encoding, delimiter, bomBytes, (record) => {
    maxColumns = Math.max(maxColumns, record.fields.length);
    if (options.header && physicalRows === 0) {
      rawHeaders = record.fields;
    } else {
      if (dataRows >= CSV_MAX_RECORDS) throw new CsvParserError("record-too-large", "The file exceeds the configured record limit");
      if (dataRows % CSV_CHECKPOINT_STRIDE === 0) checkpoints.push({ row: dataRows, offset: record.start });
      dataRows++;
    }
    physicalRows++;
  }, (processed) => progress(id, processed, file.size, started));

  if (physicalRows === 0) throw new CsvParserError("malformed-csv", "The file contains no records");
  const header = normalizeCsvHeaders(options.header ? rawHeaders : [], maxColumns);
  const columns = header.labels.map((label, index) => ({ key: `c${index}`, label, index }));
  const created: CsvSession = {
    id: nextSessionId++,
    file,
    encoding,
    delimiter,
    bomBytes,
    hasHeader: options.header,
    columns,
    rowCount: dataRows,
    rawRowCount: dataRows,
    checkpoints,
    filter: null,
    filterCheckpoints: [],
    blankHeaderCount: header.blankCount,
    duplicateHeaderCount: header.duplicateCount,
  };
  session = created;
  return {
    kind: "open",
    sessionId: created.id,
    rowCount: dataRows,
    unfilteredRowCount: dataRows,
    columns,
    encoding,
    delimiter,
    hasHeader: options.header,
    blankHeaderCount: header.blankCount,
    duplicateHeaderCount: header.duplicateCount,
    fileSize: file.size,
    fileName: file.name,
  };
}

async function filterSession(id: number, request: Extract<CsvExplorerRequest, { type: "filter" }>): Promise<CsvExplorerSuccess> {
  const current = requireSession(request.sessionId);
  if (request.filter) validateColumns(current, request.filter.columns);
  const filter = request.filter && request.filter.query.length > 0 ? request.filter : null;
  if (!filter) {
    current.filter = null;
    current.filterCheckpoints = [];
    current.rowCount = current.rawRowCount;
    return { kind: "filter", sessionId: current.id, rowCount: current.rowCount };
  }

  const prepared = prepareCsvFilter(filter);
  if (!prepared) throw new CsvParserError("malformed-csv", "The filter query is invalid");

  const checkpoints: Checkpoint[] = [];
  let matches = 0;
  const started = performance.now();
  const first = current.checkpoints[0];
  if (first) {
    await scanFile(current.file, current.encoding, current.delimiter, first.offset, (record) => {
      if (csvRecordMatchesPrepared(record.fields, prepared)) {
        if (matches % CSV_FILTER_CHECKPOINT_STRIDE === 0) checkpoints.push({ row: matches, offset: record.start });
        matches++;
      }
    }, (processed) => progress(id, processed, current.file.size, started));
  }
  current.filter = prepared;
  current.filterCheckpoints = checkpoints;
  current.rowCount = matches;
  return { kind: "filter", sessionId: current.id, rowCount: matches };
}

async function readRows(current: CsvSession, start: number, count: number, columns: readonly number[], truncateCells = true): Promise<string[][]> {
  validateColumns(current, columns);
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(count) || count < 0 || count > CSV_MAX_RANGE_ROWS) {
    throw new CsvParserError("record-too-large", "The requested table range is invalid");
  }
  if (count === 0 || start >= current.rowCount) return [];
  const checkpoints = current.filter ? current.filterCheckpoints : current.checkpoints;
  if (checkpoints.length === 0) return [];
  const checkpoint = nearestCheckpoint(checkpoints, start);
  let viewIndex = checkpoint.row;
  const rows: string[][] = [];
  await scanFile(current.file, current.encoding, current.delimiter, checkpoint.offset, (record) => {
    if (!csvRecordMatchesPrepared(record.fields, current.filter)) return;
    if (viewIndex >= start) {
      rows.push(columns.map((column) => {
        const value = record.fields[column] ?? "";
        return truncateCells ? tableCellPreview(value) : value;
      }));
    }
    viewIndex++;
    return rows.length < count;
  });
  return rows;
}

async function inspectRow(current: CsvSession, index: number): Promise<string[]> {
  if (!Number.isInteger(index) || index < 0 || index >= current.rowCount) {
    throw new CsvParserError("record-too-large", "The selected row is outside the current result");
  }
  const columns = current.columns.map((column) => column.index);
  const rows = await readRows(current, index, 1, columns, false);
  return rows[0] ?? [];
}

async function exportRows(
  id: number,
  current: CsvSession,
  request: Extract<CsvExplorerRequest, { type: "export" }>,
): Promise<CsvExplorerSuccess> {
  validateColumns(current, request.columns);
  const labels = request.columns.map((column) => current.columns[column].label);
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  let pending = request.format === "csv" && request.bom ? "\ufeff" : "";
  let outputBytes = 0;
  let exportedRows = 0;

  const flush = () => {
    if (pending.length === 0) return;
    const bytes = encoder.encode(pending);
    outputBytes += bytes.byteLength;
    if (outputBytes > CSV_MAX_EXPORT_BYTES) throw new CsvParserError("record-too-large", "The export exceeds the browser output limit");
    parts.push(bytes);
    pending = "";
  };
  const append = (value: string) => {
    pending += value;
    if (pending.length >= EXPORT_PART_CHARS) flush();
  };

  if (request.format === "csv" && request.includeHeader) append(`${encodeCsvRow(labels, request.protectFormulas)}\r\n`);
  const started = performance.now();
  const first = current.checkpoints[0];
  if (first) {
    await scanFile(current.file, current.encoding, current.delimiter, first.offset, (record) => {
      if (!csvRecordMatchesPrepared(record.fields, current.filter)) return;
      const values = request.columns.map((column) => record.fields[column] ?? "");
      if (request.format === "csv") {
        append(`${encodeCsvRow(values, request.protectFormulas)}\r\n`);
      } else {
        const properties = values.map((value, index) => `${JSON.stringify(labels[index])}:${JSON.stringify(value)}`);
        append(`{${properties.join(",")}}\n`);
      }
      exportedRows++;
    }, (processed) => progress(id, processed, current.file.size, started));
  }
  flush();
  const mime = request.format === "csv" ? "text/csv;charset=utf-8" : "application/x-ndjson;charset=utf-8";
  return {
    kind: "export",
    sessionId: current.id,
    blob: new Blob(parts, { type: mime }),
    extension: request.format,
    mime,
    rowCount: exportedRows,
  };
}

async function handle(id: number, request: CsvExplorerRequest): Promise<void> {
  try {
    let result: CsvExplorerSuccess;
    switch (request.type) {
      case "open":
        result = await openSession(id, request.file, request.options);
        break;
      case "filter":
        result = await filterSession(id, request);
        break;
      case "read": {
        const current = requireSession(request.sessionId);
        result = { kind: "read", sessionId: current.id, start: request.start, rows: await readRows(current, request.start, request.count, request.columns) };
        break;
      }
      case "inspect": {
        const current = requireSession(request.sessionId);
        result = { kind: "inspect", sessionId: current.id, index: request.index, values: await inspectRow(current, request.index) };
        break;
      }
      case "export":
        result = await exportRows(id, requireSession(request.sessionId), request);
        break;
    }
    post({ id, ok: true, ...result });
  } catch (error) {
    const parserError = error instanceof CsvParserError ? error : null;
    if (parserError) session = null;
    const limited = parserError?.code === "field-too-large"
      || parserError?.code === "record-too-large"
      || parserError?.code === "too-many-columns";
    post({
      id,
      ok: false,
      code: parserError ? (limited ? "input-too-large" : "unknown") : "worker-failed",
      message: parserError?.code ?? (error instanceof Error ? error.message : String(error)),
    });
  }
}

let queue = Promise.resolve();
self.addEventListener("message", (event: MessageEvent<CsvExplorerRequest & { id: number }>) => {
  const { id, ...request } = event.data;
  queue = queue.then(() => handle(id, request as CsvExplorerRequest));
});

export {};
