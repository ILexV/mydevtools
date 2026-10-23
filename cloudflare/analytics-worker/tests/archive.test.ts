import assert from "node:assert/strict";
import test from "node:test";

import { TOOLS, type ToolId } from "../../../apps/site/src/registry/tools.ts";
import {
  DESK_EVENT_PAIRS,
  DURATION_BUCKETS,
  TOOL_ERROR_CATEGORIES,
  VOTE_CHOICES,
} from "../../../apps/site/src/scripts/analytics/events.ts";
import type {
  AnalyticsDataset,
  MonthlyAnalyticsSnapshot,
  PeriodMetrics,
} from "../../../apps/site/src/scripts/analytics/reports.ts";
import {
  AnalyticsArchiveError,
  archiveAnalytics,
  readAnalyticsHistory,
  type ArchiveEnv,
} from "../src/archive.ts";

class MemoryKv {
  readonly values = new Map<string, string>();
  listCalls = 0;
  getCalls = 0;

  private readonly pageSize: number;

  constructor(pageSize = 1000) {
    this.pageSize = pageSize;
  }

  async get(key: string): Promise<string | null> {
    this.getCalls += 1;
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
    this.listCalls += 1;
    const prefix = options.prefix ?? "";
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort();
    const start = options.cursor === undefined ? 0 : Number(options.cursor);
    const requestedLimit = options.limit ?? 1000;
    const end = Math.min(start + Math.min(requestedLimit, this.pageSize), keys.length);
    return {
      keys: keys.slice(start, end).map((name) => ({ name })),
      list_complete: end === keys.length,
      ...(end === keys.length ? {} : { cursor: String(end) }),
    };
  }
}

function environment(
  kv: MemoryKv,
  dataset: AnalyticsDataset = "mydevtools_tool_usage",
): ArchiveEnv {
  return {
    ANALYTICS_HISTORY: kv as unknown as KVNamespace,
    ANALYTICS_REPORT_DATASET: dataset,
  };
}

function keyedCounts<const Key extends string>(
  keys: readonly Key[],
  selected?: Key,
  count = 0,
): Record<Key, number> {
  return Object.fromEntries(
    keys.map((key) => [key, key === selected ? count : 0]),
  ) as Record<Key, number>;
}

function metrics(completed = 2): PeriodMetrics {
  const failed = 1;
  const durations = keyedCounts([...DURATION_BUCKETS, "unclassified"], "100ms_1s", completed);
  const errors = keyedCounts([...TOOL_ERROR_CATEGORIES, "unclassified"], "processing_error", failed);
  return {
    summary: { started: completed + failed + 1, completed, failed, cancelled: 1 },
    tools: TOOLS.map(({ slug }, index) => ({
      tool: slug as ToolId,
      started: index === 0 ? completed + failed + 1 : 0,
      completed: index === 0 ? completed : 0,
      failed: index === 0 ? failed : 0,
      cancelled: index === 0 ? 1 : 0,
      maximumSampleInterval: index === 0 ? 3 : 0,
      durations: keyedCounts(
        [...DURATION_BUCKETS, "unclassified"],
        "100ms_1s",
        index === 0 ? completed : 0,
      ),
      errors: keyedCounts(
        [...TOOL_ERROR_CATEGORIES, "unclassified"],
        "processing_error",
        index === 0 ? failed : 0,
      ),
    })),
    durations,
    errors,
    votes: VOTE_CHOICES.map(({ id }, index) => ({
      choice: id,
      votes: index === 0 ? completed + 2 : 0,
      maximumSampleInterval: index === 0 ? 2 : 0,
    })),
    desk: DESK_EVENT_PAIRS.map(({ event, detail }, index) => ({
      event,
      detail,
      count: index === 1 ? 4 : 0,
      maximumSampleInterval: index === 1 ? 1 : 0,
    })),
    maximumSampleInterval: 3,
  };
}

async function archiveAt(
  env: ArchiveEnv,
  now: string,
  completed = 2,
): Promise<void> {
  await archiveAnalytics(env, async () => metrics(completed), new Date(now));
}

function archiveError(kind: AnalyticsArchiveError["kind"]): (error: unknown) => boolean {
  return (error) => error instanceof AnalyticsArchiveError && error.kind === kind;
}

test("archives exact UTC month ranges across year rollover and leap day", async () => {
  const kv = new MemoryKv();
  const env = environment(kv);
  const rolloverRanges: string[][] = [];
  const rolloverNow = new Date("2025-01-15T12:34:56.789Z");

  const history = await archiveAnalytics(env, async (from, to) => {
    rolloverRanges.push([from.toISOString(), to.toISOString()]);
    return metrics();
  }, rolloverNow);

  assert.deepEqual(rolloverRanges, [
    ["2025-01-01T00:00:00.000Z", "2025-01-15T12:34:56.789Z"],
    ["2024-12-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z"],
    ["2024-11-01T00:00:00.000Z", "2024-12-01T00:00:00.000Z"],
  ]);
  assert.equal(history.year, 2025);
  assert.deepEqual(history.years, [2025, 2024]);
  assert.deepEqual(history.months.map(({ month, complete }) => [month, complete]), [
    ["2025-01", false],
  ]);
  const closedHistory = await readAnalyticsHistory(env, 2024, rolloverNow);
  assert.deepEqual(closedHistory.months.map(({ month, complete }) => [month, complete]), [
    ["2024-12", true],
    ["2024-11", true],
  ]);

  const leapRanges: string[][] = [];
  await archiveAnalytics(environment(new MemoryKv()), async (from, to) => {
    leapRanges.push([from.toISOString(), to.toISOString()]);
    return metrics();
  }, new Date("2024-03-15T00:00:00.000Z"));
  assert.deepEqual(leapRanges, [
    ["2024-03-01T00:00:00.000Z", "2024-03-15T00:00:00.000Z"],
    ["2024-02-01T00:00:00.000Z", "2024-03-01T00:00:00.000Z"],
    ["2024-01-01T00:00:00.000Z", "2024-02-01T00:00:00.000Z"],
  ]);
  assert.ok(leapRanges.every(
    ([from, to]) =>
      Date.parse(to) <= Date.parse("2024-03-15T00:00:00.000Z") &&
      Date.parse(from) <= Date.parse(to),
  ));
});

test("keeps production and staging monthly aggregates isolated in one KV namespace", async () => {
  const kv = new MemoryKv();
  const production = environment(kv);
  const staging = environment(kv, "mydevtools_tool_usage_staging");
  const now = "2026-07-20T10:00:00.000Z";

  await archiveAt(production, now, 7);
  await archiveAt(staging, now, 1);

  const productionHistory = await readAnalyticsHistory(production, 2026, new Date(now));
  const stagingHistory = await readAnalyticsHistory(staging, 2026, new Date(now));
  assert.equal(productionHistory.months[0]?.summary.completed, 7);
  assert.equal(stagingHistory.months[0]?.summary.completed, 1);
  assert.ok([...kv.values.keys()].some((key) => key.includes("mydevtools_tool_usage/2026-07")));
  assert.ok([...kv.values.keys()].some((key) => key.includes("mydevtools_tool_usage_staging/2026-07")));
});

test("does not overwrite any good snapshot when collection fails or returns private fields", async () => {
  const kv = new MemoryKv();
  const env = environment(kv);
  const now = new Date("2026-08-18T08:00:00.000Z");
  await archiveAnalytics(env, async () => metrics(4), now);
  const before = [...kv.values.entries()].sort();
  let calls = 0;

  await assert.rejects(
    archiveAnalytics(env, async () => {
      calls += 1;
      if (calls === 2) throw new Error("Analytics Engine unavailable");
      return metrics(99);
    }, now),
    /Analytics Engine unavailable/,
  );
  await assert.rejects(
    archiveAnalytics(env, async () => ({
      ...metrics(99),
      rawEvents: [{ input: "private" }],
    }) as unknown as PeriodMetrics, now),
    archiveError("corrupt"),
  );
  assert.deepEqual([...kv.values.entries()].sort(), before);
});

test("paginates all dataset keys and keeps old years readable with at most twelve selected months", async () => {
  const kv = new MemoryKv(1);
  const env = environment(kv);
  for (let month = 1; month <= 12; month += 1) {
    const instant = new Date(Date.UTC(2024, month - 1, 15)).toISOString();
    await archiveAt(env, instant, month);
  }
  await archiveAt(env, "2025-01-15T00:00:00.000Z", 20);
  kv.listCalls = 0;
  kv.getCalls = 0;

  const history = await readAnalyticsHistory(env, 2024, new Date("2025-02-01T00:00:00.000Z"));
  assert.ok(kv.listCalls > 1);
  assert.equal(kv.getCalls, 12);
  assert.equal(history.year, 2024);
  assert.deepEqual(history.years, [2025, 2024, 2023]);
  assert.equal(history.months.length, 12);
  assert.equal(history.months[0]?.month, "2024-12");
  assert.equal(history.months[11]?.month, "2024-01");
  assert.equal(history.months[11]?.summary.completed, 3);

  const oldHistory = await readAnalyticsHistory(env, 2023, new Date("2025-02-01T00:00:00.000Z"));
  assert.deepEqual(oldHistory.months.map(({ month }) => month), ["2023-12", "2023-11"]);
});

test("reads former catalogs without padding or dropping retired counters", async () => {
  const kv = new MemoryKv();
  const env = environment(kv);
  const current = metrics(7);
  const snapshot: MonthlyAnalyticsSnapshot = {
    ...current,
    tools: [{ ...current.tools[0]!, tool: "retired-formatter" }],
    votes: [{ ...current.votes[0]!, choice: "retired-proposal" }],
    month: "2024-06",
    complete: true,
    generatedAt: "2024-07-01T00:00:00.000Z",
    dataset: "mydevtools_tool_usage",
  };
  const key = "analytics-history/mydevtools_tool_usage/2024-06";
  const serialized = JSON.stringify(snapshot);
  kv.values.set(key, serialized);

  const history = await readAnalyticsHistory(
    env,
    2024,
    new Date("2026-09-10T00:00:00.000Z"),
  );

  assert.deepEqual(history.months, [snapshot]);
  assert.equal(history.months[0]?.tools[0]?.completed, 7);
  assert.equal(history.months[0]?.votes[0]?.votes, 9);
  assert.equal(kv.values.get(key), serialized);
});

test("reads snapshots archived before desktop events as empty desk totals", async () => {
  const kv = new MemoryKv();
  const env = environment(kv);
  const { desk: _desk, ...legacyMetrics } = metrics(5);
  const legacy = {
    ...legacyMetrics,
    month: "2026-07",
    complete: true,
    generatedAt: "2026-08-01T00:00:00.000Z",
    dataset: "mydevtools_tool_usage",
  };
  const key = "analytics-history/mydevtools_tool_usage/2026-07";
  const serialized = JSON.stringify(legacy);
  kv.values.set(key, serialized);

  const history = await readAnalyticsHistory(env, 2026, new Date("2026-09-10T00:00:00.000Z"));
  assert.deepEqual(history.months, [{ ...legacy, desk: [] }]);
  // Reading never rewrites the stored legacy snapshot.
  assert.equal(kv.values.get(key), serialized);

  // A fresh archive run stores the desk totals alongside the other aggregates.
  await archiveAnalytics(env, async () => metrics(), new Date("2026-09-10T00:00:00.000Z"));
  const stored = JSON.parse(kv.values.get("analytics-history/mydevtools_tool_usage/2026-09")!) as MonthlyAnalyticsSnapshot;
  assert.equal(stored.desk.length, DESK_EVENT_PAIRS.length);
  assert.equal(stored.desk[1]?.count, 4);
});

test("rejects corrupted aggregates instead of dropping or exposing malformed rows", async () => {
  const kv = new MemoryKv();
  const env = environment(kv);
  const now = new Date("2026-09-10T00:00:00.000Z");
  await archiveAnalytics(env, async () => metrics(), now);
  const key = "analytics-history/mydevtools_tool_usage/2026-09";
  const valid = JSON.parse(kv.values.get(key) ?? "null") as MonthlyAnalyticsSnapshot;

  const corruptions: unknown[] = [
    { ...valid, summary: { ...valid.summary, completed: valid.summary.completed + 1 } },
    { ...valid, durations: { ...valid.durations, unknown_bucket: 1 } },
    { ...valid, errors: { ...valid.errors, unknown_category: 1 } },
    {
      ...valid,
      tools: valid.tools.map((tool, index) =>
        index === 0 ? { ...tool, tool: "../unknown-tool" } : tool
      ),
    },
    {
      ...valid,
      tools: valid.tools.map((tool, index) =>
        index === 0 ? { ...tool, tool: "a".repeat(97) } : tool
      ),
    },
    {
      ...valid,
      tools: [
        ...valid.tools,
        {
          ...valid.tools[0]!,
          started: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
          maximumSampleInterval: 0,
          durations: keyedCounts([...DURATION_BUCKETS, "unclassified"]),
          errors: keyedCounts([...TOOL_ERROR_CATEGORIES, "unclassified"]),
        },
      ],
    },
    {
      ...valid,
      votes: valid.votes.map((vote, index) =>
        index === 0 ? { ...vote, choice: "<unknown-choice>" } : vote
      ),
    },
    {
      ...valid,
      votes: valid.votes.map((vote, index) =>
        index === 0 ? { ...vote, choice: "a".repeat(92) } : vote
      ),
    },
    {
      ...valid,
      votes: [
        ...valid.votes,
        {
          choice: valid.votes[0]!.choice,
          votes: 0,
          maximumSampleInterval: 0,
        },
      ],
    },
    {
      ...valid,
      maximumSampleInterval: 2,
      tools: valid.tools.map((tool, index) =>
        index === 0 ? { ...tool, maximumSampleInterval: 0 } : tool
      ),
    },
    { ...valid, desk: "not-a-list" },
    {
      ...valid,
      desk: valid.desk.map((entry, index) =>
        index === 0 ? { ...entry, event: "Desk Opened" } : entry
      ),
    },
    {
      ...valid,
      desk: valid.desk.map((entry, index) =>
        index === 0 ? { ...entry, detail: "<script>" } : entry
      ),
    },
    {
      ...valid,
      desk: valid.desk.map((entry, index) =>
        index === 0 ? { ...entry, input: "private" } : entry
      ),
    },
    { ...valid, desk: [...valid.desk, { ...valid.desk[0]! }] },
    {
      ...valid,
      desk: valid.desk.map((entry, index) =>
        index === 0 ? { ...entry, count: 3, maximumSampleInterval: 0 } : entry
      ),
    },
    {
      ...valid,
      desk: valid.desk.map((entry, index) =>
        index === 0 ? { ...entry, count: 3, maximumSampleInterval: 9 } : entry
      ),
    },
    { ...valid, dataset: "mydevtools_tool_usage_staging" },
    { ...valid, month: "2026-08" },
    { ...valid, generatedAt: "2026-02-29T00:00:00.000Z" },
    { ...valid, complete: true },
    { ...valid, privateInput: "must-not-be-stored" },
  ];
  for (const corruption of corruptions) {
    kv.values.set(key, JSON.stringify(corruption));
    await assert.rejects(readAnalyticsHistory(env, 2026, now), archiveError("corrupt"));
  }

  kv.values.set(key, "{not-json");
  await assert.rejects(readAnalyticsHistory(env, 2026, now), archiveError("corrupt"));
});

test("fails clearly when the private KV binding or dataset configuration is unavailable", async () => {
  await assert.rejects(
    readAnalyticsHistory({ ANALYTICS_REPORT_DATASET: "mydevtools_tool_usage" }),
    archiveError("unavailable"),
  );
  await assert.rejects(
    readAnalyticsHistory({
      ANALYTICS_HISTORY: new MemoryKv() as unknown as KVNamespace,
      ANALYTICS_REPORT_DATASET: "other_dataset",
    }),
    archiveError("unavailable"),
  );
  let collections = 0;
  await assert.rejects(
    archiveAnalytics({}, async () => {
      collections += 1;
      return metrics();
    }),
    archiveError("unavailable"),
  );
  assert.equal(collections, 0);
});
