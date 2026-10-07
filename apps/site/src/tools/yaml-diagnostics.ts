/**
 * YAML error mapping for yaml-beautifier-validator. The structured-data WASM
 * (Rust `yaml-rust` 0.4, pinned in wasm/Cargo.lock) reports a scanner marker
 * as "<info> at line L column C": L is 1-based and counts "\n" only, C is the
 * 1-based code-point column — so the position comes from the parser itself,
 * not from a browser. The crate's fixed `info` texts map to localized reason
 * keys (indentation, tab, unclosed flow collection, …); anything else keeps
 * the raw detail under the generic "Syntax" reason. Pure — unit-tested in
 * `test/parse-diagnostics.test.ts`.
 */
import { charEnd, offsetAt, type ParseDiagnostic } from "./parse-diagnostics.ts";

/** yaml-rust info fragment → reason key (first match wins). */
const YAML_REASONS: ReadonlyArray<[string, string]> = [
  ["did not find expected key", "YamlIndent"],
  ["did not find expected '-' indicator", "YamlIndent"],
  ["block sequence entries are not allowed", "YamlIndent"],
  ["mapping values are not allowed", "YamlMappingValue"],
  ["found a tab", "YamlTab"],
  ["tab character", "YamlTab"],
  ["expected ',' or ']'", "YamlFlowSequence"],
  ["expected ',' or '}'", "YamlFlowMapping"],
  ["found unexpected end of stream", "UnterminatedString"],
  ["found unknown anchor", "YamlUnknownAnchor"],
  ["found duplicated anchor", "YamlDuplicateAnchor"],
  ["did not find expected node content", "YamlExpectedValue"],
  ["simple key expect", "YamlExpectedColon"],
  ["could not find expected ':'", "YamlExpectedColon"],
  ["unknown escape character", "BadEscape"],
];

const MARKER_RE = /^([\s\S]*) at line (\d+) column (\d+)$/;

/**
 * Turn a structured-data WASM YAML error into a diagnostic for `text` (the
 * exact string that was parsed). The mark underlines the token that starts
 * there (up to whitespace / line end); at a line end or EOF it is an
 * insertion point. Unknown or out-of-range markers → location unknown.
 */
export function yamlDiagnostic(text: string, error: string): ParseDiagnostic {
  const m = MARKER_RE.exec(error.trim());
  const info = (m ? m[1] : error).trim();
  const reason = YAML_REASONS.find(([needle]) => info.includes(needle))?.[1];
  const base: ParseDiagnostic = reason ? { messageKey: reason, from: null, to: null } : { messageKey: "Syntax", from: null, to: null, detail: info };
  if (!m) return base;
  let from = offsetAt(text, Number(m[2]), Number(m[3]), true);
  if (from === null) return base;
  // Indentation errors: the marker sits on the token after the misplaced key;
  // underline the key itself (first non-blank of the reported line).
  if (reason === "YamlIndent") {
    let k = text.lastIndexOf("\n", from - 1) + 1;
    while (k < from && (text[k] === " " || text[k] === "\t")) k++;
    from = k;
  }
  let to = from;
  while (to < text.length && to - from < 40 && !/\s/.test(text[to]) && !(to > from && text[to] === ":")) to = charEnd(text, to);
  return { ...base, from, to };
}
