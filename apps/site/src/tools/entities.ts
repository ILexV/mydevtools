/**
 * HTML entity encode/decode. Pure logic, no DOM. Mirrors the legacy
 * html-entity-encoder behavior: named/decimal/hex formats, special-chars /
 * non-ASCII / all modes, and reversal of named + numeric references.
 *
 * Deviation from legacy (bug fix, QA 2026-10-06): encoding iterates by code
 * point, so an emoji becomes one reference (`&#x1F600;`) instead of two
 * surrogate halves (`&#xD83D;&#xDE00;`), which browsers render as U+FFFD.
 * Decoding is a single pass (`&amp;lt;` → `&lt;`, not `<`) and still joins
 * legacy surrogate-half references back into the original character.
 */

export type EntityMode = "all" | "specialchars" | "nonascii";
export type EntityFormat = "named" | "decimal" | "hex";

/** Named entities recognized on decode (entity → char). Source: legacy tool. */
export const namedEntities: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#x60;": "`",
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": "\u00A0",
  "&copy;": "\u00A9",
  "&reg;": "\u00AE",
  "&trade;": "\u2122",
  "&mdash;": "\u2014",
  "&ndash;": "\u2013",
  "&hellip;": "\u2026",
  "&ldquo;": "\u201C",
  "&rdquo;": "\u201D",
  "&lsquo;": "\u2018",
  "&rsquo;": "\u2019",
  "&bull;": "\u2022",
  "&middot;": "\u00B7",
  "&times;": "\u00D7",
  "&divide;": "\u00F7",
  "&plusmn;": "\u00B1",
  "&frac14;": "\u00BC",
  "&frac12;": "\u00BD",
  "&frac34;": "\u00BE",
  "&deg;": "\u00B0",
  "&euro;": "\u20AC",
  "&pound;": "\u00A3",
  "&yen;": "\u00A5",
  "&cent;": "\u00A2",
};

/** Reverse map for named encoding (char → entity). Last write wins, matching legacy. */
export const reverseNamedEntities: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [entity, char] of Object.entries(namedEntities)) {
    out[char] = entity;
  }
  return out;
})();

/** Encode text to entities per mode + format. Mode and format fall back to legacy defaults. */
export function encodeHtml(
  text: string,
  mode: EntityMode = "specialchars",
  format: EntityFormat = "named",
): string {
  const special: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": format === "decimal" ? "&#39;" : "&#x27;",
  };
  let result = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;

    if (special[char] !== undefined && (mode === "all" || mode === "specialchars")) {
      result += special[char];
    } else if ((mode === "nonascii" || mode === "all") && code > 127) {
      if (format === "named" && reverseNamedEntities[char]) {
        result += reverseNamedEntities[char];
      } else if (format === "decimal") {
        result += `&#${code};`;
      } else {
        result += `&#x${code.toString(16).toUpperCase()};`;
      }
    } else {
      result += char;
    }
  }
  return result;
}

/**
 * Decode named (from `namedEntities`), decimal (`&#DDD;`) and hex
 * (`&#xHH;` / `&#XHH;`) references in one pass. Unknown names and
 * out-of-range numbers (> U+10FFFF) are left untouched.
 */
export function decodeHtml(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body[0] !== "#") return namedEntities[match] ?? match;
    const hex = body[1] === "x" || body[1] === "X";
    const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isFinite(code) || code > 0x10ffff) return match;
    // fromCharCode for BMP values keeps legacy surrogate-half pairs joinable.
    return code <= 0xffff ? String.fromCharCode(code) : String.fromCodePoint(code);
  });
}
