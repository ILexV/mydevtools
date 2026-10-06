/**
 * Client-side string formatting shared by tool controllers: positional
 * `{0}`/`{1}` interpolation (the locale-JSON placeholder convention) and
 * Intl.PluralRules-based plural-variant selection.
 *
 * Plural convention: a locale MAY provide `<Key>_<suffix>` variants next to
 * the base `<Key>` (suffix = Intl.PluralRules category: zero/one/two/few/
 * many/other). Locales without variants keep using the base key. Example:
 * `ScheduleEveryNMinutes_few` in `ru/tools/cron-parser.json`.
 *
 * Pure module — no DOM/Vite APIs, so it is unit-testable under node --test.
 */

/** Replace `{0}`, `{1}`, … placeholders, leaving unknown indices intact. */
export function formatString(
  template: string,
  ...values: Array<string | number>
): string {
  return template.replace(/\{(\d+)\}/g, (match, number: string) => {
    const idx = Number(number);
    return typeof values[idx] !== "undefined" ? String(values[idx]) : match;
  });
}

const pluralRulesCache = new Map<string, Intl.PluralRules>();

/** Intl.PluralRules category for `n` in `locale` ("one" | "few" | …). */
export function pluralSuffix(locale: string, n: number): string {
  let rules = pluralRulesCache.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRulesCache.set(locale, rules);
  }
  return rules.select(n);
}

/**
 * Format a count-sensitive string: picks `<baseKey>_<pluralCategory>` when the
 * locale provides it, else the base key, and interpolates `{0}` = n followed
 * by any extra positional values. Falls back to the raw key when absent.
 */
export function formatPlural(
  strings: Readonly<Record<string, unknown>>,
  baseKey: string,
  n: number,
  locale: string,
  ...values: Array<string | number>
): string {
  const raw = strings[`${baseKey}_${pluralSuffix(locale, n)}`] ?? strings[baseKey];
  if (typeof raw !== "string") return baseKey;
  return formatString(raw, n, ...values);
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * Human file size with binary (1024) steps: `512 B`, `1.5 KB`, `3.2 MB`.
 * Default precision matches the hash/encoding tools (1 digit, 2 from GB up);
 * pass `fractionDigits` for a fixed precision (image/PDF tools use 2).
 * Non-finite or negative input renders as `0 B`.
 */
export function formatBytes(bytes: number, fractionDigits?: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  const digits = fractionDigits ?? (unit >= 3 ? 2 : 1);
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

/** Elapsed time for progress labels: `850 ms`, `1.25 s`. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Percentage (0–100, clamped) of `processed / total`; 0 when total is 0. */
export function progressPercent(processed: number, total: number): number {
  if (!(total > 0) || !Number.isFinite(processed)) return 0;
  return Math.min(100, Math.max(0, (processed / total) * 100));
}
