/**
 * Pure i18n resolver: dotted-key lookup, `{name}` interpolation, and the
 * `lang → fallback → raw key` fallback chain. Extracted from `messages.ts`
 * (which binds it to the Vite glob) so the fallback contract — mirroring the
 * legacy `JsonLocalizationService` — is unit-testable without Astro.
 */

export type NamespaceMap = Record<string, unknown>;
export type Messages = Record<string, Record<string, NamespaceMap>>;

/** Resolve a dotted key path inside a namespace object, or undefined. */
export function lookup(nsData: NamespaceMap | undefined, key: string): string | undefined {
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

/** Interpolate `{name}` placeholders from params, leaving unknown ones intact. */
export function interpolate(
  template: string,
  params?: Readonly<Record<string, string | number>>,
): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : m,
  );
}

export interface TranslateOptions {
  params?: Readonly<Record<string, string | number>>;
}

/**
 * Translate a key in a namespace. Falls back `lang → fallback → raw key`.
 * Returns the raw key when nothing is found so missing strings are visible.
 */
export function translate(
  messages: Messages,
  lang: string,
  fallback: string,
  namespace: string,
  key: string,
  options?: TranslateOptions,
): string {
  const langs = lang === fallback ? [fallback] : [lang, fallback];
  for (const l of langs) {
    const found = lookup(messages[l]?.[namespace], key);
    if (found) return interpolate(found, options?.params);
  }
  return key;
}
