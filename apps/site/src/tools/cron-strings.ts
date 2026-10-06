/**
 * Build-time helper for the cron .astro shells: collects every cron
 * description template (`Schedule*` keys) of a
 * namespace as camelCased client strings for `describeCron` (`CronStrings`).
 * Base keys only: plural/ordinal variants must come from the locale itself
 * (`pluralVariants`), never from the en fallback (en "{0}st" ≠ ru "{0}-го").
 * Not imported by client code (it pulls in all locale messages).
 */
import { getNamespace, t } from "@/i18n/messages";
import type { LocaleCode } from "@/registry/locales";

export function scheduleTemplates(lang: LocaleCode, ns: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Keys come from en (canonical); values resolve with the usual locale → en fallback.
  for (const key of Object.keys(getNamespace("en", ns))) {
    if (key.startsWith("Schedule") && !/_(zero|one|two|few|many|other)$/.test(key)) out[key.charAt(0).toLowerCase() + key.slice(1)] = t(lang, ns, key);
  }
  return out;
}
