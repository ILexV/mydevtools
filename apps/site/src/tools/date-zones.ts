/**
 * "Same instant" helpers for the date converter (pure, unit-tested in
 * test/date-zones.test.ts): which world clocks / time zones to show for one
 * epoch (UTC, device zone, New York, Tokyo — deduplicated), their localized
 * date-time and numeric UTC offset via cached Intl.DateTimeFormat with an
 * explicit timeZone (no manual offset arithmetic), the relative-time unit, and
 * whether a zone-less input was assumed to be UTC or device-local time.
 */
import type { InputType } from "@/tools/dates";

/** Fixed reference zones after UTC and the device zone. */
export const REFERENCE_ZONES = ["America/New_York", "Asia/Tokyo"] as const;

/** IANA aliases of UTC — a device in one of them shares the UTC row. */
const UTC_ALIASES = new Set(["UTC", "Etc/UTC", "Etc/UCT", "UCT", "Etc/GMT", "GMT", "Etc/GMT0", "GMT0", "Etc/Universal", "Universal", "Etc/Zulu", "Zulu", "Etc/Greenwich", "Greenwich"]);

/** One "same instant" row: IANA zone, whether it is the device's zone, and whether it is UTC. */
export interface ZoneRow {
  zone: string;
  device: boolean;
  utc: boolean;
}

/** Canonical IANA id as the engine resolves it (aliases collapse), or null if unknown. */
export function canonicalZone(zone: string): string | null {
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
    return UTC_ALIASES.has(resolved) ? "UTC" : resolved;
  } catch {
    return null;
  }
}

/**
 * Rows for UTC, the device time zone, America/New_York and Asia/Tokyo in that
 * order, deduplicated by canonical id: a device already in one of them marks
 * that row as the device instead of adding a duplicate. Unknown device zone → skipped.
 */
export function sameInstantZones(deviceZone: string | undefined): ZoneRow[] {
  const device = deviceZone ? canonicalZone(deviceZone) : null;
  const fixed = ["UTC", ...REFERENCE_ZONES].map((zone) => canonicalZone(zone));
  // A device already among the fixed zones keeps that zone's position.
  const extra = device && !fixed.includes(device) ? [device] : [];
  const rows: ZoneRow[] = [];
  for (const zone of ["UTC", ...extra, ...REFERENCE_ZONES]) {
    if (!zone) continue;
    const id = canonicalZone(zone);
    if (!id || rows.some((row) => row.zone === id)) continue;
    rows.push({ zone: id, device: id === device, utc: id === "UTC" });
  }
  return rows;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** Cached Intl.DateTimeFormat per (locale, zone, purpose) — rows re-render on every keystroke. */
function cachedFormatter(locale: string, zone: string, kind: "display" | "offset" | "name"): Intl.DateTimeFormat {
  const key = `${locale}|${zone}|${kind}`;
  let fmt = formatterCache.get(key);
  if (!fmt) {
    const options: Intl.DateTimeFormatOptions =
      kind === "display"
        ? { timeZone: zone, weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }
        : { timeZone: zone, timeZoneName: kind === "offset" ? "longOffset" : "longGeneric" };
    fmt = new Intl.DateTimeFormat(kind === "offset" ? "en-US" : locale, options);
    formatterCache.set(key, fmt);
  }
  return fmt;
}

function zoneNamePart(fmt: Intl.DateTimeFormat, date: Date): string {
  return fmt.formatToParts(date).find((part) => part.type === "timeZoneName")?.value ?? "";
}

/**
 * Numeric UTC offset of `zone` at this instant as "UTC+09:00" / "UTC-05:00" /
 * "UTC+00:00" — read from Intl's longOffset ("GMT+09:00", "GMT" for zero), so
 * DST and historical offsets come from the time-zone database.
 */
export function utcOffset(date: Date, zone: string): string {
  const raw = zoneNamePart(cachedFormatter("en-US", zone, "offset"), date).replace(/^GMT/, "");
  return `UTC${raw === "" ? "+00:00" : raw}`;
}

/** Localized wall-clock date-time of the instant in `zone` (weekday shows day changes across zones). */
export function zonedDateTime(date: Date, zone: string, locale: string): string {
  return cachedFormatter(locale, zone, "display").format(date);
}

/** Localized generic zone name ("Japan Standard Time", "Восточная Америка"); "" when Intl only has a GMT offset. */
export function zoneName(date: Date, zone: string, locale: string): string {
  const name = zoneNamePart(cachedFormatter(locale, zone, "name"), date);
  return /^(GMT|UTC)([+-]|$)/.test(name) ? "" : name;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Relative-time value + unit for Intl.RelativeTimeFormat (minute granularity —
 * the line refreshes once a minute, never ticks seconds): <1 min "now", <1 h minutes,
 * <1 day hours, <30 days days, <1 year months (30.44 d), otherwise years.
 */
export function relativeUnit(targetMs: number, nowMs: number): { value: number; unit: Intl.RelativeTimeFormatUnit } {
  const diff = targetMs - nowMs;
  const abs = Math.abs(diff);
  const round = (n: number) => Math.round(n) || 0; // avoid -0 ("0 minutes ago" vs "now")
  if (abs < MINUTE) return { value: 0, unit: "second" }; // "now" with numeric: "auto"
  if (abs < HOUR) return { value: round(diff / MINUTE), unit: "minute" };
  if (abs < DAY) return { value: round(diff / HOUR), unit: "hour" };
  if (abs < 30 * DAY) return { value: round(diff / DAY), unit: "day" };
  if (abs < 365 * DAY) return { value: round(diff / (30.44 * DAY)), unit: "month" };
  return { value: round(diff / (365.2425 * DAY)), unit: "year" };
}

/** ISO date-only forms ("2024", "2024-02", "2024-02-29", ±YYYYYY) that JS parses as UTC midnight. */
const ISO_DATE_ONLY = /^(?:\d{4}|[+-]\d{6})(?:-\d{2}(?:-\d{2})?)?$/;
/**
 * Explicit zone at the end: a time followed by Z / ±hh / ±hh:mm / ±hhmm, or a
 * GMT/UTC/UT/US-zone abbreviation (optionally with an offset or "(name)").
 */
const HAS_ZONE =
  /(?:\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)|\b(?:GMT|UTC|UT|Z|[ECMP][SD]T)(?:\s*[+-]\d{1,2}(?::?\d{2})?)?(?:\s*\([^)]*\))?)\s*$/i;

/**
 * Zone the converter ASSUMED because the input carried none, mirroring JS Date
 * parsing semantics: epoch numbers are absolute (null); explicit Z/offset/GMT
 * (null); ISO date-only → "utc"; any other zone-less date string → "local"
 * (device time zone). Shown to the user so it never looks like it was supplied.
 */
export function assumedZone(value: string, type: InputType): "utc" | "local" | null {
  const v = value.trim();
  if (!v || type === "unix-sec" || type === "unix-ms") return null;
  if (type === "auto" && /^[+-]?\d+(?:\.\d+)?$/.test(v)) return null;
  if (ISO_DATE_ONLY.test(v)) return "utc";
  if (HAS_ZONE.test(v)) return null;
  return "local";
}
