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

// Anonymous desktop-mode (`/{lang}/desktop/`) usage events: a fixed event name plus a fixed
// detail bucket, never tool input, window titles, file names or identifiers.
export const ANALYTICS_DESK_ENDPOINT = "/api/analytics/desk";
/** blob2 marker for desktop rows; tool and vote report queries filter on other blob2 values. */
export const DESK_EVENT = "desk_event";
/** Allowed detail values per desktop event; `""` means the event carries no detail. */
export const DESK_EVENTS = {
  desk_opened: [""],
  desk_windows: ["1", "2", "3", "4_5", "6_plus"],
  desk_transfer: ["once", "link"],
  desk_workspace: ["builtin", "saved"],
  desk_file_drop: [""],
  desk_popout: [""],
  desk_clipboard: [""],
  desk_launch: ["file_handler", "share_target"],
} as const;
export type DeskEventType = keyof typeof DESK_EVENTS;
export type DeskEvent = {
  [K in DeskEventType]: { event: K; detail: (typeof DESK_EVENTS)[K][number] };
}[DeskEventType];
/** Every known (event, detail) pair in catalog order; reports pad missing pairs with zero. */
export const DESK_EVENT_PAIRS: readonly DeskEvent[] = (Object.keys(DESK_EVENTS) as DeskEventType[])
  .flatMap((event) => DESK_EVENTS[event].map((detail) => ({ event, detail }) as DeskEvent));

/** True only for a catalogued (event, detail) pair; shared by the client and the Worker. */
export function isDeskEvent(event: unknown, detail: unknown): boolean {
  return typeof event === "string" &&
    typeof detail === "string" &&
    Object.hasOwn(DESK_EVENTS, event) &&
    (DESK_EVENTS[event as DeskEventType] as readonly string[]).includes(detail);
}

/**
 * Canonical wire body of a desktop event: `{"event":"desk_opened"}` when the event has no
 * detail, otherwise `{"event":"desk_windows","detail":"3"}`. The Worker accepts only this form.
 */
export type DeskEventBody = { event: DeskEventType } | { event: DeskEventType; detail: string };
export function deskEventBody(event: DeskEvent): DeskEventBody {
  return event.detail === "" ? { event: event.event } : { event: event.event, detail: event.detail };
}
