import { test } from "node:test";
import assert from "node:assert/strict";
import {
  escapeXmlAttribute,
  escapeXmlText,
  parserErrorDetail,
  serializeXmlDocument,
  xmlDeclaration,
  type XmlNodeLike,
} from "../src/tools/xml-format.ts";

// Tiny node builders mirroring what DOMParser produces (no DOM in Node).
const node = (nodeType: number, nodeName: string, extra: Partial<XmlNodeLike> = {}): XmlNodeLike => ({
  nodeType,
  nodeName,
  nodeValue: null,
  childNodes: [],
  ...extra,
});
const el = (name: string, attrs: Record<string, string> = {}, ...children: XmlNodeLike[]) =>
  node(1, name, { attributes: Object.entries(attrs).map(([n, value]) => ({ name: n, value })), childNodes: children });
const text = (v: string) => node(3, "#text", { nodeValue: v });
const cdata = (v: string) => node(4, "#cdata-section", { nodeValue: v });
const comment = (v: string) => node(8, "#comment", { nodeValue: v });
const pi = (target: string, data: string) => node(7, target, { target, data });
const doctype = (name: string, publicId = "", systemId = "") => node(10, name, { name, publicId, systemId });
const doc = (...children: XmlNodeLike[]) => node(9, "#document", { childNodes: children });

const sample = doc(
  el(
    "catalog",
    { xmlns: "urn:x", lang: "ru" },
    text("\n  "),
    el("book", { id: "1" }, el("title", {}, text("  Мастер & Маргарита 📚 ")), el("price", { cur: 'U"S' }, text("9.5"))),
    text("\n  "),
    el("empty"),
    comment(" note "),
    cdata("<raw> & ]] "),
  ),
);

test("serializeXmlDocument: pretty print with 2 / 4 spaces and tab", () => {
  assert.equal(
    serializeXmlDocument(sample, null, 2, false),
    [
      '<catalog xmlns="urn:x" lang="ru">',
      '  <book id="1">',
      "    <title>Мастер &amp; Маргарита 📚</title>",
      '    <price cur="U&quot;S">9.5</price>',
      "  </book>",
      "  <empty/>",
      "  <!-- note -->",
      "  <![CDATA[<raw> & ]] ]]>",
      "</catalog>",
    ].join("\n"),
  );
  assert.match(serializeXmlDocument(sample, null, 4, false), /\n {4}<book id="1">\n {8}<title>/);
  assert.match(serializeXmlDocument(sample, null, "\t", false), /\n\t<book id="1">\n\t\t<title>/);
});

test("serializeXmlDocument: compact mode keeps inner text verbatim and drops blank text", () => {
  assert.equal(
    serializeXmlDocument(sample, '<?xml version="1.0"?>', 4, true),
    '<?xml version="1.0"?>\n<catalog xmlns="urn:x" lang="ru"><book id="1"><title>  Мастер &amp; Маргарита 📚 </title>' +
      '<price cur="U&quot;S">9.5</price></book><empty/><!-- note --><![CDATA[<raw> & ]] ]]></catalog>',
  );
});

test("serializeXmlDocument: document-level doctype, comments and PIs are kept in order", () => {
  const d = doc(
    doctype("note", "", "note.dtd"),
    comment(" generated "),
    pi("xml-stylesheet", 'type="text/xsl" href="s.xsl"'),
    el("note", {}, text("hi")),
    comment(" trailer "),
  );
  assert.equal(
    serializeXmlDocument(d, '<?xml version="1.0" encoding="UTF-8"?>', 2, false),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE note SYSTEM "note.dtd">',
      "<!-- generated -->",
      '<?xml-stylesheet type="text/xsl" href="s.xsl"?>',
      "<note>hi</note>",
      "<!-- trailer -->",
    ].join("\n"),
  );
  assert.equal(serializeXmlDocument(doc(doctype("html", "-//W3C//DTD XHTML 1.0//EN", "x.dtd"), el("html")), null, 2, false),
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0//EN" "x.dtd">\n<html/>');
});

test("serializeXmlDocument: mixed content puts text runs on their own lines", () => {
  const d = doc(el("p", {}, text("Hello "), el("b", {}, text("World")), text(" !")));
  assert.equal(serializeXmlDocument(d, null, 2, false), "<p>\n  Hello\n  <b>World</b>\n  !\n</p>");
});

test("serializeXmlDocument: deep nesting", () => {
  let inner = el("leaf");
  for (let i = 0; i < 500; i++) inner = el("n", {}, inner);
  const out = serializeXmlDocument(doc(inner), null, 1, false).split("\n");
  assert.equal(out.length, 1001);
  assert.equal(out[500], " ".repeat(500) + "<leaf/>");
});

test("escaping helpers", () => {
  assert.equal(escapeXmlText(`a<b>&"'`), `a&lt;b&gt;&amp;"'`);
  assert.equal(escapeXmlAttribute(`a<b>&"'`), "a&lt;b&gt;&amp;&quot;&apos;");
});

test("xmlDeclaration: only the real declaration, not xml-stylesheet", () => {
  assert.equal(xmlDeclaration('  <?xml version="1.0"?>\n<a/>'), '<?xml version="1.0"?>');
  assert.equal(xmlDeclaration('<?xml-stylesheet href="a.xsl"?><a/>'), null);
  assert.equal(xmlDeclaration("<a/>"), null);
});

test("parserErrorDetail: extracts the first meaningful line", () => {
  assert.equal(
    parserErrorDetail(
      "This page contains the following errors:error on line 1 at column 8: Opening and ending tag mismatch: a line 1 and b\nBelow is a rendering of the page up to the first error.",
    ),
    "error on line 1 at column 8: Opening and ending tag mismatch: a line 1 and b",
  );
  assert.equal(parserErrorDetail("XML Parsing Error: mismatched tag\nLocation: x\nLine Number 1, Column 8:"), "XML Parsing Error: mismatched tag");
  assert.equal(parserErrorDetail(""), "");
});
