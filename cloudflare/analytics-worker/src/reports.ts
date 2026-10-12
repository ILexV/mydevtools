import { getTool, TOOLS } from "../../../apps/site/src/registry/tools.ts";
import {
  DURATION_BUCKETS,
  TOOL_ERROR_CATEGORIES,
  TOOL_EVENTS,
  VOTE_CHOICES,
  VOTE_EVENT,
  type DurationBucket,
  type ToolErrorCategory,
  type ToolEventType,
} from "../../../apps/site/src/scripts/analytics/events.ts";
import {
  ANALYTICS_ARCHIVE_ENDPOINT,
  ANALYTICS_HISTORY_ENDPOINT,
  ANALYTICS_REPORT_ENDPOINT,
  type AnalyticsReport,
  type DailyOperationCounts,
  type DurationCounts,
  type ErrorCounts,
  type OperationCounts,
  type PeriodMetrics,
  type ReportPeriod,
  type ToolOperationCounts,
  type VoteCounts,
} from "../../../apps/site/src/scripts/analytics/reports.ts";
import {
  AnalyticsArchiveError,
  archiveAnalytics,
  readAnalyticsHistory,
  type ArchiveEnv,
} from "./archive.ts";

const ANALYTICS_ACCOUNT_ID = "5aeb7e01c612a208baf33ac1c646a048";
const REPORT_DATASETS: Record<AnalyticsReport["dataset"], true> = {
  mydevtools_tool_usage: true,
  mydevtools_tool_usage_staging: true,
};
const EVENT_FIELDS: Record<ToolEventType, keyof OperationCounts> = {
  tool_started: "started",
  tool_completed: "completed",
  tool_failed: "failed",
  tool_cancelled: "cancelled",
};
const OPERATION_FIELDS = ["started", "completed", "failed", "cancelled"] as const;
const QUERY_TIMEOUT_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const MAXIMUM_COLLECTION_MS = 93 * DAY_MS;
const HISTORICAL_ROW_LIMIT = 10_000;
const CANONICAL_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_TOOL_ID_LENGTH = 96;
const MAX_VOTE_CHOICE_LENGTH = 91;
const OPERATION_ROW_LIMIT = TOOLS.length *
  (2 + DURATION_BUCKETS.length + 1 + TOOL_ERROR_CATEGORIES.length + 1);
const EVENT_LIST_SQL = TOOL_EVENTS.map((event) => `'${event}'`).join(", ");
const TOOL_FILTER_SQL = `\n  AND blob1 IN (${TOOLS.map(({ slug }) => `'${slug}'`).join(", ")})`;
const VOTE_KEYS_SQL = VOTE_CHOICES.map(({ id }) => `'vote:${id}'`).join(", ");

export interface ReportEnv extends ArchiveEnv {
  ANALYTICS_READ_TOKEN?: string;
  ANALYTICS_ACCESS_AUD?: string;
  ANALYTICS_ACCOUNT_ID?: string;
}

type ReportConfig = {
  token: string;
  accountId: string;
  dataset: AnalyticsReport["dataset"];
};

type SqlRow = Record<string, unknown>;
type CatalogMode = "current" | "historical";

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
    accountId !== ANALYTICS_ACCOUNT_ID ||
    !hasKnownDataset
  ) {
    return null;
  }

  return {
    token,
    accountId,
    dataset: dataset as AnalyticsReport["dataset"],
  };
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

function readHistoryYear(url: URL, now: Date): number | null {
  const entries = [...url.searchParams.entries()];
  if (entries.length === 0) return now.getUTCFullYear();
  if (entries.length !== 1 || entries[0]![0] !== "year") return null;
  const value = entries[0]![1];
  if (!/^\d{4}$/.test(value)) return null;
  const year = Number(value);
  return year >= 2000 && year <= now.getUTCFullYear() ? year : null;
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

function sqlBounds(from: Date, to: Date): string {
  const fromTimestamp = Math.ceil(from.getTime() / 1_000);
  const toTimestamp = Math.ceil(to.getTime() / 1_000);
  return `timestamp >= toDateTime(${fromTimestamp})\n  AND timestamp < toDateTime(${toTimestamp})`;
}

function operationQuery(
  config: ReportConfig,
  from: Date,
  to: Date,
  mode: CatalogMode,
): string {
  const rowLimit = mode === "current" ? OPERATION_ROW_LIMIT : HISTORICAL_ROW_LIMIT;
  return `SELECT blob1 AS tool, blob2 AS event, blob3 AS duration, blob4 AS reason,
       SUM(_sample_interval * double1) AS operations,
       MAX(_sample_interval) AS maximum_sample_interval
FROM ${config.dataset}
WHERE ${sqlBounds(from, to)}
  AND blob2 IN (${EVENT_LIST_SQL})${mode === "current" ? TOOL_FILTER_SQL : ""}
GROUP BY blob1, blob2, blob3, blob4
ORDER BY tool, event, duration, reason
LIMIT ${rowLimit + 1}
FORMAT JSON`;
}

function voteQuery(
  config: ReportConfig,
  from: Date,
  to: Date,
  mode: CatalogMode,
): string {
  const currentCatalogFilter = mode === "current"
    ? `\n  AND blob1 IN (${VOTE_KEYS_SQL})`
    : "";
  const rowLimit = mode === "current" ? VOTE_CHOICES.length : HISTORICAL_ROW_LIMIT;
  return `SELECT blob1 AS vote, SUM(_sample_interval * double1) AS votes,
       MAX(_sample_interval) AS maximum_sample_interval
FROM ${config.dataset}
WHERE ${sqlBounds(from, to)}
  AND blob2 = '${VOTE_EVENT}'${currentCatalogFilter}
GROUP BY blob1
ORDER BY vote
LIMIT ${rowLimit + (mode === "current" ? 0 : 1)}
FORMAT JSON`;
}

function dailyQuery(config: ReportConfig, from: Date, to: Date): string {
  const maximumDays = Math.ceil((to.getTime() - from.getTime()) / DAY_MS) + 1;
  return `SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day,
       blob2 AS event,
       SUM(_sample_interval * double1) AS operations,
       MAX(_sample_interval) AS maximum_sample_interval
FROM ${config.dataset}
WHERE ${sqlBounds(from, to)}
  AND blob2 IN (${EVENT_LIST_SQL})${TOOL_FILTER_SQL}
GROUP BY day, blob2
ORDER BY day, event
LIMIT ${maximumDays * TOOL_EVENTS.length}
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

function emptyDurationCounts(): DurationCounts {
  return {
    lt_100ms: 0,
    "100ms_1s": 0,
    "1s_5s": 0,
    "5s_30s": 0,
    gte_30s: 0,
    unclassified: 0,
  };
}

function emptyErrorCounts(): ErrorCounts {
  return {
    invalid_input: 0,
    unsupported_format: 0,
    wasm_unavailable: 0,
    processing_error: 0,
    unclassified: 0,
  };
}

function createEmptyTool<TTool extends string>(tool: TTool): ToolOperationCounts<TTool> {
  return {
    tool,
    started: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    maximumSampleInterval: 0,
    durations: emptyDurationCounts(),
    errors: emptyErrorCounts(),
  };
}

function aggregateOperations(rows: SqlRow[], mode: CatalogMode): {
  summary: OperationCounts;
  tools: ToolOperationCounts<string>[];
  durations: DurationCounts;
  errors: ErrorCounts;
  maximumSampleInterval: number;
} | null {
  const tools: ToolOperationCounts<string>[] = mode === "current"
    ? TOOLS.map(({ slug }) => createEmptyTool(slug))
    : [];
  const byTool = new Map(tools.map((tool) => [tool.tool, tool]));
  const durations = emptyDurationCounts();
  const errors = emptyErrorCounts();
  let maximumSampleInterval = 0;

  for (const row of rows) {
    const toolId = row.tool;
    if (
      typeof toolId !== "string" ||
      (mode === "current"
        ? getTool(toolId) === undefined
        : toolId.length > MAX_TOOL_ID_LENGTH || !CANONICAL_SLUG.test(toolId))
    ) {
      return null;
    }
    const event = readEvent(row.event);
    const duration = row.duration === undefined || row.duration === null
      ? ""
      : typeof row.duration === "string" ? row.duration : null;
    const reason = row.reason === undefined || row.reason === null
      ? ""
      : typeof row.reason === "string" ? row.reason : null;
    const operations = readNonnegativeInteger(row.operations);
    const rowMaximum = readPositiveInteger(row.maximum_sample_interval);
    if (
      event === null ||
      duration === null ||
      reason === null ||
      operations === null ||
      rowMaximum === null
    ) {
      return null;
    }

    let tool = byTool.get(toolId);
    if (tool === undefined) {
      if (mode === "current") return null;
      tool = createEmptyTool(toolId);
      tools.push(tool);
      byTool.set(toolId, tool);
    }
    const field = EVENT_FIELDS[event];
    const total = addCount(tool[field], operations);
    if (total === null) return null;
    tool[field] = total;
    tool.maximumSampleInterval = Math.max(tool.maximumSampleInterval, rowMaximum);
    maximumSampleInterval = Math.max(maximumSampleInterval, rowMaximum);

    if (event === "tool_completed") {
      if (reason !== "") return null;
      const bucket = duration === ""
        ? "unclassified"
        : DURATION_BUCKETS.includes(duration as DurationBucket)
          ? duration as DurationBucket
          : null;
      if (bucket === null) return null;
      const bucketTotal = addCount(tool.durations[bucket], operations);
      const globalTotal = addCount(durations[bucket], operations);
      if (bucketTotal === null || globalTotal === null) return null;
      tool.durations[bucket] = bucketTotal;
      durations[bucket] = globalTotal;
    } else if (event === "tool_failed") {
      if (duration !== "") return null;
      const category = reason === ""
        ? "unclassified"
        : TOOL_ERROR_CATEGORIES.includes(reason as ToolErrorCategory)
          ? reason as ToolErrorCategory
          : null;
      if (category === null) return null;
      const categoryTotal = addCount(tool.errors[category], operations);
      const globalTotal = addCount(errors[category], operations);
      if (categoryTotal === null || globalTotal === null) return null;
      tool.errors[category] = categoryTotal;
      errors[category] = globalTotal;
    } else if (duration !== "" || reason !== "") {
      return null;
    }
  }

  const summary: OperationCounts = { started: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const tool of tools) {
    for (const field of OPERATION_FIELDS) {
      const total = addCount(summary[field], tool[field]);
      if (total === null) return null;
      summary[field] = total;
    }
  }

  tools.sort(
    (left, right) =>
      right.completed - left.completed ||
      right.started - left.started ||
      right.failed - left.failed ||
      right.cancelled - left.cancelled ||
      left.tool.localeCompare(right.tool),
  );
  return { summary, tools, durations, errors, maximumSampleInterval };
}

function aggregateVotes(
  rows: SqlRow[],
  mode: CatalogMode,
): { votes: VoteCounts<string>[]; maximumSampleInterval: number } | null {
  const votes: VoteCounts<string>[] = mode === "current"
    ? VOTE_CHOICES.map(({ id }) => ({
        choice: id,
        votes: 0,
        maximumSampleInterval: 0,
      }))
    : [];
  const byChoice = new Map(votes.map((vote) => [vote.choice, vote]));
  let maximumSampleInterval = 0;

  for (const row of rows) {
    if (typeof row.vote !== "string" || !row.vote.startsWith("vote:")) return null;
    const choice = row.vote.slice(5);
    if (
      mode === "historical" &&
      (choice.length > MAX_VOTE_CHOICE_LENGTH || !CANONICAL_SLUG.test(choice))
    ) {
      return null;
    }
    let target = byChoice.get(choice);
    if (target === undefined) {
      if (mode === "current") return null;
      target = { choice, votes: 0, maximumSampleInterval: 0 };
      votes.push(target);
      byChoice.set(choice, target);
    }
    const count = readNonnegativeInteger(row.votes);
    const rowMaximum = readPositiveInteger(row.maximum_sample_interval);
    if (count === null || rowMaximum === null) return null;
    const total = addCount(target.votes, count);
    if (total === null) return null;
    target.votes = total;
    target.maximumSampleInterval = Math.max(target.maximumSampleInterval, rowMaximum);
    maximumSampleInterval = Math.max(maximumSampleInterval, rowMaximum);
  }

  if (mode === "historical") {
    votes.sort((left, right) => left.choice.localeCompare(right.choice));
  }
  return { votes, maximumSampleInterval };
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

function aggregateDaily(rows: SqlRow[], from: Date, to: Date): DailyOperationCounts[] | null {
  const firstDay = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const finalDate = new Date(to.getTime() - 1);
  const finalDay = Date.UTC(
    finalDate.getUTCFullYear(),
    finalDate.getUTCMonth(),
    finalDate.getUTCDate(),
  );
  const daily: DailyOperationCounts[] = [];
  const byDay = new Map<string, DailyOperationCounts>();
  for (let time = firstDay; time <= finalDay; time += DAY_MS) {
    const day = new Date(time).toISOString().slice(0, 10);
    const counts = { day, started: 0, completed: 0, failed: 0, cancelled: 0 };
    daily.push(counts);
    byDay.set(day, counts);
  }

  for (const row of rows) {
    const day = readUtcDay(row.day);
    const event = readEvent(row.event);
    const operations = readNonnegativeInteger(row.operations);
    const rowMaximum = readPositiveInteger(row.maximum_sample_interval);
    if (day === null || event === null || operations === null || rowMaximum === null) return null;
    const counts = byDay.get(day);
    if (counts === undefined) return null;
    const field = EVENT_FIELDS[event];
    const total = addCount(counts[field], operations);
    if (total === null) return null;
    counts[field] = total;
  }

  return daily;
}

function validateCollectionBounds(from: Date, to: Date): boolean {
  const fromTime = from.getTime();
  const toTime = to.getTime();
  return Number.isFinite(fromTime) &&
    Number.isFinite(toTime) &&
    fromTime <= toTime &&
    toTime - fromTime <= MAXIMUM_COLLECTION_MS;
}

function aggregatePeriodMetrics(
  operationRows: SqlRow[],
  voteRows: SqlRow[],
  mode: "current",
): PeriodMetrics;
function aggregatePeriodMetrics(
  operationRows: SqlRow[],
  voteRows: SqlRow[],
  mode: "historical",
): PeriodMetrics<string, string>;
function aggregatePeriodMetrics(
  operationRows: SqlRow[],
  voteRows: SqlRow[],
  mode: CatalogMode,
): PeriodMetrics<string, string> {
  const operationMetrics = aggregateOperations(operationRows, mode);
  const voteMetrics = aggregateVotes(voteRows, mode);
  if (operationMetrics === null || voteMetrics === null) throw new ReportQueryError(false);
  return {
    ...operationMetrics,
    votes: voteMetrics.votes,
    maximumSampleInterval: Math.max(
      operationMetrics.maximumSampleInterval,
      voteMetrics.maximumSampleInterval,
    ),
  };
}

async function collectWithConfig(
  config: ReportConfig,
  from: Date,
  to: Date,
): Promise<PeriodMetrics> {
  const [operationRows, voteRows] = await Promise.all([
    queryAnalyticsEngine(
      config,
      operationQuery(config, from, to, "current"),
      OPERATION_ROW_LIMIT,
    ),
    queryAnalyticsEngine(
      config,
      voteQuery(config, from, to, "current"),
      VOTE_CHOICES.length,
    ),
  ]);
  return aggregatePeriodMetrics(operationRows, voteRows, "current");
}

export async function collectPeriodMetrics(
  env: ReportEnv,
  from: Date,
  to: Date,
): Promise<PeriodMetrics<string, string>> {
  const config = readConfig(env);
  if (config === null || !validateCollectionBounds(from, to)) {
    throw new ReportQueryError(false);
  }
  if (from.getTime() === to.getTime()) {
    return aggregatePeriodMetrics([], [], "historical");
  }
  const [operationRows, voteRows] = await Promise.all([
    queryAnalyticsEngine(
      config,
      operationQuery(config, from, to, "historical"),
      HISTORICAL_ROW_LIMIT,
    ),
    queryAnalyticsEngine(
      config,
      voteQuery(config, from, to, "historical"),
      HISTORICAL_ROW_LIMIT,
    ),
  ]);
  return aggregatePeriodMetrics(operationRows, voteRows, "historical");
}

function archiveErrorResponse(error: unknown): Response {
  if (error instanceof ReportQueryError) {
    return reportError(error.timedOut ? 504 : 502, "Analytics service unavailable");
  }
  if (error instanceof AnalyticsArchiveError) {
    return reportError(
      error.kind === "unavailable" ? 503 : 502,
      error.kind === "unavailable" ? "Analytics history unavailable" : "Analytics history is invalid",
    );
  }
  return reportError(502, "Analytics history unavailable");
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
  const audience = env.ANALYTICS_ACCESS_AUD;
  if (
    config === null ||
    typeof audience !== "string" ||
    !/^[A-Za-z0-9_-]{16,256}$/.test(audience)
  ) {
    return reportError(503, "Reports unavailable");
  }
  if (access === undefined || access.aud !== audience) {
    return reportError(403, "Forbidden");
  }
  if (!(await hasEmptyBody(request))) return reportError(400, "Invalid request");

  const now = new Date();
  if (url.pathname === ANALYTICS_HISTORY_ENDPOINT) {
    const year = readHistoryYear(url, now);
    if (year === null) return reportError(400, "Invalid request");
    try {
      return reportResponse(200, await readAnalyticsHistory(env, year, now));
    } catch (error) {
      return archiveErrorResponse(error);
    }
  }

  if (url.pathname === ANALYTICS_ARCHIVE_ENDPOINT) {
    if (url.search !== "") return reportError(400, "Invalid request");
    try {
      const history = await archiveAnalytics(
        env,
        (from, to) => collectPeriodMetrics(env, from, to),
        now,
      );
      return reportResponse(200, history);
    } catch (error) {
      return archiveErrorResponse(error);
    }
  }

  if (url.pathname !== ANALYTICS_REPORT_ENDPOINT) return reportError(404, "Not found");
  const days = readPeriod(url);
  if (days === null) return reportError(400, "Invalid request");

  const to = now;
  const from = new Date(to.getTime() - days * DAY_MS);
  const comparisonFrom = new Date(from.getTime() - days * DAY_MS);
  const comparisonPeriod: 7 | 30 | null = days === 90 ? null : days;

  try {
    const currentPromise = collectWithConfig(config, from, to);
    const comparisonPromise = comparisonPeriod === null
      ? Promise.resolve(null)
      : collectWithConfig(config, comparisonFrom, from);
    const dailyRowsPromise = queryAnalyticsEngine(
      config,
      dailyQuery(config, from, to),
      (days + 1) * TOOL_EVENTS.length,
    );
    const [current, previous, dailyRows] = await Promise.all([
      currentPromise,
      comparisonPromise,
      dailyRowsPromise,
    ]);
    const daily = aggregateDaily(dailyRows, from, to);
    if (daily === null) throw new ReportQueryError(false);

    const report: AnalyticsReport = {
      ...current,
      periodDays: days,
      generatedAt: now.toISOString(),
      dataset: config.dataset,
      rangeFrom: from.toISOString(),
      rangeTo: to.toISOString(),
      daily,
      comparison: previous === null
        ? null
        : {
            ...previous,
            periodDays: comparisonPeriod!,
            rangeFrom: comparisonFrom.toISOString(),
            rangeTo: from.toISOString(),
          },
    };
    return reportResponse(200, report);
  } catch (error) {
    const status = error instanceof ReportQueryError && error.timedOut ? 504 : 502;
    return reportError(status, "Analytics service unavailable");
  }
}
