import { getTool, TOOLS, type ToolId } from "../../../apps/site/src/registry/tools.ts";
import { TOOL_EVENTS, type ToolEventType } from "../../../apps/site/src/scripts/analytics/events.ts";
import {
  type AnalyticsReport,
  type DailyOperationCounts,
  type OperationCounts,
  type ReportPeriod,
  type ToolOperationCounts,
} from "../../../apps/site/src/scripts/analytics/reports.ts";

const ANALYTICS_ACCOUNT_ID = "5aeb7e01c612a208baf33ac1c646a048";
const REPORT_DATASETS: Record<AnalyticsReport["dataset"], true> = {
  mydevtools_tool_usage: true,
  mydevtools_tool_usage_staging: true,
};
const EVENT_FIELDS: Record<ToolEventType, keyof OperationCounts> = {
  tool_started: "started",
  tool_completed: "completed",
  tool_failed: "failed",
};
const QUERY_TIMEOUT_MS = 10_000;

export interface ReportEnv {
  ANALYTICS_READ_TOKEN?: string;
  ANALYTICS_ACCESS_AUD?: string;
  ANALYTICS_ACCOUNT_ID?: string;
  ANALYTICS_REPORT_DATASET?: string;
}

type ReportConfig = {
  token: string;
  audience: string;
  accountId: string;
  dataset: AnalyticsReport["dataset"];
};

type SqlRow = Record<string, unknown>;

class ReportQueryError extends Error {
  readonly timedOut: boolean;

  constructor(timedOut: boolean) {
    super("Analytics report query failed");
    this.timedOut = timedOut;
  }
}

function reportResponse(status: number, body: unknown, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Robots-Tag", "noindex");
  return Response.json(body, { status, headers });
}

function reportError(status: number, error: string, extraHeaders?: HeadersInit): Response {
  return reportResponse(status, { error }, extraHeaders);
}

function readConfig(env: ReportEnv): ReportConfig | null {
  const token = env.ANALYTICS_READ_TOKEN;
  const audience = env.ANALYTICS_ACCESS_AUD;
  const accountId = env.ANALYTICS_ACCOUNT_ID;
  const dataset = env.ANALYTICS_REPORT_DATASET;
  const hasKnownDataset =
    typeof dataset === "string" && Object.hasOwn(REPORT_DATASETS, dataset);

  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > 4096 ||
    token.trim() !== token ||
    /[\u0000-\u001f\u007f]/.test(token) ||
    typeof audience !== "string" ||
    !/^[A-Za-z0-9_-]{16,256}$/.test(audience) ||
    accountId !== ANALYTICS_ACCOUNT_ID ||
    !hasKnownDataset
  ) {
    return null;
  }

  // Object.hasOwn above narrows the external string to the two configured datasets at runtime.
  const configuredDataset = dataset as AnalyticsReport["dataset"];
  return { token, audience, accountId, dataset: configuredDataset };
}

function readPeriod(url: URL): ReportPeriod | null {
  const entries = [...url.searchParams.entries()];
  if (entries.length !== 1 || entries[0]![0] !== "days") return null;
  switch (entries[0]![1]) {
    case "7":
      return 7;
    case "30":
      return 30;
    case "90":
      return 90;
    default:
      return null;
  }
}

async function hasEmptyBody(request: Request): Promise<boolean> {
  if (request.headers.has("Content-Encoding")) return false;
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null && contentLength !== "0") return false;
  if (request.body === null) return true;

  const reader = request.body.getReader();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return true;
      if (part.value.byteLength === 0) continue;
      try {
        await reader.cancel();
      } catch {
        // The request is already rejected; cancellation is best effort.
      }
      return false;
    }
  } catch {
    return false;
  } finally {
    reader.releaseLock();
  }
}

function toolQuery(config: ReportConfig, days: ReportPeriod): string {
  const limit = TOOLS.length * TOOL_EVENTS.length;
  return `SELECT blob1 AS tool, blob2 AS event,
       SUM(_sample_interval * double1) AS operations,
       MAX(_sample_interval) AS maximum_sample_interval
FROM ${config.dataset}
WHERE timestamp >= NOW() - INTERVAL '${days}' DAY
GROUP BY blob1, blob2
ORDER BY tool, event
LIMIT ${limit}
FORMAT JSON`;
}

function dailyQuery(config: ReportConfig, days: ReportPeriod): string {
  const limit = (days + 1) * TOOL_EVENTS.length;
  return `SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day,
       blob2 AS event,
       SUM(_sample_interval * double1) AS operations,
       MAX(_sample_interval) AS maximum_sample_interval
FROM ${config.dataset}
WHERE timestamp >= NOW() - INTERVAL '${days}' DAY
GROUP BY day, blob2
ORDER BY day, event
LIMIT ${limit}
FORMAT JSON`;
}

async function queryAnalyticsEngine(
  config: ReportConfig,
  query: string,
  maximumRows: number,
): Promise<SqlRow[]> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, QUERY_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/analytics_engine/sql`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "text/plain; charset=utf-8",
        },
        body: query,
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new ReportQueryError(false);

    let value: unknown;
    try {
      value = JSON.parse(await response.text()) as unknown;
    } catch {
      throw new ReportQueryError(false);
    }
    if (typeof value !== "object" || value === null || !("data" in value)) {
      throw new ReportQueryError(false);
    }
    const data = value.data;
    if (!Array.isArray(data) || data.length > maximumRows) {
      throw new ReportQueryError(false);
    }
    for (const row of data) {
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new ReportQueryError(false);
      }
    }
    return data as SqlRow[];
  } catch (error) {
    if (error instanceof ReportQueryError) throw error;
    throw new ReportQueryError(timedOut);
  } finally {
    clearTimeout(timeout);
  }
}

function readNonnegativeInteger(value: unknown): number | null {
  let number: number;
  if (typeof value === "number") {
    number = value;
  } else if (typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.0+)?$/.test(value)) {
    number = Number(value);
  } else {
    return null;
  }
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function readPositiveInteger(value: unknown): number | null {
  const number = readNonnegativeInteger(value);
  return number !== null && number > 0 ? number : null;
}

function readEvent(value: unknown): ToolEventType | null {
  return typeof value === "string" && Object.hasOwn(EVENT_FIELDS, value)
    ? (value as ToolEventType)
    : null;
}

function addCount(left: number, right: number): number | null {
  const result = left + right;
  return Number.isSafeInteger(result) ? result : null;
}

function readUtcDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]00:00:00(?:\.0+)?Z?)?$/.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function aggregateTools(rows: SqlRow[]): {
  summary: OperationCounts;
  tools: ToolOperationCounts[];
  maximumSampleInterval: number;
} | null {
  const byTool = new Map<ToolId, ToolOperationCounts>();
  let maximumSampleInterval = 0;

  for (const row of rows) {
    if (typeof row.tool !== "string" || getTool(row.tool) === undefined) return null;
    const event = readEvent(row.event);
    const operations = readNonnegativeInteger(row.operations);
    const rowMaximum = readPositiveInteger(row.maximum_sample_interval);
    if (event === null || operations === null || rowMaximum === null) return null;

    const tool = row.tool as ToolId;
    let counts = byTool.get(tool);
    if (counts === undefined) {
      counts = { tool, started: 0, completed: 0, failed: 0, maximumSampleInterval: 0 };
      byTool.set(tool, counts);
    }
    const field = EVENT_FIELDS[event];
    const total = addCount(counts[field], operations);
    if (total === null) return null;
    counts[field] = total;
    counts.maximumSampleInterval = Math.max(counts.maximumSampleInterval, rowMaximum);
    maximumSampleInterval = Math.max(maximumSampleInterval, rowMaximum);
  }

  const tools = [...byTool.values()].sort(
    (left, right) =>
      right.completed - left.completed ||
      right.started - left.started ||
      right.failed - left.failed ||
      left.tool.localeCompare(right.tool),
  );
  const summary: OperationCounts = { started: 0, completed: 0, failed: 0 };
  for (const tool of tools) {
    for (const field of ["started", "completed", "failed"] as const) {
      const total = addCount(summary[field], tool[field]);
      if (total === null) return null;
      summary[field] = total;
    }
  }

  return { summary, tools, maximumSampleInterval };
}

function aggregateDaily(rows: SqlRow[]): {
  daily: DailyOperationCounts[];
  maximumSampleInterval: number;
} | null {
  const byDay = new Map<string, DailyOperationCounts>();
  let maximumSampleInterval = 0;

  for (const row of rows) {
    const day = readUtcDay(row.day);
    const event = readEvent(row.event);
    const operations = readNonnegativeInteger(row.operations);
    const rowMaximum = readPositiveInteger(row.maximum_sample_interval);
    if (day === null || event === null || operations === null || rowMaximum === null) return null;

    let counts = byDay.get(day);
    if (counts === undefined) {
      counts = { day, started: 0, completed: 0, failed: 0 };
      byDay.set(day, counts);
    }
    const field = EVENT_FIELDS[event];
    const total = addCount(counts[field], operations);
    if (total === null) return null;
    counts[field] = total;
    maximumSampleInterval = Math.max(maximumSampleInterval, rowMaximum);
  }

  return {
    daily: [...byDay.values()].sort((left, right) => left.day.localeCompare(right.day)),
    maximumSampleInterval,
  };
}

export async function handleReportRequest(
  request: Request,
  url: URL,
  env: ReportEnv,
  access: CloudflareAccessContext | undefined,
  allowedOrigin: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return reportError(405, "Method not allowed", { Allow: "POST" });
  }

  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (
    (origin !== null && origin !== allowedOrigin) ||
    (fetchSite !== null && fetchSite.toLowerCase() !== "same-origin")
  ) {
    return reportError(403, "Forbidden");
  }

  const config = readConfig(env);
  if (config === null) return reportError(503, "Reports unavailable");
  if (access === undefined || access.aud !== config.audience) {
    return reportError(403, "Forbidden");
  }

  const days = readPeriod(url);
  if (days === null || !(await hasEmptyBody(request))) {
    return reportError(400, "Invalid request");
  }

  try {
    const [toolRows, dailyRows] = await Promise.all([
      queryAnalyticsEngine(config, toolQuery(config, days), TOOLS.length * TOOL_EVENTS.length),
      queryAnalyticsEngine(
        config,
        dailyQuery(config, days),
        (days + 1) * TOOL_EVENTS.length,
      ),
    ]);
    const toolReport = aggregateTools(toolRows);
    const dailyReport = aggregateDaily(dailyRows);
    if (toolReport === null || dailyReport === null) {
      return reportError(502, "Analytics service unavailable");
    }

    const report: AnalyticsReport = {
      periodDays: days,
      generatedAt: new Date().toISOString(),
      dataset: config.dataset,
      summary: toolReport.summary,
      tools: toolReport.tools,
      daily: dailyReport.daily,
      maximumSampleInterval: Math.max(
        toolReport.maximumSampleInterval,
        dailyReport.maximumSampleInterval,
      ),
    };
    return reportResponse(200, report);
  } catch (error) {
    const status = error instanceof ReportQueryError && error.timedOut ? 504 : 502;
    return reportError(status, "Analytics service unavailable");
  }
}
