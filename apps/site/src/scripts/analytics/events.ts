import type { ToolId } from "../../registry/tools.ts";

export type { ToolId };

export const TOOL_EVENTS = ["tool_started", "tool_completed", "tool_failed"] as const;
export type ToolEventType = (typeof TOOL_EVENTS)[number];

export interface ToolEvent {
  tool: ToolId;
  event: ToolEventType;
}

// The telemetry Worker is routed at the canonical origin root, not the site base.
export const ANALYTICS_ENDPOINT = "/api/analytics/event";
