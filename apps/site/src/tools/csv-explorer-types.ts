/** Column types the CSV Explorer can convert cell text into for sorting, grouping and typed export. */
export type CsvColumnType = "text" | "integer" | "number" | "boolean";
/** What a conversion does with a cell that is not valid for its column type. */
export type CsvInvalidPolicy = "error" | "null";
export type CsvTypedValue = string | bigint | number | boolean | null;

export const CSV_COLUMN_TYPES: readonly CsvColumnType[] = ["text", "integer", "number", "boolean"];
export const CSV_TYPE_SAMPLE_ROWS = 1_000;
export const CSV_SORT_MAX_ROWS = 5_000_000;
export const CSV_SORT_MAX_KEY_CHARS = 32 * 1024 * 1024;
export const CSV_MAX_GROUPS = 100_000;

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const INTEGER_PATTERN = /^[+-]?\d+$/u;
const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
const TRUE_WORDS = new Set(["true", "yes", "1"]);
const FALSE_WORDS = new Set(["false", "no", "0"]);

/** A cell that does not convert to its column type; row is 0-based in the unfiltered data. */
export class CsvConversionError extends Error {
  readonly column: number;
  readonly row: number;
  readonly value: string;

  constructor(column: number, row: number, value: string) {
    super("conversion-failed");
    this.name = "CsvConversionError";
    this.column = column;
    this.row = row;
    this.value = value;
  }
}

export function isCsvColumnType(value: unknown): value is CsvColumnType {
  return typeof value === "string" && (CSV_COLUMN_TYPES as readonly string[]).includes(value);
}

/**
 * Convert one cell. Text keeps the exact string (an empty cell stays ""); other types trim
 * surrounding whitespace, map an empty cell to null and return undefined for invalid text.
 * Integers are exact 64-bit BigInt values; numbers are finite doubles.
 */
export function convertCsvCell(text: string, type: CsvColumnType): CsvTypedValue | undefined {
  if (type === "text") return text;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  switch (type) {
    case "integer": {
      if (!INTEGER_PATTERN.test(trimmed)) return undefined;
      const value = BigInt(trimmed);
      return value < INT64_MIN || value > INT64_MAX ? undefined : value;
    }
    case "number": {
      if (!NUMBER_PATTERN.test(trimmed)) return undefined;
      const value = Number(trimmed);
      return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : undefined;
    }
    case "boolean": {
      const folded = trimmed.toLowerCase();
      if (TRUE_WORDS.has(folded)) return true;
      if (FALSE_WORDS.has(folded)) return false;
      return undefined;
    }
  }
}

/** Convert with the invalid-value policy applied; the error carries the column and row. */
export function convertCsvCellOrThrow(text: string, type: CsvColumnType, policy: CsvInvalidPolicy, column: number, row: number): CsvTypedValue {
  const value = convertCsvCell(text, type);
  if (value !== undefined) return value;
  if (policy === "null") return null;
  throw new CsvConversionError(column, row, text);
}

function hasLeadingZero(text: string): boolean {
  return /^[+-]?0\d/u.test(text);
}

/**
 * Suggest a column type from sample cells. Leading zeros keep the column as text so codes such
 * as `007` are not turned into numbers; 0/1 columns become integers, true/false/yes/no booleans.
 */
export function detectCsvColumnType(samples: readonly string[]): CsvColumnType {
  let integer = true;
  let number = true;
  let boolean = true;
  let seen = 0;
  for (const sample of samples) {
    const trimmed = sample.trim();
    if (trimmed.length === 0) continue;
    seen++;
    if (hasLeadingZero(trimmed)) return "text";
    if (integer && convertCsvCell(trimmed, "integer") === undefined) integer = false;
    if (number && convertCsvCell(trimmed, "number") === undefined) number = false;
    if (boolean && (!/^(?:true|false|yes|no)$/iu.test(trimmed))) boolean = false;
    if (!integer && !number && !boolean) return "text";
  }
  if (seen === 0) return "text";
  if (integer) return "integer";
  if (number) return "number";
  return boolean ? "boolean" : "text";
}

/** Total order for non-null typed values of one column type; text uses code-unit order. */
export function compareCsvTypedValues(left: Exclude<CsvTypedValue, null>, right: Exclude<CsvTypedValue, null>): number {
  if (left === right) return 0;
  if (typeof left === "boolean") return left ? 1 : -1;
  return left < right ? -1 : 1;
}

/** Canonical text of a typed value for CSV cells, table previews and group keys. */
export function csvTypedText(value: CsvTypedValue): string {
  if (value === null) return "";
  return typeof value === "string" ? value : String(value);
}

/** JSON text of a typed value: 64-bit integers keep every digit as a JSON number. */
export function csvTypedJson(value: CsvTypedValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

export type CsvGroupOrder = "key" | "count";

export interface CsvAggregateRequest {
  groupColumn: number | null;
  valueColumn: number | null;
  order: CsvGroupOrder;
}

export interface CsvAggregateResult {
  columns: string[];
  /** Parquet/JSON type of each result column. */
  types: CsvColumnType[];
  rows: CsvTypedValue[][];
  groupCount: number;
  inputRows: number;
}

interface GroupAccumulator {
  key: CsvTypedValue;
  count: number;
  present: number;
  integerSum: bigint;
  floatSum: number;
  floatCompensation: number;
  min: Exclude<CsvTypedValue, null> | null;
  max: Exclude<CsvTypedValue, null> | null;
}

/**
 * Streaming GROUP BY with count, and for a value column non-null count, sum, average, min and
 * max. Integer sums are exact BigInt values; number sums use Neumaier compensation. Sum and
 * average exist only for integer and number columns.
 */
export class CsvAggregator {
  private readonly groups = new Map<string, GroupAccumulator>();
  private inputRows = 0;
  private readonly request: CsvAggregateRequest;
  private readonly groupType: CsvColumnType;
  private readonly valueType: CsvColumnType;

  constructor(request: CsvAggregateRequest, groupType: CsvColumnType, valueType: CsvColumnType) {
    this.request = request;
    this.groupType = groupType;
    this.valueType = valueType;
  }

  get numericValue(): boolean {
    return this.valueType === "integer" || this.valueType === "number";
  }

  add(groupValue: CsvTypedValue, value: CsvTypedValue): void {
    this.inputRows++;
    const mapKey = groupValue === null ? "\u0000null" : `${typeof groupValue}:${csvTypedText(groupValue)}`;
    let group = this.groups.get(mapKey);
    if (!group) {
      if (this.groups.size >= CSV_MAX_GROUPS) throw new Error("too-many-groups");
      group = { key: groupValue, count: 0, present: 0, integerSum: 0n, floatSum: 0, floatCompensation: 0, min: null, max: null };
      this.groups.set(mapKey, group);
    }
    group.count++;
    if (this.request.valueColumn === null || value === null) return;
    group.present++;
    if (typeof value === "bigint") group.integerSum += value;
    else if (typeof value === "number") {
      const total = group.floatSum + value;
      group.floatCompensation += Math.abs(group.floatSum) >= Math.abs(value)
        ? (group.floatSum - total) + value
        : (value - total) + group.floatSum;
      group.floatSum = total;
    }
    if (group.min === null || compareCsvTypedValues(value, group.min) < 0) group.min = value;
    if (group.max === null || compareCsvTypedValues(value, group.max) > 0) group.max = value;
  }

  finish(groupLabel: string | null, valueLabel: string | null): CsvAggregateResult {
    const columns: string[] = [];
    const types: CsvColumnType[] = [];
    if (this.request.groupColumn !== null) {
      columns.push(groupLabel ?? "group");
      types.push(this.groupType);
    }
    columns.push("count");
    types.push("integer");
    const value = this.request.valueColumn !== null ? valueLabel ?? "value" : null;
    if (value !== null) {
      columns.push(`count(${value})`);
      types.push("integer");
      if (this.numericValue) {
        columns.push(`sum(${value})`, `avg(${value})`);
        types.push(this.valueType, "number");
      }
      columns.push(`min(${value})`, `max(${value})`);
      types.push(this.valueType, this.valueType);
    }

    const groups = [...this.groups.values()];
    if (this.request.groupColumn === null && groups.length === 0) {
      groups.push({ key: null, count: 0, present: 0, integerSum: 0n, floatSum: 0, floatCompensation: 0, min: null, max: null });
    }
    groups.sort((left, right) => {
      if (this.request.order === "count" && left.count !== right.count) return right.count - left.count;
      if (left.key === null || right.key === null) return left.key === right.key ? 0 : left.key === null ? 1 : -1;
      return compareCsvTypedValues(left.key, right.key);
    });

    const rows = groups.map((group) => {
      const row: CsvTypedValue[] = [];
      if (this.request.groupColumn !== null) row.push(group.key);
      row.push(BigInt(group.count));
      if (value !== null) {
        row.push(BigInt(group.present));
        if (this.numericValue) {
          const sum = group.present === 0 ? null
            : this.valueType === "integer" ? group.integerSum : group.floatSum + group.floatCompensation;
          row.push(sum, sum === null ? null : Number(sum) / group.present);
        }
        row.push(group.min, group.max);
      }
      return row;
    });
    return { columns, types, rows, groupCount: groups.length, inputRows: this.inputRows };
  }
}
