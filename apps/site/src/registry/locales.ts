/**
 * Locale registry — the single source of truth for supported languages.
 * Source: legacy `JsonLocalizationService` supported set (en, ru, es, de, pt, zh, fr, ja, ko, hi),
 * `MetaTags.razor` og:locale + hreflang maps, and native names (not stored in the legacy repo).
 *
 * Adding a language = one entry here + full locale JSON tree under
 * `src/i18n/locales/<code>/`. Build-time validation enforces presence of every
 * tool namespace across all registered locales.
 */

export type LocaleCode =
  | "en"
  | "ru"
  | "es"
  | "de"
  | "pt"
  | "zh"
  | "fr"
  | "ja"
  | "ko"
  | "hi";

export interface LocaleMeta {
  /** URL segment, also used to key locale JSON. */
  code: LocaleCode;
  /** Endonym, shown in the language switcher. */
  nativeName: string;
  /** English name, used for `hreflang` titles and tooling. */
  englishName: string;
  /** Text direction. */
  dir: "ltr" | "rtl";
  /** BCP-47 tag for `<html lang>` and hreflang. `zh-Hans` matches the legacy site. */
  bcp47: string;
  /** Open Graph locale (`og:locale`), e.g. `en_US`. Source: legacy MetaTags.razor. */
  ogLocale: string;
}

export const LOCALES: readonly LocaleMeta[] = [
  { code: "en", nativeName: "English", englishName: "English", dir: "ltr", bcp47: "en", ogLocale: "en_US" },
  { code: "ru", nativeName: "Русский", englishName: "Russian", dir: "ltr", bcp47: "ru", ogLocale: "ru_RU" },
  { code: "es", nativeName: "Español", englishName: "Spanish", dir: "ltr", bcp47: "es", ogLocale: "es_ES" },
  { code: "de", nativeName: "Deutsch", englishName: "German", dir: "ltr", bcp47: "de", ogLocale: "de_DE" },
  { code: "pt", nativeName: "Português", englishName: "Portuguese", dir: "ltr", bcp47: "pt", ogLocale: "pt_BR" },
  { code: "zh", nativeName: "中文", englishName: "Chinese", dir: "ltr", bcp47: "zh-Hans", ogLocale: "zh_CN" },
  { code: "fr", nativeName: "Français", englishName: "French", dir: "ltr", bcp47: "fr", ogLocale: "fr_FR" },
  { code: "ja", nativeName: "日本語", englishName: "Japanese", dir: "ltr", bcp47: "ja", ogLocale: "ja_JP" },
  { code: "ko", nativeName: "한국어", englishName: "Korean", dir: "ltr", bcp47: "ko", ogLocale: "ko_KR" },
  { code: "hi", nativeName: "हिन्दी", englishName: "Hindi", dir: "ltr", bcp47: "hi", ogLocale: "hi_IN" },
] as const;

export const LOCALE_CODES: readonly LocaleCode[] = LOCALES.map((l) => l.code);

/** Canonical fallback per the legacy `JsonLocalizationService`. */
export const DEFAULT_LOCALE: LocaleCode = "en";

export function isLocaleCode(value: string): value is LocaleCode {
  return LOCALE_CODES.includes(value as LocaleCode);
}

export function getLocale(code: string): LocaleMeta | undefined {
  return LOCALES.find((l) => l.code === code);
}
