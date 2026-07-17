/**
 * Build-time registry integrity check. Call `assertRegistryValid()` from a
 * module that always runs during build (e.g. the tools route frontmatter) so a
 * broken registry fails the build before any page is emitted.
 *
 * Locale-namespace completeness across all 10 languages is enforced by the
 * i18n validator (Stage 5), not here — this module only checks the registry's
 * own internal consistency.
 */
import { TOOLS, type Tool, type WasmDomain } from "./tools";
import { CATEGORIES, type CategoryId } from "./categories";
import { LOCALES } from "./locales";

const KNOWN_CATEGORIES: Record<CategoryId, true> = Object.fromEntries(
  CATEGORIES.map((c) => [c.id, true] as const),
) as Record<CategoryId, true>;
const KNOWN_WASM: Record<WasmDomain, true> = {
  hash: true,
  encoding: true,
  cryptography: true,
  structured_data: true,
  password: true,
  text_tools: true,
  image_tools: true,
  regex_tool: true,
  qrcode: true,
  pdf: true,
  ipcalc: true,
};

export interface RegistryIssue {
  slug: string;
  message: string;
}

/** Run registry self-checks. Returns issues (empty = healthy). Pure, no throws. */
export function lintRegistry(knownLocales = LOCALES.map((l) => l.code)): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  const seen = new Map<string, number>();

  for (const tool of TOOLS) {
    const t: Tool = tool;
    if (!KNOWN_CATEGORIES[t.category]) {
      issues.push({ slug: t.slug, message: `unknown category "${t.category}"` });
    }
    if (t.wasm !== null && !KNOWN_WASM[t.wasm]) {
      issues.push({ slug: t.slug, message: `unknown wasm domain "${t.wasm}"` });
    }
    seen.set(t.slug, (seen.get(t.slug) ?? 0) + 1);
  }

  for (const [slug, count] of seen) {
    if (count > 1) issues.push({ slug, message: `duplicate slug (${count} entries)` });
  }

  // Hard-coded expected count keeps the registry honest as tools are added.
  if (TOOLS.length !== 39) {
    issues.push({ slug: "__registry__", message: `expected 39 tools, found ${TOOLS.length}` });
  }
  if (knownLocales.length !== 10) {
    issues.push({ slug: "__registry__", message: `expected 10 locales, found ${knownLocales.length}` });
  }

  return issues;
}

/** Throws on any registry issue; call during build to fail fast. */
export function assertRegistryValid(): void {
  const issues = lintRegistry();
  if (issues.length === 0) return;
  const detail = issues.map((i) => `  - ${i.slug}: ${i.message}`).join("\n");
  throw new Error(`Registry validation failed:\n${detail}`);
}
