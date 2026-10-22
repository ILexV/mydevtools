import { ByteWriter, ParquetWriter, schemaFromColumnData } from "hyparquet-writer";
import type { CsvColumnType, CsvTypedValue } from "@/tools/csv-explorer-types";

const ROW_GROUP_ROWS = 65_536;
const ROW_GROUP_TEXT_CHARS = 32 * 1024 * 1024;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

export interface CsvParquetColumn {
  name: string;
  type: CsvColumnType;
}

export interface CsvParquetStream {
  /** Buffer one row; call flushIfFull() regularly to write completed row groups. */
  add(row: readonly CsvTypedValue[]): void;
  flushIfFull(): Promise<void>;
  finish(): Promise<void>;
}

const PARQUET_TYPES = { text: "STRING", integer: "INT64", number: "DOUBLE", boolean: "BOOLEAN" } as const;

/**
 * Streaming Parquet writer for typed CSV rows: buffers about one row group (64Ki rows or ~32M
 * text chars), writes it with Snappy compression and hands the bytes to the async sink before
 * buffering more, so memory stays bounded by a row group plus the footer metadata.
 */
export function createCsvParquetStream(columns: readonly CsvParquetColumn[], sink: (bytes: Uint8Array) => Promise<void>): CsvParquetStream {
  const writer: ByteWriter & { flush?: () => Promise<void> } = new ByteWriter(1024 * 1024);
  const flush = async () => {
    if (writer.index === 0) return;
    const chunk = new Uint8Array(writer.buffer, 0, writer.index).slice();
    writer.index = 0;
    await sink(chunk);
  };
  writer.flush = flush;
  writer.finish = flush;

  const schema = schemaFromColumnData({
    columnData: columns.map((column) => ({ name: column.name, data: [], type: PARQUET_TYPES[column.type], nullable: true })),
  });
  const parquet = new ParquetWriter({ writer, schema, codec: "SNAPPY" });
  let buffered: CsvTypedValue[][] = columns.map(() => []);
  let rows = 0;
  let textChars = 0;

  async function writeGroup(): Promise<void> {
    if (rows === 0) return;
    const columnData = columns.map((column, index) => ({ name: column.name, data: buffered[index] }));
    buffered = columns.map(() => []);
    const count = rows;
    rows = 0;
    textChars = 0;
    await parquet.write({ columnData, rowGroupSize: count });
  }

  return {
    add(row) {
      for (let index = 0; index < columns.length; index++) {
        const value = row[index] ?? null;
        if (typeof value === "bigint" && (value < INT64_MIN || value > INT64_MAX)) throw new Error("value-out-of-range");
        if (typeof value === "string") textChars += value.length;
        buffered[index].push(value);
      }
      rows++;
    },
    async flushIfFull() {
      if (rows >= ROW_GROUP_ROWS || textChars >= ROW_GROUP_TEXT_CHARS) await writeGroup();
    },
    async finish() {
      await writeGroup();
      await parquet.finish();
    },
  };
}
