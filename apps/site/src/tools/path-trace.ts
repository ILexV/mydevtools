/**
 * Path trace (MTR) reports and saved probe settings.
 * The page builds text and HTML from an agent snapshot. The agent writes no files.
 * Null round-trip times render as an en dash, never as zero. Hop results are not stored.
 */

export const PATH_TRACE_STORAGE_KEY = "mdt.path-trace.v1";
export const PATH_TRACE_HISTORY_LIMIT = 20;

export const TRACE_INTERVAL_MS = { min: 200, max: 60_000, default: 1000 } as const;
export const TRACE_PAYLOAD_BYTES = { min: 0, max: 1472, default: 64 } as const;
export const TRACE_MAX_HOPS = { min: 1, max: 64, default: 30 } as const;
export const TRACE_TIMEOUT_MS = { min: 100, max: 30_000, default: 5000 } as const;

const TARGET_MAX_CHARS = 253;
const RTT_GAP = "\u2014";

export interface PathTraceSettings {
  v: 1;
  targets: string[];
  intervalMs: number;
  payloadBytes: number;
  maxHops: number;
  timeoutMs: number;
  resolveNames: boolean;
  /** Chosen local address. Empty with `sourceInterface` means automatic. */
  sourceAddress: string;
  /** Interface name that owns `sourceAddress`. A missing address falls back to automatic. */
  sourceInterface: string;
}

export interface PathTraceHopView {
  hop: number;
  address: string | null;
  name: string | null;
  sent: number;
  received: number;
  lossPercent: number;
  lastMs: number | null;
  bestMs: number | null;
  avgMs: number | null;
  worstMs: number | null;
  /** Sample standard deviation of reply RTTs. Null until two replies. */
  stdevMs: number | null;
  /** Average absolute gap between consecutive reply RTTs. Null until two replies. */
  jitterMs: number | null;
  status: string | null;
}

export interface PathTraceReport {
  targetInput: string;
  target: string;
  hops: readonly PathTraceHopView[];
}

export interface PathTraceReportLabels {
  title: string;
  target: string;
  resolved: string;
  hostname: string;
  nr: string;
  loss: string;
  sent: string;
  recv: string;
  best: string;
  avg: string;
  worst: string;
  last: string;
  stdev: string;
  jitter: string;
  status: string;
  noResponse: string;
  statusText: (code: string) => string;
}

export function defaultPathTraceSettings(): PathTraceSettings {
  return {
    v: 1,
    targets: [],
    intervalMs: TRACE_INTERVAL_MS.default,
    payloadBytes: TRACE_PAYLOAD_BYTES.default,
    maxHops: TRACE_MAX_HOPS.default,
    timeoutMs: TRACE_TIMEOUT_MS.default,
    resolveNames: true,
    sourceAddress: "",
    sourceInterface: "",
  };
}

const MAX_SOURCE_ADDRESS_CHARS = 64;
const MAX_INTERFACE_CHARS = 256;

/** A saved source is a local address plus its interface name. Half a pair is dropped. */
function storedSource(address: unknown, interfaceName: unknown): { sourceAddress: string; sourceInterface: string } {
  if (typeof address !== "string" || typeof interfaceName !== "string") {
    return { sourceAddress: "", sourceInterface: "" };
  }
  if (!address || !interfaceName) return { sourceAddress: "", sourceInterface: "" };
  if ([...address].length > MAX_SOURCE_ADDRESS_CHARS || [...interfaceName].length > MAX_INTERFACE_CHARS) {
    return { sourceAddress: "", sourceInterface: "" };
  }
  if (/[\u0000\n\r]/.test(interfaceName) || /[\s\u0000\n\r]/.test(address)) {
    return { sourceAddress: "", sourceInterface: "" };
  }
  return { sourceAddress: address, sourceInterface: interfaceName };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function inRange(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

/** Restores probe settings. Unknown or out-of-range fields fall back to defaults. Hop rows are ignored. */
export function parsePathTraceSettings(value: unknown): PathTraceSettings {
  const base = defaultPathTraceSettings();
  if (!isObject(value) || value.v !== 1) return base;
  const targets = Array.isArray(value.targets)
    ? value.targets
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => normalizeTarget(item) !== null)
      .slice(0, PATH_TRACE_HISTORY_LIMIT)
    : [];
  return {
    v: 1,
    targets,
    intervalMs: inRange(value.intervalMs, TRACE_INTERVAL_MS.min, TRACE_INTERVAL_MS.max) ?? base.intervalMs,
    payloadBytes: inRange(value.payloadBytes, TRACE_PAYLOAD_BYTES.min, TRACE_PAYLOAD_BYTES.max) ?? base.payloadBytes,
    maxHops: inRange(value.maxHops, TRACE_MAX_HOPS.min, TRACE_MAX_HOPS.max) ?? base.maxHops,
    timeoutMs: inRange(value.timeoutMs, TRACE_TIMEOUT_MS.min, TRACE_TIMEOUT_MS.max) ?? base.timeoutMs,
    resolveNames: typeof value.resolveNames === "boolean" ? value.resolveNames : base.resolveNames,
    ...storedSource(value.sourceAddress, value.sourceInterface),
  };
}

/** Moves a successfully started target to the front and keeps at most 20 unique names. */
export function rememberTarget(targets: readonly string[], target: string): string[] {
  return [target, ...targets.filter((item) => item !== target)].slice(0, PATH_TRACE_HISTORY_LIMIT);
}

/**
 * One user target: a host name or IP, matching the agent rule.
 * Rejects empty input, URLs, paths, and control characters. IPv6 colons stay allowed.
 */
export function normalizeTarget(raw: string): string | null {
  const target = raw.trim();
  if (!target || [...target].length > TARGET_MAX_CHARS) return null;
  if (/[\s\p{Cc}]/u.test(target)) return null;
  if (/[\\/@?#]/.test(target)) return null;
  return target;
}

/** Whole milliseconds or bytes inside an inclusive agent limit. */
export function parseBoundedInteger(raw: string, min: number, max: number): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) return null;
  return value;
}

function rtt(value: number | null): string {
  return value === null ? RTT_GAP : String(value);
}

/** Tenths of a millisecond. An en dash until two reply samples exist. */
export function formatSpreadMs(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return RTT_GAP;
  return (Math.round(value * 10) / 10).toFixed(1);
}

function plainCell(value: string): string {
  return value.replace(/[\t\r\n]+/g, " ");
}

/** Host column: reverse name, else address, else "no response" for a silent timeout. */
export function hopHostname(
  hop: Pick<PathTraceHopView, "name" | "address" | "status">,
  labels: Pick<PathTraceReportLabels, "noResponse" | "statusText">,
): string {
  if (hop.name) return hop.name;
  if (hop.address) return hop.address;
  if (!hop.status || hop.status === "timeout") return labels.noResponse;
  return labels.statusText(hop.status);
}

export function hopStatusLabel(status: string | null, statusText: (code: string) => string): string {
  if (!status) return RTT_GAP;
  return statusText(status);
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function reportRows(report: PathTraceReport, labels: PathTraceReportLabels): string[][] {
  return report.hops.map((hop) => [
    hopHostname(hop, labels),
    String(hop.hop),
    String(hop.lossPercent),
    String(hop.sent),
    String(hop.received),
    rtt(hop.bestMs),
    rtt(hop.avgMs),
    rtt(hop.worstMs),
    rtt(hop.lastMs),
    formatSpreadMs(hop.stdevMs),
    formatSpreadMs(hop.jitterMs),
    hopStatusLabel(hop.status, labels.statusText),
  ]);
}

function headerCells(labels: PathTraceReportLabels): string[] {
  return [
    labels.hostname,
    labels.nr,
    labels.loss,
    labels.sent,
    labels.recv,
    labels.best,
    labels.avg,
    labels.worst,
    labels.last,
    labels.stdev,
    labels.jitter,
    labels.status,
  ];
}

/** Tab-separated hop table plus the typed target and the resolved address. */
export function formatPathTraceText(report: PathTraceReport, labels: PathTraceReportLabels): string {
  const header = headerCells(labels).map(plainCell).join("\t");
  const rows = reportRows(report, labels).map((row) => row.map(plainCell).join("\t"));
  return [
    labels.title,
    `${labels.target}: ${plainCell(report.targetInput)}`,
    `${labels.resolved}: ${plainCell(report.target)}`,
    "",
    header,
    ...rows,
    "",
  ].join("\n");
}

/** HTML table for download and copy. Every dynamic string is escaped. */
export function formatPathTraceHtml(report: PathTraceReport, labels: PathTraceReportLabels): string {
  const headers = headerCells(labels).map((cell) => `<th>${escapeHtml(cell)}</th>`).join("");
  const rows = reportRows(report, labels).map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("");
  return [
    "<!DOCTYPE html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml(labels.title)}</title>`,
    "</head>",
    "<body>",
    `<h1>${escapeHtml(labels.title)}</h1>`,
    `<p>${escapeHtml(labels.target)}: ${escapeHtml(report.targetInput)}</p>`,
    `<p>${escapeHtml(labels.resolved)}: ${escapeHtml(report.target)}</p>`,
    "<table>",
    `<thead><tr>${headers}</tr></thead>`,
    `<tbody>${rows}</tbody>`,
    "</table>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
