/// <reference lib="webworker" />
import { readBlobChunks } from "@/scripts/blob-chunks";
import { classifyWorkerError, createWorkerByteWriter } from "@/scripts/wasm/worker-protocol";
import { encodeCsvRow } from "@/tools/explorer-delimited";
import {
  CSV_CHECKPOINT_STRIDE,
  CSV_CHUNK_BYTES,
  CSV_FILTER_CHECKPOINT_STRIDE,
  CSV_MAX_FIELD_BYTES,
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
import {
  CSV_EXPORT_MIME,
  encodeCsvConversionError,
  type CsvColumn,
  type CsvExplorerRequest,
  type CsvExplorerSuccess,
  type CsvExplorerWorkerMessage,
  type CsvOpenOptions,
  type CsvSort,
} from "@/tools/csv-explorer-protocol";
import { createCsvParquetStream } from "@/tools/csv-explorer-parquet";
import {
  CSV_SORT_MAX_KEY_CHARS,
  CSV_SORT_MAX_ROWS,
  CSV_TYPE_SAMPLE_ROWS,
  CsvAggregator,
  CsvConversionError,
  compareCsvTypedValues,
  convertCsvCellOrThrow,
  csvTypedJson,
  csvTypedText,
  detectCsvColumnType,
  isCsvColumnType,
  type CsvAggregateResult,
  type CsvColumnType,
  type CsvInvalidPolicy,
  type CsvTypedValue,
} from "@/tools/csv-explorer-types";

const SAMPLE_BYTES = 256 * 1024;
const EXPORT_PART_CHARS = 256 * 1024;
const TABLE_CELL_CHARS = 512;
const SORTED_WINDOW_ROWS = 65_536;
const SORTED_WINDOW_BYTES = 32 * 1024 * 1024;
const SORTED_READ_GAP_BYTES = 256 * 1024;
const SORTED_READ_MAX_BYTES = 8 * 1024 * 1024;
/** Plain Error messages the client maps to localized limit explanations. */
const LIMIT_ERRORS = new Set(["sort-too-large", "too-many-groups", "value-out-of-range"]);

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

/** Filtered rows in sorted order: order[i] indexes the parallel record arrays. */
interface SortedView {
  order: Uint32Array;
  starts: Float64Array;
  lengths: Uint32Array;
  rawRows: Uint32Array;
  totalBytes: number;
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
  types: CsvColumnType[];
  invalid: CsvInvalidPolicy;
  sort: CsvSort | null;
  sorted: SortedView | null;
  aggregate: CsvAggregateResult | null;
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
  afterChunk?: () => Promise<void>,
): Promise<void> {
  const parser = new CsvByteParser(encoding, delimiter, startOffset, onRecord);
  let keepGoing = true;
  for await (const chunk of readBlobChunks(file, { chunkBytes: CSV_CHUNK_BYTES, start: startOffset })) {
    keepGoing = parser.push(chunk.bytes, chunk.offset);
    onBytes?.(chunk.end);
    await afterChunk?.();
    if (!keepGoing) break;
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

/** Sort and group results depend on the filter and the column types, so both reset them. */
function clearDerivedViews(current: CsvSession): void {
  current.sort = null;
  current.sorted = null;
  current.aggregate = null;
}

/** Visit every row of the filtered view in file order with its 0-based unfiltered row number. */
async function scanView(
  id: number,
  current: CsvSession,
  onRow: (fields: readonly string[], record: CsvParsedRecord, rawRow: number) => void,
  afterChunk?: () => Promise<void>,
): Promise<void> {
  const first = current.checkpoints[0];
  if (!first) return;
  const started = performance.now();
  let rawRow = 0;
  await scanFile(current.file, current.encoding, current.delimiter, first.offset, (record) => {
    const row = rawRow++;
    if (csvRecordMatchesPrepared(record.fields, current.filter)) onRow(record.fields, record, row);
  }, (processed) => progress(id, processed, current.file.size, started), afterChunk);
}

/** Scratch field buffer shared by the synchronous single-record parses of sorted reads. */
const recordFieldBuffer = new Uint8Array(CSV_MAX_FIELD_BYTES);

/** Parse one complete record from its bytes; absoluteStart keeps parser offsets exact. */
function parseRecordBytes(current: CsvSession, bytes: Uint8Array, absoluteStart: number): readonly string[] {
  let fields: readonly string[] = [];
  const parser = new CsvByteParser(current.encoding, current.delimiter, absoluteStart, (record) => {
    fields = record.fields;
    return false;
  }, recordFieldBuffer);
  if (parser.push(bytes, absoluteStart)) parser.finish(absoluteStart + bytes.length);
  return fields;
}

/**
 * Read sorted positions [from, to) as one window: records are fetched in file order with
 * nearby ranges coalesced into large slices, copied into one buffer, then parsed and emitted
 * in sorted order. One Blob read per record would be far slower than these batched reads.
 */
async function readSortedWindow(
  current: CsvSession,
  view: SortedView,
  from: number,
  to: number,
  onRow: (fields: readonly string[], rawRow: number, bytes: number) => void,
): Promise<void> {
  const count = to - from;
  const positions = view.order.subarray(from, to);
  const offsets = new Float64Array(count + 1);
  for (let index = 0; index < count; index++) offsets[index + 1] = offsets[index] + view.lengths[positions[index]];
  const buffer = new Uint8Array(offsets[count]);
  const byStart = new Uint32Array(count);
  for (let index = 0; index < count; index++) byStart[index] = index;
  byStart.sort((left, right) => view.starts[positions[left]] - view.starts[positions[right]]);

  for (let first = 0; first < count;) {
    const rangeStart = view.starts[positions[byStart[first]]];
    let rangeEnd = rangeStart + view.lengths[positions[byStart[first]]];
    let last = first + 1;
    while (last < count) {
      const start = view.starts[positions[byStart[last]]];
      const end = start + view.lengths[positions[byStart[last]]];
      if (start - rangeEnd > SORTED_READ_GAP_BYTES || end - rangeStart > SORTED_READ_MAX_BYTES) break;
      rangeEnd = Math.max(rangeEnd, end);
      last++;
    }
    const chunk = new Uint8Array(await current.file.slice(rangeStart, rangeEnd).arrayBuffer());
    for (let index = first; index < last; index++) {
      const slot = byStart[index];
      const position = positions[slot];
      const local = view.starts[position] - rangeStart;
      buffer.set(chunk.subarray(local, local + view.lengths[position]), offsets[slot]);
    }
    first = last;
  }

  for (let index = 0; index < count; index++) {
    const position = positions[index];
    const fields = parseRecordBytes(current, buffer.subarray(offsets[index], offsets[index + 1]), view.starts[position]);
    onRow(fields, view.rawRows[position], view.lengths[position]);
  }
}

/** Visit sorted positions [from, to) in order, in windows bounded by rows and bytes. */
async function forEachSorted(
  current: CsvSession,
  view: SortedView,
  from: number,
  to: number,
  onRow: (fields: readonly string[], rawRow: number, bytes: number) => void,
  afterWindow?: () => Promise<void>,
): Promise<void> {
  for (let windowStart = from; windowStart < to;) {
    let windowEnd = windowStart;
    let bytes = 0;
    while (windowEnd < to && windowEnd - windowStart < SORTED_WINDOW_ROWS
      && (windowEnd === windowStart || bytes + view.lengths[view.order[windowEnd]] <= SORTED_WINDOW_BYTES)) {
      bytes += view.lengths[view.order[windowEnd]];
      windowEnd++;
    }
    await readSortedWindow(current, view, windowStart, windowEnd, onRow);
    await afterWindow?.();
    windowStart = windowEnd;
  }
}

function validateColumn(current: CsvSession, column: number | null): void {
  if (column !== null) validateColumns(current, [column]);
}

function setTypes(current: CsvSession, types: readonly CsvColumnType[], invalid: CsvInvalidPolicy): CsvExplorerSuccess {
  if (types.length !== current.columns.length || !types.every(isCsvColumnType) || (invalid !== "error" && invalid !== "null")) {
    throw new CsvParserError("too-many-columns", "Invalid column types");
  }
  current.types = [...types];
  current.invalid = invalid;
  clearDerivedViews(current);
  return { kind: "types", sessionId: current.id };
}

/** Suggest a type per column from the first rows of the file, ignoring the filter. */
async function detectTypes(current: CsvSession): Promise<CsvExplorerSuccess> {
  const samples: string[][] = current.columns.map(() => []);
  const first = current.checkpoints[0];
  if (first) {
    let rows = 0;
    await scanFile(current.file, current.encoding, current.delimiter, first.offset, (record) => {
      for (let column = 0; column < samples.length; column++) samples[column].push(record.fields[column] ?? "");
      return ++rows < CSV_TYPE_SAMPLE_ROWS;
    });
  }
  return { kind: "detect", sessionId: current.id, types: samples.map(detectCsvColumnType) };
}

/**
 * Build a sorted view of the filtered rows by one typed column. Keys and record ranges for at
 * most CSV_SORT_MAX_ROWS rows are held in typed arrays; nulls sort last in both directions and
 * equal keys keep file order.
 */
async function sortSession(id: number, current: CsvSession, sort: CsvSort | null): Promise<CsvExplorerSuccess> {
  current.sort = null;
  current.sorted = null;
  if (!sort) return { kind: "sort", sessionId: current.id, sorted: false };
  validateColumn(current, sort.column);
  if (sort.direction !== "asc" && sort.direction !== "desc") throw new CsvParserError("too-many-columns", "Invalid sort direction");
  const count = current.rowCount;
  if (count > CSV_SORT_MAX_ROWS) throw new Error("sort-too-large");
  const type = current.types[sort.column];
  const starts = new Float64Array(count);
  const lengths = new Uint32Array(count);
  const rawRows = new Uint32Array(count);
  const nulls = new Uint8Array(count);
  const text: (string | null)[] = type === "text" ? new Array<string | null>(count) : [];
  const integers = type === "integer" ? new BigInt64Array(count) : null;
  const numbers = type === "number" || type === "boolean" ? new Float64Array(count) : null;
  let index = 0;
  let keyChars = 0;
  let totalBytes = 0;

  await scanView(id, current, (fields, record, rawRow) => {
    if (index >= count) return;
    starts[index] = record.start;
    lengths[index] = record.end - record.start;
    rawRows[index] = rawRow;
    totalBytes += record.end - record.start;
    const value = convertCsvCellOrThrow(fields[sort.column] ?? "", type, current.invalid, sort.column, rawRow);
    if (value === null) nulls[index] = 1;
    else if (typeof value === "string") {
      keyChars += value.length;
      if (keyChars > CSV_SORT_MAX_KEY_CHARS) throw new Error("sort-too-large");
      text[index] = value;
    } else if (typeof value === "bigint") integers![index] = value;
    else numbers![index] = typeof value === "boolean" ? Number(value) : value;
    index++;
  });

  const direction = sort.direction === "desc" ? -1 : 1;
  const order = new Uint32Array(index);
  for (let position = 0; position < index; position++) order[position] = position;
  order.sort((left, right) => {
    const leftNull = nulls[left];
    const rightNull = nulls[right];
    if (leftNull || rightNull) return leftNull === rightNull ? left - right : leftNull ? 1 : -1;
    let comparison: number;
    if (integers) comparison = integers[left] < integers[right] ? -1 : integers[left] > integers[right] ? 1 : 0;
    else if (numbers) comparison = numbers[left] - numbers[right];
    else comparison = compareCsvTypedValues(text[left]!, text[right]!);
    return comparison !== 0 ? comparison * direction : left - right;
  });
  current.sort = { ...sort };
  current.sorted = { order, starts, lengths, rawRows, totalBytes };
  return { kind: "sort", sessionId: current.id, sorted: true };
}

async function aggregateSession(id: number, current: CsvSession, request: Extract<CsvExplorerRequest, { type: "aggregate" }>["request"]): Promise<CsvExplorerSuccess> {
  const { groupColumn, valueColumn } = request;
  validateColumn(current, groupColumn);
  validateColumn(current, valueColumn);
  if (request.order !== "key" && request.order !== "count") throw new CsvParserError("too-many-columns", "Invalid group order");
  current.aggregate = null;
  const groupType = groupColumn === null ? "text" : current.types[groupColumn];
  const valueType = valueColumn === null ? "text" : current.types[valueColumn];
  const aggregator = new CsvAggregator({ groupColumn, valueColumn, order: request.order }, groupType, valueType);
  await scanView(id, current, (fields, _record, rawRow) => {
    const group = groupColumn === null ? null : convertCsvCellOrThrow(fields[groupColumn] ?? "", groupType, current.invalid, groupColumn, rawRow);
    const value = valueColumn === null ? null : convertCsvCellOrThrow(fields[valueColumn] ?? "", valueType, current.invalid, valueColumn, rawRow);
    aggregator.add(group, value);
  });
  const label = (column: number | null) => column === null ? null : current.columns[column].label;
  const result = aggregator.finish(label(groupColumn), label(valueColumn));
  current.aggregate = result;
  return { kind: "aggregate", sessionId: current.id, columns: result.columns, groupCount: result.groupCount, inputRows: result.inputRows };
}

function readGroups(current: CsvSession, start: number, count: number): CsvExplorerSuccess {
  if (!current.aggregate) throw new CsvParserError("session-missing", "No group result");
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(count) || count < 0 || count > CSV_MAX_RANGE_ROWS) {
    throw new CsvParserError("record-too-large", "The requested table range is invalid");
  }
  const rows = current.aggregate.rows.slice(start, start + count)
    .map((row) => row.map((value) => value === null ? null : tableCellPreview(csvTypedText(value))));
  return { kind: "read-groups", sessionId: current.id, start, rows };
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
    types: columns.map(() => "text"),
    invalid: "error",
    sort: null,
    sorted: null,
    aggregate: null,
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
  clearDerivedViews(current);
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
  const project = (fields: readonly string[]) => columns.map((column) => {
    const value = fields[column] ?? "";
    return truncateCells ? tableCellPreview(value) : value;
  });
  if (current.sorted) {
    const rows: string[][] = [];
    await forEachSorted(current, current.sorted, start, Math.min(current.rowCount, start + count), (fields) => { rows.push(project(fields)); });
    return rows;
  }
  const checkpoints = current.filter ? current.filterCheckpoints : current.checkpoints;
  if (checkpoints.length === 0) return [];
  const checkpoint = nearestCheckpoint(checkpoints, start);
  let viewIndex = checkpoint.row;
  const rows: string[][] = [];
  await scanFile(current.file, current.encoding, current.delimiter, checkpoint.offset, (record) => {
    if (!csvRecordMatchesPrepared(record.fields, current.filter)) return;
    if (viewIndex >= start) rows.push(project(record.fields));
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

/** Unique non-empty Parquet/JSON field names; group results may repeat a column label. */
function uniqueNames(labels: readonly string[]): string[] {
  const used = new Set<string>();
  return labels.map((label) => {
    let name = label;
    for (let suffix = 2; used.has(name); suffix++) name = `${label} (${suffix})`;
    used.add(name);
    return name;
  });
}

/**
 * Stream the filtered (and sorted) rows or the group result as CSV, JSONL or Parquet. Typed
 * columns are converted: CSV gets canonical text, JSONL JSON numbers/booleans/null, Parquet
 * INT64/DOUBLE/BOOLEAN/STRING columns. Text columns keep the original cell exactly.
 */
async function exportRows(
  id: number,
  current: CsvSession,
  request: Extract<CsvExplorerRequest, { type: "export" }>,
): Promise<CsvExplorerSuccess> {
  const groups = request.source === "groups";
  if (groups && !current.aggregate) throw new CsvParserError("session-missing", "No group result");
  if (!groups) validateColumns(current, request.columns);
  const labels = uniqueNames(groups ? current.aggregate!.columns : request.columns.map((column) => current.columns[column].label));
  const types: CsvColumnType[] = groups ? current.aggregate!.types : request.columns.map((column) => current.types[column]);
  const encoder = new TextEncoder();
  const queued: Uint8Array[] = [];
  const writer = createWorkerByteWriter(request.stream);
  let pending = request.format === "csv" && request.bom ? "\ufeff" : "";
  let exportedRows = 0;

  const flush = () => {
    if (pending.length === 0) return;
    queued.push(encoder.encode(pending));
    pending = "";
  };
  const drain = async () => {
    flush();
    for (const bytes of queued) await writer.write(bytes);
    queued.length = 0;
  };
  const append = (value: string) => {
    pending += value;
    if (pending.length >= EXPORT_PART_CHARS) flush();
  };
  const parquet = request.format === "parquet"
    ? createCsvParquetStream(labels.map((name, index) => ({ name, type: types[index] })), (bytes) => writer.write(bytes))
    : null;

  const emit = (values: readonly CsvTypedValue[]) => {
    exportedRows++;
    if (parquet) {
      parquet.add(values);
      return;
    }
    if (request.format === "csv") {
      const cells = values.map((value, index) => types[index] === "text"
        ? encodeCsvRow([csvTypedText(value)], request.protectFormulas)
        : encodeCsvRow([csvTypedText(value)], false));
      append(`${cells.join(",")}\r\n`);
    } else {
      const properties = values.map((value, index) => `${JSON.stringify(labels[index])}:${csvTypedJson(value)}`);
      append(`{${properties.join(",")}}\n`);
    }
  };
  const settle = async () => {
    await parquet?.flushIfFull();
    await drain();
  };
  const convertRow = (fields: readonly string[], rawRow: number) => request.columns.map((column, index) =>
    convertCsvCellOrThrow(fields[column] ?? "", types[index], current.invalid, column, rawRow));

  if (request.format === "csv" && request.includeHeader) append(`${encodeCsvRow(labels, request.protectFormulas)}\r\n`);
  if (groups) {
    const rows = current.aggregate!.rows;
    for (let index = 0; index < rows.length; index++) {
      emit(rows[index]);
      if (index % 4096 === 4095) await settle();
    }
  } else if (current.sorted) {
    const sorted = current.sorted;
    const started = performance.now();
    let bytes = 0;
    await forEachSorted(current, sorted, 0, current.rowCount, (fields, rawRow, length) => {
      emit(convertRow(fields, rawRow));
      bytes += length;
    }, async () => {
      progress(id, bytes, sorted.totalBytes, started);
      await settle();
    });
  } else {
    await scanView(id, current, (fields, _record, rawRow) => emit(convertRow(fields, rawRow)), settle);
  }
  await settle();
  await parquet?.finish();
  writer.close();
  return {
    kind: "export",
    sessionId: current.id,
    extension: request.format,
    mime: CSV_EXPORT_MIME[request.format],
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
      case "types":
        result = setTypes(requireSession(request.sessionId), request.types, request.invalid);
        break;
      case "detect":
        result = await detectTypes(requireSession(request.sessionId));
        break;
      case "sort":
        result = await sortSession(id, requireSession(request.sessionId), request.sort);
        break;
      case "aggregate":
        result = await aggregateSession(id, requireSession(request.sessionId), request.request);
        break;
      case "read-groups":
        result = readGroups(requireSession(request.sessionId), request.start, request.count);
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
    if (error instanceof CsvConversionError) {
      post({ id, ok: false, code: "unknown", message: encodeCsvConversionError(error.column, error.row, error.value) });
      return;
    }
    if (error instanceof Error && LIMIT_ERRORS.has(error.message)) {
      post({ id, ok: false, code: "input-too-large", message: error.message });
      return;
    }
    const parserError = error instanceof CsvParserError ? error : null;
    if (parserError && request.type === "open") session = null;
    const limited = parserError?.code === "field-too-large"
      || parserError?.code === "record-too-large"
      || parserError?.code === "too-many-columns";
    const fallback = parserError ? (limited ? "input-too-large" : "unknown") : "worker-failed";
    const classified = classifyWorkerError(error, fallback);
    post({
      id,
      ok: false,
      code: classified.code,
      message: parserError?.code ?? classified.message,
    });
  }
}

let queue = Promise.resolve();
self.addEventListener("message", (event: MessageEvent<CsvExplorerRequest & { id: number }>) => {
  const { id, ...request } = event.data;
  queue = queue.then(() => handle(id, request as CsvExplorerRequest));
});

export {};
