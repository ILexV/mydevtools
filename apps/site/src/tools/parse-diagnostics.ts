/**
 * Shared parse-error diagnostic model for the editor tools (json/xml/yaml
 * beautifiers, json-to-typescript): reason key + args + exact source range,
 * line/column conversion and the localized "Trailing comma — line 3,
 * column 17" message. Pure and browser-independent; positions always come
 * from our own scanners or the parser's reported location, never from
 * engine exception text. Unit-tested in `test/parse-diagnostics.test.ts`.
 */

/**
 * Normalized parser error. `from`/`to` are UTF-16 offsets into the checked
 * text (= CodeMirror document offsets); `from === null` means the location
 * is unknown and the UI must say so instead of inventing a position.
 * `from === to` is an insertion point (e.g. a missing bracket at EOF).
 */
export interface ParseDiagnostic {
  /** Reason suffix of the locale key `Diag_<messageKey>` (e.g. "TrailingComma"). */
  messageKey: string;
  args?: Record<string, string | number>;
  from: number | null;
  to: number | null;
  /** Raw, untranslated parser detail — shown only for the generic "Syntax" reason. */
  detail?: string;
}

/** 1-based line and 1-based column counted in Unicode code points (a tab is one column). */
export interface TextPosition {
  line: number;
  column: number;
}

/**
 * Templates by reason (`Diag_` prefix dropped): At, NoLocation, GoTo, Syntax,
 * TrailingComma, … plus an optional tool-specific `SyntaxNoLocation`
 * ("Invalid JSON. Please check your input.") for an unlocated generic error.
 */
export type DiagnosticStrings = Record<string, string>;

/**
 * Line/column of a UTF-16 offset. CRLF, lone CR and LF each end one line
 * (CodeMirror's default line splitting); surrogate pairs count as one column.
 */
export function positionAt(text: string, offset: number): TextPosition {
  const end = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: codePointLength(text, lineStart, end) + 1 };
}

/**
 * UTF-16 offset of a 1-based line / code-point column, or null when the line
 * doesn't exist. A column past the line end clamps to the line end.
 * `lfOnly` counts only "\n" as a line break (yaml-rust's marker semantics).
 */
export function offsetAt(text: string, line: number, column: number, lfOnly = false): number | null {
  if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1) return null;
  let i = 0;
  for (let l = 1; l < line; l++) {
    const next = nextLineStart(text, i, lfOnly);
    if (next === null) return null;
    i = next;
  }
  for (let col = 1; col < column && i < text.length; col++) {
    const c = text.charCodeAt(i);
    if (c === 10 || (!lfOnly && c === 13)) break;
    i += isHighSurrogatePair(text, i) ? 2 : 1;
  }
  return i;
}

function nextLineStart(text: string, from: number, lfOnly: boolean): number | null {
  for (let i = from; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) return i + 1;
    if (!lfOnly && c === 13) return text.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
  }
  return null;
}

function isHighSurrogatePair(text: string, i: number): boolean {
  const c = text.charCodeAt(i);
  if (c < 0xd800 || c > 0xdbff) return false;
  const d = text.charCodeAt(i + 1);
  return d >= 0xdc00 && d <= 0xdfff;
}

function codePointLength(text: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) {
    n++;
    if (isHighSurrogatePair(text, i) && i + 1 < to) i++;
  }
  return n;
}

/** End offset of one code point starting at `i` (keeps surrogate pairs whole). */
export function charEnd(text: string, i: number): number {
  return Math.min(text.length, i + (isHighSurrogatePair(text, i) ? 2 : 1));
}

/**
 * Source token for a message, unchanged except that invisible characters are
 * spelled as U+XXXX and long runs are cut to 24 code points with "…".
 */
export function displayToken(token: string): string {
  const chars = Array.from(token);
  if (chars.length === 1) {
    const cp = chars[0].codePointAt(0) ?? 0;
    if (cp <= 0x20 || (cp >= 0x7f && cp <= 0xa0) || cp === 0xfeff || cp === 0x2028 || cp === 0x2029) {
      return "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
    }
  }
  return chars.length > 24 ? chars.slice(0, 24).join("") + "…" : token;
}

/** `{name}` interpolation (unknown placeholders stay visible). */
export function formatTemplate(template: string, args?: Record<string, string | number>): string {
  if (!args) return template;
  return template.replace(/\{(\w+)\}/g, (m, key: string) =>
    Object.prototype.hasOwnProperty.call(args, key) ? String(args[key]) : m,
  );
}

/** Move a diagnostic found in a substring (e.g. trimmed input) back to document offsets. */
export function shiftDiagnostic(diag: ParseDiagnostic, delta: number): ParseDiagnostic {
  if (!delta || diag.from === null) return diag;
  return { ...diag, from: diag.from + delta, to: (diag.to ?? diag.from) + delta };
}

/**
 * Localized one-line message: "<reason> — line L, column C" (template `At`)
 * or "<reason> (location unknown)" (template `NoLocation`). Unknown reason
 * keys fall back to `Syntax`. Line/column are computed from `text`.
 */
export function diagnosticMessage(strings: DiagnosticStrings, diag: ParseDiagnostic, text: string): string {
  const key = diag.from === null && diag.messageKey === "Syntax" && strings.SyntaxNoLocation ? "SyntaxNoLocation" : diag.messageKey;
  const reason = formatTemplate(strings[key] ?? strings.Syntax ?? diag.messageKey, diag.args);
  if (diag.from === null) return formatTemplate(strings.NoLocation ?? "{message}", { message: reason });
  const pos = positionAt(text, diag.from);
  return formatTemplate(strings.At ?? "{message} ({line}:{column})", { message: reason, line: pos.line, column: pos.column });
}

/** What the editor panel shows: final text + raw detail + document range. */
export interface ShownDiagnostic {
  message: string;
  detail?: string;
  from: number | null;
  to: number | null;
}

/** Diagnostic → editor-ready view model (`MdtEditor.setDiagnostic`). */
export function presentDiagnostic(strings: DiagnosticStrings, diag: ParseDiagnostic, text: string): ShownDiagnostic {
  return {
    message: diagnosticMessage(strings, diag, text),
    ...(diag.detail ? { detail: diag.detail } : {}),
    from: diag.from,
    to: diag.from === null ? null : (diag.to ?? diag.from),
  };
}
