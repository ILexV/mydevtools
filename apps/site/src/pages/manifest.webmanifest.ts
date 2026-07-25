import type { APIRoute } from "astro";
import { LOCALES, DEFAULT_LOCALE } from "@/registry/locales";
import { t } from "@/i18n/messages";

/**
 * Web App Manifest — emitted at build time as `dist/manifest.webmanifest`.
 *
 * `start_url`/`scope` use `import.meta.env.BASE_URL` so they stay correct under
 * the GitHub Pages subpath (`/mydevtools/`) without hardcoding. Icons live in
 * `public/icons/` and are referenced base-relative. The page-level manifest link
 * is emitted by `Seo.astro`.
 */
export const GET: APIRoute = () => {
  const base = import.meta.env.BASE_URL;
  const name = t(DEFAULT_LOCALE, "common", "AppName");
  const shortName = "MyDevTools";
  const description = t(DEFAULT_LOCALE, "home", "Subtitle");

  const icons = ([
    ["icon-192.png", "192x192", "any"],
    ["icon-512.png", "512x512", "any"],
    ["icon-512-maskable.png", "512x512", "maskable"],
  ] as const).map(([file, sizes, purpose]) => ({
    src: `${base}icons/${file}`,
    sizes,
    type: "image/png",
    purpose,
  }));

  const manifest = {
    name,
    short_name: shortName,
    description,
    // Language coverage is surfaced so browsers can hint at localization scope.
    lang: DEFAULT_LOCALE,
    start_url: `${base}?source=pwa`,
    scope: base,
    display: "standalone",
    orientation: "any",
    background_color: "#f6f7fb",
    theme_color: "#6a5af9",
    categories: ["developer", "utilities", "productivity"],
    icons,
    shortcuts: LOCALES.slice(0, 4).map((l) => ({
      name: l.nativeName,
      url: `${base}${l.code}/`,
    })),
  };

  return new Response(JSON.stringify(manifest), {
    headers: { "Content-Type": "application/manifest+json; charset=utf-8" },
  });
};
