import type { ToolId } from "./events.ts";
import { trackToolEvent } from "./trackToolEvent.ts";

export interface ToolOperation {
  complete(): void;
  fail(): void;
}

/** Call only for explicit processing, after local preflight validation succeeds. */
export function startToolOperation(tool: ToolId): ToolOperation {
  trackToolEvent(tool, "tool_started");
  let settled = false;
  const finish = (event: "tool_completed" | "tool_failed") => {
    if (settled) return;
    settled = true;
    trackToolEvent(tool, event);
  };
  return {
    complete: () => finish("tool_completed"),
    // Expected abort/cancellation paths must not call fail(). No error data is accepted.
    fail: () => finish("tool_failed"),
  };
}
