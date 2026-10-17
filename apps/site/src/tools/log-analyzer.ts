import { JsonExplorerError, JsonlLineDecoder, type JsonlDecodedLine } from "./json-explorer-core.ts";

export const LOG_ANALYZER_LIMITS = {
  chunkBytes: 1024 * 1024,
  maxLineBytes: 2 * 1024 * 1024,
  maxRecords: 100_000_000,
  sourceCheckpointStride: 512,
  filterCheckpointStride: 256,
  maxRangeRecords: 250,
  maxFilterChars: 512,
  maxAggregateKeys: 2_000,
  maxAggregateValueChars: 512,
  maxTemporalMinutes: 4_096,
  maxChartBuckets: 120,
  maxTopItems: 12,
  maxPreviewChars: 2_000,
  maxInspectorChars: 64 * 1024,
  maxExportFallbackBytes: 512 * 1024 * 1024,
} as const;

export type LogPreset = "auto" | "serilog" | "nginx-access" | "nginx-error" | "jsonl" | "text";
export type ResolvedLogPreset = Exclude<LogPreset, "auto">;
export type LogSeverity = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "unknown";

export const LOG_SEVERITIES: readonly LogSeverity[] = ["trace", "debug", "info", "warn", "error", "fatal", "unknown"];

export interface ParsedLogRecord {
  line: number;
  raw: string;
  timestamp: number | null;
  timestampText: string;
  severity: LogSeverity;
  source: string;
  correlationId: string;
  message: string;
  /** Stable unrendered template used to group otherwise variable messages. */
  messageTemplate: string;
  errorType: string;
  malformed: boolean;
}

export interface LogFilter {
  from: number | null;
  to: number | null;
  severities: readonly LogSeverity[];
  source: string;
  correlationId: string;
  search: string;
}
export interface PreparedLogFilter extends LogFilter {
  normalizedSource: string;
  normalizedCorrelationId: string;
  normalizedSearch: string;
}


export interface CountedValue {
  value: string;
  count: number;
}

export interface TemporalBucket {
  from: number;
  to: number;
  count: number;
}

export interface LogAnalysis {
  recordCount: number;
  malformedCount: number;
  severityCounts: Record<LogSeverity, number>;
  errorTypes: CountedValue[];
  topMessages: CountedValue[];
  temporal: TemporalBucket[];
  aggregateLimitReached: boolean;
}

export type LogAnalyzerErrorCode =
  | "empty"
  | "invalid-utf8"
  | "line-too-large"
  | "record-limit"
  | "filter-too-large"
  | "session-missing";

export class LogAnalyzerError extends Error {
  readonly code: LogAnalyzerErrorCode;

  constructor(code: LogAnalyzerErrorCode, message: string) {
    super(message);
    this.name = "LogAnalyzerError";
    this.code = code;
  }
}

function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return "";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstValue(objects: readonly (Record<string, unknown> | null)[], keys: readonly string[]): string {
  for (const object of objects) {
    if (!object) continue;
    for (const key of keys) {
      const value = scalar(object[key]);
      if (value) return value;
    }
  }
  return "";
}

function normalizeSeverity(value: string): LogSeverity {
  switch (value.trim().toLowerCase()) {
    case "trace":
    case "verbose":
    case "vrb":
    case "trce": return "trace";
    case "debug":
    case "dbg":
    case "dbug": return "debug";
    case "information":
    case "info":
    case "inf": return "info";
    case "warning":
    case "warn":
    case "wrn": return "warn";
    case "error":
    case "err":
    case "fail": return "error";
    case "fatal":
    case "critical":
    case "crit":
    case "ftl": return "fatal";
    default: return "unknown";
  }
}

function parseTimestamp(value: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function exceptionType(value: string): string {
  if (!value) return "";
  const first = value.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  const match = first.match(/(?:^|--->\s+)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:Exception|Error))(?=\s*:|\s|$)/u);
  return match?.[1] ?? "";
}

function parseJsonRecord(raw: string, line: number, requireSerilog: boolean): ParsedLogRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return malformedRecord(raw, line);
  }
  const root = objectValue(parsed);
  if (!root) {
    if (requireSerilog) return malformedRecord(raw, line);
    const message = typeof parsed === "string" ? parsed : raw;
    return {
      line,
      raw,
      timestamp: null,
      timestampText: "",
      severity: "unknown",
      source: "",
      correlationId: "",
      message,
      messageTemplate: message,
      errorType: "",
      malformed: false,
    };
  }
  const properties = objectValue(root.Properties) ?? objectValue(root.properties);
  const objects = [root, properties] as const;
  const timestampText = firstValue(objects, ["@t", "Timestamp", "timestamp", "time", "datetime", "date"]);
  const level = firstValue(objects, ["@l", "Level", "level", "LogLevel", "severity", "Severity"]);
  const rendered = firstValue(objects, ["@m", "RenderedMessage", "renderedMessage", "Message", "message", "msg"]);
  const template = firstValue(objects, ["@mt", "MessageTemplate", "messageTemplate", "template"]);
  const exception = firstValue(objects, ["@x", "Exception", "exception", "error", "Error"]);
  const source = firstValue(objects, ["SourceContext", "source", "Source", "logger", "Logger", "category"]);
  const correlationId = firstValue(objects, [
    "CorrelationId", "correlationId", "correlation_id", "RequestId", "requestId", "request_id",
    "TraceId", "traceId", "trace_id", "ActivityId", "activityId", "@tr",
  ]);
  const serilogShape = ["@t", "@l", "@m", "@mt", "@x", "Timestamp", "Level", "MessageTemplate", "RenderedMessage"]
    .some((key) => Object.hasOwn(root, key));
  if (requireSerilog && !serilogShape) return malformedRecord(raw, line);
  const message = rendered || template || exception || raw;
  return {
    line,
    raw,
    timestamp: parseTimestamp(timestampText),
    timestampText,
    severity: !level && Object.hasOwn(root, "@t") && !Object.hasOwn(root, "@l") ? "info" : normalizeSeverity(level),
    source,
    correlationId,
    message,
    messageTemplate: template || message,
    errorType: exceptionType(exception),
    malformed: false,
  };
}

const NGINX_ACCESS = /^(\S+)\s+\S+\s+(\S+)\s+\[([^\]]+)\]\s+"([A-Z]+)\s+([^"\s]+)(?:\s+HTTP\/[^"\s]+)?"\s+(\d{3})\s+(\S+)(?:\s+"([^"]*)"\s+"([^"]*)")?(.*)$/u;
const NGINX_ERROR = /^(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})\s+\[([^\]]+)\]\s+(?:\d+#\d+:\s+)?(?:\*(\d+)\s+)?(.*)$/u;

function parseNginxDate(value: string): number | null {
  const access = value.match(/^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s+([+-]\d{4})$/u);
  if (access) {
    const months: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
    const month = months[access[2]];
    if (month === undefined) return null;
    const sign = access[7][0] === "-" ? -1 : 1;
    const offsetMinutes = sign * (Number(access[7].slice(1, 3)) * 60 + Number(access[7].slice(3, 5)));
    return Date.UTC(Number(access[3]), month, Number(access[1]), Number(access[4]), Number(access[5]), Number(access[6])) - offsetMinutes * 60_000;
  }
  const error = value.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/u);
  return error ? Date.UTC(Number(error[1]), Number(error[2]) - 1, Number(error[3]), Number(error[4]), Number(error[5]), Number(error[6])) : null;
}

function taggedId(raw: string): string {
  return raw.match(/(?:request[_-]?id|correlation[_-]?id|trace[_-]?id)[=:"\s]+([A-Za-z0-9._:-]+)/iu)?.[1] ?? "";
}

function parseNginxAccess(raw: string, line: number): ParsedLogRecord {
  const match = raw.match(NGINX_ACCESS);
  if (!match) return malformedRecord(raw, line);
  const status = Number(match[6]);
  const message = `${match[4]} ${match[5]} ${match[6]}`;
  return {
    line,
    raw,
    timestamp: parseNginxDate(match[3]),
    timestampText: match[3],
    severity: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
    source: match[1],
    correlationId: taggedId(match[10] ?? ""),
    message,
    messageTemplate: `${match[4]} ${match[5]} {status}`,
    errorType: status >= 400 ? `HTTP ${Math.floor(status / 100)}xx` : "",
    malformed: false,
  };
}

function parseNginxError(raw: string, line: number): ParsedLogRecord {
  const match = raw.match(NGINX_ERROR);
  if (!match) return malformedRecord(raw, line);
  const message = match[4];
  const source = message.match(/(?:server|upstream):\s*([^,]+)/iu)?.[1]?.trim() ?? "nginx";
  return {
    line,
    raw,
    timestamp: parseNginxDate(match[1]),
    timestampText: match[1],
    severity: normalizeSeverity(match[2]),
    source,
    correlationId: taggedId(message) || match[3] || "",
    message,
    messageTemplate: message,
    errorType: exceptionType(message),
    malformed: false,
  };
}

const DOTNET_LINE = /^(\d{4}-\d{2}-\d{2}[T ][^\s]+)?\s*(trce|dbug|info|warn|fail|crit|trace|debug|information|warning|error|fatal|critical)\s*:?\s*([^\s\[]+)?(?:\[([^\]]*)\])?\s*:?[ \t]*(.*)$/iu;

function parseText(raw: string, line: number, strictDotNet = false): ParsedLogRecord {
  const dotnet = raw.match(DOTNET_LINE);
  if (strictDotNet && !dotnet) return malformedRecord(raw, line);
  const timestampText = dotnet?.[1] ?? raw.match(/^(?:\[)?(\d{4}-\d{2}-\d{2}[T ][^\]\s]+)/u)?.[1] ?? "";
  const severityText = dotnet?.[2] ?? raw.match(/\b(trace|verbose|debug|information|info|warning|warn|error|fatal|critical|crit|fail)\b/iu)?.[1] ?? "";
  const source = dotnet?.[3] ?? raw.match(/\[([^\]]+)\]/u)?.[1] ?? "";
  const message = dotnet?.[5] || raw;
  return {
    line,
    raw,
    timestamp: parseTimestamp(timestampText),
    timestampText,
    severity: normalizeSeverity(severityText),
    source,
    correlationId: taggedId(raw),
    message,
    messageTemplate: message,
    errorType: exceptionType(raw),
    malformed: false,
  };
}

function malformedRecord(raw: string, line: number): ParsedLogRecord {
  return {
    line,
    raw,
    timestamp: null,
    timestampText: "",
    severity: "unknown",
    source: "",
    correlationId: "",
    message: raw,
    messageTemplate: raw,
    errorType: "",
    malformed: true,
  };
}

export function detectLogPreset(raw: string): ResolvedLogPreset {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const object = objectValue(JSON.parse(raw));
      if (object && ["@t", "@l", "@m", "@mt", "@x", "Timestamp", "Level", "MessageTemplate", "RenderedMessage"]
        .some((key) => Object.hasOwn(object, key))) return "serilog";
    } catch {
      return "jsonl";
    }
    return "jsonl";
  }
  if (NGINX_ACCESS.test(raw)) return "nginx-access";
  if (NGINX_ERROR.test(raw)) return "nginx-error";
  if (DOTNET_LINE.test(raw)) return "serilog";
  return "text";
}

export function parseLogRecord(raw: string, line: number, preset: ResolvedLogPreset): ParsedLogRecord {
  switch (preset) {
    case "serilog": return raw.trimStart().startsWith("{") ? parseJsonRecord(raw, line, true) : parseText(raw, line, true);
    case "jsonl": return parseJsonRecord(raw, line, false);
    case "nginx-access": return parseNginxAccess(raw, line);
    case "nginx-error": return parseNginxError(raw, line);
    case "text": return parseText(raw, line);
  }
}

export function validateLogFilter(filter: LogFilter): LogFilter {
  for (const value of [filter.source, filter.correlationId, filter.search]) {
    if (value.length > LOG_ANALYZER_LIMITS.maxFilterChars) {
      throw new LogAnalyzerError("filter-too-large", "A filter exceeds the configured character limit");
    }
  }
  if (filter.from !== null && !Number.isFinite(filter.from)) throw new LogAnalyzerError("filter-too-large", "The start time is invalid");
  if (filter.to !== null && !Number.isFinite(filter.to)) throw new LogAnalyzerError("filter-too-large", "The end time is invalid");
  const severities = [...new Set(filter.severities)].filter((value): value is LogSeverity => LOG_SEVERITIES.includes(value));
  return { ...filter, severities };
}
export function prepareLogFilter(filter: LogFilter): PreparedLogFilter {
  const validated = validateLogFilter(filter);
  return {
    ...validated,
    normalizedSource: validated.source.trim().toLocaleLowerCase(),
    normalizedCorrelationId: validated.correlationId.trim().toLocaleLowerCase(),
    normalizedSearch: validated.search.toLocaleLowerCase(),
  };
}


export function logRecordMatches(record: ParsedLogRecord, filter: PreparedLogFilter | null): boolean {
  if (!filter) return true;
  if (filter.from !== null && (record.timestamp === null || record.timestamp < filter.from)) return false;
  if (filter.to !== null && (record.timestamp === null || record.timestamp > filter.to)) return false;
  if (!filter.severities.includes(record.severity)) return false;
  if (filter.normalizedSource && !record.source.toLocaleLowerCase().includes(filter.normalizedSource)) return false;
  if (filter.normalizedCorrelationId && !record.correlationId.toLocaleLowerCase().includes(filter.normalizedCorrelationId)) return false;
  if (filter.normalizedSearch && !record.raw.toLocaleLowerCase().includes(filter.normalizedSearch)) return false;
  return true;
}

function emptySeverityCounts(): Record<LogSeverity, number> {
  return { trace: 0, debug: 0, info: 0, warn: 0, error: 0, fatal: 0, unknown: 0 };
}

function addBounded(map: Map<string, number>, value: string, maximum: number): boolean {
  if (!value) return false;
  const limited = value.length > LOG_ANALYZER_LIMITS.maxAggregateValueChars;
  const key = limited ? previewLogValue(value, LOG_ANALYZER_LIMITS.maxAggregateValueChars) : value;
  const count = map.get(key);
  if (count !== undefined) {
    map.set(key, count + 1);
    return limited;
  }
  if (map.size >= maximum) return true;
  map.set(key, 1);
  return limited;
}

function topValues(map: ReadonlyMap<string, number>): CountedValue[] {
  return [...map].map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
    .slice(0, LOG_ANALYZER_LIMITS.maxTopItems);
}

export class LogAnalysisAccumulator {
  private recordCount = 0;
  private malformedCount = 0;
  private readonly severityCounts = emptySeverityCounts();
  private readonly errors = new Map<string, number>();
  private readonly messages = new Map<string, number>();
  private readonly minutes = new Map<number, number>();
  private limited = false;

  add(record: ParsedLogRecord): void {
    this.recordCount++;
    if (record.malformed) this.malformedCount++;
    this.severityCounts[record.severity]++;
    this.limited = addBounded(this.errors, record.errorType, LOG_ANALYZER_LIMITS.maxAggregateKeys) || this.limited;
    this.limited = addBounded(this.messages, record.messageTemplate, LOG_ANALYZER_LIMITS.maxAggregateKeys) || this.limited;
    if (record.timestamp !== null) {
      const minute = Math.floor(record.timestamp / 60_000) * 60_000;
      const count = this.minutes.get(minute);
      if (count !== undefined) this.minutes.set(minute, count + 1);
      else if (this.minutes.size < LOG_ANALYZER_LIMITS.maxTemporalMinutes) this.minutes.set(minute, 1);
      else this.limited = true;
    }
  }

  finish(): LogAnalysis {
    const ordered = [...this.minutes].sort((left, right) => left[0] - right[0]);
    const temporal: TemporalBucket[] = [];
    if (ordered.length > 0) {
      const minimum = ordered[0][0];
      const maximum = ordered[ordered.length - 1][0] + 60_000;
      const bucketWidth = Math.max(60_000, Math.ceil((maximum - minimum) / LOG_ANALYZER_LIMITS.maxChartBuckets / 60_000) * 60_000);
      for (const [minute, count] of ordered) {
        const from = minimum + Math.floor((minute - minimum) / bucketWidth) * bucketWidth;
        const previous = temporal[temporal.length - 1];
        if (previous?.from === from) previous.count += count;
        else temporal.push({ from, to: from + bucketWidth, count });
      }
    }
    return {
      recordCount: this.recordCount,
      malformedCount: this.malformedCount,
      severityCounts: { ...this.severityCounts },
      errorTypes: topValues(this.errors),
      topMessages: topValues(this.messages),
      temporal,
      aggregateLimitReached: this.limited,
    };
  }
}

/** Adapt the shared bounded JSONL decoder and normalize its errors for log callers. */
export class LogLineDecoder {
  private readonly decoder: JsonlLineDecoder;

  constructor(startOffset = 0, startPhysicalLine = 1) {
    this.decoder = new JsonlLineDecoder(LOG_ANALYZER_LIMITS.maxLineBytes, startOffset, startPhysicalLine);
  }

  push(bytes: Uint8Array): JsonlDecodedLine[] {
    try {
      return this.decoder.push(bytes);
    } catch (error) {
      throw normalizeDecoderError(error);
    }
  }

  finish(finalOffset: number): JsonlDecodedLine[] {
    try {
      return this.decoder.finish(finalOffset);
    } catch (error) {
      throw normalizeDecoderError(error);
    }
  }
}

function normalizeDecoderError(error: unknown): unknown {
  if (!(error instanceof JsonExplorerError)) return error;
  if (error.code === "record-limit") return new LogAnalyzerError("line-too-large", error.message);
  if (error.code === "invalid-utf8") return new LogAnalyzerError("invalid-utf8", error.message);
  return error;
}

const encoder = new TextEncoder();

/** Recreate one source line byte-for-byte, including BOM and its original terminator. */
export function encodeOriginalLogLine(line: JsonlDecodedLine): Uint8Array {
  const text = encoder.encode(line.text);
  const terminator = encoder.encode(line.terminator);
  const bomBytes = line.leadingBom ? 3 : 0;
  const result = new Uint8Array(bomBytes + text.length + terminator.length);
  if (line.leadingBom) result.set([0xef, 0xbb, 0xbf]);
  result.set(text, bomBytes);
  result.set(terminator, bomBytes + text.length);
  return result;
}

export function previewLogValue(value: string, maximum: number = LOG_ANALYZER_LIMITS.maxPreviewChars): string {
  if (value.length <= maximum) return value;
  const last = value.charCodeAt(maximum - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? maximum - 1 : maximum;
  return `${value.slice(0, end)}…`;
}
