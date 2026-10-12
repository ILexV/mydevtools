import type { ToolId } from "../../registry/tools.ts";

// Like ingestion, reports use the canonical origin-root Worker route, not Astro's base.
export const ANALYTICS_REPORT_ENDPOINT = "/api/analytics/reports/summary";
export const REPORT_PERIODS = [7, 30, 90] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

export interface OperationCounts {
  started: number;
  completed: number;
  failed: number;
}

export interface ToolOperationCounts extends OperationCounts {
  tool: ToolId;
  maximumSampleInterval: number;
}

export interface DailyOperationCounts extends OperationCounts {
  /** UTC calendar date, YYYY-MM-DD. Rolling windows can contain partial boundary days. */
  day: string;
}

export interface AnalyticsReport {
  periodDays: ReportPeriod;
  generatedAt: string;
  dataset: "mydevtools_tool_usage" | "mydevtools_tool_usage_staging";
  summary: OperationCounts;
  tools: ToolOperationCounts[];
  daily: DailyOperationCounts[];
  maximumSampleInterval: number;
}
