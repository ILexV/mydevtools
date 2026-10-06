/**
 * Regex Tester pure helpers (DOM-free; unit-tested in test/regex-tester.test.ts):
 * JS-style flag checkboxes → Rust inline flags, match highlighting markup for
 * the backdrop layer, and tolerant parsing of saved patterns from localStorage
 * (legacy key `mydevtools_regex_saved`, entry shape { name, pattern, sample?, flags? }).
 */

/** Match span from the WASM engine; positions are UTF-16 offsets (JS string indices). */
export interface MatchSpan {
  start: number;
  end: number;
}

export interface SavedPattern {
  name: string;
  pattern: string;
  sample?: string;
  flags?: string[];
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Flag checkboxes g/i/m/s → Rust inline group, e.g. ("a.b", ["g","i","s"]) →
 * "(?is)a.b". `g` is handled by the caller (all matches vs first). `u` is
 * ignored: Unicode mode is always on in the Rust engine, so the UI no longer
 * offers it, but saved legacy patterns may still carry it.
 */
export function buildRustPattern(pattern: string, flags: readonly string[]): string {
  const inline = flags.filter((f) => f.length === 1 && "imsUx".includes(f)).join("");
  return inline ? `(?${inline})${pattern}` : pattern;
}

/**
 * JS-style `g` semantics on top of the engine, which always returns every
 * match: without the Global flag only the first match is kept (previously
 * the checkbox had no effect).
 */
export function applyGlobalFlag<T>(matches: readonly T[], global: boolean): T[] {
  return global ? matches.slice() : matches.slice(0, 1);
}

/**
 * Escaped text with `<mark class="rx-mark">` around each non-overlapping span
 * (spans out of order/overlapping/out of range are skipped). A trailing newline
 * gets a filler line so the backdrop keeps the textarea's scroll height.
 */
export function buildHighlightHtml(value: string, matches: readonly MatchSpan[]): string {
  let html = "";
  let last = 0;
  for (const m of matches) {
    if (m.start < last || m.end < m.start || m.end > value.length) continue;
    html += escapeHtml(value.slice(last, m.start));
    if (m.end > m.start) html += `<mark class="rx-mark">${escapeHtml(value.slice(m.start, m.end))}</mark>`;
    last = m.end;
  }
  html += escapeHtml(value.slice(last));
  if (value.endsWith("\n")) html += "<br>&nbsp;";
  return html;
}

/** Parse the saved-patterns JSON; corrupt data or bad entries are dropped, never thrown. */
export function parseSavedPatterns(raw: string | null): SavedPattern[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item): SavedPattern[] => {
    if (!item || typeof item !== "object") return [];
    const { name, pattern, sample, flags } = item as Record<string, unknown>;
    if (typeof name !== "string" || typeof pattern !== "string") return [];
    const entry: SavedPattern = { name, pattern };
    if (typeof sample === "string") entry.sample = sample;
    if (Array.isArray(flags)) entry.flags = flags.filter((f): f is string => typeof f === "string");
    return [entry];
  });
}

/** Shorten long match text for the details list (by code points, emoji-safe). */
export function truncateText(text: string, max = 100): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") + "…" : text;
}
