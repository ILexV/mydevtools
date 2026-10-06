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

test("seoMarkdownToHtml: inline code is escaped verbatim, prose is not", () => {
  const html = seoMarkdownToHtml(
    '- Input: `<div class="x">Hi & bye</div>`\n- Output: `&lt;b&gt; **not bold**`\nPlain **bold** & <em>trusted</em>',
  );
  assert.match(html, /<li>Input: <code>&lt;div class=&quot;x&quot;&gt;Hi &amp; bye&lt;\/div&gt;<\/code><\/li>/);
  assert.match(html, /<li>Output: <code>&amp;lt;b&amp;gt; \*\*not bold\*\*<\/code><\/li>/);
  assert.match(html, /<p>Plain <strong>bold<\/strong> & <em>trusted<\/em><\/p>/);
});

test("seoMarkdownToHtml: code-only line still becomes a paragraph", () => {
  assert.equal(seoMarkdownToHtml("`a < b`"), "<p><code>a &lt; b</code></p>");
});

test("seoMarkdownToHtml: unmatched backtick is left as text", () => {
  assert.equal(seoMarkdownToHtml("it`s fine"), "<p>it`s fine</p>");
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

test("parseHowToSteps: localized step headings split into separate steps with prefix stripped", () => {
  const cases: Array<[string, string]> = [
    ["### Шаг 1: Вставьте текст\nТело 1\n\n### Шаг 2: Скопируйте\nТело 2", "Вставьте текст"],
    ["### 步骤1：准备输入\n正文\n\n### 步骤2：复制\n正文", "准备输入"],
    ["### 1단계: 입력 준비\n본문\n\n### 2단계: 복사\n본문", "입력 준비"],
    ["### Étape 1 : Préparez\nCorps\n\n### Étape 2 : Copiez\nCorps", "Préparez"],
    ["### चरण 1: इनपुट तैयार करें\nपाठ\n\n### चरण 2: कॉपी करें\nपाठ", "इनपुट तैयार करें"],
    ["### ステップ1: 入力を準備する\n本文\n\n### ステップ2: コピー\n本文", "入力を準備する"],
  ];
  for (const [md, first] of cases) {
    const steps = parseHowToSteps(md);
    assert.equal(steps.length, 2, md);
    assert.equal(steps[0].name, first);
  }
});

test("parseHowToSteps: heading without a step number keeps its full name", () => {
  assert.equal(parseHowToSteps("### Paste your JSON\nBody")[0].name, "Paste your JSON");
});
