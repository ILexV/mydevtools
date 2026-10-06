import type { APIRoute } from "astro";
import { CATEGORIES } from "@/registry/categories";
import { TOOLS, resolveTool } from "@/registry/tools";
import type { LocaleCode } from "@/registry/locales";
import { categoryLabel } from "@/registry/catalog";
import { t } from "@/i18n/messages";
import { OG_HOME_SLUG, OG_LOCALES, firstSentence } from "@/lib/og/layout";
import { type CardAssets, type CardInput, MissingGlyphError, renderCard } from "@/lib/og/render";
import globalCss from "@/styles/global.css?raw";
import faviconSvg from "../../../../public/icons/favicon.svg?raw";

/**
 * Open Graph / Twitter share image endpoint: one 1200×630 PNG social preview
 * card per tool and locale (+ `home`), emitted at build time as
 * `dist/og/<lang>/<slug>.png` and referenced by `Seo.astro`. Only locales the
 * bundled fonts can render (`OG_LOCALES`); zh/ja/ko/hi pages use the en card.
 */
export function getStaticPaths() {
  return OG_LOCALES.flatMap((lang) =>
    [OG_HOME_SLUG, ...TOOLS.map((tool) => tool.slug)].map((slug) => ({ params: { lang, slug } })),
  );
}

const ASSETS: CardAssets = { css: globalCss, logoSvg: faviconSvg };
const SPECTRUM = [...CATEGORIES].sort((a, b) => a.order - b.order).map((c) => c.id);
const SITE_LABEL = `${new URL(import.meta.env.SITE).host}${import.meta.env.BASE_URL}`.replace(/\/+$/, "");

/** Localized card content for a tool (or the home page). */
function cardInput(lang: LocaleCode, slug: string): CardInput {
  const common = {
    brand: t(lang, "common", "AppName"),
    footnote: t(lang, "common", "NoDataSent"),
    siteLabel: SITE_LABEL,
    spectrum: SPECTRUM,
  };
  if (slug === OG_HOME_SLUG) {
    return { ...common, title: common.brand, tagline: firstSentence(t(lang, "home", "Subtitle")) };
  }
  const resolved = resolveTool(slug);
  if (!resolved) throw new Error(`og: unknown tool slug ${slug}`);
  const { tool, namespace } = resolved;
  return {
    ...common,
    title: t(lang, namespace, "Title"),
    tagline: firstSentence(t(lang, namespace, "Description")),
    monogram: tool.monogram,
    category: tool.category,
    categoryLabel: categoryLabel(lang, tool.category),
  };
}

/** Render one card; a string the fonts can't draw falls back to the English card. */
async function render(lang: LocaleCode, slug: string): Promise<Buffer> {
  try {
    return await renderCard(cardInput(lang, slug), ASSETS);
  } catch (err) {
    if (!(err instanceof MissingGlyphError) || lang === "en") throw err;
    console.warn(`${err.message} — og/${lang}/${slug}.png uses English text`);
    return renderCard(cardInput("en", slug), ASSETS);
  }
}

let batch: Map<string, Promise<Buffer>> | null = null;

/**
 * Build: Astro requests the cards one by one, so the first request starts all
 * of them at once (a small pool keeps sharp's libuv threads busy) — a few
 * seconds in total instead of ~0.1 s × 240 sequentially. Dev renders on demand.
 */
function cardPng(lang: LocaleCode, slug: string): Promise<Buffer> {
  if (import.meta.env.DEV) return render(lang, slug);
  if (!batch) {
    batch = new Map();
    const jobs = getStaticPaths().map(({ params }) => params);
    const resolvers = new Map<string, [(b: Buffer) => void, (e: unknown) => void]>();
    for (const p of jobs) {
      const key = `${p.lang}/${p.slug}`;
      const card = new Promise<Buffer>((res, rej) => resolvers.set(key, [res, rej]));
      card.catch(() => {}); // surfaced when Astro awaits this path, not as unhandled
      batch.set(key, card);
    }
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const p = jobs[next++];
        const [res, rej] = resolvers.get(`${p.lang}/${p.slug}`)!;
        await render(p.lang, p.slug).then(res, rej);
      }
    };
    for (let i = 0; i < 8; i++) void worker();
  }
  return batch.get(`${lang}/${slug}`) ?? render(lang, slug);
}

export const GET: APIRoute = async ({ params }) => {
  const png = await cardPng(params.lang as LocaleCode, params.slug as string);
  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png" },
  });
};
