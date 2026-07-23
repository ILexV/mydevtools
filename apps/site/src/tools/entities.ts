/**
 * HTML entity encode/decode. Pure logic, no DOM. Mirrors the legacy
 * html-entity-encoder behavior: named/decimal/hex formats, special-chars /
 * non-ASCII / all modes, and reversal of named + numeric references.
 *
 * Iterates by UTF-16 code unit (legacy uses `text[i]` + `charCodeAt(0)`), so
 * surrogate pairs are handled one half at a time — intentional parity.
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
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const code = char.charCodeAt(0);

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

/** Decode named, decimal (&#DDD;), and hex (&#xHH;) entities back to characters. */
export function decodeHtml(text: string): string {
  let result = text.replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  result = result.replace(/&#(\d+);/g, (_m, dec: string) =>
    String.fromCharCode(parseInt(dec, 10)),
  );
  for (const [entity, char] of Object.entries(namedEntities)) {
    result = result.replace(new RegExp(entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), char);
  }
  return result;
}
