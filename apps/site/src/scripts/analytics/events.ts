import type { ToolId } from "../../registry/tools.ts";

export type { ToolId };

export const TOOL_EVENTS = ["tool_started", "tool_completed", "tool_failed", "tool_cancelled"] as const;
export type ToolEventType = (typeof TOOL_EVENTS)[number];

export const DURATION_BUCKETS = ["lt_100ms", "100ms_1s", "1s_5s", "5s_30s", "gte_30s"] as const;
export type DurationBucket = (typeof DURATION_BUCKETS)[number];

export const TOOL_ERROR_CATEGORIES = ["invalid_input", "unsupported_format", "wasm_unavailable", "processing_error"] as const;
export type ToolErrorCategory = (typeof TOOL_ERROR_CATEGORIES)[number];

export type ToolEvent = { tool: ToolId } & (
  | { event: "tool_started" | "tool_cancelled" }
  | { event: "tool_completed"; duration: DurationBucket }
  | { event: "tool_failed"; reason: ToolErrorCategory }
);

// The telemetry Worker is routed at the canonical origin root, not the site base.
export const ANALYTICS_ENDPOINT = "/api/analytics/event";

export const ANALYTICS_VOTE_ENDPOINT = "/api/analytics/vote";
export const VOTE_EVENT = "feedback_vote";
export const VOTE_CHOICES = [
  { id: "sql-formatter", labelKey: "ChoiceSqlFormatter", kind: "tool" },
  { id: "json-schema-validator", labelKey: "ChoiceJsonSchemaValidator", kind: "tool" },
  { id: "curl-to-code", labelKey: "ChoiceCurlToCode", kind: "tool" },
  { id: "large-file-performance", labelKey: "ChoiceLargeFilePerformance", kind: "improvement" },
  { id: "additional-image-formats", labelKey: "ChoiceAdditionalImageFormats", kind: "improvement" },
  { id: "batch-conversion", labelKey: "ChoiceBatchConversion", kind: "improvement" },
] as const;
export type VoteChoice = (typeof VOTE_CHOICES)[number]["id"];
export interface ToolVote {
  choice: VoteChoice;
}
