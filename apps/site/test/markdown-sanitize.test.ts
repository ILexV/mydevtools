import { test } from "node:test";
import assert from "node:assert/strict";
import { elementAction, isAllowedAttribute, isSafeUrl } from "../src/tools/markdown-sanitize.ts";

// DOM walking (`sanitizeHtml`) is verified in a real browser (QA report
// docs/qa/reports/text.md); here we pin the pure policy it applies.

test("isSafeUrl(href): blocks script-capable schemes incl. obfuscated ones", () => {
  for (const bad of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "\u0001javascript:alert(1)",
    "vbscript:msgbox",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
  ]) {
    assert.equal(isSafeUrl(bad, "href"), false, bad);
  }
  for (const ok of ["https://example.com", "http://x.y/z?q=1", "mailto:a@b.c", "tel:+123", "#section", "/path", "relative/page.html", "//cdn.example.com/x", "?q=javascript:1"]) {
    assert.equal(isSafeUrl(ok, "href"), true, ok);
  }
});

test("isSafeUrl(src): only http(s), relative and raster base64 data images", () => {
  assert.equal(isSafeUrl("https://example.com/a.png", "src"), true);
  assert.equal(isSafeUrl("img/a.png", "src"), true);
  assert.equal(isSafeUrl("data:image/png;base64,iVBORw0KGgo=", "src"), true);
  assert.equal(isSafeUrl("data:image/svg+xml;base64,PHN2Zz4=", "src"), false);
  assert.equal(isSafeUrl("data:text/html;base64,PHNjcmlwdD4=", "src"), false);
  assert.equal(isSafeUrl("javascript:alert(1)", "src"), false);
  assert.equal(isSafeUrl("mailto:a@b.c", "src"), false);
});

test("isAllowedAttribute: event handlers, style, id/name and arbitrary class are removed", () => {
  assert.equal(isAllowedAttribute("img", "onerror", "alert(1)"), false);
  assert.equal(isAllowedAttribute("a", "onclick", "x"), false);
  assert.equal(isAllowedAttribute("p", "style", "position:fixed"), false);
  assert.equal(isAllowedAttribute("h1", "id", "marked"), false);
  assert.equal(isAllowedAttribute("img", "name", "x"), false);
  assert.equal(isAllowedAttribute("div", "class", "ds-scrim"), false);
  assert.equal(isAllowedAttribute("a", "href", "javascript:alert(1)"), false);
  assert.equal(isAllowedAttribute("div", "href", "https://x"), false);
  assert.equal(isAllowedAttribute("img", "srcset", "https://x 1x"), false);
  assert.equal(isAllowedAttribute("a", "formaction", "x"), false);
});

test("isAllowedAttribute: what marked/GFM legitimately emits is kept", () => {
  assert.equal(isAllowedAttribute("a", "href", "https://mydevtools.app"), true);
  assert.equal(isAllowedAttribute("a", "title", "t"), true);
  assert.equal(isAllowedAttribute("img", "src", "https://x/y.png"), true);
  assert.equal(isAllowedAttribute("img", "alt", "alt"), true);
  assert.equal(isAllowedAttribute("code", "class", "language-javascript"), true);
  assert.equal(isAllowedAttribute("code", "class", "language-js evil"), false);
  assert.equal(isAllowedAttribute("td", "align", "center"), true);
  assert.equal(isAllowedAttribute("ol", "start", "3"), true);
  assert.equal(isAllowedAttribute("input", "type", "checkbox"), true);
  assert.equal(isAllowedAttribute("input", "type", "text"), false);
  assert.equal(isAllowedAttribute("input", "checked", ""), true);
});

test("elementAction: active content dropped, unknown unwrapped, markdown tags kept", () => {
  for (const t of ["script", "style", "iframe", "object", "embed", "svg", "math", "form", "textarea", "template", "meta", "link", "base"]) {
    assert.equal(elementAction(t), "drop", t);
  }
  for (const t of ["custom-el", "marquee", "center", "font", "body", "html"]) {
    assert.equal(elementAction(t), "unwrap", t);
  }
  for (const t of ["p", "a", "img", "pre", "code", "table", "td", "ul", "li", "details", "summary", "kbd", "input"]) {
    assert.equal(elementAction(t), "keep", t);
  }
});

test("previewHeadingLevel: preview demotes one level so user # never becomes a page h1", async () => {
  const { previewHeadingLevel } = await import("../src/tools/markdown-sanitize.ts");
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(previewHeadingLevel), [2, 3, 4, 5, 6, 7]);
  assert.equal(previewHeadingLevel(0), 2);
});
