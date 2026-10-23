/**
 * Read a local Parquet file by footer and by column window.
 *
 * hyparquet slices the file instead of loading every row group. Compression
 * beyond Snappy (gzip, brotli, zstd, lz4, lz4_raw) comes from
 * hyparquet-compressors. LZO is not registered and fails as an unsupported codec.
 * Callers project columns by name so unread columns stay on disk.
 */
import {
  parquetMetadataAsync,
  parquetScan,
  parquetSchema,
  type AsyncBuffer,
  type FileMetaData,
  type ParquetScan,
  type SchemaElement,
} from "hyparquet";
import { compressors } from "hyparquet-compressors";
import {
  PARQUET_MAX_CELL_CHARS,
  PARQUET_MAX_COLUMNS,
  PARQUET_MAX_EXPORT_BYTES,
  PARQUET_MAX_LISTED_ROW_GROUPS,
  PARQUET_MAX_METADATA_PAIRS,
  PARQUET_MAX_READ_ROWS,
  ParquetExplorerError,
  assertExportableValue,
  buildCsvLine,
  buildJsonlLine,
  formatParquetCell,
  hasParquetMagic,
  parquetTypeLabel,
  uniqueColumnLabels,
  type ParquetFieldType,
} from "./parquet-explorer.ts";
import { PARQUET_PARSERS, forEachParquetWindow, parquetColumnKind, type ParquetColumnKind, type ParquetRowSelection } from "./parquet-explorer-query.ts";
import { csvTypedJson, csvTypedText, type CsvAggregateResult } from "./csv-explorer-types.ts";
import { encodeCsvRow } from "./explorer-delimited.ts";

export interface ParquetColumn {
  index: number;
  /** Name stored in the file. hyparquet selects columns by this name. */
  name: string;
  /** Unique label for the table header and for JSONL keys. */
  label: string;
  typeLabel: string;
  /** Comparison and aggregation kind for filters and group summaries. */
  kind: ParquetColumnKind;
  repetition: string;
  codecs: string[];
}

export interface ParquetRowGroup {
  index: number;
  rows: number;
  byteSize: number;
  compressedSize: number;
  codecs: string[];
}

export interface ParquetKeyValue {
  key: string;
  value: string;
}

export interface ParquetFileSummary {
  rows: number;
  columns: ParquetColumn[];
  rowGroupCount: number;
  rowGroupBytes: number;
  rowGroups: ParquetRowGroup[];
  rowGroupsTruncated: boolean;
  createdBy: string | null;
  version: number;
  duplicateColumnCount: number;
  fileSize: number;
  metadata: ParquetKeyValue[];
  metadataTruncated: boolean;
}

export interface ParquetExportOptions {
  /** Rows of the current (filtered) view, or the group summary. */
  source?: "rows" | "groups";
  columns: number[];
  format: "csv" | "jsonl";
  includeHeader: boolean;
  protectFormulas: boolean;
  bom: boolean;
  maxBytes?: number;
}

export interface ParquetExportResult {
  bytes: Uint8Array;
  rowCount: number;
}

export interface ParquetStreamExportResult {
  rowCount: number;
  bytesWritten: number;
}

/** Blob or ArrayBuffer slice source. A browser `File` is wrapped by the worker. */
export function asyncBufferFromBlob(blob: Blob): AsyncBuffer {
  return {
    byteLength: blob.size,
    slice(start: number, end?: number) {
      const from = Math.max(0, start);
      const to = end === undefined ? blob.size : end;
      return blob.slice(from, to).arrayBuffer();
    },
  };
}

function asCount(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ParquetExplorerError("invalid", `${label} is outside the safe integer range`);
  }
  return Number(value);
}

function fieldType(element: SchemaElement): ParquetFieldType {
  const logical = element.logical_type;
  return {
    physical: element.type,
    logical: logical?.type ?? element.converted_type,
    precision: logical?.type === "DECIMAL" ? logical.precision : element.precision,
    scale: logical?.type === "DECIMAL" ? logical.scale : element.scale,
    bitWidth: logical?.type === "INTEGER" ? logical.bitWidth : undefined,
    signed: logical?.type === "INTEGER" ? logical.isSigned : undefined,
  };
}

function clipMeta(value: string | undefined): string {
  if (!value) return "";
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}

async function readMagic(file: AsyncBuffer): Promise<void> {
  if (file.byteLength === 0) throw new ParquetExplorerError("empty", "The file is empty");
  if (file.byteLength < 12) throw new ParquetExplorerError("invalid", "The file is not Parquet");
  const head = new Uint8Array(await file.slice(0, 4));
  const tail = new Uint8Array(await file.slice(file.byteLength - 4, file.byteLength));
  if (!hasParquetMagic(head, tail)) throw new ParquetExplorerError("invalid", "The file is not Parquet");
}

function wrapReadError(error: unknown): never {
  if (error instanceof ParquetExplorerError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (/compress|codec|snappy|gzip|zstd|brotli|lz4|lzo/i.test(message)) {
    throw new ParquetExplorerError("unsupported-codec", message);
  }
  throw new ParquetExplorerError("invalid", message || "The Parquet file could not be read");
}

/** Optional state a read or export shares with the worker session. */
export interface ParquetReadContext {
  metadata?: FileMetaData;
  selection?: ParquetRowSelection | null;
  reader?: ParquetViewReader;
  aggregate?: CsvAggregateResult | null;
}

/**
 * Read the Parquet footer: schema, row-group sizes and codecs, file metadata.
 * Column pages are not decoded.
 */
export async function openParquet(file: AsyncBuffer): Promise<ParquetFileSummary> {
  return (await openParquetSource(file)).summary;
}

/** Summary plus the parsed footer, which later reads reuse instead of fetching it again. */
export async function openParquetSource(file: AsyncBuffer): Promise<{ summary: ParquetFileSummary; metadata: FileMetaData }> {
  await readMagic(file);
  let metadata;
  try {
    metadata = await parquetMetadataAsync(file);
  } catch (error) {
    wrapReadError(error);
  }
  const fields = parquetSchema(metadata).children;
  if (fields.length > PARQUET_MAX_COLUMNS) {
    throw new ParquetExplorerError("too-many-columns", "The file has more than 512 columns");
  }
  const names = fields.map((field) => field.element.name);
  const { labels, duplicateCount } = uniqueColumnLabels(names);
  const codecsByColumn = names.map(() => new Set<string>());
  const rowGroups: ParquetRowGroup[] = [];
  let rowGroupBytes = 0;
  for (let index = 0; index < metadata.row_groups.length; index++) {
    const group = metadata.row_groups[index];
    const codecs = new Set<string>();
    for (const column of group.columns) {
      const codec = column.meta_data?.codec;
      if (!codec) continue;
      codecs.add(codec);
      const top = column.meta_data?.path_in_schema[0];
      const columnIndex = top === undefined ? -1 : names.indexOf(top);
      if (columnIndex >= 0) codecsByColumn[columnIndex].add(codec);
    }
    const byteSize = asCount(group.total_byte_size, "row group size");
    const compressedSize = group.total_compressed_size === undefined
      ? byteSize
      : asCount(group.total_compressed_size, "compressed row group size");
    rowGroupBytes += byteSize;
    if (rowGroups.length < PARQUET_MAX_LISTED_ROW_GROUPS) {
      rowGroups.push({
        index,
        rows: asCount(group.num_rows, "row group row count"),
        byteSize,
        compressedSize,
        codecs: [...codecs],
      });
    }
  }
  const pairs = metadata.key_value_metadata ?? [];
  const summary: ParquetFileSummary = {
    rows: asCount(metadata.num_rows, "row count"),
    columns: fields.map((field, index) => ({
      index,
      name: names[index],
      label: labels[index],
      typeLabel: parquetTypeLabel(fieldType(field.element)),
      kind: field.children.length > 0 ? "text" : parquetColumnKind(field.element.type, fieldType(field.element).logical),
      repetition: field.element.repetition_type ?? (field.element.type ? "REQUIRED" : "GROUP"),
      codecs: [...codecsByColumn[index]],
    })),
    rowGroupCount: metadata.row_groups.length,
    rowGroupBytes,
    rowGroups,
    rowGroupsTruncated: metadata.row_groups.length > PARQUET_MAX_LISTED_ROW_GROUPS,
    createdBy: metadata.created_by ? clipMeta(metadata.created_by) : null,
    version: metadata.version,
    duplicateColumnCount: duplicateCount,
    fileSize: file.byteLength,
    metadata: pairs.slice(0, PARQUET_MAX_METADATA_PAIRS).map((pair) => ({
      key: clipMeta(pair.key),
      value: clipMeta(pair.value),
    })),
    metadataTruncated: pairs.length > PARQUET_MAX_METADATA_PAIRS,
  };
  return { summary, metadata };
}

function selectedColumns(summary: ParquetFileSummary, indexes: readonly number[]): ParquetFileSummary["columns"] {
  const columns = indexes.map((index) => summary.columns[index]);
  if (indexes.length === 0 || columns.some((column) => !column) || new Set(indexes).size !== indexes.length) {
    throw new ParquetExplorerError("invalid", "Select at least one valid column");
  }
  return columns;
}

const VIEW_BLOCK_ROWS = 4096;

/**
 * Table and inspector reads. Rows are fetched in aligned 4,096-row blocks inside row groups
 * that have an offset index, otherwise as the whole group; hyparquet keeps the last range per
 * column, so scrolling through one group decodes its pages once instead of on every page.
 */
export class ParquetViewReader {
  private readonly file: AsyncBuffer;
  private readonly metadata: FileMetaData;
  private readonly groups: { start: number; end: number; indexed: boolean }[] = [];
  private scan: Promise<ParquetScan> | null = null;

  constructor(file: AsyncBuffer, metadata: FileMetaData) {
    this.file = file;
    this.metadata = metadata;
    let start = 0;
    for (const group of metadata.row_groups) {
      const rows = Number(group.num_rows);
      const indexed = group.columns.every((chunk) => !!chunk.offset_index_offset && !!chunk.offset_index_length);
      this.groups.push({ start, end: start + rows, indexed });
      start += rows;
    }
  }

  private rangeOf(row: number): { start: number; end: number } {
    let low = 0;
    let high = this.groups.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.groups[middle].start <= row) low = middle;
      else high = middle - 1;
    }
    const group = this.groups[low];
    if (!group.indexed) return group;
    const start = Math.max(group.start, Math.floor(row / VIEW_BLOCK_ROWS) * VIEW_BLOCK_ROWS);
    return { start, end: Math.min(group.end, start + VIEW_BLOCK_ROWS) };
  }

  /** Values of `names` for ascending file row numbers. */
  async read(rows: readonly number[], names: readonly string[]): Promise<unknown[][]> {
    this.scan ??= parquetScan({ file: this.file, metadata: this.metadata, compressors, parsers: PARQUET_PARSERS, utf8: false });
    const scan = await this.scan;
    const out: unknown[][] = rows.map(() => new Array<unknown>(names.length));
    for (let first = 0; first < rows.length;) {
      const range = this.rangeOf(rows[first]);
      let last = first;
      while (last < rows.length && rows[last] < range.end) last++;
      for (let column = 0; column < names.length; column++) {
        const data = await scan.readColumn({ column: names[column], rowStart: range.start, rowEnd: range.end }) as ArrayLike<unknown>;
        for (let index = first; index < last; index++) out[index][column] = data[rows[index] - range.start];
      }
      first = last;
    }
    return out;
  }
}

async function contextMetadata(file: AsyncBuffer, context: ParquetReadContext): Promise<FileMetaData> {
  if (context.metadata) return context.metadata;
  try {
    context.metadata = await parquetMetadataAsync(file);
  } catch (error) {
    wrapReadError(error);
  }
  return context.metadata;
}

/** Decode one window of the current view (all rows or the filter selection) into clipped cells. */
export async function readParquetRows(
  file: AsyncBuffer,
  summary: ParquetFileSummary,
  start: number,
  count: number,
  columnIndexes: readonly number[],
  maxChars: number,
  context: ParquetReadContext = {},
): Promise<string[][]> {
  const viewRows = context.selection ? context.selection.count : summary.rows;
  if (start < 0 || count < 0 || count > PARQUET_MAX_READ_ROWS || start > viewRows) {
    throw new ParquetExplorerError("invalid", "The requested row window is outside the file");
  }
  const columns = selectedColumns(summary, columnIndexes);
  const rows = context.selection
    ? context.selection.rowsForView(start, count)
    : Array.from({ length: Math.min(count, summary.rows - start) }, (_, index) => start + index);
  if (rows.length === 0) return [];
  const reader = context.reader ?? new ParquetViewReader(file, await contextMetadata(file, context));
  let values: unknown[][];
  try {
    values = await reader.read(rows, columns.map((column) => column.name));
  } catch (error) {
    wrapReadError(error);
  }
  return values.map((row) => row.map((value) => formatParquetCell(value, maxChars).text));
}

const PARQUET_EXPORT_CHUNK_CHARS = 256 * 1024;

/**
 * Project selected columns into incrementally written CSV or JSONL chunks.
 * Awaiting `write` between bounded chunks propagates destination backpressure.
 */
export async function exportParquetStream(
  file: AsyncBuffer,
  summary: ParquetFileSummary,
  options: ParquetExportOptions,
  write: (bytes: Uint8Array) => Promise<void>,
  onProgress?: (processed: number, total: number) => void,
  context: ParquetReadContext = {},
): Promise<ParquetStreamExportResult> {
  const groups = options.source === "groups";
  if (groups && !context.aggregate) throw new ParquetExplorerError("session-missing", "No group result");
  const columns = groups ? [] : selectedColumns(summary, options.columns);
  const names = columns.map((column) => column.name);
  const labels = groups ? uniqueColumnLabels(context.aggregate!.columns).labels : columns.map((column) => column.label);
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  const encoder = new TextEncoder();
  let pending = "";
  let bytesWritten = 0;
  const flush = async () => {
    if (pending.length === 0) return;
    const bytes = encoder.encode(pending);
    pending = "";
    if (bytesWritten + bytes.byteLength > maxBytes) {
      throw new ParquetExplorerError("export-too-large", "The export exceeds the configured output limit");
    }
    await write(bytes);
    bytesWritten += bytes.byteLength;
  };
  const append = (line: string) => {
    pending += line;
  };

  if (options.format === "csv" && options.bom) append("\uFEFF");
  if (options.format === "csv" && options.includeHeader) append(buildCsvLine(labels, false));
  let exported = 0;

  if (groups) {
    const types = context.aggregate!.types;
    for (const row of context.aggregate!.rows) {
      if (options.format === "csv") {
        append(`${row.map((value, index) => encodeCsvRow([csvTypedText(value)], types[index] === "text" && options.protectFormulas)).join(",")}\n`);
      } else {
        append(`{${row.map((value, index) => `${JSON.stringify(labels[index])}:${csvTypedJson(value)}`).join(",")}}\n`);
      }
      exported++;
      if (pending.length >= PARQUET_EXPORT_CHUNK_CHARS) await flush();
    }
    await flush();
    return { rowCount: exported, bytesWritten };
  }

  const selection = context.selection ?? null;
  const total = summary.rows;
  onProgress?.(0, total);
  const metadata = await contextMetadata(file, context);
  try {
    await forEachParquetWindow({ file, metadata }, names, async (start, end, data) => {
      for (let row = start; row < end; row++) {
        if (selection && !selection.has(row)) continue;
        const values = data.map((column) => column[row - start]);
        for (const value of values) assertExportableValue(value);
        if (options.format === "csv") {
          const cells = values.map((value) => formatParquetCell(value, PARQUET_MAX_CELL_CHARS));
          if (cells.some((cell) => cell.truncated)) {
            throw new ParquetExplorerError("cell-too-large", "A value exceeds the 1 MiB cell limit");
          }
          append(buildCsvLine(cells.map((cell) => cell.text), options.protectFormulas));
        } else {
          append(buildJsonlLine(labels, values));
        }
        exported++;
        if (pending.length >= PARQUET_EXPORT_CHUNK_CHARS) await flush();
      }
      onProgress?.(end, total);
    }, { skip: selection ? (start, end) => !selection.hasAny(start, end) : undefined });
  } catch (error) {
    wrapReadError(error);
  }
  await flush();
  onProgress?.(total, total);
  return { rowCount: exported, bytesWritten };
}

/** Collect a bounded export for non-streaming callers. */
export async function exportParquet(
  file: AsyncBuffer,
  summary: ParquetFileSummary,
  options: ParquetExportOptions,
  onProgress?: (processed: number, total: number) => void,
  context: ParquetReadContext = {},
): Promise<ParquetExportResult> {
  const maxBytes = options.maxBytes ?? PARQUET_MAX_EXPORT_BYTES;
  const parts: Uint8Array[] = [];
  const result = await exportParquetStream(
    file,
    summary,
    { ...options, maxBytes },
    async (bytes) => { parts.push(bytes); },
    onProgress,
    context,
  );
  const bytes = new Uint8Array(result.bytesWritten);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { bytes, rowCount: result.rowCount };
}
