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

const NUMERIC = /^[+-]?\d+(?:\.\d+)?$/;

/** Epoch value → Date; non-numeric text yields an Invalid Date (shown as error). */
function fromEpoch(v: string, multiplier: number): Date {
  if (!NUMERIC.test(v)) return new Date(NaN);
  return new Date(Math.round(Number(v) * multiplier));
}

/**
 * Parse a raw input string into a Date per the input type.
 * Auto sniffs numeric strings (optional sign / fraction) as Unix timestamps —
 * ≤11 integer digits → seconds, otherwise milliseconds (legacy rule) — and
 * falls back to Date parsing for everything else. Explicit Unix types accept
 * only plain decimal numbers (no hex/exponent). Returns null for empty input;
 * the returned Date may still be Invalid (out of range or unparseable).
 */
export function parse(value: string, type: InputType): Date | null {
  const v = value.trim();
  if (!v) return null;

  if (type === "auto") {
    if (NUMERIC.test(v)) {
      const intDigits = v.replace(/^[+-]/, "").split(".")[0].length;
      return fromEpoch(v, intDigits <= 11 ? 1000 : 1);
    }
    return new Date(v);
  }
  if (type === "unix-sec") return fromEpoch(v, 1000);
  if (type === "unix-ms") return fromEpoch(v, 1);
  return new Date(v);
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/**
 * Render a Date with a custom token format. Tokens: yyyy MM dd HH mm ss SSS,
 * every occurrence replaced in one pass (legacy replaced only the first one).
 * Uses LOCAL time components, matching the legacy tool.
 */
export function formatCustom(date: Date, fmt: string): string {
  return fmt.replace(/yyyy|MM|dd|HH|mm|ss|SSS/g, (tok) => {
    switch (tok) {
      case "yyyy": return pad(date.getFullYear(), 4);
      case "MM": return pad(date.getMonth() + 1);
      case "dd": return pad(date.getDate());
      case "HH": return pad(date.getHours());
      case "mm": return pad(date.getMinutes());
      case "ss": return pad(date.getSeconds());
      default: return pad(date.getMilliseconds(), 3);
    }
  });
}

/**
 * Format a Date to the chosen output format. Returns null when the date is
 * invalid (NaN). Custom format defaults to `dd.MM.yyyy` when no string given.
 * `local` renders in the page `locale` with the time-zone name when one is
 * given (Intl), otherwise the engine's `Date#toString()` (legacy).
 */
export function format(date: Date, fmt: OutputFormat, custom?: string, locale?: string): string | null {
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
      if (!locale) return date.toString();
      try {
        return date.toLocaleString(locale, { dateStyle: "full", timeStyle: "long" });
      } catch {
        return date.toString();
      }
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
