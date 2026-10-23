/**
 * Filters, row selections and full scans for the Parquet explorer.
 *
 * A scan walks the file row group by row group with hyparquet's lazy column
 * reader. Groups that carry an offset index are read in bounded windows; groups
 * without one are decoded once per group, because a sub-range read would decode
 * the whole column chunk again for every window. A filter result is a bitset
 * plus per-block counts, so it costs one bit per row whatever the match count.
 */
import { parquetScan, type AsyncBuffer, type FileMetaData } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { compareCsvDecimals, normalizeCsvDecimal, type NormalizedCsvDecimal } from "./csv-explorer.ts";
import { CsvAggregator, type CsvAggregateResult, type CsvColumnType, type CsvGroupOrder, type CsvTypedValue } from "./csv-explorer-types.ts";
import { PARQUET_MAX_CELL_CHARS, ParquetExplorerError, formatParquetCell } from "./parquet-explorer.ts";

/** How filters compare and aggregates sum a column, derived from its Parquet type. */
export type ParquetColumnKind = "integer" | "number" | "boolean" | "time" | "text";

export type ParquetFilterOperator =
  | "contains" | "not-contains" | "equals" | "not-equals"
  | "gt" | "gte" | "lt" | "lte" | "empty" | "not-empty";

export interface ParquetCondition {
  column: number;
  operator: ParquetFilterOperator;
  value: string;
}

/** All conditions must match (AND). Text comparisons fold case unless caseSensitive. */
export interface ParquetFilter {
  conditions: ParquetCondition[];
  caseSensitive: boolean;
}

export interface ParquetQueryColumn {
  name: string;
  label: string;
  kind: ParquetColumnKind;
}

const utf8Decoder = new TextDecoder();

/**
 * hyparquet string parser with an ASCII fast path. TextDecoder has a high fixed cost per call,
 * which dominated scans of short text cells in Chromium workers (about 6x slower than this loop).
 */
export const PARQUET_PARSERS = {
  stringFromBytes(bytes: Uint8Array): string {
    if (!bytes) return bytes;
    const length = bytes.length;
    if (length > 64) return utf8Decoder.decode(bytes);
    let text = "";
    for (let index = 0; index < length; index++) {
      const byte = bytes[index];
      if (byte > 0x7f) return utf8Decoder.decode(bytes);
      text += String.fromCharCode(byte);
    }
    return text;
  },
};

export const PARQUET_SCAN_WINDOW_ROWS = 65_536;
export const PARQUET_MAX_CONDITIONS = 8;
const SELECTION_BLOCK_ROWS = 4096;
const OPERATORS = new Set<ParquetFilterOperator>(["contains", "not-contains", "equals", "not-equals", "gt", "gte", "lt", "lte", "empty", "not-empty"]);
const TRUE_WORDS = new Set(["true", "yes", "1"]);
const FALSE_WORDS = new Set(["false", "no", "0"]);

/** Column kind from the physical type and the logical or converted type. */
export function parquetColumnKind(physical: string | undefined, logical: string | undefined): ParquetColumnKind {
  if (logical === "DECIMAL") return "number";
  if (logical === "DATE" || logical === "TIMESTAMP" || logical?.startsWith("TIMESTAMP_") || physical === "INT96") return "time";
  if (logical && /^(?:TIME|TIME_MILLIS|TIME_MICROS|STRING|UTF8|ENUM|JSON|BSON|UUID|INTERVAL)$/u.test(logical)) return "text";
  if (physical === "INT32" || physical === "INT64") return "integer";
  if (physical === "FLOAT" || physical === "DOUBLE" || logical === "FLOAT16") return "number";
  if (physical === "BOOLEAN") return "boolean";
  return "text";
}

/** Full cell text for contains/equals on text, timestamps and nested values. */
function cellText(value: unknown): string {
  return typeof value === "string" ? value : formatParquetCell(value, PARQUET_MAX_CELL_CHARS).text;
}

function timeValue(value: unknown): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "number" || typeof value === "bigint") return Number(value);
  return null;
}

type Predicate = (value: unknown) => boolean;

function comparisonMatches(operator: ParquetFilterOperator, order: number): boolean {
  switch (operator) {
    case "equals": return order === 0;
    case "not-equals": return order !== 0;
    case "gt": return order > 0;
    case "gte": return order >= 0;
    case "lt": return order < 0;
    case "lte": return order <= 0;
    default: return false;
  }
}

function invalidValue(condition: ParquetCondition): never {
  throw new ParquetExplorerError("filter-value", String(condition.column));
}

function exactNumber(value: unknown): NormalizedCsvDecimal | null {
  if (typeof value === "bigint") return normalizeCsvDecimal(value.toString());
  if (typeof value === "number") return Number.isFinite(value) ? normalizeCsvDecimal(String(value)) : null;
  return null;
}

/**
 * Compile one condition for a column kind. Numbers compare exactly (64-bit integers and
 * decimals keep every digit), timestamps by instant, text by code units. A null cell matches
 * only `empty` and never a comparison, as in SQL.
 */
export function compileParquetCondition(condition: ParquetCondition, kind: ParquetColumnKind, caseSensitive: boolean): Predicate {
  const { operator } = condition;
  if (!OPERATORS.has(operator)) invalidValue(condition);
  if (operator === "empty") return (value) => value == null || value === "";
  if (operator === "not-empty") return (value) => value != null && value !== "";
  const fold = (text: string) => caseSensitive ? text : text.toLowerCase();

  if (operator === "contains" || operator === "not-contains") {
    const needle = fold(condition.value);
    const negate = operator === "not-contains";
    return (value) => value != null && fold(cellText(value)).includes(needle) !== negate;
  }

  if (kind === "integer" || kind === "number") {
    const query = normalizeCsvDecimal(condition.value);
    if (!query) invalidValue(condition);
    const trimmed = condition.value.trim();
    // Fast paths stay exact: a double compare only when the query is itself an exact double,
    // a BigInt compare only for an integer query.
    const queryDouble = Number(trimmed);
    const doubleExact = Number.isFinite(queryDouble) && compareCsvDecimals(normalizeCsvDecimal(String(queryDouble))!, query) === 0;
    const queryBigInt = /^[+-]?\d+$/u.test(trimmed) ? BigInt(trimmed) : null;
    return (value) => {
      if (value == null) return false;
      if (typeof value === "number" && doubleExact && Number.isFinite(value)) {
        return comparisonMatches(operator, value === queryDouble ? 0 : value < queryDouble ? -1 : 1);
      }
      if (typeof value === "bigint" && queryBigInt !== null) {
        return comparisonMatches(operator, value === queryBigInt ? 0 : value < queryBigInt ? -1 : 1);
      }
      const cell = exactNumber(value);
      return cell !== null && comparisonMatches(operator, compareCsvDecimals(cell, query));
    };
  }
  if (kind === "boolean") {
    const folded = condition.value.trim().toLowerCase();
    if (!TRUE_WORDS.has(folded) && !FALSE_WORDS.has(folded)) invalidValue(condition);
    const query = TRUE_WORDS.has(folded);
    return (value) => typeof value === "boolean" && comparisonMatches(operator, value === query ? 0 : value ? 1 : -1);
  }
  if (kind === "time") {
    const query = Date.parse(condition.value.trim());
    if (Number.isNaN(query)) invalidValue(condition);
    return (value) => {
      const time = timeValue(value);
      return time !== null && comparisonMatches(operator, time === query ? 0 : time < query ? -1 : 1);
    };
  }
  const query = fold(condition.value);
  return (value) => {
    if (value == null) return false;
    const text = fold(cellText(value));
    return comparisonMatches(operator, text === query ? 0 : text < query ? -1 : 1);
  };
}

/** Value as the CSV aggregator's typed value; timestamps become ISO text so min/max still order. */
export function parquetAggregateValue(value: unknown, kind: ParquetColumnKind): CsvTypedValue {
  if (value == null) return null;
  if (kind === "integer") {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  }
  if (kind === "number") {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  if (kind === "boolean" && typeof value === "boolean") return value;
  return cellText(value);
}

export function parquetAggregateType(kind: ParquetColumnKind): CsvColumnType {
  return kind === "integer" || kind === "number" || kind === "boolean" ? kind : "text";
}

/** One bit per row plus per-block prefix counts for O(log n) view-to-row lookups. */
export class ParquetRowSelection {
  readonly rows: number;
  readonly bits: Uint8Array;
  private prefix: Float64Array | null = null;

  constructor(rows: number) {
    this.rows = rows;
    this.bits = new Uint8Array(Math.ceil(rows / 8));
  }

  set(row: number): void {
    this.bits[row >>> 3] |= 1 << (row & 7);
  }

  has(row: number): boolean {
    return (this.bits[row >>> 3] & (1 << (row & 7))) !== 0;
  }

  /** Freeze the selection and build block counts; call once after the last set(). */
  finish(): number {
    const blocks = Math.ceil(this.rows / SELECTION_BLOCK_ROWS);
    const prefix = new Float64Array(blocks + 1);
    for (let block = 0; block < blocks; block++) {
      let count = 0;
      const end = Math.min(this.rows, (block + 1) * SELECTION_BLOCK_ROWS);
      for (let row = block * SELECTION_BLOCK_ROWS; row < end; row += 8) {
        let byte = this.bits[row >>> 3];
        while (byte) {
          byte &= byte - 1;
          count++;
        }
      }
      prefix[block + 1] = prefix[block] + count;
    }
    this.prefix = prefix;
    return prefix[blocks];
  }

  get count(): number {
    return this.prefix ? this.prefix[this.prefix.length - 1] : 0;
  }

  /** Whether any selected row falls in [start, end). */
  hasAny(start: number, end: number): boolean {
    const prefix = this.prefix!;
    const firstBlock = Math.floor(start / SELECTION_BLOCK_ROWS);
    const lastBlock = Math.ceil(end / SELECTION_BLOCK_ROWS);
    if (prefix[lastBlock] - prefix[firstBlock] === 0) return false;
    for (let row = start; row < end; row++) if (this.has(row)) return true;
    return false;
  }

  /** File row numbers of selected rows at view positions [start, start + count). */
  rowsForView(start: number, count: number): number[] {
    const prefix = this.prefix!;
    const result: number[] = [];
    if (start >= this.count) return result;
    let low = 0;
    let high = prefix.length - 2;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (prefix[middle] <= start) low = middle;
      else high = middle - 1;
    }
    let seen = prefix[low];
    for (let row = low * SELECTION_BLOCK_ROWS; row < this.rows && result.length < count; row++) {
      if (row % SELECTION_BLOCK_ROWS === 0 && prefix[row / SELECTION_BLOCK_ROWS + 1] === seen) {
        row += SELECTION_BLOCK_ROWS - 1;
        continue;
      }
      if (!this.has(row)) continue;
      if (seen >= start) result.push(row);
      seen++;
    }
    return result;
  }
}

interface ScanGroup {
  start: number;
  end: number;
  /** Rows per read: a window when every needed column has an offset index, else the group. */
  step: number;
}

function scanGroups(metadata: FileMetaData, names: readonly string[], windowRows: number): ScanGroup[] {
  const wanted = new Set(names);
  const groups: ScanGroup[] = [];
  let start = 0;
  for (const group of metadata.row_groups) {
    const rows = Number(group.num_rows);
    const indexed = group.columns.every((chunk) => {
      const top = chunk.meta_data?.path_in_schema[0];
      return top === undefined || !wanted.has(top) || (!!chunk.offset_index_offset && !!chunk.offset_index_length);
    });
    if (rows > 0) groups.push({ start, end: start + rows, step: indexed ? windowRows : rows });
    start += rows;
  }
  return groups;
}

export interface ParquetScanSource {
  file: AsyncBuffer;
  metadata: FileMetaData;
}

/**
 * Decode `names` window by window and hand each window's columns to `onWindow`, in file order.
 * `skip` lets a filtered scan avoid reading windows without selected rows.
 */
export async function forEachParquetWindow(
  source: ParquetScanSource,
  names: readonly string[],
  onWindow: (start: number, end: number, columns: ArrayLike<unknown>[]) => void | Promise<void>,
  options: { skip?: (start: number, end: number) => boolean; windowRows?: number } = {},
): Promise<void> {
  const unique = [...new Set(names)];
  const scan = await parquetScan({ file: source.file, metadata: source.metadata, columns: unique, compressors, parsers: PARQUET_PARSERS, utf8: false });
  for (const group of scanGroups(source.metadata, unique, options.windowRows ?? PARQUET_SCAN_WINDOW_ROWS)) {
    for (let start = group.start; start < group.end; start += group.step) {
      const end = Math.min(group.end, start + group.step);
      if (options.skip?.(start, end)) continue;
      const decoded = new Map<string, ArrayLike<unknown>>();
      for (const name of unique) decoded.set(name, await scan.readColumn({ column: name, rowStart: start, rowEnd: end }) as ArrayLike<unknown>);
      await onWindow(start, end, names.map((name) => decoded.get(name)!));
    }
  }
}

/** Evaluate a filter over the whole file into a row selection. */
export async function buildParquetSelection(
  source: ParquetScanSource,
  columns: readonly ParquetQueryColumn[],
  filter: ParquetFilter,
  onProgress?: (processed: number, total: number) => void,
): Promise<ParquetRowSelection> {
  if (filter.conditions.length === 0 || filter.conditions.length > PARQUET_MAX_CONDITIONS) {
    throw new ParquetExplorerError("invalid", "Invalid number of conditions");
  }
  for (const condition of filter.conditions) {
    if (!columns[condition.column]) throw new ParquetExplorerError("invalid", "Unknown filter column");
  }
  const predicates = filter.conditions.map((condition) =>
    compileParquetCondition(condition, columns[condition.column].kind, filter.caseSensitive));
  const total = Number(source.metadata.num_rows);
  const selection = new ParquetRowSelection(total);
  const names = filter.conditions.map((condition) => columns[condition.column].name);
  onProgress?.(0, total);
  await forEachParquetWindow(source, names, (start, end, data) => {
    for (let row = start; row < end; row++) {
      let matches = true;
      for (let index = 0; index < predicates.length && matches; index++) matches = predicates[index](data[index][row - start]);
      if (matches) selection.set(row);
    }
    onProgress?.(end, total);
  });
  selection.finish();
  return selection;
}

export interface ParquetAggregateRequest {
  groupColumn: number | null;
  valueColumn: number | null;
  order: CsvGroupOrder;
}

/** Group the selected (or all) rows by one column and summarize another. */
export async function aggregateParquet(
  source: ParquetScanSource,
  columns: readonly ParquetQueryColumn[],
  selection: ParquetRowSelection | null,
  request: ParquetAggregateRequest,
  onProgress?: (processed: number, total: number) => void,
): Promise<CsvAggregateResult> {
  const { groupColumn, valueColumn } = request;
  for (const column of [groupColumn, valueColumn]) {
    if (column !== null && !columns[column]) throw new ParquetExplorerError("invalid", "Unknown group column");
  }
  if (request.order !== "key" && request.order !== "count") throw new ParquetExplorerError("invalid", "Invalid group order");
  const groupKind = groupColumn === null ? "text" : columns[groupColumn].kind;
  const valueKind = valueColumn === null ? "text" : columns[valueColumn].kind;
  const aggregator = new CsvAggregator({ groupColumn, valueColumn, order: request.order }, parquetAggregateType(groupKind), parquetAggregateType(valueKind));
  const total = Number(source.metadata.num_rows);
  const names = [groupColumn, valueColumn].filter((column): column is number => column !== null).map((column) => columns[column].name);
  const groupIndex = groupColumn === null ? -1 : 0;
  const valueIndex = valueColumn === null ? -1 : groupColumn === null ? 0 : 1;

  const addRow = (data: ArrayLike<unknown>[], offset: number) => {
    const group = groupIndex < 0 ? null : parquetAggregateValue(data[groupIndex][offset], groupKind);
    const value = valueIndex < 0 ? null : parquetAggregateValue(data[valueIndex][offset], valueKind);
    aggregator.add(group, value);
  };
  if (names.length === 0) {
    const count = selection ? selection.count : total;
    for (let row = 0; row < count; row++) aggregator.add(null, null);
  } else {
    await forEachParquetWindow(source, names, (start, end, data) => {
      for (let row = start; row < end; row++) {
        if (!selection || selection.has(row)) addRow(data, row - start);
      }
      onProgress?.(end, total);
    }, { skip: selection ? (start, end) => !selection.hasAny(start, end) : undefined });
  }
  const label = (column: number | null) => column === null ? null : columns[column].label;
  return aggregator.finish(label(groupColumn), label(valueColumn));
}
