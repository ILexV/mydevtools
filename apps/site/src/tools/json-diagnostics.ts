/**
 * JSON error locator: a strict RFC 8259 scanner that finds the exact offset
 * and a reason key (trailing comma, missing comma/colon, unquoted key,
 * unterminated string, bad number/escape, unclosed bracket at EOF, …) for
 * text that `JSON.parse` rejected. Browser-independent — V8, SpiderMonkey and
 * JavaScriptCore word and position their SyntaxErrors differently, so the
 * engine message is never parsed. Iterative (no recursion limit on deep
 * nesting). Pure — unit-tested in `test/parse-diagnostics.test.ts`.
 */
import { charEnd, displayToken, type ParseDiagnostic } from "./parse-diagnostics.ts";

interface Frame {
  kind: "{" | "[";
  open: number;
}

const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const WORD_CHAR = /[\p{L}\p{N}_$]/u;
const SMART_QUOTES = new Set(["“", "”", "„", "‘", "’", "«", "»"]);
const ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

/**
 * Locate the first syntax error in `text` (UTF-16 offsets). Returns null
 * when the scanner finds the text valid — callers then report "location
 * unknown" rather than guess.
 */
export function locateJsonError(text: string): ParseDiagnostic | null {
  const n = text.length;
  const stack: Frame[] = [];
  let i = 0;

  const diag = (messageKey: string, from: number, to = charEnd(text, from), args?: ParseDiagnostic["args"]): ParseDiagnostic =>
    ({ messageKey, from, to: Math.max(from, Math.min(to, n)), ...(args ? { args } : {}) });

  /** 1-based line of an offset (for "opened on line N" args). */
  const lineOf = (offset: number) => {
    let line = 1;
    for (let k = 0; k < offset; k++) {
      const c = text.charCodeAt(k);
      if (c === 10 || (c === 13 && text.charCodeAt(k + 1) !== 10)) line++;
    }
    return line;
  };

  const skipWs = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };

  const lineEnd = (from: number) => {
    let k = from;
    while (k < n && text[k] !== "\n" && text[k] !== "\r") k++;
    return k;
  };

  const wordEnd = (from: number) => {
    let k = from;
    while (k < n && WORD_CHAR.test(String.fromCodePoint(text.codePointAt(k) ?? 0))) k = charEnd(text, k);
    return k;
  };

  /** Extent of the token at `from` — for underlining whatever stands where a comma/colon was expected. */
  const tokenEnd = (from: number) => {
    const c = text[from];
    if (c === '"') {
      const close = text.indexOf('"', from + 1);
      const eol = lineEnd(from);
      return close !== -1 && close < eol ? close + 1 : eol;
    }
    const w = wordEnd(from);
    if (w > from) return w;
    if (c === "-" || c === "+" || c === ".") return numberRunEnd(from);
    return charEnd(text, from);
  };

  const numberRunEnd = (from: number) => {
    let k = from;
    while (k < n && /[0-9+\-.eE]/.test(text[k])) k++;
    return k;
  };

  /** End of EOF-unclosed containers: report at EOF, naming the innermost opener's line. */
  const unclosed = (): ParseDiagnostic => {
    const top = stack[stack.length - 1];
    if (!top) return diag("UnexpectedEnd", n, n);
    return diag(top.kind === "{" ? "UnclosedObject" : "UnclosedArray", n, n, { line: lineOf(top.open) });
  };

  /** Comments (`//`, `/*`) are a common non-JSON habit — name them explicitly. */
  const comment = (): ParseDiagnostic | null => {
    if (text[i] !== "/" || (text[i + 1] !== "/" && text[i + 1] !== "*")) return null;
    if (text[i + 1] === "/") return diag("Comment", i, lineEnd(i));
    const close = text.indexOf("*/", i + 2);
    return diag("Comment", i, close === -1 ? lineEnd(i) : close + 2);
  };

  /** Scan a double-quoted string at `i`; advances past it or returns the error. */
  const scanString = (): ParseDiagnostic | null => {
    const start = i;
    i++;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i++;
        return null;
      }
      if (c === 0x5c) {
        const e = text[i + 1];
        if (e === undefined) break;
        if (e === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
            const end = Math.min(n, i + 6);
            return diag("BadEscape", i, end, { token: displayToken(text.slice(i, end)) });
          }
          i += 6;
          continue;
        }
        if (!ESCAPES.has(e)) return diag("BadEscape", i, charEnd(text, i + 1), { token: displayToken(text.slice(i, charEnd(text, i + 1))) });
        i += 2;
        continue;
      }
      if (c === 0x0a || c === 0x0d) return diag("UnterminatedString", start, i);
      if (c < 0x20) return diag("ControlChar", i, i + 1, { token: displayToken(text[i]) });
      i++;
    }
    return diag("UnterminatedString", start, lineEnd(start));
  };

  /**
   * A value is expected at `i`. Advances past scalars, pushes containers.
   * `after` tells what preceded it (for trailing/unexpected comma reasons).
   */
  const scanValue = (after: "start" | "colon" | "comma" | "open", commaAt: number): ParseDiagnostic | null => {
    skipWs();
    if (i >= n) return unclosed();
    const c = text[i];
    if (c === '"') return scanString();
    if (c === "{" || c === "[") {
      stack.push({ kind: c, open: i });
      i++;
      return null;
    }
    if (c === "-" || (c >= "0" && c <= "9") || c === "+" || c === ".") {
      const end = numberRunEnd(i);
      const token = text.slice(i, end);
      if (!NUMBER_RE.test(token)) return diag("BadNumber", i, end, { token: displayToken(token) });
      i = end;
      return null;
    }
    const w = wordEnd(i);
    if (w > i) {
      const word = text.slice(i, w);
      if (word === "true" || word === "false" || word === "null") {
        i = w;
        return null;
      }
      return diag("UnexpectedWord", i, w, { token: displayToken(word) });
    }
    if (c === "]" || c === "}") {
      if (after === "comma") return diag("TrailingComma", commaAt);
      if (after === "colon") return diag("MissingValue", i);
      return diag("UnexpectedChar", i, i + 1, { token: c });
    }
    if (c === ",") return diag(after === "colon" ? "MissingValue" : "UnexpectedComma", i);
    if (c === "'") return diag("SingleQuotes", i, tokenEndQuoted(i, "'"));
    if (SMART_QUOTES.has(c)) return diag("SmartQuotes", i);
    return comment() ?? diag("UnexpectedChar", i, charEnd(text, i), { token: displayToken(String.fromCodePoint(text.codePointAt(i) ?? 0)) });
  };

  const tokenEndQuoted = (from: number, q: string) => {
    const close = text.indexOf(q, from + 1);
    const eol = lineEnd(from);
    return close !== -1 && close < eol ? close + 1 : eol;
  };

  /** Object key expected at `i` (after `{` or `,`). */
  const scanKey = (afterComma: boolean, commaAt: number): ParseDiagnostic | null => {
    skipWs();
    if (i >= n) return unclosed();
    const c = text[i];
    if (c === '"') return scanString();
    if (c === "}" && afterComma) return diag("TrailingComma", commaAt);
    if (c === ",") return diag("UnexpectedComma", i);
    if (c === "'") return diag("UnquotedKey", i, tokenEndQuoted(i, "'"));
    if (SMART_QUOTES.has(c)) return diag("SmartQuotes", i);
    const w = wordEnd(i);
    if (w > i) return diag("UnquotedKey", i, w);
    if (c === "]") return mismatch(i);
    return comment() ?? diag("UnexpectedChar", i, charEnd(text, i), { token: displayToken(String.fromCodePoint(text.codePointAt(i) ?? 0)) });
  };

  const mismatch = (at: number): ParseDiagnostic => {
    const top = stack[stack.length - 1];
    if (!top) return diag("UnexpectedChar", at, at + 1, { token: text[at] });
    return diag("MismatchedBracket", at, at + 1, {
      expected: top.kind === "{" ? "}" : "]",
      found: text[at],
      line: lineOf(top.open),
    });
  };

  // Top-level value.
  let err = scanValue("start", -1);
  if (err) return err;

  // Container loop: after each value decide between `,`, the closer, or an error.
  // `justOpened` = the last token was `{`/`[` (empty container allowed).
  let justOpened = stack.length > 0;
  while (stack.length) {
    const top = stack[stack.length - 1];
    skipWs();
    if (justOpened) {
      justOpened = false;
      if (i >= n) return unclosed();
      const closer = top.kind === "{" ? "}" : "]";
      if (text[i] === closer) {
        stack.pop();
        i++;
        continue;
      }
      if (top.kind === "{") {
        err = scanKey(false, -1) ?? expectColonAndValue();
      } else {
        err = scanValue("open", -1);
      }
      if (err) return err;
      justOpened = stack[stack.length - 1] !== top && stack.length > 0;
      continue;
    }
    if (i >= n) return unclosed();
    const c = text[i];
    const closer = top.kind === "{" ? "}" : "]";
    if (c === closer) {
      stack.pop();
      i++;
      continue;
    }
    if (c === "]" || c === "}") return mismatch(i);
    if (c === ",") {
      const commaAt = i;
      i++;
      err = top.kind === "{" ? scanKey(true, commaAt) ?? expectColonAndValue() : scanValue("comma", commaAt);
      if (err) return err;
      justOpened = stack[stack.length - 1] !== top && stack.length > 0;
      continue;
    }
    if (c === ":" && top.kind === "[") return diag("UnexpectedChar", i, i + 1, { token: ":" });
    return comment() ?? diag("MissingComma", i, tokenEnd(i));
  }

  skipWs();
  if (i < n) return comment() ?? diag("ExtraContent", i, tokenEnd(i));
  return null;

  /** After an object key: `:` then a value. */
  function expectColonAndValue(): ParseDiagnostic | null {
    skipWs();
    if (i >= n) return unclosed();
    if (text[i] !== ":") return comment() ?? diag("MissingColon", i, tokenEnd(i));
    i++;
    return scanValue("colon", -1);
  }
}
