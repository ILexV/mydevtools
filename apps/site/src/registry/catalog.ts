/**
 * Catalog data layer — joins the tool/category registries with localized strings
 * to produce everything the home, search, command palette, related-tools and
 * sitemap consume. Pure build-time function: call from Astro frontmatter.
 *
 * One call per locale at build; the result drives home sections, the embedded
 * search index, and related-tool links. Adding a tool = one `tools.ts` entry →
 * it appears here with no further edits (Stage 4 Gate 4 contract).
 */
import { CATEGORIES, type CategoryId, getCategory } from "./categories";
import { TOOLS, type Tool, type WasmDomain, toolNamespace } from "./tools";
import type { LocaleCode } from "./locales";
import { t } from "@/i18n/messages";
import { localizedPath } from "@/lib/url";

export interface CatalogTool {
  slug: string;
  title: string;
  description: string;
  /** English comma-separated keywords from the tool namespace (SEO + search). */
  keywords: string[];
  category: CategoryId;
  wasm: WasmDomain | null;
  href: string;
}

export interface CatalogCategory {
  id: CategoryId;
  label: string;
  iconKey: string;
  order: number;
  tools: CatalogTool[];
}

export interface Catalog {
  /** Categories sorted by display order, empty ones dropped. */
  categories: CatalogCategory[];
  /** Flat tool list (all categories) — the search index source. */
  tools: CatalogTool[];
}

function splitKeywords(raw: string): string[] {
  return raw
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0);
}

function buildTool(tool: Tool, lang: LocaleCode): CatalogTool {
  const ns = toolNamespace(tool.slug);
  const title = t(lang, ns, "Title");
  const description = t(lang, ns, "Description");
  const keywords = splitKeywords(t(lang, ns, "Keywords"));
  return {
    slug: tool.slug,
    title,
    description,
    keywords,
    category: tool.category,
    wasm: tool.wasm,
    href: localizedPath(lang, tool.slug),
  };
}

/** Build the full localized catalog for a locale. */
export function buildCatalog(lang: LocaleCode): Catalog {
  const tools = TOOLS.map((tool) => buildTool(tool, lang));

  const categories = CATEGORIES.map((cat) => ({
    id: cat.id,
    label: t(lang, "home", cat.labelKey),
    iconKey: cat.iconKey,
    order: cat.order,
    tools: tools.filter((tool) => tool.category === cat.id),
  }))
    .filter((cat) => cat.tools.length > 0)
    .sort((a, b) => a.order - b.order);

  return { categories, tools };
}

/** Tools sharing the same category as `slug`, excluding itself, capped. */
export function relatedTools(lang: LocaleCode, slug: string, limit = 6): CatalogTool[] {
  const tool = TOOLS.find((t) => t.slug === slug);
  if (!tool) return [];
  return TOOLS.filter((t) => t.category === tool.category && t.slug !== slug)
    .slice(0, limit)
    .map((t) => buildTool(t, lang));
}

/** Localized label for a category id (used by tool-page breadcrumbs/related). */
export function categoryLabel(lang: LocaleCode, id: CategoryId): string {
  const cat = getCategory(id);
  return cat ? t(lang, "home", cat.labelKey) : id;
}
