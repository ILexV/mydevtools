/**
 * Related-tools selection for the tool page ("Related tools" strip). Pure and
 * locale-independent so every language shows the same cards in the same order.
 *
 * Rule: same-category siblings first (registry order), then fill up to the
 * target count from neighbouring categories (CATEGORY_NEIGHBOURS order),
 * interleaved one tool per category so the fill mixes topics. Never includes
 * the tool itself; deterministic for a given registry.
 */
import type { CategoryId } from "./categories.ts";
import { CATEGORIES } from "./categories.ts";
import { TOOLS, type Tool } from "./tools.ts";

/** Default number of related cards (one desktop grid row). */
export const RELATED_COUNT = 4;

/**
 * Topical neighbours per category, closest first — what a visitor of one
 * category most plausibly needs next (e.g. hashing → cryptography/generators).
 */
export const CATEGORY_NEIGHBOURS: Record<CategoryId, readonly CategoryId[]> = {
  encoding: ["hashing", "structured-data", "cryptography"],
  "structured-data": ["text", "encoding", "regex"],
  text: ["regex", "structured-data", "generators"],
  jwt: ["cryptography", "encoding", "hashing"],
  regex: ["text", "structured-data", "encoding"],
  hashing: ["cryptography", "generators", "encoding"],
  cryptography: ["hashing", "jwt", "encoding"],
  generators: ["text", "hashing", "converters"],
  converters: ["structured-data", "generators", "design"],
  design: ["images", "converters", "text"],
  images: ["pdf", "design", "qrcode"],
  pdf: ["images", "text", "qrcode"],
  qrcode: ["images", "encoding", "generators"],
};

/** Slugs of the tools related to `slug` (empty for an unknown slug). */
export function relatedSlugs(slug: string, limit = RELATED_COUNT): string[] {
  const tool = TOOLS.find((t) => t.slug === slug);
  if (!tool || limit <= 0) return [];

  const picked: Tool[] = TOOLS.filter((t) => t.category === tool.category && t.slug !== slug).slice(0, limit);

  // Round-robin over the neighbours (first tool of each, then the second, …);
  // only when they run dry, every other category by display order.
  const fill = (ids: readonly CategoryId[]) => {
    const pools = ids.map((id) => TOOLS.filter((t) => t.category === id));
    for (let round = 0; picked.length < limit && pools.some((p) => p.length > round); round++) {
      for (const pool of pools) {
        if (picked.length >= limit) break;
        const candidate = pool[round];
        if (candidate) picked.push(candidate);
      }
    }
  };
  const neighbours = CATEGORY_NEIGHBOURS[tool.category];
  fill(neighbours);
  const rest = [...CATEGORIES]
    .sort((a, b) => a.order - b.order)
    .map((c) => c.id)
    .filter((id) => id !== tool.category && !neighbours.includes(id));
  fill(rest);
  return picked.map((t) => t.slug);
}
