import type { ToolEventType, ToolId } from "./events.ts";
import { sendToolEvent } from "./transport.ts";

/** Opt-in at build time; disabled in local development and tests by default. */
export function trackToolEvent(tool: ToolId, event: ToolEventType): void {
  if (import.meta.env?.ANALYTICS_ENABLED !== true) return;
  sendToolEvent(tool, event);
}
