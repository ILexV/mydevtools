/**
 * Tool registry — the single source of truth for all 39 tools.
 *
 * Adding a tool = one entry here + locale JSON under
 * `src/i18n/locales/<lang>/tools/<slug>.json` (all 10 langs). Build-time
 * validation (Stage 4) verifies: unique slug, known category, and that every
 * locale has a `tools/<slug>` namespace.
 *
 * Derived data flows from this registry:
 *   - static routes via `getStaticPaths` (`/{lang}/{slug}/`)
 *   - home catalog & category grouping
 *   - search index (title/description/keywords pulled from locale JSON)
 *   - related tools, command palette, sitemap
 *
 * `localeNamespace` is always `tools/<slug>`; the `toolNamespace()` helper keeps
 * it DRY. Keywords live in each tool's locale JSON (kept English for SEO in the
 * legacy site) rather than duplicated here.
 *
 * Capabilities drive Stage 6/7/9 work (component selection, WASM lazy-load,
 * worker dispatch, file-flow patterns). Sourced from the inventory in
 * `docs/inventory-tools.md`.
 */
import type { CategoryId } from "./categories";
import type { LocaleCode } from "./locales";

/** Rust/WASM crate domain, or `null` for pure-JS tools. Mirrors `wasm/Cargo.toml`. */
export type WasmDomain =
  | "hash"
  | "encoding"
  | "cryptography"
  | "structured_data"
  | "password"
  | "text_tools"
  | "image_tools"
  | "regex_tool"
  | "qrcode"
  | "pdf"
  | "ipcalc";

export type FileInput = "single" | "multi" | "optional";

export interface ToolCapabilities {
  /** File handling: single, multi-file batch, or optional (text OR file). */
  file?: FileInput;
  /** Streams large files in chunks instead of buffering whole file. */
  chunked?: boolean;
  /** Reports progress for long operations. */
  progress?: boolean;
  /** Supports AbortController cancellation. */
  cancel?: boolean;
  /** Uses a code editor (CodeMirror / future editor). */
  codeEditor?: boolean;
  /** Output copy-to-clipboard. */
  copy?: boolean;
  /** Result download (file). */
  download?: boolean;
  /** Input ↔ output swap. */
  swap?: boolean;
  /** Depends on external CDN libs (Stage 7 must vendor or replace). */
  externalDeps?: boolean;
}

export interface Tool {
  slug: string;
  category: CategoryId;
  wasm: WasmDomain | null;
  capabilities: ToolCapabilities;
}

export const TOOLS: readonly Tool[] = [
  // ── encoding ──────────────────────────────────────────────────────────────
  { slug: "base64-encoder", category: "encoding", wasm: "encoding", capabilities: { file: "optional", chunked: true, progress: true, cancel: true, copy: true, download: true, swap: true } },
  { slug: "base32-encoder", category: "encoding", wasm: "encoding", capabilities: { file: "optional", chunked: true, progress: true, cancel: true, copy: true, download: true, swap: true } },
  { slug: "base58-encoder", category: "encoding", wasm: "encoding", capabilities: { file: "optional", progress: true, copy: true, download: true, swap: true } },
  { slug: "hex-encoder", category: "encoding", wasm: "encoding", capabilities: { file: "optional", chunked: true, progress: true, cancel: true, copy: true, download: true, swap: true } },
  { slug: "url-encoder", category: "encoding", wasm: "encoding", capabilities: { copy: true, swap: true } },
  { slug: "html-entity-encoder", category: "encoding", wasm: null, capabilities: { copy: true, swap: true } },

  // ── structured-data ───────────────────────────────────────────────────────
  { slug: "json-beautifier", category: "structured-data", wasm: null, capabilities: { codeEditor: true, copy: true } },
  { slug: "json-to-typescript", category: "structured-data", wasm: null, capabilities: { codeEditor: true, copy: true, download: true } },
  { slug: "xml-beautifier", category: "structured-data", wasm: null, capabilities: { codeEditor: true, copy: true } },
  { slug: "yaml-beautifier-validator", category: "structured-data", wasm: "structured_data", capabilities: { codeEditor: true, copy: true } },
  { slug: "cron-generator", category: "structured-data", wasm: null, capabilities: { copy: true } },
  { slug: "cron-parser", category: "structured-data", wasm: null, capabilities: { copy: true } },

  // ── text ──────────────────────────────────────────────────────────────────
  { slug: "word-counter", category: "text", wasm: null, capabilities: { copy: true } },
  { slug: "text-case-converter", category: "text", wasm: "text_tools", capabilities: { copy: true } },
  { slug: "text-diff-viewer", category: "text", wasm: null, capabilities: { file: "optional", copy: true, externalDeps: true } },

  // ── jwt ───────────────────────────────────────────────────────────────────
  { slug: "jwt-decoder", category: "jwt", wasm: "cryptography", capabilities: { copy: true } },
  { slug: "jwt-encoder", category: "jwt", wasm: "cryptography", capabilities: { copy: true } },

  // ── regex ─────────────────────────────────────────────────────────────────
  { slug: "regex-tester", category: "regex", wasm: "regex_tool", capabilities: { copy: true } },

  // ── hashing ───────────────────────────────────────────────────────────────
  { slug: "hash-calculator", category: "hashing", wasm: "hash", capabilities: { file: "optional", chunked: true, progress: true, cancel: true, copy: true } },
  { slug: "password-generator", category: "hashing", wasm: "password", capabilities: { copy: true } },

  // ── cryptography ──────────────────────────────────────────────────────────
  { slug: "hmac-calculator", category: "cryptography", wasm: "cryptography", capabilities: { copy: true } },
  { slug: "aead-file", category: "cryptography", wasm: "cryptography", capabilities: { file: "single", chunked: true, progress: true, cancel: true, download: true } },
  { slug: "openssh-keys", category: "cryptography", wasm: "cryptography", capabilities: { file: "optional", copy: true, download: true } },
  { slug: "x509", category: "cryptography", wasm: "cryptography", capabilities: { copy: true, download: true } },

  // ── generators (legacy: ungrouped; new IA) ────────────────────────────────
  { slug: "uuid-generator", category: "generators", wasm: null, capabilities: { copy: true, download: true } },
  { slug: "lorem-ipsum-generator", category: "generators", wasm: null, capabilities: { copy: true, download: true } },

  // ── converters ────────────────────────────────────────────────────────────
  { slug: "unit-converter", category: "converters", wasm: null, capabilities: { copy: true } },
  { slug: "date-converter", category: "converters", wasm: null, capabilities: { copy: true } },
  { slug: "ip-subnet-calculator", category: "converters", wasm: "ipcalc", capabilities: { copy: true } },

  // ── design ────────────────────────────────────────────────────────────────
  { slug: "color-converter", category: "design", wasm: null, capabilities: { copy: true } },
  { slug: "markdown-preview", category: "design", wasm: null, capabilities: { copy: true, download: true, externalDeps: true } },

  // ── images ────────────────────────────────────────────────────────────────
  { slug: "image-compressor", category: "images", wasm: "image_tools", capabilities: { file: "multi", progress: true, download: true, externalDeps: true } },
  { slug: "image-converter", category: "images", wasm: "image_tools", capabilities: { file: "single", download: true } },
  { slug: "image-resizer", category: "images", wasm: "image_tools", capabilities: { file: "single", download: true } },

  // ── pdf ───────────────────────────────────────────────────────────────────
  { slug: "pdf-compressor", category: "pdf", wasm: "pdf", capabilities: { file: "multi", progress: true, download: true } },
  { slug: "pdf-merger", category: "pdf", wasm: "pdf", capabilities: { file: "multi", progress: true, download: true } },
  { slug: "pdf-to-text", category: "pdf", wasm: "pdf", capabilities: { file: "multi", progress: true, download: true } },

  // ── qrcode ────────────────────────────────────────────────────────────────
  { slug: "qr-code-generator", category: "qrcode", wasm: "qrcode", capabilities: { file: "optional", download: true } },
  { slug: "qr-scanner", category: "qrcode", wasm: "qrcode", capabilities: { file: "single", copy: true } },
] as const;

export const TOOL_COUNT = TOOLS.length;

/** Locale namespace for a tool — always `tools/<slug>` (legacy contract). */
export function toolNamespace(slug: string): string {
  return `tools/${slug}`;
}

export function getTool(slug: string): Tool | undefined {
  return TOOLS.find((t) => t.slug === slug);
}

export function toolsByCategory(category: CategoryId): Tool[] {
  return TOOLS.filter((t) => t.category === category);
}

export interface ResolvedTool {
  tool: Tool;
  namespace: string;
  /** Stable id for sitemap / structured data. */
  seoId: string;
}

/** Resolve a tool's derived metadata for routing/SEO. */
export function resolveTool(slug: string): ResolvedTool | undefined {
  const tool = getTool(slug);
  if (!tool) return undefined;
  return { tool, namespace: toolNamespace(slug), seoId: slug };
}

/** Locales × tools → every localized route param for `getStaticPaths`. */
export function allLocalizedRoutes(langs: readonly LocaleCode[]) {
  return langs.flatMap((lang) => TOOLS.map((tool) => ({ lang, slug: tool.slug })));
}
