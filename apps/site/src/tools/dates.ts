/**
 * Date conversion helpers (pure logic). Mirrors legacy date-converter behavior:
 * Auto/UnixSec/UnixMs/ISO parsing, ISO/European/UTC/Local/RFC/UnixSec/UnixMs/Custom
 * output formats, and custom-format tokens (yyyy MM dd HH mm ss SSS).
 */

export type InputType = "auto" | "unix-sec" | "unix-ms" | "iso";

export type OutputFormat =
  | "iso"
  | "euro"
  | "utc"
  | "local"
  | "rfc"
  | "unix-sec"
  | "unix-ms"
  | "custom";

/**
 * Parse a raw input string into a Date per the input type.
 * Auto sniffs digit-only strings as Unix timestamps (≤11 digits → seconds,
 * otherwise milliseconds) and falls back to Date parsing for everything else.
 * Returns null for empty input; the returned Date may still be Invalid.
 */
export function parse(value: string, type: InputType): Date | null {
  const v = value.trim();
  if (!v) return null;

  if (type === "auto") {
    if (/^\d{1,14}$/.test(v)) {
      const num = Number(v);
      return v.length <= 11 ? new Date(num * 1000) : new Date(num);
    }
    return new Date(v);
  }
  if (type === "unix-sec") return new Date(Number(v) * 1000);
  if (type === "unix-ms") return new Date(Number(v));
  return new Date(v);
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/**
 * Render a Date with a custom token format. Tokens (matched in legacy order):
 * yyyy MM dd HH mm ss SSS. Uses LOCAL time components, matching the legacy tool.
 */
export function formatCustom(date: Date, fmt: string): string {
  return fmt
    .replace("yyyy", String(date.getFullYear()))
    .replace("MM", pad(date.getMonth() + 1))
    .replace("dd", pad(date.getDate()))
    .replace("HH", pad(date.getHours()))
    .replace("mm", pad(date.getMinutes()))
    .replace("ss", pad(date.getSeconds()))
    .replace("SSS", pad(date.getMilliseconds(), 3));
}

/**
 * Format a Date to the chosen output format. Returns null when the date is
 * invalid (NaN). Custom format defaults to `dd.MM.yyyy` when no string given.
 */
export function format(date: Date, fmt: OutputFormat, custom?: string): string | null {
  if (Number.isNaN(date.getTime())) return null;
  switch (fmt) {
    case "iso":
      return date.toISOString();
    case "euro":
      return formatCustom(date, "dd.MM.yyyy HH:mm:ss");
    case "custom":
      return formatCustom(date, custom || "dd.MM.yyyy");
    case "utc":
      return date.toUTCString();
    case "local":
      return date.toString();
    case "rfc":
      return date.toUTCString();
    case "unix-sec":
      return Math.floor(date.getTime() / 1000).toString();
    case "unix-ms":
      return date.getTime().toString();
    default:
      return date.toISOString();
  }
}
