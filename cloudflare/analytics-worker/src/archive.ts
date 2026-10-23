import {
  DURATION_BUCKETS,
  TOOL_ERROR_CATEGORIES,
} from "../../../apps/site/src/scripts/analytics/events.ts";
import type {
  AnalyticsDataset,
  AnalyticsHistory,
  DeskEventCounts,
  MonthlyAnalyticsSnapshot,
  OperationCounts,
  PeriodMetrics,
} from "../../../apps/site/src/scripts/analytics/reports.ts";

const DATASETS: Record<AnalyticsDataset, true> = {
  mydevtools_tool_usage: true,
  mydevtools_tool_usage_staging: true,
};
const DURATION_KEYS = [...DURATION_BUCKETS, "unclassified"] as const;
const ERROR_KEYS = [...TOOL_ERROR_CATEGORIES, "unclassified"] as const;
const CANONICAL_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_TOOL_ID_LENGTH = 96;
const MAX_VOTE_CHOICE_LENGTH = 91;
const OPERATION_KEYS = ["started", "completed", "failed", "cancelled"] as const;
const HISTORY_PREFIX = "analytics-history/";
const FIRST_HISTORY_YEAR = 2000;

const SUMMARY_KEYS = [...OPERATION_KEYS] as const;
const DURATION_COUNT_KEYS = [...DURATION_KEYS] as const;
const ERROR_COUNT_KEYS = [...ERROR_KEYS] as const;
const TOOL_KEYS = [
  "tool",
  ...OPERATION_KEYS,
  "maximumSampleInterval",
  "durations",
  "errors",
] as const;
const VOTE_KEYS = ["choice", "votes", "maximumSampleInterval"] as const;
const DESK_KEYS = ["event", "detail", "count", "maximumSampleInterval"] as const;
const DESK_EVENT_NAME = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const DESK_DETAIL = /^(?:[a-z0-9]+(?:_[a-z0-9]+)*)?$/;
const MAX_DESK_EVENT_LENGTH = 64;
const MAX_DESK_DETAIL_LENGTH = 32;
const METRICS_KEYS = [
  "summary",
  "tools",
  "durations",
  "errors",
  "votes",
  "desk",
  "maximumSampleInterval",
] as const;
const SNAPSHOT_KEYS = [
  ...METRICS_KEYS,
  "month",
  "complete",
  "generatedAt",
  "dataset",
] as const;
// Snapshots archived before desktop events existed have no `desk` field; read them as desk: [].
const LEGACY_SNAPSHOT_KEYS = SNAPSHOT_KEYS.filter((key) => key !== "desk");

export interface ArchiveEnv {
  ANALYTICS_HISTORY?: KVNamespace;
  ANALYTICS_REPORT_DATASET?: string;
}

export class AnalyticsArchiveError extends Error {
  readonly kind: "unavailable" | "corrupt";
  constructor(
    kind: "unavailable" | "corrupt",
    message: string,
  ) {
    super(message);
    this.kind = kind;
    this.name = "AnalyticsArchiveError";
  }
}

type ArchiveConfig = {
  history: KVNamespace;
  dataset: AnalyticsDataset;
  prefix: string;
};

type JsonObject = Record<string, unknown>;

function unavailable(): AnalyticsArchiveError {
  return new AnalyticsArchiveError("unavailable", "Analytics history is unavailable");
}

function corrupt(): AnalyticsArchiveError {
  return new AnalyticsArchiveError("corrupt", "Analytics history data is corrupt");
}

function readConfig(env: ArchiveEnv): ArchiveConfig {
  const history = env.ANALYTICS_HISTORY;
  const dataset = env.ANALYTICS_REPORT_DATASET;
  if (
    history === undefined ||
    typeof history.list !== "function" ||
    typeof history.get !== "function" ||
    typeof history.put !== "function" ||
    typeof dataset !== "string" ||
    !Object.hasOwn(DATASETS, dataset)
  ) {
    throw unavailable();
  }

  return {
    history,
    dataset: dataset as AnalyticsDataset,
    prefix: `${HISTORY_PREFIX}${dataset}/`,
  };
}

function validNow(now: Date | undefined): Date {
  const captured = now === undefined ? new Date() : new Date(now.getTime());
  if (!Number.isFinite(captured.getTime())) {
    throw new RangeError("Analytics history date is invalid");
  }
  return captured;
}

function readYear(year: number | undefined, now: Date): number {
  const selected = year ?? now.getUTCFullYear();
  if (
    !Number.isSafeInteger(selected) ||
    selected < FIRST_HISTORY_YEAR ||
    selected > now.getUTCFullYear()
  ) {
    throw new RangeError("Analytics history year is invalid");
  }
  return selected;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isCanonicalSlug(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximumLength &&
    CANONICAL_SLUG.test(value)
  );
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeAdd(left: number, right: number): number | null {
  const sum = left + right;
  return Number.isSafeInteger(sum) ? sum : null;
}

function readOperationCounts(value: unknown, requireExactKeys = true): OperationCounts | null {
  if (
    !isObject(value) ||
    (requireExactKeys && !hasExactKeys(value, SUMMARY_KEYS))
  ) {
    return null;
  }
  for (const key of OPERATION_KEYS) {
    if (!isCount(value[key])) return null;
  }
  return value as unknown as OperationCounts;
}

function readKeyedCounts(
  value: unknown,
  keys: readonly string[],
): Record<string, number> | null {
  if (!isObject(value) || !hasExactKeys(value, keys)) return null;
  for (const key of keys) {
    if (!isCount(value[key])) return null;
  }
  return value as Record<string, number>;
}

function sumCounts(value: Record<string, number>, keys: readonly string[]): number | null {
  let total = 0;
  for (const key of keys) {
    const next = safeAdd(total, value[key]);
    if (next === null) return null;
    total = next;
  }
  return total;
}

function addKeyedCounts(
  target: Record<string, number>,
  source: Record<string, number>,
  keys: readonly string[],
): boolean {
  for (const key of keys) {
    const next = safeAdd(target[key], source[key]);
    if (next === null) return false;
    target[key] = next;
  }
  return true;
}

function zeroCounts(keys: readonly string[]): Record<string, number> {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function readPeriodMetrics(value: unknown): PeriodMetrics<string, string> | null {
  if (!isObject(value)) return null;
  const desk = value.desk === undefined ? [] : value.desk;

  const summary = readOperationCounts(value.summary);
  const durations = readKeyedCounts(value.durations, DURATION_COUNT_KEYS);
  const errors = readKeyedCounts(value.errors, ERROR_COUNT_KEYS);
  if (
    summary === null ||
    durations === null ||
    errors === null ||
    !Array.isArray(value.tools) ||
    !Array.isArray(value.votes) ||
    !Array.isArray(desk) ||
    !isCount(value.maximumSampleInterval)
  ) {
    return null;
  }

  const toolIds = new Set<string>();
  const operationTotals = zeroCounts(OPERATION_KEYS);
  const durationTotals = zeroCounts(DURATION_COUNT_KEYS);
  const errorTotals = zeroCounts(ERROR_COUNT_KEYS);
  let maximumSampleInterval = 0;

  for (const candidate of value.tools) {
    if (!isObject(candidate) || !hasExactKeys(candidate, TOOL_KEYS)) return null;
    const tool = candidate.tool;
    if (
      !isCanonicalSlug(tool, MAX_TOOL_ID_LENGTH) ||
      toolIds.has(tool)
    ) {
      return null;
    }
    const operations = readOperationCounts(candidate, false);
    const toolDurations = readKeyedCounts(candidate.durations, DURATION_COUNT_KEYS);
    const toolErrors = readKeyedCounts(candidate.errors, ERROR_COUNT_KEYS);
    if (
      operations === null ||
      toolDurations === null ||
      toolErrors === null ||
      !isCount(candidate.maximumSampleInterval) ||
      sumCounts(toolDurations, DURATION_COUNT_KEYS) !== operations.completed ||
      sumCounts(toolErrors, ERROR_COUNT_KEYS) !== operations.failed
    ) {
      return null;
    }
    const operationTotal = sumCounts(
      operations as unknown as Record<string, number>,
      OPERATION_KEYS,
    );
    if (
      operationTotal === null ||
      (operationTotal === 0) !== (candidate.maximumSampleInterval === 0)
    ) {
      return null;
    }
    toolIds.add(tool);
    if (
      !addKeyedCounts(operationTotals, operations as unknown as Record<string, number>, OPERATION_KEYS) ||
      !addKeyedCounts(durationTotals, toolDurations, DURATION_COUNT_KEYS) ||
      !addKeyedCounts(errorTotals, toolErrors, ERROR_COUNT_KEYS)
    ) {
      return null;
    }
    maximumSampleInterval = Math.max(maximumSampleInterval, candidate.maximumSampleInterval);
  }

  for (const key of OPERATION_KEYS) {
    if (operationTotals[key] !== summary[key]) return null;
  }
  for (const key of DURATION_COUNT_KEYS) {
    if (durationTotals[key] !== durations[key]) return null;
  }
  for (const key of ERROR_COUNT_KEYS) {
    if (errorTotals[key] !== errors[key]) return null;
  }
  if (
    sumCounts(durations, DURATION_COUNT_KEYS) !== summary.completed ||
    sumCounts(errors, ERROR_COUNT_KEYS) !== summary.failed
  ) {
    return null;
  }

  const voteIds = new Set<string>();
  for (const candidate of value.votes) {
    if (!isObject(candidate) || !hasExactKeys(candidate, VOTE_KEYS)) return null;
    const choice = candidate.choice;
    if (
      !isCanonicalSlug(choice, MAX_VOTE_CHOICE_LENGTH) ||
      voteIds.has(choice) ||
      !isCount(candidate.votes) ||
      !isCount(candidate.maximumSampleInterval) ||
      (candidate.votes === 0) !== (candidate.maximumSampleInterval === 0)
    ) {
      return null;
    }
    voteIds.add(choice);
    maximumSampleInterval = Math.max(maximumSampleInterval, candidate.maximumSampleInterval);
  }

  const deskPairs = new Set<string>();
  for (const candidate of desk as unknown[]) {
    if (!isObject(candidate) || !hasExactKeys(candidate, DESK_KEYS)) return null;
    const { event, detail } = candidate;
    if (
      typeof event !== "string" ||
      event.length > MAX_DESK_EVENT_LENGTH ||
      !DESK_EVENT_NAME.test(event) ||
      typeof detail !== "string" ||
      detail.length > MAX_DESK_DETAIL_LENGTH ||
      !DESK_DETAIL.test(detail) ||
      deskPairs.has(`${event}\u0000${detail}`) ||
      !isCount(candidate.count) ||
      !isCount(candidate.maximumSampleInterval) ||
      (candidate.count === 0) !== (candidate.maximumSampleInterval === 0)
    ) {
      return null;
    }
    deskPairs.add(`${event}\u0000${detail}`);
    maximumSampleInterval = Math.max(maximumSampleInterval, candidate.maximumSampleInterval);
  }

  if (value.maximumSampleInterval !== maximumSampleInterval) return null;
  return { ...value, desk: desk as DeskEventCounts[] } as unknown as PeriodMetrics<string, string>;
}

function monthParts(month: string): { year: number; monthIndex: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (match === null) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (year < FIRST_HISTORY_YEAR || monthIndex < 0 || monthIndex > 11) return null;
  return { year, monthIndex };
}

function monthName(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthStart(now: Date, offset: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function readSnapshot(
  value: unknown,
  expectedMonth: string,
  config: ArchiveConfig,
  now: Date,
): MonthlyAnalyticsSnapshot | null {
  if (
    !isObject(value) ||
    !(hasExactKeys(value, SNAPSHOT_KEYS) || hasExactKeys(value, LEGACY_SNAPSHOT_KEYS))
  ) {
    return null;
  }
  const metrics = readPeriodMetrics(value);
  if (
    metrics === null ||
    value.month !== expectedMonth ||
    typeof value.complete !== "boolean" ||
    !isCanonicalIsoDate(value.generatedAt) ||
    value.dataset !== config.dataset
  ) {
    return null;
  }

  const parts = monthParts(expectedMonth);
  if (parts === null) return null;
  const start = new Date(Date.UTC(parts.year, parts.monthIndex, 1)).getTime();
  const end = new Date(Date.UTC(parts.year, parts.monthIndex + 1, 1)).getTime();
  const generatedAt = Date.parse(value.generatedAt);
  if (
    start > now.getTime() ||
    generatedAt > now.getTime() ||
    (value.complete ? generatedAt < end : generatedAt < start || generatedAt >= end)
  ) {
    return null;
  }
  return { ...value, desk: metrics.desk } as unknown as MonthlyAnalyticsSnapshot;
}

function snapshotKey(config: ArchiveConfig, month: string): string {
  return `${config.prefix}${month}`;
}

async function listMonths(config: ArchiveConfig, now: Date): Promise<string[]> {
  const months: string[] = [];
  const seenNames = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  try {
    for (;;) {
      const page = await config.history.list({ prefix: config.prefix, cursor, limit: 1000 });
      if (
        typeof page !== "object" ||
        page === null ||
        !Array.isArray(page.keys) ||
        typeof page.list_complete !== "boolean"
      ) {
        throw corrupt();
      }
      for (const entry of page.keys) {
        if (!isObject(entry) || typeof entry.name !== "string" || seenNames.has(entry.name)) {
          throw corrupt();
        }
        const month = entry.name.slice(config.prefix.length);
        const parts = monthParts(month);
        if (
          !entry.name.startsWith(config.prefix) ||
          parts === null ||
          new Date(Date.UTC(parts.year, parts.monthIndex, 1)).getTime() > now.getTime()
        ) {
          throw corrupt();
        }
        seenNames.add(entry.name);
        months.push(month);
      }
      if (page.list_complete) break;
      if (typeof page.cursor !== "string" || page.cursor.length === 0 || seenCursors.has(page.cursor)) {
        throw corrupt();
      }
      seenCursors.add(page.cursor);
      cursor = page.cursor;
    }
  } catch (error) {
    if (error instanceof AnalyticsArchiveError) throw error;
    throw unavailable();
  }
  return months;
}

async function getSnapshot(
  config: ArchiveConfig,
  month: string,
  now: Date,
): Promise<MonthlyAnalyticsSnapshot> {
  let serialized: string | null;
  try {
    serialized = await config.history.get(snapshotKey(config, month));
  } catch {
    throw unavailable();
  }
  if (serialized === null) throw corrupt();

  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw corrupt();
  }
  const snapshot = readSnapshot(value, month, config, now);
  if (snapshot === null) throw corrupt();
  return snapshot;
}

export async function readAnalyticsHistory(
  env: ArchiveEnv,
  year?: number,
  now?: Date,
): Promise<AnalyticsHistory> {
  const capturedNow = validNow(now);
  const selectedYear = readYear(year, capturedNow);
  const config = readConfig(env);
  const allMonths = await listMonths(config, capturedNow);
  const years = [...new Set(allMonths.map((month) => Number(month.slice(0, 4))))]
    .sort((left, right) => right - left);
  const selectedMonths = allMonths
    .filter((month) => Number(month.slice(0, 4)) === selectedYear)
    .sort((left, right) => right.localeCompare(left));
  if (selectedMonths.length > 12) throw corrupt();

  const months = await Promise.all(
    selectedMonths.map((month) => getSnapshot(config, month, capturedNow)),
  );
  return {
    generatedAt: capturedNow.toISOString(),
    dataset: config.dataset,
    year: selectedYear,
    years,
    months,
  };
}

export async function archiveAnalytics(
  env: ArchiveEnv,
  collect: (from: Date, to: Date) => Promise<PeriodMetrics<string, string>>,
  now?: Date,
): Promise<AnalyticsHistory> {
  const capturedNow = validNow(now);
  const config = readConfig(env);
  const generatedAt = capturedNow.toISOString();
  const pending: Array<{ key: string; value: string }> = [];

  for (const offset of [0, -1, -2]) {
    const from = monthStart(capturedNow, offset);
    const to = offset === 0 ? new Date(capturedNow.getTime()) : monthStart(capturedNow, offset + 1);
    const metrics = await collect(new Date(from.getTime()), new Date(to.getTime()));
    const month = monthName(from);
    const snapshot: MonthlyAnalyticsSnapshot = {
      ...metrics,
      month,
      complete: offset < 0,
      generatedAt,
      dataset: config.dataset,
    };
    if (readSnapshot(snapshot, month, config, capturedNow) === null) throw corrupt();

    let value: string | undefined;
    let serializedSnapshot: unknown;
    try {
      value = JSON.stringify(snapshot);
      serializedSnapshot = value === undefined ? undefined : JSON.parse(value);
    } catch {
      throw corrupt();
    }
    if (
      value === undefined ||
      readSnapshot(serializedSnapshot, month, config, capturedNow) === null
    ) {
      throw corrupt();
    }
    pending.push({ key: snapshotKey(config, month), value });
  }

  try {
    for (const snapshot of pending) {
      await config.history.put(snapshot.key, snapshot.value);
    }
  } catch {
    throw unavailable();
  }
  return readAnalyticsHistory(env, capturedNow.getUTCFullYear(), capturedNow);
}
