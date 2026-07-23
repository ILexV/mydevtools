/**
 * Text case transforms (pure JS). Mirrors the legacy `text_tools` WASM
 * `convert_text_case(text, case_type)` exactly — verified against the compiled
 * wasm across camelCase / digit / acronym boundaries, preserved punctuation,
 * and Unicode letters.
 *
 * Deviation from legacy: implemented in pure TS instead of Rust→WASM. The WASM
 * only exposed `convert_text_case`; the Rust source is not in the repo, so the
 * behavior below was reverse-engineered by running the shipped wasm and is
 * confirmed equivalent by a differential test.
 *
 * Model:
 *  - "separators" (space, '-', '_') collapse to a single joiner and trim at edges;
 *  - other whitespace (\t \n \r) is preserved verbatim and resets the camel index;
 *  - within a segment, words split on lower→upper, letter↔digit, and the
 *    acronym rule (uppercase run whose last letter precedes a lowercase letter);
 *  - non-alphanumeric punctuation attaches to the current word and is preserved.
 */

export type CaseType =
  | "sentence"
  | "lower"
  | "upper"
  | "title"
  | "alternating"
  | "inverse"
  | "camel"
  | "snake"
  | "kebab";

const isLower = (c: string): boolean => c !== c.toUpperCase();
const isUpper = (c: string): boolean => c !== c.toLowerCase();
const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isAlpha = (c: string): boolean => isLower(c) || isUpper(c);
const isAlnum = (c: string): boolean => isAlpha(c) || isDigit(c);
const isSeparator = (c: string): boolean => c === " " || c === "-" || c === "_";
const isWs = (c: string): boolean => c === "\t" || c === "\n" || c === "\r";

/** Insert a word boundary before `b` given prev alnum `a` and next alnum `next`. */
function boundaryBefore(a: string, b: string, next: string | null): boolean {
  const aD = isDigit(a);
  const bD = isDigit(b);
  if (aD && bD) return false; // digit-run
  if (aD || bD) return true; // letter↔digit
  // both letters
  if (isLower(a) && isUpper(b)) return true; // camelCase
  if (isUpper(a) && isUpper(b) && next !== null && isLower(next)) return true; // acronym
  return false;
}

/** Split a separator/whitespace-free segment into sub-words. */
function splitWords(segment: string): string[] {
  const alnum: string[] = [];
  for (const ch of segment) if (isAlnum(ch)) alnum.push(ch);
  const words: string[] = [];
  let cur = "";
  let ai = 0;
  for (const ch of segment) {
    if (isAlnum(ch)) {
      const prev = ai > 0 ? alnum[ai - 1] : null;
      const next = ai < alnum.length - 1 ? alnum[ai + 1] : null;
      if (prev !== null && boundaryBefore(prev, ch, next) && cur.length > 0) {
        words.push(cur);
        cur = "";
      }
      cur += ch;
      ai++;
    } else {
      cur += ch; // punctuation attaches to current word
    }
  }
  if (cur.length > 0) words.push(cur);
  return words;
}

type Token = { kind: "words"; words: string[] } | { kind: "sep" } | { kind: "ws"; ch: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (isSeparator(ch)) {
      while (i < n && isSeparator(input[i])) i++;
      tokens.push({ kind: "sep" });
    } else if (isWs(ch)) {
      tokens.push({ kind: "ws", ch });
      i++;
    } else {
      let seg = "";
      while (i < n && !isSeparator(input[i]) && !isWs(input[i])) {
        seg += input[i];
        i++;
      }
      tokens.push({ kind: "words", words: splitWords(seg) });
    }
  }
  // trim leading/trailing separators
  let s = 0;
  let e = tokens.length;
  while (s < e && tokens[s].kind === "sep") s++;
  while (e > s && tokens[e - 1].kind === "sep") e--;
  return tokens.slice(s, e);
}

/** Render the word tokens with a uniform joiner and per-word transform. */
function renderWords(
  input: string,
  joiner: string,
  wordFn: (word: string, index: number, afterWs: boolean) => string,
): string {
  const tokens = tokenize(input);
  let out = "";
  let idx = 0;
  let afterWs = false;
  for (const tk of tokens) {
    if (tk.kind === "sep") {
      out += joiner;
      afterWs = false;
    } else if (tk.kind === "ws") {
      out += tk.ch;
      idx = 0;
      afterWs = true;
    } else {
      for (let j = 0; j < tk.words.length; j++) {
        if (j > 0) out += joiner;
        out += wordFn(tk.words[j], idx++, afterWs);
        afterWs = false;
      }
    }
  }
  return out;
}

export function toSentenceCase(text: string): string {
  const lowered = text.toLowerCase();
  let out = "";
  let capNext = true;
  for (const ch of lowered) {
    if (isAlpha(ch)) {
      out += capNext ? ch.toUpperCase() : ch;
      capNext = false;
    } else if (isDigit(ch)) {
      out += ch;
      capNext = false;
    } else if (ch === "." || ch === "!" || ch === "?") {
      out += ch;
      capNext = true;
    } else {
      out += ch; // whitespace / other punctuation: preserve capNext state
    }
  }
  return out;
}

export function toLower(text: string): string {
  return renderWords(text, " ", (w) => w.toLowerCase());
}

export function toUpper(text: string): string {
  return renderWords(text, " ", (w) => w.toUpperCase());
}

export function toTitle(text: string): string {
  return renderWords(
    text,
    " ",
    (w, _i, afterWs) =>
      afterWs ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
  );
}

export function toCamel(text: string): string {
  return renderWords(text, "", (w, i) =>
    i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
  );
}

export function toSnake(text: string): string {
  return renderWords(text, "_", (w) => w.toLowerCase());
}

export function toKebab(text: string): string {
  return renderWords(text, "-", (w) => w.toLowerCase());
}

export function toAlternating(text: string): string {
  const base = renderWords(text, " ", (w) => w.toLowerCase());
  let out = "";
  let letterIdx = 0;
  for (const ch of base) {
    if (isAlpha(ch)) {
      out += letterIdx % 2 === 0 ? ch.toLowerCase() : ch.toUpperCase();
      letterIdx++;
    } else {
      out += ch;
    }
  }
  return out;
}

export function toInverse(text: string): string {
  let out = "";
  for (const ch of text) {
    if (isLower(ch)) out += ch.toUpperCase();
    else if (isUpper(ch)) out += ch.toLowerCase();
    else out += ch;
  }
  return out;
}

const CONVERTERS: Record<CaseType, (text: string) => string> = {
  sentence: toSentenceCase,
  lower: toLower,
  upper: toUpper,
  title: toTitle,
  camel: toCamel,
  snake: toSnake,
  kebab: toKebab,
  alternating: toAlternating,
  inverse: toInverse,
};

export function convertCase(text: string, type: CaseType): string {
  return CONVERTERS[type](text);
}
