import { test } from "node:test";
import assert from "node:assert/strict";
import { seoMarkdownToHtml, parseHowToSteps } from "../src/lib/markdown.ts";

test("seoMarkdownToHtml: headings, bold, paragraphs", () => {
  const html = seoMarkdownToHtml("## Section\nSome **bold** text\n\nMore text");
  assert.match(html, /<h2>Section<\/h2>/);
  assert.match(html, /<p>Some <strong>bold<\/strong> text<\/p>/);
  assert.match(html, /<p>More text<\/p>/);
});

test("seoMarkdownToHtml: consecutive '- ' lines group into one list", () => {
  const html = seoMarkdownToHtml("- one\n- two\ntrailing");
  assert.equal((html.match(/<ul>/g) ?? []).length, 1);
  assert.match(html, /<li>one<\/li>\n<li>two<\/li>/);
  assert.match(html, /<\/ul>\n<p>trailing<\/p>/);
});

test("seoMarkdownToHtml: list closes at end of input", () => {
  const html = seoMarkdownToHtml("- only");
  assert.match(html, /<ul>\n<li>only<\/li>\n<\/ul>$/);
});

test("seoMarkdownToHtml: empty input stays empty", () => {
  assert.equal(seoMarkdownToHtml(""), "");
});

test("parseHowToSteps: splits steps, strips 'Step N:' prefix, keeps body", () => {
  const steps = parseHowToSteps(
    "### Step 1: Choose Input\nType or paste text.\n\n### Step 2: Copy Result\nClick the button.",
  );
  assert.equal(steps.length, 2);
  assert.deepEqual(steps[0], { name: "Choose Input", text: "Type or paste text." });
  assert.deepEqual(steps[1], { name: "Copy Result", text: "Click the button." });
});

test("parseHowToSteps: step without body yields empty text", () => {
  const steps = parseHowToSteps("### Step 1: Only Heading");
  assert.deepEqual(steps, [{ name: "Only Heading", text: "" }]);
});

test("parseHowToSteps: garbage without step markers yields no HowTo schema material", () => {
  // Legacy behavior: parts without the marker are still emitted as steps, but
  // blank/whitespace input must produce zero steps so no HowTo JSON-LD is added.
  assert.deepEqual(parseHowToSteps(""), []);
  assert.deepEqual(parseHowToSteps("   \n  "), []);
});
