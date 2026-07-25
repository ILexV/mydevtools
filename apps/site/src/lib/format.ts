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
