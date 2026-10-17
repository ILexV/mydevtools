import {
  parseJsonLossless,
  rawJson,
  type JsonNode,
  type JsonObjectNode,
} from "@/tools/json-explorer-core";

type ColumnKind = "number" | "boolean" | "text" | "null";

interface CodecRequest {
  id: number;
  bytes: Uint8Array;
  format: "json" | "jsonl";
}

interface RecordValue {
  node: JsonNode;
  source: string;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

function csvCell(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

function recordsFromJson(source: string): RecordValue[] {
  const root = parseJsonLossless(source);
  const nodes = root.kind === "array" ? root.elements : [root];
  return nodes.map((node) => ({ node, source }));
}

function recordsFromJsonl(source: string): RecordValue[] {
  const records: RecordValue[] = [];
  for (const line of source.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    records.push({ node: parseJsonLossless(line), source: line });
  }
  return records;
}

function entries(record: RecordValue): Array<{ key: string; value: RecordValue }> {
  if (record.node.kind !== "object") return [{ key: "value", value: record }];
  const unique = new Map<string, RecordValue>();
  for (const entry of (record.node as JsonObjectNode).entries) {
    unique.set(entry.key, { node: entry.value, source: record.source });
  }
  return [...unique].map(([key, value]) => ({ key, value }));
}

function kindOf(node: JsonNode): ColumnKind {
  if (node.kind === "number") return "number";
  if (node.kind === "boolean") return "boolean";
  if (node.kind === "null") return "null";
  if (node.kind === "string") return "text";
  throw new Error("json-tabular-unsupported");
}

function mergeKind(current: ColumnKind | undefined, next: ColumnKind): ColumnKind {
  if (!current || current === "null") return next;
  if (next === "null" || current === next) return current;
  throw new Error("json-tabular-unsupported");
}

function decimalType(name: string, rows: ReadonlyArray<Map<string, RecordValue>>): string {
  let maxIntegerDigits = 0;
  let maxScale = 0;
  for (const row of rows) {
    const value = row.get(name);
    if (!value || value.node.kind !== "number") continue;
    const literal = rawJson(value.node, value.source);
    const match = /^-?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(literal);
    if (!match) throw new Error("json-tabular-unsupported");
    const integer = match[1];
    const fraction = match[2] ?? "";
    const exponent = Number(match[3] ?? "0");
    if (!Number.isSafeInteger(exponent)) throw new Error("json-tabular-unsupported");
    const decimalPosition = integer.length + exponent;
    maxIntegerDigits = Math.max(maxIntegerDigits, Math.max(0, decimalPosition));
    maxScale = Math.max(maxScale, Math.max(0, fraction.length - exponent));
  }
  if (maxIntegerDigits + maxScale > 38) throw new Error("json-tabular-unsupported");
  return `DECIMAL(38,${maxScale})`;
}

function sqlType(name: string, kind: ColumnKind, rows: ReadonlyArray<Map<string, RecordValue>>): string {
  if (kind === "number") return decimalType(name, rows);
  if (kind === "boolean") return "BOOLEAN";
  return "VARCHAR";
}

function cell(value: RecordValue, nullToken: string): string {
  const { node, source } = value;
  if (node.kind === "null") return nullToken;
  if (node.kind === "string") return node.value;
  if (node.kind === "boolean") return node.value ? "true" : "false";
  return rawJson(node, source);
}

self.addEventListener("message", (event: MessageEvent<CodecRequest>) => {
  const { id, bytes, format } = event.data;
  try {
    const source = decoder.decode(bytes);
    const records = format === "json" ? recordsFromJson(source) : recordsFromJsonl(source);
    if (records.length === 0) throw new Error("empty-json");
    const columns: string[] = [];
    const kinds = new Map<string, ColumnKind>();
    const rows = records.map((record) => {
      const row = new Map<string, RecordValue>();
      for (const entry of entries(record)) {
        if (!kinds.has(entry.key)) columns.push(entry.key);
        kinds.set(entry.key, mergeKind(kinds.get(entry.key), kindOf(entry.value.node)));
        row.set(entry.key, entry.value);
      }
      return row;
    });
    let nullToken = "__MDT_JSON_NULL__";
    while (source.includes(nullToken)) nullToken += "_";
    const lines = [columns.map(csvCell).join(",")];
    for (const row of rows) {
      lines.push(columns.map((name) => {
        const value = row.get(name);
        return value ? csvCell(cell(value, nullToken)) : nullToken;
      }).join(","));
    }
    const output = encoder.encode(`${lines.join("\r\n")}\r\n`);
    self.postMessage({
      id,
      bytes: output,
      nullToken,
      columns: columns.map((name) => {
        const kind = kinds.get(name) ?? "null";
        return { name, kind, sqlType: sqlType(name, kind, rows) };
      }),
    }, { transfer: [output.buffer as ArrayBuffer] });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
