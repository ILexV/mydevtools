/**
 * Build-time localization. Locale JSON lives under `./locales/<code>/<namespace>.json`.
 * Astro renders localized HTML at build time; the browser never loads the full catalog.
 *
 * Lookup order for `t(lang, ns, key)`: `lang` → `en` → return the key itself.
 * Mirrors the legacy `JsonLocalizationService` fallback contract.
 */
import type { LocaleCode } from "@/registry/locales";
import { DEFAULT_LOCALE } from "@/registry/locales";

// Eager glob: every namespace, every language, inlined into the build graph.
const modules = import.meta.glob<{ default: Record<string, unknown> }>(
  "./locales/**/*.json",
  { eager: true },
);

type NamespaceMap = Record<string, Record<string, unknown>>;
type Messages = Partial<Record<LocaleCode, NamespaceMap>>;

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

/** Interpolate `{name}` placeholders from params, leaving unknown ones intact. */
function interpolate(template: string, params?: Readonly<Record<string, string | number>>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : m,
  );
}

/** Resolve a dotted key path inside a namespace object, or undefined. */
function lookup(nsData: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!nsData) return undefined;
  const parts = key.split(".");
  let node: unknown = nsData;
  for (const part of parts) {
    if (node && typeof node === "object" && part in (node as object)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof node === "string" ? node : undefined;
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
  const langs: LocaleCode[] = lang === fallback ? [fallback] : [lang, fallback];

  for (const l of langs) {
    const found = lookup(messages[l]?.[namespace], key);
    if (found) return interpolate(found, options?.params);
  }
  return key;
}

/** Fetch a whole namespace object (e.g. to pass a tool's UI strings to its client controller). */
export function getNamespace(lang: LocaleCode, namespace: string): Record<string, unknown> {
  return messages[lang]?.[namespace] ?? messages[DEFAULT_LOCALE]?.[namespace] ?? {};
}
