/**
 * Pure helpers for the cron next-run timeline shared by cron-parser and
 * cron-generator: how many runs to compute/show ("Show next 5", capped at 10),
 * whether the engine's search horizon cut the list short, the "in 3 hours"
 * relative-time unit picked from a snapshot, the UTC offset label of the
 * evaluation time zone and splitting an expression into its five field values
 * for the field capsules. No DOM; unit-tested in `test/cron-timeline.test.ts`.
 */

/** Runs shown before "Show next 5". */
export const TIMELINE_INITIAL = 5;
/** Runs added per "Show next" click. */
export const TIMELINE_STEP = 5;
/** Hard cap: runs computed per evaluation and the most the timeline ever lists. */
export const TIMELINE_MAX = 10;

export interface TimelineView {
  /** Runs to render now. */
  visible: number;
  /** Runs the "Show next" button would add (0 → hide the button). */
  more: number;
  /** True when the engine found fewer runs than the timeline asked for (search horizon reached). */
  shortfall: boolean;
}

/**
 * What the timeline shows for `found` computed runs (≤ TIMELINE_MAX) after
 * `expansions` "Show next" clicks. A shortfall is reported only once the user
 * asked for more runs than exist, so five of seven runs don't warn early.
 */
export function timelineView(found: number, expansions: number): TimelineView {
  const wanted = Math.min(TIMELINE_MAX, TIMELINE_INITIAL + Math.max(0, expansions) * TIMELINE_STEP);
  const visible = Math.min(found, wanted);
  const more = wanted < TIMELINE_MAX ? Math.min(TIMELINE_STEP, found - visible, TIMELINE_MAX - visible) : 0;
  return { visible, more: Math.max(0, more), shortfall: found < wanted };
}

export type RelativeUnit = "second" | "minute" | "hour" | "day" | "month" | "year";

/**
 * Unit and rounded amount for "in …" (Intl.RelativeTimeFormat) between the
 * evaluation snapshot `nowMs` and a run at `atMs`. Seconds under a minute,
 * minutes under two hours (so 65 and 80 minutes don't both read "1 hour"),
 * hours under two days, days under two months, months
 * under two years, then years. Never returns 0 for a future run.
 */
export function relativeTimeParts(nowMs: number, atMs: number): { value: number; unit: RelativeUnit } {
  const sec = Math.max(0, (atMs - nowMs) / 1000);
  const pick = (value: number, unit: RelativeUnit) => ({ value: Math.max(1, Math.round(value)), unit });
  if (sec < 60) return pick(sec, "second");
  if (sec < 7200) return pick(sec / 60, "minute");
  if (sec < 48 * 3600) return pick(sec / 3600, "hour");
  const days = sec / 86400;
  if (days < 60) return pick(days, "day");
  if (days < 730) return pick(days / 30.4375, "month");
  return pick(days / 365.25, "year");
}

/** `UTC+06:00` / `UTC−03:30` / `UTC` for an offset in minutes east of UTC (`-date.getTimezoneOffset()`). */
export function utcOffsetLabel(offsetMinutes: number): string {
  if (!offsetMinutes) return "UTC";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.trunc(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `UTC${offsetMinutes > 0 ? "+" : "−"}${hh}:${mm}`;
}

/** Five field values (minute … weekday) of an expanded 5-field expression, or null when it isn't one. */
export function cronFieldValues(expanded: string | null): string[] | null {
  if (!expanded) return null;
  const parts = expanded.trim().split(/\s+/).filter(Boolean);
  return parts.length === 5 ? parts : null;
}
