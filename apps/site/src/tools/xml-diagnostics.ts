/**
 * XML error locator for xml-beautifier: a minimal well-formedness scanner
 * (tags, attributes, entities, comments, CDATA, PIs, DOCTYPE, single root)
 * that yields the exact offset + reason key (mismatched / unclosed tag,
 * unquoted or duplicate attribute, unescaped `<`/`&`, text outside the root,
 * …) once DOMParser has rejected the input. DOMParser's `<parsererror>` text
 * differs per engine (and is localized in Firefox), so it is only a fallback:
 * `xmlEngineLocation` reads its line/column digits when the scanner has no
 * opinion. Pure — unit-tested in `test/parse-diagnostics.test.ts`.
 */
import { charEnd, displayToken, offsetAt, type ParseDiagnostic } from "./parse-diagnostics.ts";

const PREDEFINED_ENTITIES = new Set(["lt", "gt", "amp", "quot", "apos"]);
const NAME_START = /[A-Za-z_:À-￿]/;
const NAME_CHAR = /[A-Za-z0-9_:.\-·À-￿]/;
const ENTITY_RE = /&(?:#[0-9]+|#x[0-9a-fA-F]+|([A-Za-z_:À-￿][A-Za-z0-9_:.\-·À-￿]*));/y;

interface OpenTag {
  name: string;
  at: number;
}

/**
 * First well-formedness error in `text`, or null when the scanner sees
 * nothing wrong or meets a construct it doesn't model (then the caller
 * falls back to the engine location instead of guessing).
 */
export function locateXmlError(text: string): ParseDiagnostic | null {
  const n = text.length;
  const stack: OpenTag[] = [];
  let i = 0;
  let rootSeen = false;
  let hasDoctype = false;

  const diag = (messageKey: string, from: number, to = charEnd(text, from), args?: ParseDiagnostic["args"]): ParseDiagnostic =>
    ({ messageKey, from, to: Math.max(from, Math.min(to, n)), ...(args ? { args } : {}) });
  const lineOf = (offset: number) => {
    let line = 1;
    for (let k = 0; k < offset; k++) if (text[k] === "\n" || (text[k] === "\r" && text[k + 1] !== "\n")) line++;
    return line;
  };
  const isWs = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";
  const skipWs = (k: number) => {
    while (k < n && isWs(text[k])) k++;
    return k;
  };
  const readName = (k: number) => {
    if (k >= n || !NAME_START.test(text[k])) return k;
    k++;
    while (k < n && NAME_CHAR.test(text[k])) k++;
    return k;
  };
  const lineEnd = (k: number) => {
    while (k < n && text[k] !== "\n" && text[k] !== "\r") k++;
    return k;
  };
  const unexpected = (k: number): ParseDiagnostic =>
    k >= n ? diag("UnexpectedEnd", n, n) : diag("UnexpectedChar", k, charEnd(text, k), { token: displayToken(text.slice(k, charEnd(text, k))) });

  /** `&…;` reference at `k`: returns its end, or a diagnostic. */
  const entity = (k: number): number | ParseDiagnostic => {
    ENTITY_RE.lastIndex = k;
    const m = ENTITY_RE.exec(text);
    if (!m) return diag("XmlBadEntity", k, k + 1);
    if (m[1] && !PREDEFINED_ENTITIES.has(m[1]) && !hasDoctype) {
      return diag("XmlUnknownEntity", k, k + m[0].length, { name: m[0] });
    }
    return k + m[0].length;
  };

  while (i < n) {
    const c = text[i];
    if (c === "<") {
      if (text.startsWith("<!--", i)) {
        const close = text.indexOf("-->", i + 4);
        if (close === -1) return diag("XmlUnclosedComment", i, i + 4);
        i = close + 3;
        continue;
      }
      if (text.startsWith("<![CDATA[", i)) {
        if (!stack.length) return diag("XmlTextOutsideRoot", i, i + 9);
        const close = text.indexOf("]]>", i + 9);
        if (close === -1) return diag("XmlUnclosedCdata", i, i + 9);
        i = close + 3;
        continue;
      }
      if (text.startsWith("<!DOCTYPE", i)) {
        if (rootSeen) return null;
        // Skip to the matching `>`, honouring quotes and an internal [ … ] subset.
        let k = i + 9;
        let depth = 0;
        let quote = "";
        for (; k < n; k++) {
          const d = text[k];
          if (quote) {
            if (d === quote) quote = "";
          } else if (d === '"' || d === "'") quote = d;
          else if (d === "[") depth++;
          else if (d === "]") depth--;
          else if (d === ">" && depth <= 0) break;
        }
        if (k >= n) return diag("UnexpectedEnd", n, n);
        hasDoctype = true;
        i = k + 1;
        continue;
      }
      if (text[i + 1] === "!") return null; // other markup declarations: no opinion
      if (text[i + 1] === "?") {
        const nameEnd = readName(i + 2);
        const close = text.indexOf("?>", i + 2);
        if (close === -1) return diag("XmlUnclosedPi", i, Math.max(nameEnd, i + 2));
        if (text.slice(i + 2, nameEnd).toLowerCase() === "xml" && i !== 0) return diag("XmlMisplacedDeclaration", i, nameEnd);
        i = close + 2;
        continue;
      }
      if (text[i + 1] === "/") {
        const nameStart = i + 2;
        const nameEnd = readName(nameStart);
        if (nameEnd === nameStart) return unexpected(nameStart);
        const name = text.slice(nameStart, nameEnd);
        const k = skipWs(nameEnd);
        if (k >= n) return diag("XmlUnclosedTag", n, n, { name });
        if (text[k] !== ">") return unexpected(k);
        const top = stack[stack.length - 1];
        if (!top) return diag("XmlUnexpectedCloseTag", i, k + 1, { found: name });
        if (top.name !== name) {
          return diag("XmlMismatchedTag", i, k + 1, { found: name, expected: top.name, line: lineOf(top.at) });
        }
        stack.pop();
        i = k + 1;
        continue;
      }
      // Start tag.
      const nameStart = i + 1;
      const nameEnd = readName(nameStart);
      if (nameEnd === nameStart) {
        // `a < b` in text, `< tag>` or `<1x>`: an unescaped less-than sign.
        return nameStart >= n ? diag("UnexpectedEnd", n, n) : diag("XmlUnescapedLt", i, i + 1);
      }
      const name = text.slice(nameStart, nameEnd);
      if (!stack.length && rootSeen) return diag("XmlMultipleRoots", i, nameEnd);
      let k = nameEnd;
      const seen = new Set<string>();
      let selfClosing = false;
      for (;;) {
        const before = k;
        k = skipWs(k);
        if (k >= n) return diag("XmlUnclosedTag", n, n, { name });
        if (text[k] === ">") break;
        if (text[k] === "/") {
          if (text[k + 1] !== ">") return unexpected(k + 1);
          selfClosing = true;
          k++;
          break;
        }
        const attrEnd = readName(k);
        if (attrEnd === k) return text[k] === "<" ? diag("XmlUnclosedTag", k, k, { name }) : unexpected(k);
        if (k === before) return null; // attributes glued together: let the engine report it
        const attr = text.slice(k, attrEnd);
        if (seen.has(attr)) return diag("XmlDuplicateAttr", k, attrEnd, { name: attr });
        seen.add(attr);
        let v = skipWs(attrEnd);
        if (text[v] !== "=") return diag("XmlAttrNoValue", k, attrEnd, { name: attr });
        v = skipWs(v + 1);
        const q = text[v];
        if (q !== '"' && q !== "'") {
          if (v >= n) return diag("UnexpectedEnd", n, n);
          let end = v;
          while (end < n && !isWs(text[end]) && text[end] !== ">" && text[end] !== "/") end++;
          return diag("XmlAttrUnquoted", v, Math.max(end, v + 1), { name: attr });
        }
        let j = v + 1;
        for (; j < n && text[j] !== q; j++) {
          if (text[j] === "<") return diag("XmlLtInAttr", j, j + 1);
          if (text[j] === "&") {
            const r = entity(j);
            if (typeof r !== "number") return r;
            j = r - 1;
          }
        }
        if (j >= n) return diag("UnterminatedString", v, lineEnd(v));
        k = j + 1;
      }
      rootSeen = true;
      if (!selfClosing) stack.push({ name, at: i });
      i = k + 1;
      continue;
    }
    if (c === "&") {
      if (!stack.length) return diag("XmlTextOutsideRoot", i, lineEnd(i));
      const r = entity(i);
      if (typeof r !== "number") return r;
      i = r;
      continue;
    }
    if (!stack.length && !isWs(c)) {
      let end = i;
      while (end < n && text[end] !== "<" && text[end] !== "\n" && text[end] !== "\r") end++;
      return diag("XmlTextOutsideRoot", i, end);
    }
    i++;
  }

  const top = stack[stack.length - 1];
  if (top) return diag("XmlUnclosedElement", n, n, { name: top.name, line: lineOf(top.at) });
  if (!rootSeen) return diag("XmlNoRoot", n, n);
  return null;
}

/**
 * Line/column digits from a DOMParser `<parsererror>` text — Chromium/WebKit
 * ("error on line 3 at column 17") and Gecko ("Line Number 3, Column 17").
 * Fallback only; null when absent (e.g. a localized Firefox message).
 */
export function xmlEngineLocation(errorText: string): { line: number; column: number } | null {
  const m = /line\D{0,12}?(\d+)\D{1,12}?column\D{0,3}?(\d+)/i.exec(errorText);
  if (!m) return null;
  const line = Number(m[1]);
  const column = Number(m[2]);
  return line > 0 && column > 0 ? { line, column } : null;
}

/**
 * Engine fallback → diagnostic: one-character mark at the reported position,
 * else location unknown. The detail drops a leading "error on line … at
 * column …:" (the panel already shows the position).
 */
export function xmlEngineDiagnostic(text: string, errorText: string, rawDetail: string): ParseDiagnostic {
  const loc = xmlEngineLocation(errorText);
  const detail = loc ? rawDetail.replace(/^error on line \d+ at column \d+:\s*/i, "") : rawDetail;
  const from = loc ? offsetAt(text, loc.line, loc.column) : null;
  if (from === null) return { messageKey: "Syntax", from: null, to: null, detail };
  return { messageKey: "Syntax", from, to: from < text.length ? charEnd(text, from) : from, detail };
}
