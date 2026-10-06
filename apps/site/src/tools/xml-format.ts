/**
 * XML pretty-print / minify core for xml-beautifier (ported from legacy
 * xml-beautifier.js). Parsing is the browser DOMParser; serialization walks
 * a minimal node-like interface, so it is unit-testable without a DOM
 * (`test/xml-format.test.ts`). Keeps the `<?xml …?>` declaration, DOCTYPE,
 * and document-level comments / processing instructions around the root
 * (legacy dropped them); escapes text and attribute values; collapses
 * single-text children onto one line; self-closes empty elements.
 */

/** The subset of DOM Node the serializer reads. */
export interface XmlNodeLike {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  childNodes: ArrayLike<XmlNodeLike>;
  attributes?: ArrayLike<{ name: string; value: string }>;
  /** ProcessingInstruction */
  target?: string;
  data?: string;
  /** DocumentType */
  name?: string;
  publicId?: string;
  systemId?: string;
}

const ELEMENT = 1;
const TEXT = 3;
const CDATA = 4;
const PI = 7;
const COMMENT = 8;
const DOCTYPE = 10;

export class XmlParseError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "XmlParseError";
  }
}

export function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function formatDoctype(node: XmlNodeLike): string {
  let id = "";
  if (node.publicId) {
    id += ` PUBLIC "${node.publicId}"`;
    if (node.systemId) id += ` "${node.systemId}"`;
  } else if (node.systemId) {
    id += ` SYSTEM "${node.systemId}"`;
  }
  return `<!DOCTYPE ${node.name ?? node.nodeName}${id}>`;
}

const isBlankText = (node: XmlNodeLike) => node.nodeType === TEXT && !(node.nodeValue || "").trim();

function openTag(el: XmlNodeLike, selfClose: boolean): string {
  const attrs = Array.from(el.attributes ?? [])
    .map((a) => `${a.name}="${escapeXmlAttribute(a.value)}"`)
    .join(" ");
  return `<${el.nodeName}${attrs ? " " + attrs : ""}${selfClose ? "/>" : ">"}`;
}

function leaf(node: XmlNodeLike): string | null {
  switch (node.nodeType) {
    case CDATA:
      return `<![CDATA[${node.nodeValue ?? ""}]]>`;
    case COMMENT:
      return `<!--${node.nodeValue ?? ""}-->`;
    case PI:
      return `<?${node.target ?? node.nodeName}${node.data ? " " + node.data : ""}?>`;
    case DOCTYPE:
      return formatDoctype(node);
    default:
      return null;
  }
}

function serializePretty(node: XmlNodeLike, depth: number, lines: string[], unit: string): void {
  const indent = unit.repeat(depth);
  if (node.nodeType === ELEMENT) {
    const children = Array.from(node.childNodes).filter((c) => !isBlankText(c));
    if (children.length === 0) {
      lines.push(indent + openTag(node, true));
    } else if (children.length === 1 && children[0].nodeType === TEXT) {
      lines.push(indent + openTag(node, false) + escapeXmlText((children[0].nodeValue || "").trim()) + `</${node.nodeName}>`);
    } else {
      lines.push(indent + openTag(node, false));
      for (const child of children) serializePretty(child, depth + 1, lines, unit);
      lines.push(indent + `</${node.nodeName}>`);
    }
    return;
  }
  if (node.nodeType === TEXT) {
    const text = (node.nodeValue || "").trim();
    if (text) lines.push(indent + escapeXmlText(text));
    return;
  }
  const out = leaf(node);
  if (out !== null) lines.push(indent + out);
}

function serializeCompact(node: XmlNodeLike): string {
  if (node.nodeType === ELEMENT) {
    const children = Array.from(node.childNodes).filter((c) => !isBlankText(c));
    if (children.length === 0) return openTag(node, true);
    return openTag(node, false) + children.map(serializeCompact).join("") + `</${node.nodeName}>`;
  }
  if (node.nodeType === TEXT) return escapeXmlText(node.nodeValue ?? "");
  return leaf(node) ?? "";
}

/** `<?xml version=… ?>` declaration at the start of the input (not exposed by the DOM). */
export function xmlDeclaration(input: string): string | null {
  const m = input.match(/^\s*(<\?xml\s[^>]*\?>)/i);
  return m ? m[1].trim() : null;
}

/** Serialize a parsed document. `indent`: number of spaces or "\t". */
export function serializeXmlDocument(
  doc: XmlNodeLike,
  declaration: string | null,
  indent: number | "\t",
  compact: boolean,
): string {
  const parts: string[] = [];
  if (declaration) parts.push(declaration);
  const unit = indent === "\t" ? "\t" : " ".repeat(indent);
  for (const node of Array.from(doc.childNodes)) {
    if (isBlankText(node)) continue;
    if (compact) {
      const out = serializeCompact(node);
      if (out) parts.push(out);
    } else {
      serializePretty(node, 0, parts, unit);
    }
  }
  return parts.join("\n");
}

/** First error line of a DOMParser `<parsererror>` (Chromium/WebKit/Gecko wording differs). */
export function parserErrorDetail(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^This page contains the following errors:?$/i.test(l) && !/^Below is a rendering/i.test(l));
  return (lines[0] ?? "").replace(/^This page contains the following errors:\s*/i, "").slice(0, 300);
}

/** Parse with DOMParser and format. Throws XmlParseError (with detail) on malformed XML. */
export function formatXml(input: string, indent: number | "\t", compact: boolean): string {
  const doc = new DOMParser().parseFromString(input, "application/xml");
  const err = doc.getElementsByTagName("parsererror")[0];
  if (err) throw new XmlParseError(parserErrorDetail(err.textContent ?? ""));
  return serializeXmlDocument(doc as unknown as XmlNodeLike, xmlDeclaration(input), indent, compact);
}
