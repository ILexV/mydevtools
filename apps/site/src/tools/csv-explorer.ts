export const CSV_CHUNK_BYTES = 1024 * 1024;
export const CSV_MAX_FIELD_BYTES = 2 * 1024 * 1024;
export const CSV_MAX_RECORD_BYTES = 8 * 1024 * 1024;
export const CSV_MAX_COLUMNS = 512;
export const CSV_MAX_RECORDS = 100_000_000;
export const CSV_CHECKPOINT_STRIDE = 512;
export const CSV_FILTER_CHECKPOINT_STRIDE = 256;
export const CSV_MAX_EXPORT_BYTES = 512 * 1024 * 1024;
export const CSV_MAX_RANGE_ROWS = 250;

export type CsvEncoding = "utf-8" | "utf-16le" | "utf-16be" | "latin1";
export type CsvDelimiter = "," | ";" | "\t" | "|";
export type CsvFilterOperator = "contains" | "equals" | "gt" | "gte" | "lt" | "lte";

export interface CsvFilter {
  operator: CsvFilterOperator;
  query: string;
  columns: readonly number[];
  caseSensitive: boolean;
}

export interface CsvParsedRecord {
  fields: readonly string[];
  start: number;
  end: number;
}

export interface CsvHeaderInfo {
  labels: string[];
  blankCount: number;
  duplicateCount: number;
}

export type CsvParserErrorCode = "field-too-large" | "record-too-large" | "too-many-columns" | "invalid-encoding" | "malformed-csv" | "session-missing";

export class CsvParserError extends Error {
  readonly code: CsvParserErrorCode;

  constructor(code: CsvParserErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "CsvParserError";
  }
}

function decoderLabel(encoding: CsvEncoding): string {
  return encoding === "latin1" ? "windows-1252" : encoding;
}

/** Detect UTF BOMs. UTF-8 without a BOM is the auto-mode default. */
export function detectCsvEncoding(bytes: Uint8Array): { encoding: CsvEncoding; bomBytes: number } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: "utf-8", bomBytes: 3 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: "utf-16le", bomBytes: 2 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: "utf-16be", bomBytes: 2 };
  }
  return { encoding: "utf-8", bomBytes: 0 };
}

/** Decode a bounded sample; stream mode avoids rejecting a final partial UTF-8 sequence. */
export function decodeCsvSample(bytes: Uint8Array, encoding: CsvEncoding, skipBytes = 0): string {
  try {
    const decoder = new TextDecoder(decoderLabel(encoding), { fatal: true, ignoreBOM: true });
    return decoder.decode(bytes.subarray(skipBytes), { stream: true });
  } catch (error) {
    throw new CsvParserError("invalid-encoding", error instanceof Error ? error.message : "Invalid text encoding");
  }
}

/** Pick the separator producing the strongest consistent positive field count. */
export function detectCsvDelimiter(text: string): CsvDelimiter {
  const candidates: readonly CsvDelimiter[] = [",", ";", "\t", "|"];
  let best: CsvDelimiter = ",";
  let bestScore = -1;

  for (const delimiter of candidates) {
    const counts: number[] = [];
    let count = 0;
    let quoted = false;
    let afterQuote = false;
    let fieldStart = true;
    let recordTouched = false;

    const finish = () => {
      if (recordTouched || count > 0) counts.push(count);
      count = 0;
      quoted = false;
      afterQuote = false;
      fieldStart = true;
      recordTouched = false;
    };

    for (let i = 0; i < text.length && counts.length < 64; i++) {
      const char = text[i];
      if (quoted) {
        if (char === '"') {
          if (text[i + 1] === '"') i++;
          else {
            quoted = false;
            afterQuote = true;
          }
        }
        recordTouched = true;
        continue;
      }

      if (char === "\r" || char === "\n") {
        finish();
        if (char === "\r" && text[i + 1] === "\n") i++;
        continue;
      }

      const possibleSeparator = char === "," || char === ";" || char === "\t" || char === "|";
      if (afterQuote) {
        if (possibleSeparator) {
          if (char === delimiter) count++;
          fieldStart = true;
          afterQuote = false;
          recordTouched = true;
        } else if (!/\s/u.test(char)) {
          afterQuote = false;
          fieldStart = false;
          recordTouched = true;
        }
        continue;
      }

      if (char === '"' && fieldStart) {
        quoted = true;
        fieldStart = false;
        recordTouched = true;
      } else if (possibleSeparator) {
        if (char === delimiter) count++;
        fieldStart = true;
        recordTouched = true;
      } else {
        fieldStart = false;
        recordTouched = true;
      }
    }
    if (!quoted) finish();

    const frequencies = new Map<number, number>();
    for (const value of counts) {
      if (value > 0) frequencies.set(value, (frequencies.get(value) ?? 0) + 1);
    }
    let modal = 0;
    let frequency = 0;
    for (const [value, seen] of frequencies) {
      if (seen > frequency || (seen === frequency && value > modal)) {
        modal = value;
        frequency = seen;
      }
    }
    const score = frequency === 0 ? 0 : frequency * 1000 + modal * 10 - (counts.length - frequency);
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }
  return best;
}

/** Produce non-empty, unique display/property names without changing cell text. */
export function normalizeCsvHeaders(raw: readonly string[], columnCount: number): CsvHeaderInfo {
  const labels: string[] = [];
  const uses = new Map<string, number>();
  let blankCount = 0;
  let duplicateCount = 0;

  for (let index = 0; index < columnCount; index++) {
    let base = raw[index] ?? "";
    if (base.trim().length === 0) {
      base = `Column ${index + 1}`;
      blankCount++;
    }
    const occurrence = (uses.get(base) ?? 0) + 1;
    uses.set(base, occurrence);
    if (occurrence > 1) duplicateCount++;
    let label = occurrence === 1 ? base : `${base} (${occurrence})`;
    let suffix = occurrence;
    while (labels.includes(label)) {
      suffix++;
      label = `${base} (${suffix})`;
      duplicateCount++;
    }
    labels.push(label);
  }
  return { labels, blankCount, duplicateCount };
}

interface SignedDecimalInteger {
  sign: -1 | 0 | 1;
  digits: string;
}

export interface NormalizedCsvDecimal {
  sign: -1 | 0 | 1;
  digits: string;
  scale: SignedDecimalInteger;
}

export interface PreparedCsvFilter {
  filter: CsvFilter;
  foldedQuery: string;
  numericQuery: NormalizedCsvDecimal | null;
}

function compareUnsignedIntegers(left: string, right: string): -1 | 0 | 1 {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function addUnsignedIntegers(left: string, right: string): string {
  let carry = 0;
  const reversed: string[] = [];
  for (let a = left.length - 1, b = right.length - 1; a >= 0 || b >= 0 || carry > 0; a--, b--) {
    const sum = (a >= 0 ? left.charCodeAt(a) - 48 : 0) + (b >= 0 ? right.charCodeAt(b) - 48 : 0) + carry;
    reversed.push(String(sum % 10));
    carry = Math.floor(sum / 10);
  }
  reversed.reverse();
  return reversed.join("");
}

function subtractUnsignedIntegers(left: string, right: string): string {
  let borrow = 0;
  const reversed: string[] = [];
  for (let a = left.length - 1, b = right.length - 1; a >= 0; a--, b--) {
    let digit = left.charCodeAt(a) - 48 - borrow - (b >= 0 ? right.charCodeAt(b) - 48 : 0);
    if (digit < 0) {
      digit += 10;
      borrow = 1;
    } else {
      borrow = 0;
    }
    reversed.push(String(digit));
  }
  while (reversed.length > 1 && reversed[reversed.length - 1] === "0") reversed.pop();
  reversed.reverse();
  return reversed.join("");
}

function signedInteger(sign: -1 | 0 | 1, digits: string): SignedDecimalInteger {
  const normalized = digits.replace(/^0+/u, "");
  return normalized.length === 0 ? { sign: 0, digits: "0" } : { sign, digits: normalized };
}

function addSignedIntegers(left: SignedDecimalInteger, right: SignedDecimalInteger): SignedDecimalInteger {
  if (left.sign === 0) return right;
  if (right.sign === 0) return left;
  if (left.sign === right.sign) return signedInteger(left.sign, addUnsignedIntegers(left.digits, right.digits));
  const order = compareUnsignedIntegers(left.digits, right.digits);
  if (order === 0) return { sign: 0, digits: "0" };
  return order > 0
    ? signedInteger(left.sign, subtractUnsignedIntegers(left.digits, right.digits))
    : signedInteger(right.sign, subtractUnsignedIntegers(right.digits, left.digits));
}

function addSmallInteger(value: SignedDecimalInteger, amount: number): SignedDecimalInteger {
  if (amount === 0) return value;
  const sign: -1 | 1 = amount < 0 ? -1 : 1;
  return addSignedIntegers(value, { sign, digits: String(Math.abs(amount)) });
}

function compareSignedIntegers(left: SignedDecimalInteger, right: SignedDecimalInteger): -1 | 0 | 1 {
  if (left.sign !== right.sign) return left.sign < right.sign ? -1 : 1;
  if (left.sign === 0) return 0;
  const magnitude = compareUnsignedIntegers(left.digits, right.digits);
  return left.sign === 1 ? magnitude : magnitude === 0 ? 0 : magnitude === 1 ? -1 : 1;
}

export function normalizeCsvDecimal(value: string): NormalizedCsvDecimal | null {
  const match = value.trim().match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?)(\d+))?$/u);
  if (!match) return null;
  const fraction = match[3] ?? match[4] ?? "";
  let digits = `${match[2] ?? ""}${fraction}`.replace(/^0+/u, "");
  if (digits.length === 0) return { sign: 0, digits: "0", scale: { sign: 0, digits: "0" } };

  let significantEnd = digits.length;
  while (significantEnd > 0 && digits.charCodeAt(significantEnd - 1) === 48) significantEnd--;
  const trailingZeros = digits.length - significantEnd;
  digits = digits.slice(0, significantEnd);
  const exponentDigits = match[6] ?? "0";
  const exponentSign: -1 | 0 | 1 = /^0+$/u.test(exponentDigits) ? 0 : match[5] === "-" ? -1 : 1;
  const exponent = signedInteger(exponentSign, exponentDigits);
  const scale = addSmallInteger(exponent, trailingZeros - fraction.length);
  return { sign: match[1] === "-" ? -1 : 1, digits, scale };
}

export function compareCsvDecimals(left: NormalizedCsvDecimal, right: NormalizedCsvDecimal): -1 | 0 | 1 {
  if (left.sign !== right.sign) return left.sign < right.sign ? -1 : 1;
  if (left.sign === 0) return 0;
  const leftOrder = addSmallInteger(left.scale, left.digits.length);
  const rightOrder = addSmallInteger(right.scale, right.digits.length);
  let order = compareSignedIntegers(leftOrder, rightOrder);
  if (order === 0) {
    const width = Math.max(left.digits.length, right.digits.length);
    for (let index = 0; index < width; index++) {
      const a = index < left.digits.length ? left.digits.charCodeAt(index) : 48;
      const b = index < right.digits.length ? right.digits.charCodeAt(index) : 48;
      if (a !== b) {
        order = a < b ? -1 : 1;
        break;
      }
    }
  }
  return left.sign === 1 ? order : order === 0 ? 0 : order === 1 ? -1 : 1;
}

export function prepareCsvFilter(filter: CsvFilter | null): PreparedCsvFilter | null {
  if (!filter || filter.query.length === 0) return null;
  const copied = { ...filter, columns: [...filter.columns] };
  return {
    filter: copied,
    foldedQuery: filter.caseSensitive ? filter.query : filter.query.toLowerCase(),
    numericQuery: normalizeCsvDecimal(filter.query),
  };
}

export function csvRecordMatchesPrepared(fields: readonly string[], prepared: PreparedCsvFilter | null): boolean {
  if (!prepared) return true;
  const { filter } = prepared;
  return filter.columns.some((column) => {
    const original = fields[column] ?? "";
    if (filter.operator === "contains" || filter.operator === "equals") {
      const value = filter.caseSensitive ? original : original.toLowerCase();
      return filter.operator === "contains" ? value.includes(prepared.foldedQuery) : value === prepared.foldedQuery;
    }
    if (!prepared.numericQuery) return false;
    const value = normalizeCsvDecimal(original);
    if (!value) return false;
    const comparison = compareCsvDecimals(value, prepared.numericQuery);
    switch (filter.operator) {
      case "gt": return comparison > 0;
      case "gte": return comparison >= 0;
      case "lt": return comparison < 0;
      case "lte": return comparison <= 0;
      default: return false;
    }
  });
}

export function csvRecordMatches(fields: readonly string[], filter: CsvFilter | null): boolean {
  return csvRecordMatchesPrepared(fields, prepareCsvFilter(filter));
}

/**
 * Incremental RFC 4180 parser operating on bytes so record offsets remain
 * exact. Delimiter/newline/quote code units are ASCII in every supported
 * encoding; field decoding happens only after a bounded field is complete.
 */
export class CsvByteParser {
  private readonly decoder: TextDecoder;
  private readonly fieldBuffer = new Uint8Array(CSV_MAX_FIELD_BYTES);
  private fieldLength = 0;
  private fields: string[] = [];
  private quoted = false;
  private afterQuote = false;
  private fieldStarted = false;
  private skipLf = false;
  private stopped = false;
  private utf16Carry: { byte: number; offset: number } | null = null;
  private recordStart: number;
  private readonly encoding: CsvEncoding;
  private readonly delimiterCode: number;
  private readonly onRecord: (record: CsvParsedRecord) => boolean | void;

  constructor(
    encoding: CsvEncoding,
    delimiter: CsvDelimiter,
    startOffset: number,
    onRecord: (record: CsvParsedRecord) => boolean | void,
  ) {
    this.encoding = encoding;
    this.delimiterCode = delimiter.charCodeAt(0);
    this.onRecord = onRecord;
    this.decoder = new TextDecoder(decoderLabel(encoding), { fatal: true, ignoreBOM: true });
    this.recordStart = startOffset;
  }

  push(bytes: Uint8Array, absoluteStart: number): boolean {
    if (this.stopped) return false;
    if (this.encoding === "utf-16le" || this.encoding === "utf-16be") {
      this.pushUtf16(bytes, absoluteStart);
    } else {
      for (let index = 0; index < bytes.length && !this.stopped; index++) {
        const offset = absoluteStart + index;
        const byte = bytes[index];
        this.consume(byte, offset, offset + 1, byte);
      }
    }
    return !this.stopped;
  }

  finish(endOffset: number): void {
    if (this.utf16Carry) throw new CsvParserError("invalid-encoding", "Incomplete UTF-16 code unit");
    if (this.quoted) throw new CsvParserError("malformed-csv", "Unterminated quoted field");
    if (this.afterQuote || this.fieldStarted || this.fields.length > 0) {
      this.finishField();
      this.emitRecord(endOffset);
    }
  }

  private pushUtf16(bytes: Uint8Array, absoluteStart: number): void {
    let index = 0;
    if (this.utf16Carry && bytes.length > 0) {
      const first = this.utf16Carry;
      const next = bytes[0];
      const code = this.encoding === "utf-16le" ? first.byte | (next << 8) : (first.byte << 8) | next;
      this.utf16Carry = null;
      this.consume(code, first.offset, absoluteStart + 1, first.byte, next);
      index = 1;
    }
    for (; index + 1 < bytes.length && !this.stopped; index += 2) {
      const first = bytes[index];
      const next = bytes[index + 1];
      const code = this.encoding === "utf-16le" ? first | (next << 8) : (first << 8) | next;
      this.consume(code, absoluteStart + index, absoluteStart + index + 2, first, next);
    }
    if (index < bytes.length) this.utf16Carry = { byte: bytes[index], offset: absoluteStart + index };
  }

  private append(firstByte: number, secondByte?: number): void {
    const length = secondByte === undefined ? 1 : 2;
    if (this.fieldLength + length > CSV_MAX_FIELD_BYTES) {
      throw new CsvParserError("field-too-large", "A field exceeds the configured byte limit");
    }
    this.fieldBuffer[this.fieldLength++] = firstByte;
    if (secondByte !== undefined) this.fieldBuffer[this.fieldLength++] = secondByte;
    this.fieldStarted = true;
  }

  private finishField(): void {
    if (this.fields.length >= CSV_MAX_COLUMNS) {
      throw new CsvParserError("too-many-columns", "A record exceeds the configured column limit");
    }
    try {
      this.fields.push(this.decoder.decode(this.fieldBuffer.subarray(0, this.fieldLength)));
    } catch (error) {
      throw new CsvParserError("invalid-encoding", error instanceof Error ? error.message : "Invalid text encoding");
    }
    this.fieldLength = 0;
    this.fieldStarted = false;
    this.afterQuote = false;
  }

  private emitRecord(endOffset: number): void {
    const record = { fields: this.fields, start: this.recordStart, end: endOffset };
    this.fields = [];
    this.recordStart = endOffset;
    if (this.onRecord(record) === false) this.stopped = true;
  }

  private endRecord(endOffset: number, cr: boolean): void {
    this.finishField();
    this.emitRecord(endOffset);
    this.skipLf = cr;
  }

  private consume(code: number, start: number, end: number, firstByte: number, secondByte?: number): void {
    if (end - this.recordStart > CSV_MAX_RECORD_BYTES) {
      throw new CsvParserError("record-too-large", "A record exceeds the configured byte limit");
    }
    if (this.skipLf) {
      this.skipLf = false;
      if (code === 10) {
        this.recordStart = end;
        return;
      }
    }

    const quote = code === 34;
    const cr = code === 13;
    const lf = code === 10;
    const delimiter = code === this.delimiterCode;

    if (this.quoted) {
      if (quote) {
        this.quoted = false;
        this.afterQuote = true;
      } else {
        this.append(firstByte, secondByte);
      }
      return;
    }

    if (this.afterQuote) {
      if (quote) {
        this.append(firstByte, secondByte);
        this.quoted = true;
        this.afterQuote = false;
      } else if (delimiter) {
        this.finishField();
      } else if (cr || lf) {
        this.endRecord(end, cr);
      } else {
        throw new CsvParserError("malformed-csv", `Unexpected character after a closing quote at byte ${start}`);
      }
      return;
    }

    if (quote) {
      if (this.fieldStarted) throw new CsvParserError("malformed-csv", `Unexpected quote in an unquoted field at byte ${start}`);
      this.quoted = true;
      this.fieldStarted = true;
    } else if (delimiter) {
      this.finishField();
    } else if (cr || lf) {
      this.endRecord(end, cr);
    } else {
      this.append(firstByte, secondByte);
    }
  }
}
