/**
 * Build-time localization. Locale JSON lives under `./locales/<code>/<namespace>.json`.
 * Astro renders localized HTML at build time; the browser never loads the full catalog.
 *
 * Lookup order for `t(lang, ns, key)`: `lang` → `en` → return the key itself.
 * Mirrors the legacy `JsonLocalizationService` fallback contract. The pure
 * resolver lives in `./resolve.ts` (unit-tested); this module binds it to the
 * Vite-globbed message catalog.
 */
import type { LocaleCode } from "@/registry/locales";
import { DEFAULT_LOCALE } from "@/registry/locales";
import { translate } from "./resolve";

// Eager glob: every namespace, every language, inlined into the build graph.
const modules = import.meta.glob<{ default: Record<string, unknown> }>(
  "./locales/**/*.json",
  { eager: true },
);

type NamespaceData = Record<string, unknown>;
type Messages = Partial<Record<LocaleCode, Record<string, NamespaceData>>>;

/** `locales/en/common.json` → messages["en"]["common"]. */
export const messages: Messages = buildMessages();

function buildMessages(): Messages {
  const out: Messages = {};
  for (const [path, mod] of Object.entries(modules)) {
    // path shape: "./locales/en/common.json" or "./locales/en/tools/base64-encoder.json"
    const match = path.match(/\/locales\/([^/]+)\/(.+)\.json$/);
    if (!match) continue;
    const [, code, ns] = match;
    const lang = code as LocaleCode;
    (out[lang] ??= {})[ns] = mod.default;
  }
  return out;
}

export interface TranslateOptions {
  params?: Readonly<Record<string, string | number>>;
  /** Override fallback (defaults to `en`). */
  fallback?: LocaleCode;
}

/**
 * Translate a key in a namespace. Falls back `lang → fallback → raw key`.
 * Returns the raw key when nothing is found so missing strings are visible.
 */
export function t(
  lang: LocaleCode,
  namespace: string,
  key: string,
  options?: TranslateOptions,
): string {
  const fallback = options?.fallback ?? DEFAULT_LOCALE;
  return translate(messages as unknown as Parameters<typeof translate>[0], lang, fallback, namespace, key, options);
}

/** Fetch a whole namespace object (e.g. to pass a tool's UI strings to its client controller). */
export function getNamespace(lang: LocaleCode, namespace: string): Record<string, unknown> {
  return messages[lang]?.[namespace] ?? messages[DEFAULT_LOCALE]?.[namespace] ?? {};
}
