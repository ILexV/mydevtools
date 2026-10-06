/**
 * XSS sanitizer for the Markdown Preview (marked output may carry raw HTML
 * from the user's markdown: <script>, <img onerror>, javascript: links, …).
 * Allowlist-based: unknown elements are unwrapped (text kept), dangerous
 * containers are dropped with their content, every attribute outside the
 * per-tag allowlist is removed (on*, style, id, name, class except
 * `language-*` on <code>), and href/src URLs are restricted to safe schemes.
 * Policy functions are pure (unit-tested in test/markdown-sanitize.test.ts);
 * `sanitizeHtml` walks an inert <template> DOM (verified in a real browser).
 */

/** Elements kept as-is (attributes still filtered). */
export const ALLOWED_TAGS = new Set([
  "a", "abbr", "b", "blockquote", "br", "caption", "cite", "code", "col", "colgroup",
  "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "input", "ins", "kbd", "li",
  "mark", "ol", "p", "pre", "q", "rp", "rt", "ruby", "s", "samp", "small", "span",
  "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead",
  "time", "tr", "u", "ul", "var", "wbr",
]);

/** Elements removed together with their whole subtree (active/embedding content). */
export const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet",
  "template", "noscript", "noembed", "noframes", "xmp", "plaintext", "svg", "math",
  "form", "textarea", "select", "option", "button", "link", "meta", "base", "title",
  "head", "audio", "video", "source", "track", "canvas", "portal", "dialog",
]);

const GLOBAL_ATTRS = new Set(["title", "lang", "dir"]);
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href"]),
  img: new Set(["src", "alt", "width", "height"]),
  td: new Set(["align", "colspan", "rowspan"]),
  th: new Set(["align", "colspan", "rowspan", "scope"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  ol: new Set(["start", "reversed"]),
  li: new Set(["value"]),
  details: new Set(["open"]),
  input: new Set(["type", "checked", "disabled"]),
  time: new Set(["datetime"]),
  q: new Set(["cite"]),
  blockquote: new Set(["cite"]),
};

const LINK_SCHEMES = new Set(["http", "https", "mailto", "tel"]);
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]*$/i;

/**
 * True when `value` is a safe URL for `kind`: relative/fragment URLs and
 * http(s)/mailto/tel (links) or http(s)/raster data: images (img). Control
 * chars and whitespace are stripped first, as browsers do ("java\tscript:").
 */
export function isSafeUrl(value: string, kind: "href" | "src"): boolean {
  const v = value.replace(/[\u0000- \u007f-\u009f]/g, "");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(v)?.[1]?.toLowerCase();
  if (scheme === undefined) return true; // relative, #fragment, //host (inherits https)
  if (kind === "src") return scheme === "http" || scheme === "https" || (scheme === "data" && SAFE_DATA_IMAGE.test(v));
  return LINK_SCHEMES.has(scheme);
}

/** Whether attribute `name` (lowercase) with `value` may stay on `tag` (lowercase). */
export function isAllowedAttribute(tag: string, name: string, value: string): boolean {
  if (name.startsWith("on")) return false;
  if (name === "class") return tag === "code" && /^language-[\w+#.-]+$/.test(value.trim());
  if (name === "href" || name === "cite") return (TAG_ATTRS[tag]?.has(name) ?? false) && isSafeUrl(value, "href");
  if (name === "src") return tag === "img" && isSafeUrl(value, "src");
  if (tag === "input" && name === "type") return value.toLowerCase() === "checkbox";
  return GLOBAL_ATTRS.has(name) || (TAG_ATTRS[tag]?.has(name) ?? false);
}

/** What happens to an element: kept, unwrapped (children kept) or dropped. */
export function elementAction(tag: string): "keep" | "unwrap" | "drop" {
  if (DROP_WITH_CONTENT.has(tag)) return "drop";
  return ALLOWED_TAGS.has(tag) ? "keep" : "unwrap";
}

function cleanElement(el: Element): void {
  const tag = el.localName;
  for (const attr of Array.from(el.attributes)) {
    if (!isAllowedAttribute(tag, attr.name.toLowerCase(), attr.value)) el.removeAttribute(attr.name);
  }
  if (tag === "input") {
    // Only GFM task-list checkboxes survive, always read-only.
    if (el.getAttribute("type")?.toLowerCase() !== "checkbox") {
      el.remove();
      return;
    }
    el.setAttribute("disabled", "");
  }
  if (tag === "a" && el.hasAttribute("href")) {
    el.setAttribute("target", "_blank");
    el.setAttribute("rel", "noopener noreferrer nofollow");
  }
}

function walk(parent: ParentNode): void {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === 8 /* comment */) {
      node.remove();
      continue;
    }
    if (node.nodeType !== 1 /* element */) continue;
    const el = node as Element;
    // Foreign (SVG/MathML) namespaces are dropped wholesale.
    if (el.namespaceURI !== "http://www.w3.org/1999/xhtml") {
      el.remove();
      continue;
    }
    const action = elementAction(el.localName);
    if (action === "drop") {
      el.remove();
      continue;
    }
    walk(el);
    if (action === "unwrap") {
      el.replaceWith(...Array.from(el.childNodes));
      continue;
    }
    cleanElement(el);
  }
}

/** Sanitize untrusted HTML into an inert fragment owned by `doc` (nothing executes while parsing). */
export function sanitizeHtml(html: string, doc: Document = document): DocumentFragment {
  const tpl = doc.createElement("template");
  tpl.innerHTML = html;
  walk(tpl.content);
  return tpl.content;
}
