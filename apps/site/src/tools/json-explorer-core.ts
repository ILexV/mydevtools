export const JSON_EXPLORER_LIMITS = {
  chunkBytes: 1024 * 1024,
  ordinaryJsonBytes: 32 * 1024 * 1024,
  recordBytes: 4 * 1024 * 1024,
  maxDepth: 256,
  detectedColumns: 100,
  detectedColumnNameChars: 256,
  detectedColumnTotalChars: 16 * 1024,
  columnSampleRecords: 10_000,
  sparseStride: 128,
  treePageSize: 100,
  cellPreviewChars: 512,
  treePreviewChars: 160,
  exportChunkBytes: 1024 * 1024,
  exportBytes: 256 * 1024 * 1024,
} as const;

export type JsonKind = "object" | "array" | "string" | "number" | "boolean" | "null";

interface JsonNodeBase {
  kind: JsonKind;
  start: number;
  end: number;
}

export interface JsonObjectNode extends JsonNodeBase {
  kind: "object";
  entries: Array<{ key: string; keyStart: number; value: JsonNode }>;
}

export interface JsonArrayNode extends JsonNodeBase {
  kind: "array";
  elements: JsonNode[];
}

export interface JsonStringNode extends JsonNodeBase {
  kind: "string";
  value: string;
}

export interface JsonNumberNode extends JsonNodeBase {
  kind: "number";
}

export interface JsonBooleanNode extends JsonNodeBase {
  kind: "boolean";
  value: boolean;
}

export interface JsonNullNode extends JsonNodeBase {
  kind: "null";
}

export type JsonNode = JsonObjectNode | JsonArrayNode | JsonStringNode | JsonNumberNode | JsonBooleanNode | JsonNullNode;

export type JsonExplorerDiagnosticCode =
  | "invalid-json"
  | "malformed-jsonl"
  | "empty-json"
  | "invalid-utf8"
  | "depth-limit"
  | "record-limit"
  | "ordinary-limit"
  | "field-limit"
  | "invalid-path"
  | "session-missing"
  | "row-range"
  | "tree-unavailable";

export interface JsonExplorerDiagnostic {
  code: JsonExplorerDiagnosticCode;
  line?: number;
  column?: number;
  limitBytes?: number;
  maxDepth?: number;
  maxFields?: number;
  row?: number;
}

export class JsonExplorerError extends SyntaxError {
  readonly code: JsonExplorerDiagnosticCode;
  readonly position: number | null;
  readonly details: Omit<JsonExplorerDiagnostic, "code">;

  constructor(
    message: string,
    code: JsonExplorerDiagnosticCode,
    position: number | null = null,
    details: Omit<JsonExplorerDiagnostic, "code"> = {},
  ) {
    super(message);
    this.code = code;
    this.position = position;
    this.details = details;
    this.name = "JsonExplorerError";
  }

  diagnostic(): JsonExplorerDiagnostic {
    return { code: this.code, ...this.details };
  }
}

export interface JsonlDecodedLine {
  byteOffset: number;
  nextOffset: number;
  physicalLine: number;
  text: string;
}

/** Incremental UTF-8 JSONL line decoder with byte offsets and a bounded carry buffer. */
export class JsonlLineDecoder {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  private carry = new Uint8Array(0);
  private carryOffset: number;
  private physicalLine: number;
  private readonly recordLimit: number;

  constructor(
    recordLimit: number,
    startOffset = 0,
    startPhysicalLine = 1,
  ) {
    this.recordLimit = recordLimit;
    this.carryOffset = startOffset;
    this.physicalLine = startPhysicalLine;
  }

  push(chunk: Uint8Array): JsonlDecodedLine[] {
    let data: Uint8Array;
    if (this.carry.length === 0) {
      data = chunk;
    } else {
      data = new Uint8Array(this.carry.length + chunk.length);
      data.set(this.carry);
      data.set(chunk, this.carry.length);
    }
    const lines: JsonlDecodedLine[] = [];
    let lineStart = 0;
    for (let index = 0; index < data.length; index++) {
      if (data[index] !== 0x0a) continue;
      let lineEnd = index;
      if (lineEnd > lineStart && data[lineEnd - 1] === 0x0d) lineEnd--;
      lines.push(this.decode(data.subarray(lineStart, lineEnd), this.carryOffset + lineStart, this.carryOffset + index + 1));
      lineStart = index + 1;
    }
    this.carry = data.slice(lineStart);
    this.carryOffset += lineStart;
    const pendingCr = this.carry.length === this.recordLimit + 1 && this.carry[this.carry.length - 1] === 0x0d;
    if (this.carry.length > this.recordLimit && !pendingCr) {
      throw new JsonExplorerError(`JSONL record on line ${this.physicalLine} exceeds the configured byte limit`, "record-limit", null, { line: this.physicalLine, limitBytes: this.recordLimit });
    }
    return lines;
  }

  finish(finalOffset: number): JsonlDecodedLine[] {
    if (this.carry.length === 0) return [];
    let lineEnd = this.carry.length;
    if (this.carry[lineEnd - 1] === 0x0d) lineEnd--;
    const line = this.decode(this.carry.subarray(0, lineEnd), this.carryOffset, finalOffset);
    this.carry = new Uint8Array(0);
    this.carryOffset = finalOffset;
    return [line];
  }

  private decode(bytes: Uint8Array, byteOffset: number, nextOffset: number): JsonlDecodedLine {
    if (bytes.length > this.recordLimit) {
      throw new JsonExplorerError(`JSONL record on line ${this.physicalLine} exceeds the configured byte limit`, "record-limit", null, { line: this.physicalLine, limitBytes: this.recordLimit });
    }
    let text: string;
    try {
      text = this.decoder.decode(bytes);
    } catch {
      throw new JsonExplorerError(`Invalid UTF-8 on line ${this.physicalLine}`, "invalid-utf8", null, { line: this.physicalLine });
    }
    if (byteOffset === 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { byteOffset, nextOffset, physicalLine: this.physicalLine++, text };
  }
}

class Parser {
  private pos = 0;

  private readonly source: string;
  private readonly maxDepth: number;

  constructor(source: string, maxDepth: number) {
    this.source = source;
    this.maxDepth = maxDepth;
  }

  parse(): JsonNode {
    this.space();
    if (this.pos === this.source.length) throw new JsonExplorerError("JSON input is empty", "empty-json", this.pos);
    const node = this.value(0);
    this.space();
    if (this.pos !== this.source.length) throw this.error("Unexpected content after the JSON value");
    return node;
  }

  private value(depth: number): JsonNode {
    if (depth > this.maxDepth) throw new JsonExplorerError(`JSON nesting exceeds ${this.maxDepth}`, "depth-limit", this.pos, { maxDepth: this.maxDepth });
    const c = this.source.charCodeAt(this.pos);
    if (c === 0x7b) return this.object(depth);
    if (c === 0x5b) return this.array(depth);
    if (c === 0x22) {
      const start = this.pos;
      return { kind: "string", start, end: this.stringEnd(), value: this.decodeString(start, this.pos) };
    }
    if (this.source.startsWith("true", this.pos)) {
      const start = this.pos;
      this.pos += 4;
      return { kind: "boolean", start, end: this.pos, value: true };
    }
    if (this.source.startsWith("false", this.pos)) {
      const start = this.pos;
      this.pos += 5;
      return { kind: "boolean", start, end: this.pos, value: false };
    }
    if (this.source.startsWith("null", this.pos)) {
      const start = this.pos;
      this.pos += 4;
      return { kind: "null", start, end: this.pos };
    }
    const rest = this.source.slice(this.pos);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(rest);
    if (match) {
      const start = this.pos;
      this.pos += match[0].length;
      return { kind: "number", start, end: this.pos };
    }
    throw this.error("Expected a JSON value");
  }

  private object(depth: number): JsonObjectNode {
    const start = this.pos++;
    const entries: JsonObjectNode["entries"] = [];
    this.space();
    if (this.take("}")) return { kind: "object", start, end: this.pos, entries };
    while (true) {
      if (this.source.charCodeAt(this.pos) !== 0x22) throw this.error("Expected a double-quoted property name");
      const keyStart = this.pos;
      const keyEnd = this.stringEnd();
      const key = this.decodeString(keyStart, keyEnd);
      this.space();
      if (!this.take(":")) throw this.error("Expected ':' after the property name");
      this.space();
      entries.push({ key, keyStart, value: this.value(depth + 1) });
      this.space();
      if (this.take("}")) return { kind: "object", start, end: this.pos, entries };
      if (!this.take(",")) throw this.error("Expected ',' or '}'");
      this.space();
    }
  }

  private array(depth: number): JsonArrayNode {
    const start = this.pos++;
    const elements: JsonNode[] = [];
    this.space();
    if (this.take("]")) return { kind: "array", start, end: this.pos, elements };
    while (true) {
      elements.push(this.value(depth + 1));
      this.space();
      if (this.take("]")) return { kind: "array", start, end: this.pos, elements };
      if (!this.take(",")) throw this.error("Expected ',' or ']'");
      this.space();
    }
  }

  private stringEnd(): number {
    const start = this.pos++;
    let escaped = false;
    while (this.pos < this.source.length) {
      const code = this.source.charCodeAt(this.pos++);
      if (escaped) {
        escaped = false;
        continue;
      }
      if (code === 0x5c) {
        escaped = true;
        continue;
      }
      if (code === 0x22) return this.pos;
      if (code < 0x20) throw new JsonExplorerError("Unescaped control character in string", "invalid-json", this.pos - 1);
    }
    throw new JsonExplorerError("Unterminated JSON string", "invalid-json", start);
  }

  private decodeString(start: number, end: number): string {
    try {
      return JSON.parse(this.source.slice(start, end)) as string;
    } catch {
      throw new JsonExplorerError("Invalid JSON string escape", "invalid-json", start);
    }
  }

  private space(): void {
    while (this.pos < this.source.length && /[\u0009\u000a\u000d\u0020]/u.test(this.source[this.pos])) this.pos++;
  }

  private take(char: string): boolean {
    if (this.source[this.pos] !== char) return false;
    this.pos++;
    return true;
  }

  private error(message: string): JsonExplorerError {
    return new JsonExplorerError(message, "invalid-json", this.pos);
  }
}

export function parseJsonLossless(source: string, maxDepth: number = JSON_EXPLORER_LIMITS.maxDepth): JsonNode {
  return new Parser(source, maxDepth).parse();
}

export function rawJson(node: JsonNode, source: string): string {
  return source.slice(node.start, node.end);
}

export function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function parseJsonPointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new JsonExplorerError("A JSON Pointer must be empty or start with '/'", "invalid-path");
  const parts = pointer.slice(1).split("/");
  return parts.map((part) => {
    if (/~(?:[^01]|$)/u.test(part)) throw new JsonExplorerError("Invalid '~' escape in JSON Pointer", "invalid-path");
    return part.replaceAll("~1", "/").replaceAll("~0", "~");
  });
}

export function resolveJsonPointer(root: JsonNode, pointer: string): JsonNode | undefined {
  let node: JsonNode | undefined = root;
  for (const part of parseJsonPointer(pointer)) {
    if (!node) return undefined;
    if (node.kind === "object") {
      node = [...node.entries].reverse().find((entry) => entry.key === part)?.value;
    } else if (node.kind === "array" && /^(?:0|[1-9]\d*)$/u.test(part)) {
      node = node.elements[Number(part)];
    } else {
      return undefined;
    }
  }
  return node;
}

export function jsonNodeText(node: JsonNode, source: string, max: number = JSON_EXPLORER_LIMITS.treePreviewChars): string {
  if (node.kind === "number") {
    const length = node.end - node.start;
    if (length <= max) return source.slice(node.start, node.end);
    return `${source.slice(node.start, node.start + Math.max(0, max - 1))}…`;
  }
  let text: string;
  switch (node.kind) {
    case "string": text = node.value; break;
    case "boolean": text = String(node.value); break;
    case "null": text = "null"; break;
    case "array": text = `[${node.elements.length}]`; break;
    case "object": text = `{${node.entries.length}}`; break;
  }
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

export interface JsonViewFilter {
  query: string;
  scope: "keys" | "values" | "both";
  fieldPath: string;
  fieldValue: string;
  caseSensitive: boolean;
}

function includes(haystack: string, needle: string, sensitive: boolean): boolean {
  return sensitive ? haystack.includes(needle) : haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

function searchNode(node: JsonNode, source: string, query: string, scope: JsonViewFilter["scope"], sensitive: boolean): boolean {
  if (node.kind === "object") {
    for (const entry of node.entries) {
      if (scope !== "values" && includes(entry.key, query, sensitive)) return true;
      if (searchNode(entry.value, source, query, scope, sensitive)) return true;
    }
    return false;
  }
  if (node.kind === "array") return node.elements.some((child) => searchNode(child, source, query, scope, sensitive));
  return scope !== "keys" && includes(jsonNodeText(node, source, Number.MAX_SAFE_INTEGER), query, sensitive);
}

export function recordMatches(node: JsonNode, source: string, filter: JsonViewFilter): boolean {
  if (filter.query && !searchNode(node, source, filter.query, filter.scope, filter.caseSensitive)) return false;
  if (filter.fieldPath || filter.fieldValue) {
    const field = resolveJsonPointer(node, filter.fieldPath);
    if (!field) return false;
    if (filter.fieldValue && !searchNode(field, source, filter.fieldValue, "values", filter.caseSensitive)) return false;
  }
  return true;
}

export interface ColumnDiscoveryState {
  truncated: boolean;
  retainedChars: number;
}

export function addDiscoveredColumns(node: JsonNode, found: Set<string>, state: ColumnDiscoveryState): void {
  if (node.kind !== "object") {
    if (!found.has("")) found.add("");
    return;
  }
  for (const entry of node.entries) {
    if (entry.key.length + 1 > JSON_EXPLORER_LIMITS.detectedColumnNameChars) {
      state.truncated = true;
      continue;
    }
    let pointerLength = 1;
    for (const character of entry.key) {
      pointerLength += character === "~" || character === "/" ? 2 : 1;
      if (pointerLength > JSON_EXPLORER_LIMITS.detectedColumnNameChars) break;
    }
    if (pointerLength > JSON_EXPLORER_LIMITS.detectedColumnNameChars) {
      state.truncated = true;
      continue;
    }
    const pointer = `/${pointerSegment(entry.key)}`;
    if (found.has(pointer)) continue;
    if (
      found.size >= JSON_EXPLORER_LIMITS.detectedColumns ||
      state.retainedChars + pointer.length > JSON_EXPLORER_LIMITS.detectedColumnTotalChars
    ) {
      state.truncated = true;
      continue;
    }
    found.add(pointer);
    state.retainedChars += pointer.length;
  }
}

export function normalizePointers(lines: string): string[] {
  const found = new Set<string>();
  for (const pointer of lines.split(/\r?\n/u)) {
    if (pointer === "" || found.has(pointer)) continue;
    parseJsonPointer(pointer);
    found.add(pointer);
  }
  return [...found];
}

export function projectedJson(node: JsonNode, source: string, pointers: readonly string[]): string {
  if (pointers.length === 0) return rawJson(node, source);
  return `{${pointers.map((pointer) => {
    const value = resolveJsonPointer(node, pointer);
    return `${JSON.stringify(pointer)}:${value ? rawJson(value, source) : "null"}`;
  }).join(",")}}`;
}

export function projectedCells(node: JsonNode, source: string, pointers: readonly string[]): string[] {
  const selected = pointers.length > 0 ? pointers : [""];
  return selected.map((pointer) => {
    const value = resolveJsonPointer(node, pointer);
    return value ? jsonNodeText(value, source, JSON_EXPLORER_LIMITS.cellPreviewChars) : "";
  });
}

export interface TreeChild {
  pointer: string;
  label: string;
  kind: JsonKind;
  preview: string;
  childCount: number;
}

export function treeChildren(root: JsonNode, source: string, pointer: string, start: number, count: number): { total: number; children: TreeChild[] } {
  const parent = resolveJsonPointer(root, pointer);
  if (!parent || (parent.kind !== "array" && parent.kind !== "object")) return { total: 0, children: [] };
  const total = parent.kind === "array" ? parent.elements.length : parent.entries.length;
  const first = Math.min(total, Math.max(0, start));
  const last = Math.min(total, first + Math.max(0, count));
  const children: TreeChild[] = [];
  for (let index = first; index < last; index++) {
    const label = parent.kind === "array" ? String(index) : parent.entries[index].key;
    const value = parent.kind === "array" ? parent.elements[index] : parent.entries[index].value;
    const childCount = value.kind === "array" ? value.elements.length : value.kind === "object" ? value.entries.length : 0;
    children.push({
      pointer: childCount > 0 ? `${pointer}/${pointerSegment(label)}` : "",
      label: label.length > JSON_EXPLORER_LIMITS.treePreviewChars
        ? `${label.slice(0, JSON_EXPLORER_LIMITS.treePreviewChars - 1)}…`
        : label,
      kind: value.kind,
      preview: jsonNodeText(value, source),
      childCount,
    });
  }
  return { total, children };
}

