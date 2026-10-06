/**
 * JSON beautify / minify core for json-beautifier: indent 2/4/tab, compact
 * (minify), recursive sort keys. Numbers are kept exactly as written (big
 * integers like 12345678901234567890, `1.0`, `1e3`) via JSON.parse source
 * text + JSON.rawJSON when the engine supports them, so formatting never
 * changes values. `__proto__` keys survive sorting. Pure — unit-tested in
 * `test/json-format.test.ts`.
 */

export interface JsonFormatOptions {
  /** "2" | "4" | "tab" (select values); anything else falls back to 4 spaces. */
  indent: string;
  sortKeys: boolean;
  compact: boolean;
}

type RawJsonApi = {
  rawJSON?: (text: string) => unknown;
  isRawJSON?: (value: unknown) => boolean;
};
const RAW = JSON as unknown as RawJsonApi;

/** Space argument for JSON.stringify. */
export function jsonIndent(opts: JsonFormatOptions): string | number {
  if (opts.compact) return 0;
  if (opts.indent === "tab") return "\t";
  const n = Number.parseInt(opts.indent, 10);
  return n === 2 || n === 4 ? n : 4;
}

/** Reviver that swaps numbers whose JS value would print differently for their raw source text. */
function preserveNumbers(this: unknown, _key: string, value: unknown, context?: { source?: string }): unknown {
  if (typeof value === "number" && context?.source !== undefined && RAW.rawJSON && JSON.stringify(value) !== context.source) {
    return RAW.rawJSON(context.source);
  }
  return value;
}

function sortReplacer(_key: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || RAW.isRawJSON?.(value)) return value;
  // Null prototype: a "__proto__" key stays an own property instead of hitting the setter.
  const sorted: Record<string, unknown> = Object.create(null);
  for (const k of Object.keys(value).sort()) sorted[k] = (value as Record<string, unknown>)[k];
  return sorted;
}

/** Parse `input` and re-serialize it. Throws SyntaxError (engine message) on invalid JSON. */
export function formatJson(input: string, opts: JsonFormatOptions): string {
  const parsed: unknown = RAW.rawJSON ? JSON.parse(input, preserveNumbers as never) : JSON.parse(input);
  const space = jsonIndent(opts);
  return opts.sortKeys ? JSON.stringify(parsed, sortReplacer, space) : JSON.stringify(parsed, null, space);
}
