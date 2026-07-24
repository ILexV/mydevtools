/**
 * Pure, base-agnostic URL path helpers.
 *
 * No `import.meta` access — callers pass the resolved base/site, so routing
 * logic is unit-testable without a Vite/Astro context. `url.ts` binds these to
 * the real `import.meta.env.BASE_URL` / `SITE`.
 */

/** Ensure a base path has both leading and trailing slashes (e.g. "/mydevtools/"). */
export function normalizeBase(base: string): string {
  let b = base.endsWith("/") ? base : `${base}/`;
  if (!b.startsWith("/")) b = `/${b}`;
  return b;
}

/** Join a path onto a base. `path` may or may not have a leading slash. */
export function joinBase(base: string, path: string): string {
  const rest = path.startsWith("/") ? path.slice(1) : path;
  return `${normalizeBase(base)}${rest}`;
}

/**
 * Build a localized site path from a base: `localizedPathFor("/mydevtools/", "ru", "x")`
 * → "/mydevtools/ru/x/". Empty `path` → the locale home.
 */
export function localizedPathFor(base: string, lang: string, path = ""): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  const middle = trimmed ? `${lang}/${trimmed}` : lang;
  return `${normalizeBase(base)}${middle}/`;
}

/** Absolute URL (for canonical/og/sitemap) from an origin + a base-prefixed path. */
export function absoluteUrlFor(site: string, basePath: string): string {
  return new URL(basePath, site).toString();
}
