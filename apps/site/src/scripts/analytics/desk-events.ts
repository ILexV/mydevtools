import { DESK_EVENTS, type DeskEvent, type DeskEventType } from "./events.ts";
import { sendDeskEvent } from "./transport.ts";

export { DESK_EVENTS, type DeskEvent, type DeskEventType };

export type DeskWindowBucket = (typeof DESK_EVENTS)["desk_windows"][number];

/** Coarse bucket for the number of open desktop windows; `null` when nothing is open (< 1). */
export function windowCountBucket(count: number): DeskWindowBucket | null {
  if (!Number.isFinite(count) || count < 1) return null;
  if (count < 2) return "1";
  if (count < 3) return "2";
  if (count < 4) return "3";
  if (count < 6) return "4_5";
  return "6_plus";
}

/**
 * Fire-and-forget anonymous desktop-mode usage event (desk_opened, desk_windows, …).
 * Same gating as tool events: build-time ANALYTICS_ENABLED opt-in, then DNT/GPC/offline checks in
 * the transport. Never throws; sends only the fixed event/detail pair, no identifiers or content.
 */
export function trackDeskEvent(event: DeskEvent): void {
  try {
    if (import.meta.env?.ANALYTICS_ENABLED !== true) return;
    sendDeskEvent(event);
  } catch {
    // Telemetry must never break the desktop.
  }
}
