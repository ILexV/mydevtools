import { TOOLS } from "../../../apps/site/src/registry/tools.ts";
import {
  DURATION_BUCKETS,
  TOOL_ERROR_CATEGORIES,
  TOOL_EVENTS,
  VOTE_CHOICES,
  isDeskEvent,
  type DeskEvent,
  type ToolEvent,
  type ToolEventType,
  type ToolVote,
} from "../../../apps/site/src/scripts/analytics/events.ts";

const TOOL_IDS: ReadonlySet<string> = new Set(TOOLS.map(({ slug }) => slug));

function skipJsonWhitespace(input: string, start: number): number {
  let index = start;
  while (
    index < input.length &&
    (input[index] === " " ||
      input[index] === "\t" ||
      input[index] === "\n" ||
      input[index] === "\r")
  ) {
    index += 1;
  }
  return index;
}

function readJsonString(
  input: string,
  start: number,
): { value: string; end: number } | null {
  if (input[start] !== '"') return null;

  let escaped = false;
  for (let index = start + 1; index < input.length; index += 1) {
    const character = input[index];
    if (!escaped && character === '"') {
      const encoded = input.slice(start, index + 1);
      try {
        const value: unknown = JSON.parse(encoded);
        return typeof value === "string" ? { value, end: index + 1 } : null;
      } catch {
        return null;
      }
    }
    if (!escaped && character === "\\") {
      escaped = true;
    } else {
      escaped = false;
    }
  }
  return null;
}

/** Parse a flat object with string values while retaining duplicate-key detection. */
function parseStringObject(input: string): Map<string, string> | null {
  let index = skipJsonWhitespace(input, 0);
  if (input[index] !== "{") return null;
  index = skipJsonWhitespace(input, index + 1);

  const fields = new Map<string, string>();
  if (input[index] === "}") return null;

  while (index < input.length) {
    const key = readJsonString(input, index);
    if (!key || fields.has(key.value)) return null;

    index = skipJsonWhitespace(input, key.end);
    if (input[index] !== ":") return null;

    index = skipJsonWhitespace(input, index + 1);
    const value = readJsonString(input, index);
    if (!value) return null;
    fields.set(key.value, value.value);

    index = skipJsonWhitespace(input, value.end);
    if (input[index] === "}") {
      index = skipJsonWhitespace(input, index + 1);
      return index === input.length ? fields : null;
    }
    if (input[index] !== ",") return null;
    index = skipJsonWhitespace(input, index + 1);
  }

  return null;
}

export function validateToolEvent(input: string): ToolEvent | null {
  const fields = parseStringObject(input);
  if (!fields || !fields.has("tool") || !fields.has("event")) return null;

  const tool = fields.get("tool");
  const event = fields.get("event");
  if (
    !tool ||
    !event ||
    !TOOL_IDS.has(tool) ||
    !TOOL_EVENTS.includes(event as ToolEventType)
  ) {
    return null;
  }

  const typedTool = tool as ToolEvent["tool"];
  const typedEvent = event as ToolEventType;
  switch (typedEvent) {
    case "tool_started":
    case "tool_cancelled":
      return fields.size === 2 ? { tool: typedTool, event: typedEvent } : null;
    case "tool_completed": {
      const duration = fields.get("duration");
      return fields.size === 3 &&
        duration !== undefined &&
        DURATION_BUCKETS.includes(duration as (typeof DURATION_BUCKETS)[number])
        ? {
            tool: typedTool,
            event: typedEvent,
            duration: duration as (typeof DURATION_BUCKETS)[number],
          }
        : null;
    }
    case "tool_failed": {
      const reason = fields.get("reason");
      return fields.size === 3 &&
        reason !== undefined &&
        TOOL_ERROR_CATEGORIES.includes(
          reason as (typeof TOOL_ERROR_CATEGORIES)[number],
        )
        ? {
            tool: typedTool,
            event: typedEvent,
            reason: reason as (typeof TOOL_ERROR_CATEGORIES)[number],
          }
        : null;
    }
  }
}

export function validateToolVote(input: string): ToolVote | null {
  const fields = parseStringObject(input);
  if (!fields || fields.size !== 1 || !fields.has("choice")) return null;
  const choice = fields.get("choice");
  return choice !== undefined &&
    VOTE_CHOICES.some(({ id }) => id === choice)
    ? { choice: choice as ToolVote["choice"] }
    : null;
}

/**
 * Desktop-mode event: exactly `{"event":"<name>"}` for detail-less events, or exactly
 * `{"event":"<name>","detail":"<bucket>"}` with a catalogued non-empty detail. An explicit
 * empty detail, unknown pairs, or any extra field are rejected.
 */
export function validateDeskEvent(input: string): DeskEvent | null {
  const fields = parseStringObject(input);
  if (!fields || !fields.has("event")) return null;
  const event = fields.get("event");
  if (fields.size === 1) {
    return isDeskEvent(event, "") ? ({ event, detail: "" } as DeskEvent) : null;
  }
  if (fields.size !== 2 || !fields.has("detail")) return null;
  const detail = fields.get("detail");
  return detail !== "" && isDeskEvent(event, detail)
    ? ({ event, detail } as DeskEvent)
    : null;
}
