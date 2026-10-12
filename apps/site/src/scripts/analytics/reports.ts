import type { ToolId } from "../../registry/tools.ts";
import type { DurationBucket, ToolErrorCategory, VoteChoice } from "./events.ts";

// Like ingestion, reports use the canonical origin-root Worker route, not Astro's base.
export const ANALYTICS_REPORT_ENDPOINT = "/api/analytics/reports/summary";
export const ANALYTICS_HISTORY_ENDPOINT = "/api/analytics/reports/history";
export const ANALYTICS_ARCHIVE_ENDPOINT = "/api/analytics/reports/archive";
export const REPORT_PERIODS = [7, 30, 90] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

export interface OperationCounts {
  started: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface ToolOperationCounts<TTool extends string = ToolId> extends OperationCounts {
  tool: TTool;
  maximumSampleInterval: number;
  durations: DurationCounts;
  errors: ErrorCounts;
}

export interface DailyOperationCounts extends OperationCounts {
  /** UTC calendar date, YYYY-MM-DD. Rolling windows can contain partial boundary days. */
  day: string;
}

/** Older points have no duration/category; do not invent measurements for them. */
export type ReportDurationBucket = DurationBucket | "unclassified";
export type ReportErrorCategory = ToolErrorCategory | "unclassified";
export type DurationCounts = Record<ReportDurationBucket, number>;
export type ErrorCounts = Record<ReportErrorCategory, number>;

export interface VoteCounts<TChoice extends string = VoteChoice> {
  choice: TChoice;
  votes: number;
  maximumSampleInterval: number;
}

export interface PeriodMetrics<TTool extends string = ToolId, TChoice extends string = VoteChoice> {
  summary: OperationCounts;
  tools: ToolOperationCounts<TTool>[];
  /** Distribution of successful processing times only, not typing or failed work. */
  durations: DurationCounts;
  errors: ErrorCounts;
  votes: VoteCounts<TChoice>[];
  maximumSampleInterval: number;
}

export type AnalyticsDataset = "mydevtools_tool_usage" | "mydevtools_tool_usage_staging";

export interface AnalyticsReport extends PeriodMetrics {
  periodDays: ReportPeriod;
  generatedAt: string;
  dataset: AnalyticsDataset;
  rangeFrom: string;
  rangeTo: string;
  daily: DailyOperationCounts[];
  comparison: (PeriodMetrics & {
    periodDays: 7 | 30;
    rangeFrom: string;
    rangeTo: string;
  }) | null;
}

/** Historical identifiers belong to the catalog at collection, not the current catalog. */
export interface MonthlyAnalyticsSnapshot extends PeriodMetrics<string, string> {
  month: string;
  /** Closed-month snapshots can be complete; retained provisional snapshots stay incomplete. */
  complete: boolean;
  generatedAt: string;
  dataset: AnalyticsDataset;
}

export interface AnalyticsHistory {
  generatedAt: string;
  dataset: AnalyticsDataset;
  year: number;
  years: number[];
  months: MonthlyAnalyticsSnapshot[];
}
