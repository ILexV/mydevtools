import type { DurationBucket, ToolErrorCategory, ToolEvent, ToolId } from "./events.ts";
import { trackToolEvent } from "./trackToolEvent.ts";

export interface ToolOperation {
  complete(): void;
  fail(reason: ToolErrorCategory): void;
  cancel(): void;
}

export type ToolEventSink = (event: ToolEvent) => void;

export function durationBucket(durationMs: number): DurationBucket {
  if (durationMs < 100) return "lt_100ms";
  if (durationMs < 1_000) return "100ms_1s";
  if (durationMs < 5_000) return "1s_5s";
  if (durationMs < 30_000) return "5s_30s";
  return "gte_30s";
}

/** State machine shared by explicit operations and deterministic lifecycle tests. */
export function createToolOperation(
  tool: ToolId,
  emit: ToolEventSink,
  clock: () => number,
): ToolOperation {
  emit({ tool, event: "tool_started" });
  const startedAt = clock();
  let settled = false;
  const finish = (terminal: () => void) => {
    if (settled) return;
    settled = true;
    terminal();
  };
  return {
    complete: () => finish(() => emit({
      tool,
      event: "tool_completed",
      duration: durationBucket(Math.max(0, clock() - startedAt)),
    })),
    fail: (reason) => finish(() => emit({ tool, event: "tool_failed", reason })),
    cancel: () => finish(() => emit({ tool, event: "tool_cancelled" })),
  };
}

/** Call only when real processing starts, after local preflight validation succeeds. */
export function startToolOperation(tool: ToolId): ToolOperation {
  return createToolOperation(
    tool,
    trackToolEvent,
    () => typeof performance === "undefined" ? Date.now() : performance.now(),
  );
}
