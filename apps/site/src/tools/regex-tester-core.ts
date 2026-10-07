/**
 * Regex Tester pure helpers (DOM-free; unit-tested in test/regex-tester.test.ts):
 * JS-style flag checkboxes → Rust inline flags, match + capture-group
 * highlighting markup for the backdrop layer (nested groups: inner fill,
 * outer underline), capture labels/states for the details list, and tolerant parsing of saved patterns from localStorage
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
 * One capture group of a match, as reported by the WASM engine. `matched`
 * false = the group did not participate (optional group, other alternation
 * branch); that is different from a group that matched the empty string.
 * Missing fields arrive as `undefined` from serde, hence the loose `?: | null`.
 */
export interface CaptureSpan {
  index: number;
  name?: string | null;
  matched: boolean;
  text?: string | null;
  start?: number | null;
  end?: number | null;
}

/** Whole match plus its capture groups (positions = UTF-16 offsets). */
export interface MatchWithCaptures extends MatchSpan {
  captures?: readonly CaptureSpan[];
}

/** Number of recurring capture colours (spectrum hues reused from `--mdt-cat-*`). */
export const CAPTURE_HUES = 6;

/** Colour slot 0..5 for capture group `index` (1-based); colours repeat, numbers don't. */
export function captureHue(index: number): number {
  return (Math.max(1, index) - 1) % CAPTURE_HUES;
}

/** Legend / details label: `2` or `2 · year` (user-defined name kept verbatim). */
export function captureLabel(index: number, name?: string | null): string {
  return name ? `${index} · ${name}` : String(index);
}

/**
 * Group value state for the details list: "unmatched" (did not participate),
 * "empty" (participated, matched ""), or "value" (non-empty text).
 */
export function captureState(c: CaptureSpan): "unmatched" | "empty" | "value" {
  if (!c.matched || c.start == null || c.end == null) return "unmatched";
  return c.end > c.start ? "value" : "empty";
}

export interface HighlightOptions {
  /** Capture group to emphasize (1-based); other groups are dimmed. */
  selected?: number | null;
  /** Only the first N matches get capture colours (DOM budget); the rest keep whole-match shading. */
  captureLimit?: number;
}

/**
 * Splits one match into elementary segments at every capture boundary and
 * returns marks for the highlight backdrop. Nested/overlapping groups: the
 * selected group, else the innermost (shortest) group owns the fill; the
 * nearest enclosing group draws an underline. Uncovered match text keeps the
 * subdued whole-match shading. Spans outside the match or reversed are ignored.
 */
function matchMarksHtml(value: string, m: MatchWithCaptures, opts: HighlightOptions): string {
  const groups = (m.captures ?? []).filter(
    (c) => c.matched && c.start != null && c.end != null && c.end > c.start && c.start >= m.start && c.end <= m.end,
  ) as Array<CaptureSpan & { start: number; end: number }>;
  const selected = opts.selected ?? null;
  const cuts = new Set<number>([m.start, m.end]);
  for (const g of groups) {
    cuts.add(g.start);
    cuts.add(g.end);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const byDepth = (a: CaptureSpan & { start: number; end: number }, b: typeof a) =>
    a.end - a.start - (b.end - b.start) || b.index - a.index;

  let html = "";
  let pendingClass = "";
  let pendingText = "";
  const flush = () => {
    if (pendingText) html += `<mark class="${pendingClass}">${escapeHtml(pendingText)}</mark>`;
    pendingText = "";
  };
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const covering = groups.filter((g) => g.start <= a && g.end >= b).sort(byDepth);
    let cls = "rx-mark";
    if (covering.length > 0) {
      const fill = covering.find((g) => g.index === selected) ?? covering[0];
      const under = covering.find((g) => g !== fill);
      cls += ` rx-cap rx-c${captureHue(fill.index)}`;
      if (under) cls += ` rx-u${captureHue(under.index)}`;
      if (selected !== null) cls += fill.index === selected ? " is-sel" : " is-dim";
    }
    if (cls !== pendingClass) flush();
    pendingClass = cls;
    pendingText += value.slice(a, b);
  }
  flush();
  return html;
}

/**
 * Escaped text with `<mark class="rx-mark">` around each non-overlapping
 * match (spans out of order/overlapping/out of range are skipped). Matches
 * carrying capture groups are split into coloured group segments (see
 * `matchMarksHtml`). A trailing newline gets a filler line so the backdrop
 * keeps the textarea's scroll height.
 */
export function buildHighlightHtml(
  value: string,
  matches: readonly MatchWithCaptures[],
  opts: HighlightOptions = {},
): string {
  const captureLimit = opts.captureLimit ?? Infinity;
  let html = "";
  let last = 0;
  let n = 0;
  for (const m of matches) {
    if (m.start < last || m.end < m.start || m.end > value.length) continue;
    html += escapeHtml(value.slice(last, m.start));
    if (m.end > m.start) {
      html += n < captureLimit && m.captures?.length
        ? matchMarksHtml(value, m, opts)
        : `<mark class="rx-mark">${escapeHtml(value.slice(m.start, m.end))}</mark>`;
    }
    n++;
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
