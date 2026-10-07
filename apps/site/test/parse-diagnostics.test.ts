import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diagnosticMessage,
  displayToken,
  formatTemplate,
  offsetAt,
  positionAt,
  presentDiagnostic,
  shiftDiagnostic,
  type ParseDiagnostic,
} from "../src/tools/parse-diagnostics.ts";
import { locateJsonError } from "../src/tools/json-diagnostics.ts";
import { locateXmlError, xmlEngineDiagnostic, xmlEngineLocation } from "../src/tools/xml-diagnostics.ts";
import { yamlDiagnostic } from "../src/tools/yaml-diagnostics.ts";

/** Diagnostic → [reason, line, column, underlined text] for compact assertions. */
function where(text: string, d: ParseDiagnostic | null): [string, number, number, string] | null {
  if (!d) return null;
  if (d.from === null) return [d.messageKey, 0, 0, ""];
  const p = positionAt(text, d.from);
  return [d.messageKey, p.line, p.column, text.slice(d.from, d.to ?? d.from)];
}

test("positionAt: 1-based lines, code-point columns, CRLF / CR / tabs / astral chars", () => {
  assert.deepEqual(positionAt("abc", 0), { line: 1, column: 1 });
  assert.deepEqual(positionAt("a\nbc", 3), { line: 2, column: 2 });
  assert.deepEqual(positionAt("a\r\nbc", 4), { line: 2, column: 2 });
  assert.deepEqual(positionAt("a\rbc", 3), { line: 2, column: 2 });
  assert.deepEqual(positionAt("\t\tx", 2), { line: 1, column: 3 });
  // "😀" is two UTF-16 units but one column.
  assert.deepEqual(positionAt("😀,", 2), { line: 1, column: 2 });
  assert.deepEqual(positionAt("ab", 99), { line: 1, column: 3 });
});

test("offsetAt is the inverse of positionAt; lfOnly ignores lone CR; bad input → null", () => {
  const text = "x😀y\r\nимя: 1\n";
  for (let i = 0; i <= text.length; i++) {
    if (text[i - 1] === "\ud83d" || (text[i - 1] === "\r" && text[i] === "\n")) continue;
    const p = positionAt(text, i);
    assert.equal(offsetAt(text, p.line, p.column), i, `offset ${i}`);
  }
  assert.equal(offsetAt("a\rb\nc", 2, 1, true), 4);
  assert.equal(offsetAt("ab\ncd", 1, 99), 2);
  assert.equal(offsetAt("ab", 3, 1), null);
  assert.equal(offsetAt("ab", 0, 1), null);
});

test("formatTemplate / displayToken / shiftDiagnostic", () => {
  assert.equal(formatTemplate("{a} and {b} {c}", { a: 1, b: "x" }), "1 and x {c}");
  assert.equal(displayToken("\t"), "U+0009");
  assert.equal(displayToken(" "), "U+00A0");
  assert.equal(displayToken(","), ",");
  assert.equal(displayToken("x".repeat(30)), "x".repeat(24) + "…");
  assert.deepEqual(shiftDiagnostic({ messageKey: "A", from: 1, to: 2 }, 3), { messageKey: "A", from: 4, to: 5 });
  const unknown = { messageKey: "A", from: null, to: null };
  assert.equal(shiftDiagnostic(unknown, 3), unknown);
});

test("diagnosticMessage: localized line/column, unknown location, fallbacks", () => {
  const strings = {
    At: "{message} — line {line}, column {column}",
    NoLocation: "{message} (location unknown)",
    Syntax: "Syntax error",
    SyntaxNoLocation: "Invalid JSON.",
    UnclosedArray: "Unclosed “[” from line {line}",
  };
  const text = '[\n  "é😀", ,';
  const d: ParseDiagnostic = { messageKey: "UnclosedArray", args: { line: 1 }, from: 11, to: 11 };
  assert.equal(diagnosticMessage(strings, d, text), "Unclosed “[” from line 1 — line 2, column 9");
  assert.equal(diagnosticMessage(strings, { messageKey: "Nope", from: 0, to: 1 }, text), "Syntax error — line 1, column 1");
  assert.equal(diagnosticMessage(strings, { messageKey: "Syntax", from: null, to: null }, text), "Invalid JSON. (location unknown)");
  assert.deepEqual(presentDiagnostic(strings, { messageKey: "Syntax", from: null, to: null, detail: "raw" }, text), {
    message: "Invalid JSON. (location unknown)",
    detail: "raw",
    from: null,
    to: null,
  });
});

test("locateJsonError: reason + exact token for common mistakes", () => {
  const cases: Array<[string, [string, number, number, string]]> = [
    ['{"a":1,}', ["TrailingComma", 1, 7, ","]],
    ["[1,]", ["TrailingComma", 1, 3, ","]],
    ['{\n  "items": [1, 2,, 3]\n}', ["UnexpectedComma", 2, 18, ","]],
    ['{"a":1 "b":2}', ["MissingComma", 1, 8, '"b"']],
    ['{"a" 1}', ["MissingColon", 1, 6, "1"]],
    ['{"a":,}', ["MissingValue", 1, 6, ","]],
    ["{a:1}", ["UnquotedKey", 1, 2, "a"]],
    ["{'a':1}", ["UnquotedKey", 1, 2, "'a'"]],
    ["['x']", ["SingleQuotes", 1, 2, "'x'"]],
    ["[“x”]", ["SmartQuotes", 1, 2, "“"]],
    ['{\n  "name": "demo,\n  "ok": true\n}', ["UnterminatedString", 2, 11, '"demo,']],
    ['"a\tb"', ["ControlChar", 1, 3, "\t"]],
    ['"\\x"', ["BadEscape", 1, 2, "\\x"]],
    ['"\\u12G4"', ["BadEscape", 1, 2, "\\u12G4"]],
    ["[01]", ["BadNumber", 1, 2, "01"]],
    ["[1.]", ["BadNumber", 1, 2, "1."]],
    ["[-]", ["BadNumber", 1, 2, "-"]],
    ["[NaN]", ["UnexpectedWord", 1, 2, "NaN"]],
    ['{"a":tru}', ["UnexpectedWord", 1, 6, "tru"]],
    ['{"a":[1}', ["MismatchedBracket", 1, 8, "}"]],
    ['{"a":1} x', ["ExtraContent", 1, 9, "x"]],
    ["// note\n{}", ["Comment", 1, 1, "// note"]],
    ['[1 /* x */]', ["Comment", 1, 4, "/* x */"]],
  ];
  for (const [text, expected] of cases) assert.deepEqual(where(text, locateJsonError(text)), expected, text);
});

test("locateJsonError: EOF → insertion point naming the innermost opener", () => {
  const text = '{\n  "items": [\n    {"id": 1}';
  const d = locateJsonError(text);
  assert.deepEqual(where(text, d), ["UnclosedArray", 3, 14, ""]);
  assert.deepEqual(d?.args, { line: 2 });
  assert.equal(d?.from, text.length);
  assert.deepEqual(where('{"a":', locateJsonError('{"a":')), ["UnclosedObject", 1, 6, ""]);
});

test("locateJsonError: multibyte, tabs and CRLF before the error; valid input → null", () => {
  const text = '{\r\n\t"имя": "Ёжик 🦔", "日本": "語" "x": 1\r\n}';
  assert.deepEqual(where(text, locateJsonError(text)), ["MissingComma", 2, 29, '"x"']);
  for (const ok of ['{"a":[1,2,{"b":null}],"c":"\\u00e9\\n","d":-1.5e+3}', "[]", "{}", " 0 ", '"x"', "true"]) {
    assert.equal(locateJsonError(ok), null, ok);
  }
  // Deep nesting: iterative, no stack overflow.
  assert.equal(locateJsonError("[".repeat(20000) + "]".repeat(20000)), null);
  assert.equal(locateJsonError("[".repeat(20000))?.messageKey, "UnclosedArray");
});

test("locateXmlError: tags, attributes, entities, roots", () => {
  const cases: Array<[string, [string, number, number, string]]> = [
    ["<catalog>\n  <title>XML</titel>\n</catalog>", ["XmlMismatchedTag", 2, 13, "</titel>"]],
    ["<a></b>", ["XmlMismatchedTag", 1, 4, "</b>"]],
    ["<a/></a>", ["XmlUnexpectedCloseTag", 1, 5, "</a>"]],
    ["<a><b>", ["XmlUnclosedElement", 1, 7, ""]],
    ["<a", ["XmlUnclosedTag", 1, 3, ""]],
    ["<a b=1/>", ["XmlAttrUnquoted", 1, 6, "1"]],
    ['<a b="1" b="2"/>', ["XmlDuplicateAttr", 1, 10, "b"]],
    ["<a b></a>", ["XmlAttrNoValue", 1, 4, "b"]],
    ['<a x="<"/>', ["XmlLtInAttr", 1, 7, "<"]],
    ["<a>1 < 2</a>", ["XmlUnescapedLt", 1, 6, "<"]],
    ["<a>x & y</a>", ["XmlBadEntity", 1, 6, "&"]],
    ["<a>&nbsp;</a>", ["XmlUnknownEntity", 1, 4, "&nbsp;"]],
    ["<a/><b/>", ["XmlMultipleRoots", 1, 5, "<b"]],
    ["x<a/>", ["XmlTextOutsideRoot", 1, 1, "x"]],
    ["<a><!-- x</a>", ["XmlUnclosedComment", 1, 4, "<!--"]],
    ["<a><![CDATA[x</a>", ["XmlUnclosedCdata", 1, 4, "<![CDATA["]],
    ['<a/><?xml version="1.0"?>', ["XmlMisplacedDeclaration", 1, 5, "<?xml"]],
    ["<!-- only -->", ["XmlNoRoot", 1, 14, ""]],
    ["<ä>😀<ö></ä>", ["XmlMismatchedTag", 1, 8, "</ä>"]],
  ];
  for (const [text, expected] of cases) assert.deepEqual(where(text, locateXmlError(text)), expected, text);
});

test("locateXmlError: well-formed documents → null", () => {
  for (const ok of [
    '<?xml version="1.0" encoding="UTF-8"?>\n<a x=\'1\' y="a > b">t &amp; &#169; &#x1F600;<b/><!-- c --><![CDATA[<x>]]></a>',
    '<!DOCTYPE a [<!ENTITY e "x">]><a>&e;</a>',
    "<a>\r\n\t<b>1</b>\r\n</a>",
  ]) {
    assert.equal(locateXmlError(ok), null, ok);
  }
});

test("xmlEngineLocation / xmlEngineDiagnostic: Chromium and Gecko digits; unknown → no position", () => {
  assert.deepEqual(xmlEngineLocation("error on line 2 at column 7: Namespace prefix x on b is not defined"), { line: 2, column: 7 });
  assert.deepEqual(xmlEngineLocation("XML Parsing Error: unbound prefix\nLocation: about:blank\nLine Number 2, Column 3:"), { line: 2, column: 3 });
  assert.equal(xmlEngineLocation("Erreur d’analyse XML : préfixe non lié"), null);
  const d = xmlEngineDiagnostic("<a>\n  <x:b/>\n</a>", "error on line 2 at column 7: Namespace prefix", "error on line 2 at column 7: Namespace prefix");
  assert.deepEqual([d.messageKey, d.from, d.detail], ["Syntax", 10, "Namespace prefix"]);
  assert.equal(xmlEngineDiagnostic("<a/>", "no digits", "no digits").from, null);
});

test("yamlDiagnostic: yaml-rust marker → reason + token, LF-only lines, code-point columns", () => {
  const indent = "services:\n  web:\n    image: nginx\n   ports: [80]\n";
  assert.deepEqual(
    where(indent, yamlDiagnostic(indent, "while parsing a block mapping, did not find expected key at line 4 column 9")),
    ["YamlIndent", 4, 4, "ports"],
  );
  const mapping = "a: 1\n  b: 2\n";
  assert.deepEqual(where(mapping, yamlDiagnostic(mapping, "mapping values are not allowed in this context at line 2 column 4")), ["YamlMappingValue", 2, 4, ":"]);
  const flow = "имя: [1, 2\nnext: 3\n";
  assert.deepEqual(where(flow, yamlDiagnostic(flow, "while parsing a flow sequence, expected ',' or ']' at line 2 column 5")), ["YamlFlowSequence", 2, 5, ":"]);
  const emoji = "k: 😀 x: y";
  assert.deepEqual(where(emoji, yamlDiagnostic(emoji, "mapping values are not allowed in this context at line 1 column 7")), ["YamlMappingValue", 1, 7, ":"]);
  // Unmapped info keeps the raw detail; a marker past the text → location unknown.
  const other = yamlDiagnostic("a", "something new at line 1 column 1");
  assert.deepEqual([other.messageKey, other.detail, other.from], ["Syntax", "something new", 0]);
  assert.equal(yamlDiagnostic("a", "mapping values are not allowed at line 9 column 1").from, null);
  assert.equal(yamlDiagnostic("a", "no marker").from, null);
});
