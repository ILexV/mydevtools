/**
 * Base-aware URL helpers for GitHub Pages.
 *
 * All internal links/assets MUST go through these so the production build works
 * under a non-empty `base` (`/mydevtools/`). Never hardcode `/foo` paths.
 */
import type { LocaleCode } from "@/registry/locales";

/** Resolved at build time from `astro.config` `base`. Always has leading+trailing slash. */
export const BASE_URL: string = import.meta.env.BASE_URL?.endsWith("/")
  ? import.meta.env.BASE_URL
  : `${import.meta.env.BASE_URL}/`;

/** Join a path onto the configured base. Accepts with or without leading slash. */
export function withBase(path: string): string {
  const normalized = path.startsWith("/") ? path.slice(1) : path;
  return `${BASE_URL}${normalized}`;
}

/**
 * Build a localized site path: `localizedPath("ru", "hash-calculator")` →
 * `/mydevtools/ru/hash-calculator/`. Empty `path` → the locale home.
 */
export function localizedPath(lang: LocaleCode, path = ""): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  const middle = trimmed ? `${lang}/${trimmed}` : lang;
  return `${BASE_URL}${middle}/`;
}

/**
 * Absolute URL (for canonical/og/sitemap) from a base-prefixed path
 * (i.e. one already produced by `withBase`/`localizedPath`). Resolves against
 * `import.meta.env.SITE`; does NOT add the base a second time.
 */
export function absoluteUrl(basePath: string): string {
  return new URL(basePath, import.meta.env.SITE).toString();
}
