import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeHtml, decodeHtml, type EntityMode, type EntityFormat } from "../src/tools/entities.ts";

const MODES: EntityMode[] = ["specialchars", "nonascii", "all"];
const FORMATS: EntityFormat[] = ["named", "decimal", "hex"];

test("encodeHtml: special chars (default mode/format)", () => {
  assert.equal(encodeHtml(`<a href="x">Tom & Jerry's</a>`), "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#x27;s&lt;/a&gt;");
  assert.equal(encodeHtml("'", "specialchars", "decimal"), "&#39;");
  assert.equal(encodeHtml("plain ascii 123"), "plain ascii 123");
  assert.equal(encodeHtml(""), "");
});

test("encodeHtml: non-ASCII per format; specialchars mode leaves them", () => {
  assert.equal(encodeHtml("© é", "nonascii", "named"), "&copy; &#xE9;");
  assert.equal(encodeHtml("© é", "nonascii", "decimal"), "&#169; &#233;");
  assert.equal(encodeHtml("© é", "nonascii", "hex"), "&#xA9; &#xE9;");
  assert.equal(encodeHtml("<é>", "nonascii", "hex"), "<&#xE9;>");
  assert.equal(encodeHtml("<é>", "specialchars", "hex"), "&lt;é&gt;");
  assert.equal(encodeHtml("<é>", "all", "decimal"), "&lt;&#233;&gt;");
});

test("encodeHtml: astral chars become ONE code-point reference (bug fix)", () => {
  assert.equal(encodeHtml("😀", "nonascii", "hex"), "&#x1F600;");
  assert.equal(encodeHtml("😀", "all", "decimal"), "&#128512;");
  assert.equal(encodeHtml("a😀b", "nonascii", "named"), "a&#x1F600;b");
});

test("decodeHtml: named, decimal, hex (both x cases)", () => {
  assert.equal(decodeHtml("&lt;p&gt;&amp;&quot;&#39;&apos;&#x27;"), `<p>&"'''`);
  assert.equal(decodeHtml("&#169;&#xA9;&#XA9;&copy;"), "©©©©");
  assert.equal(decodeHtml("&#128512;&#x1F600;"), "😀😀");
});

test("decodeHtml: single pass — double-escaped input decodes one level", () => {
  assert.equal(decodeHtml("&amp;lt;"), "&lt;");
  assert.equal(decodeHtml("&#38;lt;"), "&lt;");
  assert.equal(decodeHtml("&amp;amp;"), "&amp;");
});

test("decodeHtml: unknown / malformed / out-of-range references stay intact", () => {
  assert.equal(decodeHtml("&unknown; & &;"), "&unknown; & &;");
  assert.equal(decodeHtml("&lt"), "&lt");
  assert.equal(decodeHtml("&#x110000;"), "&#x110000;");
  assert.equal(decodeHtml("&#99999999999;"), "&#99999999999;");
});

test("decodeHtml: legacy surrogate-half references still join into the character", () => {
  assert.equal(decodeHtml("&#xD83D;&#xDE00;"), "😀");
  assert.equal(decodeHtml("&#55357;&#56832;"), "😀");
});

test("round-trip: every mode × format restores the original (parity fixture 3×3)", () => {
  const samples = [
    `<script>alert("x & 'y'")</script>`,
    "Café — “quotes” … 100°C ± 5 € £ ¥ ¢ ½ ¼ ¾ × ÷ •",
    "Emoji 😀👍🏽 and 中文 / 日本語 / 한국어",
    "",
  ];
  for (const mode of MODES) {
    for (const format of FORMATS) {
      for (const sample of samples) {
        assert.equal(decodeHtml(encodeHtml(sample, mode, format)), sample, `${mode}/${format}: ${sample}`);
      }
    }
  }
});

test("encodeHtml: 'all' output is pure ASCII", () => {
  const out = encodeHtml("Ünïcödé 😀 <&>", "all", "named");
  assert.match(out, /^[\x20-\x7e]*$/);
});
