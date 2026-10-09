import { TOOLS } from "../../../apps/site/src/registry/tools.ts";
import {
  TOOL_EVENTS,
  type ToolEvent,
  type ToolEventType,
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

/** Parse only the two-string-field event object, retaining duplicate-key detection. */
function parseEventObject(input: string): Map<string, string> | null {
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
  const fields = parseEventObject(input);
  if (
    !fields ||
    fields.size !== 2 ||
    !fields.has("tool") ||
    !fields.has("event")
  ) {
    return null;
  }

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

  return {
    tool: tool as ToolEvent["tool"],
    event: event as ToolEventType,
  };
}
