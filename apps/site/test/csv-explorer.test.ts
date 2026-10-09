import assert from "node:assert/strict";
import test from "node:test";
import { encodeCsvRow } from "../src/tools/explorer-delimited.ts";
import {
  CsvByteParser,
  CsvParserError,
  csvRecordMatches,
  compareCsvDecimals,
  detectCsvDelimiter,
  normalizeCsvHeaders,
  normalizeCsvDecimal,
  type CsvDelimiter,
  type CsvEncoding,
  type CsvParsedRecord,
} from "../src/tools/csv-explorer.ts";

function parseChunks(bytes: Uint8Array, encoding: CsvEncoding, delimiter: CsvDelimiter, chunkSizes: readonly number[]): CsvParsedRecord[] {
  const records: CsvParsedRecord[] = [];
  const parser = new CsvByteParser(encoding, delimiter, 0, (record) => { records.push(record); });
  let offset = 0;
  let chunk = 0;
  while (offset < bytes.length) {
    const size = chunkSizes[chunk++ % chunkSizes.length];
    const end = Math.min(bytes.length, offset + size);
    parser.push(bytes.subarray(offset, end), offset);
    offset = end;
  }
  parser.finish(bytes.length);
  return records;
}

function utf16Bytes(text: string, bigEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(text.length * 2);
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    bytes[index * 2 + (bigEndian ? 1 : 0)] = code & 0xff;
    bytes[index * 2 + (bigEndian ? 0 : 1)] = code >>> 8;
  }
  return bytes;
}

test("CSV parser preserves escaped quotes, multiline fields and UTF-8 across byte boundaries", () => {
  const input = 'id,text\r\n1,"snowman ☃\r\nand ""quotes"""\r\n2,done';
  const records = parseChunks(new TextEncoder().encode(input), "utf-8", ",", [1, 2, 5, 3]);
  assert.deepEqual(records.map((record) => record.fields), [
    ["id", "text"],
    ["1", 'snowman ☃\r\nand "quotes"'],
    ["2", "done"],
  ]);
  assert.equal(records[2].start, new TextEncoder().encode('id,text\r\n1,"snowman ☃\r\nand ""quotes"""\r\n').byteLength);
});

test("CSV parser accepts UTF-16 code units and CRLF split between odd chunks", () => {
  const input = 'α\t"β\r\nγ"\r\nδ\tε';
  for (const [encoding, bigEndian] of [["utf-16le", false], ["utf-16be", true]] as const) {
    const records = parseChunks(utf16Bytes(input, bigEndian), encoding, "\t", [3, 1, 7]);
    assert.deepEqual(records.map((record) => record.fields), [["α", "β\r\nγ"], ["δ", "ε"]]);
  }
});

test("CSV parser preserves embedded FEFF at UTF-8 and UTF-16 field starts", () => {
  const text = "left,\ufeffright";
  const utf8 = parseChunks(new TextEncoder().encode(text), "utf-8", ",", [2, 1, 4]);
  const utf16 = parseChunks(utf16Bytes(text, false), "utf-16le", ",", [3, 5, 1]);
  assert.deepEqual(utf8.map((record) => record.fields), [["left", "\ufeffright"]]);
  assert.deepEqual(utf16.map((record) => record.fields), [["left", "\ufeffright"]]);
});

test("CSV parser rejects malformed quotes instead of silently repairing them", () => {
  const bytes = new TextEncoder().encode('a,"unterminated');
  assert.throws(
    () => parseChunks(bytes, "utf-8", ",", [4]),
    (error: unknown) => error instanceof CsvParserError && error.code === "malformed-csv",
  );
  const trailing = new TextEncoder().encode('a,"closed"x');
  assert.throws(
    () => parseChunks(trailing, "utf-8", ",", [2]),
    (error: unknown) => error instanceof CsvParserError && error.code === "malformed-csv",
  );
});

test("delimiter detection ignores separators inside quotes and favors consistent records", () => {
  assert.equal(detectCsvDelimiter('a;b;c\r\n1;"x,y";3\r\n4;5;6'), ";");
  assert.equal(detectCsvDelimiter('a\tb\n1\t2\n3\t4'), "\t");
  assert.equal(detectCsvDelimiter('single column\nsecond row'), ",");
});

test("delimiter detection recognizes quoted non-first fields in headerless records", () => {
  const input = '1,"a;b;c;d"\r\n2,"e;f;g;h"\r\n';
  assert.equal(detectCsvDelimiter(input), ",");
});

test("delimiter detection ignores candidate separators across quoted multiline fields", () => {
  const input = 'id,note\r\n1,"a;b;c;d\nx;y;z;v\np;q;r;s"\r\n2,"e;f;g;h\nx;y;z;v\np;q;r;s"\r\n';
  assert.equal(detectCsvDelimiter(input), ",");
});

test("header normalization gives blank and duplicate names deterministic unique labels", () => {
  assert.deepEqual(normalizeCsvHeaders(["", "name", "name", "Column 1"], 5), {
    labels: ["Column 1", "name", "name (2)", "Column 1 (2)", "Column 5"],
    blankCount: 2,
    duplicateCount: 2,
  });
});

test("filters use selected columns and strict locale-independent numeric text", () => {
  const row = ["Alpha", "1.25e2", "1,25"];
  assert.equal(csvRecordMatches(row, { operator: "contains", query: "alp", columns: [0], caseSensitive: false }), true);
  assert.equal(csvRecordMatches(row, { operator: "gt", query: "100", columns: [1], caseSensitive: false }), true);
  assert.equal(csvRecordMatches(row, { operator: "gt", query: "1", columns: [2], caseSensitive: false }), false);
});

test("numeric filters compare arbitrary-precision decimal and exponent lexemes exactly", () => {
  assert.equal(csvRecordMatches(["9007199254740993"], {
    operator: "gt", query: "9007199254740992", columns: [0], caseSensitive: false,
  }), true);
  assert.equal(csvRecordMatches(["0.10000000000000000001"], {
    operator: "gt", query: "0.1", columns: [0], caseSensitive: false,
  }), true);
  assert.equal(csvRecordMatches(["-9007199254740993"], {
    operator: "lt", query: "-9007199254740992", columns: [0], caseSensitive: false,
  }), true);
  const exponent = normalizeCsvDecimal("1.2300e3");
  const expanded = normalizeCsvDecimal("123e1");
  assert.ok(exponent);
  assert.ok(expanded);
  assert.equal(compareCsvDecimals(exponent, expanded), 0);
  assert.equal(csvRecordMatches(["1e100000000000000000000"], {
    operator: "gt", query: "9e99999999999999999999", columns: [0], caseSensitive: false,
  }), true);
});

test("CSV export quoting and formula protection preserve Unicode and embedded newlines", () => {
  assert.equal(encodeCsvRow(["plain", 'a,"b"', "line\r\nbreak", "☃"]), 'plain,"a,""b""","line\r\nbreak",☃');
  assert.equal(encodeCsvRow(["=2+2", " \t@SUM(A1:A2)", "-7", "+cmd"]), "'=2+2,' \t@SUM(A1:A2),'-7,'+cmd");
  assert.equal(encodeCsvRow(["=2+2"], false), "=2+2");
});
