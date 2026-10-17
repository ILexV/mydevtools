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
  parquetReadObjects,
  parquetSchema,
  type AsyncBuffer,
  type SchemaElement,
} from "hyparquet";
import { compressors } from "hyparquet-compressors";
import {
  PARQUET_EXPORT_WINDOW,
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

export interface ParquetColumn {
  index: number;
  /** Name stored in the file. hyparquet selects columns by this name. */
  name: string;
  /** Unique label for the table header and for JSONL keys. */
  label: string;
  typeLabel: string;
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

/**
 * Read the Parquet footer: schema, row-group sizes and codecs, file metadata.
 * Column pages are not decoded.
 */
export async function openParquet(file: AsyncBuffer): Promise<ParquetFileSummary> {
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
  return {
    rows: asCount(metadata.num_rows, "row count"),
    columns: fields.map((field, index) => ({
      index,
      name: names[index],
      label: labels[index],
      typeLabel: parquetTypeLabel(fieldType(field.element)),
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
}

function selectedColumns(summary: ParquetFileSummary, indexes: readonly number[]): ParquetFileSummary["columns"] {
  const columns = indexes.map((index) => summary.columns[index]);
  if (indexes.length === 0 || columns.some((column) => !column) || new Set(indexes).size !== indexes.length) {
    throw new ParquetExplorerError("invalid", "Select at least one valid column");
  }
  return columns;
}

async function readValues(
  file: AsyncBuffer,
  names: readonly string[],
  start: number,
  count: number,
): Promise<unknown[][]> {
  if (count === 0) return [];
  let rows;
  try {
    rows = await parquetReadObjects({
      file,
      columns: [...names],
      rowStart: start,
      rowEnd: start + count,
      compressors,
      // Plain BYTE_ARRAY stays bytes so binary cells can be shown as hex.
      // STRING / UTF8 columns still decode to text.
      utf8: false,
    });
  } catch (error) {
    wrapReadError(error);
  }
  return rows.map((row) => names.map((name) => row[name]));
}

/** Decode one window of selected columns into clipped table cells. */
export async function readParquetRows(
  file: AsyncBuffer,
  summary: ParquetFileSummary,
  start: number,
  count: number,
  columnIndexes: readonly number[],
  maxChars: number,
): Promise<string[][]> {
  if (start < 0 || count < 0 || count > PARQUET_MAX_READ_ROWS || start > summary.rows) {
    throw new ParquetExplorerError("invalid", "The requested row window is outside the file");
  }
  const columns = selectedColumns(summary, columnIndexes);
  const end = Math.min(count, summary.rows - start);
  const values = await readValues(file, columns.map((column) => column.name), start, end);
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
): Promise<ParquetStreamExportResult> {
  const columns = selectedColumns(summary, options.columns);
  const names = columns.map((column) => column.name);
  const labels = columns.map((column) => column.label);
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
  onProgress?.(0, summary.rows);
  while (exported < summary.rows) {
    const count = Math.min(PARQUET_EXPORT_WINDOW, summary.rows - exported);
    const values = await readValues(file, names, exported, count);
    if (values.length === 0) break;
    for (const row of values) {
      for (const value of row) assertExportableValue(value);
      if (options.format === "csv") {
        const cells = row.map((value) => formatParquetCell(value, PARQUET_MAX_CELL_CHARS));
        if (cells.some((cell) => cell.truncated)) {
          throw new ParquetExplorerError("cell-too-large", "A value exceeds the 1 MiB cell limit");
        }
        append(buildCsvLine(cells.map((cell) => cell.text), options.protectFormulas));
      } else {
        append(buildJsonlLine(labels, row));
      }
      if (pending.length >= PARQUET_EXPORT_CHUNK_CHARS) await flush();
    }
    exported += values.length;
    onProgress?.(exported, summary.rows);
  }
  await flush();
  return { rowCount: exported, bytesWritten };
}

/** Collect a bounded export for non-streaming callers. */
export async function exportParquet(
  file: AsyncBuffer,
  summary: ParquetFileSummary,
  options: ParquetExportOptions,
  onProgress?: (processed: number, total: number) => void,
): Promise<ParquetExportResult> {
  const maxBytes = options.maxBytes ?? PARQUET_MAX_EXPORT_BYTES;
  const parts: Uint8Array[] = [];
  const result = await exportParquetStream(
    file,
    summary,
    { ...options, maxBytes },
    async (bytes) => { parts.push(bytes); },
    onProgress,
  );
  const bytes = new Uint8Array(result.bytesWritten);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { bytes, rowCount: result.rowCount };
}
