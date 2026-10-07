import path from "node:path";
import { test, expect, type Page, type Locator } from "@playwright/test";

/**
 * Round-5 state baselines: purposeful element-level captures of interactive
 * tool states (image comparison, regex groups, diff views, parse-error
 * diagnostics, colour contrast/palette, guide TOC, localized 404, password
 * meter) plus cheap behavioural assertions next to them. Complements the
 * page-level baselines in pages.spec.ts; global determinism (reduced motion,
 * SW block, animations disabled, light scheme) comes from playwright.config.ts.
 *
 * Every wait is a real condition (fonts ready, worker/WASM output in the DOM),
 * never a sleep. Fixtures are fixed; password randomness is seeded.
 */

const BASE = "/mydevtools";
const FIXTURES = path.join(__dirname, "fixtures");
const MOBILE = { width: 375, height: 812 };
// The chromium project spreads devices["Desktop Chrome"] (1280×720) over the global viewport.
const DESKTOP = { width: 1440, height: 900 };
/** Element captures: un-stick the site header so it can't overlap a scrolled-to panel. */
const ELEMENT_SHOT = { stylePath: path.join(__dirname, "states.capture.css") };

async function open(page: Page, route: string) {
  await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
}

/** Fonts loaded after a state change (e.g. mono in fresh output) + one painted frame. */
async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

/** Move focus off inputs so no focus ring/caret ends up in the capture. */
async function blur(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "document must not scroll horizontally").toBeLessThanOrEqual(0);
}

/** Replace a CodeMirror editor's whole document (multi-char insert skips auto-close brackets). */
async function setEditorText(page: Page, editor: Locator, text: string) {
  const content = editor.locator(".cm-content");
  await content.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(text);
  await expect(content).toHaveText(text.replace(/\n/g, ""));
}

test.describe("states — mobile 375", () => {
  test.use({ viewport: MOBILE });

  test("image-compressor — empty", async ({ page }) => {
    await open(page, "/en/image-compressor/");
    await expect(page.locator("[data-imgc-compress]")).toBeDisabled();
    await expectNoHorizontalOverflow(page);
    await expect(page.locator("[data-imgc-tool]")).toHaveScreenshot("image-compressor-empty-375.png", ELEMENT_SHOT);
  });

  test("image-compressor — before/after comparison", async ({ page }) => {
    await open(page, "/en/image-compressor/");
    await page.setInputFiles("[data-imgc-file]", path.join(FIXTURES, "compare.png"));
    const compress = page.locator("[data-imgc-compress]");
    await expect(compress).toBeEnabled();
    await page.selectOption("[data-imgc-format]", "jpeg");
    await page.locator("[data-imgc-quality]").evaluate((el: HTMLInputElement) => {
      el.value = "25";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await compress.click();

    const compare = page.locator("[data-image-compare]");
    await expect(compare).toBeVisible({ timeout: 30_000 });
    await expect(compare.locator("[data-ic-result-meta]")).not.toBeEmpty();
    // Both sides decoded (show() awaits decode before unhiding; assert anyway).
    await expect
      .poll(() =>
        compare.evaluate((root) =>
          [...root.querySelectorAll<HTMLImageElement>("img")].every((i) => i.complete && i.naturalWidth > 0),
        ),
      )
      .toBe(true);
    await blur(page);
    await settle(page);
    await expectNoHorizontalOverflow(page);
    await expect(compare).toHaveScreenshot("image-compare-375.png", ELEMENT_SHOT);

    // Keyboard: the range value is the divider position from the left (original
    // left, result right); aria-valuetext reports the visible result share.
    const range = compare.locator("[data-ic-range]");
    await expect(range).toHaveAttribute("aria-valuetext", /\b50\b/);
    await range.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(range).toHaveValue("49");
    await expect(range).toHaveAttribute("aria-valuetext", /\b51\b/);
    await page.keyboard.press("End");
    await expect(range).toHaveValue("100");
    await expect(range).toHaveAttribute("aria-valuetext", /\b0\b/);
  });

  test("regex-tester — named + nested captures", async ({ page }) => {
    await open(page, "/en/regex-tester/");
    await page.fill("[data-rx-pattern]", String.raw`(?P<user>[\w.]+)@(?P<domain>(?P<host>\w+)\.(?P<tld>[a-z]+))`);
    await page.fill("[data-rx-text]", "Contact: ada.lovelace@example.org\nCC: alan@turing.dev, nobody here");
    const matches = page.locator("[data-rx-matches]");
    await expect(matches.locator("[data-rx-count]")).toHaveText("2");
    await expect(matches.locator("[data-rx-legend]")).toBeVisible();
    await expect(matches.locator("[data-rx-legend-list]")).toContainText("tld");
    await expect(page.locator("[data-rx-backdrop] mark").first()).toBeAttached();
    await blur(page);
    await settle(page);
    await expectNoHorizontalOverflow(page);
    await expect(page.locator("[data-rx-tool] > .ds-workbench").first()).toHaveScreenshot("regex-captures-375.png", ELEMENT_SHOT);
  });

  test("text-diff-viewer — unified (line-by-line) example", async ({ page }) => {
    await open(page, "/en/text-diff-viewer/");
    await page.locator("[data-diff-example]").first().click();
    await page.locator('[data-diff-mode][value="line-by-line"]').check();
    await page.locator("[data-diff-compare]").click();
    const panel = page.locator("[data-diff-output-panel]");
    await expect(panel.locator("[data-diff-output] .d2h-wrapper")).toBeVisible();
    await expect(panel.locator(".d2h-file-side-diff")).toHaveCount(0);
    await expect(panel.locator("[data-diff-nav]")).toBeVisible();
    await expect(panel.locator("[data-diff-position]")).not.toBeEmpty();
    await blur(page);
    await settle(page);
    await expectNoHorizontalOverflow(page);
    await expect(panel).toHaveScreenshot("diff-unified-375.png", ELEMENT_SHOT);
  });

  test("json-beautifier — parse error diagnostic", async ({ page }) => {
    await open(page, "/en/json-beautifier/");
    const editor = page.locator("[data-json-editor]");
    await expect(editor.locator(".cm-content")).toBeVisible();
    await setEditorText(page, editor, '{\n  "name": "demo",\n  "items": [1, 2,, 3],\n  "ok": true\n}');
    await page.locator("[data-json-format]").click();
    const diag = page.locator("[data-json-error]");
    await expect(diag).toBeVisible();
    await expect(diag.locator(".mdt-diag-goto")).toBeVisible();
    await expect(editor.locator(".cm-mdt-diag-line")).toHaveCount(1);
    await blur(page);
    await settle(page);
    await expectNoHorizontalOverflow(page);
    await expect(page.locator("[data-json-tool]")).toHaveScreenshot("json-error-375.png", ELEMENT_SHOT);

    // "Go to error" moves focus into the editor.
    await diag.locator(".mdt-diag-goto").click();
    await expect(editor.locator(".cm-content")).toBeFocused();
  });

  test("color-converter — contrast cards and tints/shades", async ({ page }) => {
    await open(page, "/en/color-converter/");
    const tool = page.locator("[data-color-tool]");
    await expect(tool.locator("[data-color-ratio]")).not.toHaveText("—");
    await expect(tool.locator("[data-color-wcag] li").first()).toBeVisible();
    await expect(tool.locator("[data-color-shades] > *").first()).toBeVisible();
    await settle(page);
    await expectNoHorizontalOverflow(page);
    const contrast = tool.locator("section.ds-card").filter({ has: page.locator("[data-color-wcag]") });
    await expect(contrast).toHaveScreenshot("color-contrast-375.png", ELEMENT_SHOT);
    const palette = tool.locator("section.ds-card").filter({ has: page.locator("[data-color-shades]") });
    await expect(palette).toHaveScreenshot("color-palette-375.png", ELEMENT_SHOT);
  });

  test("404 — localized (ru)", async ({ page }) => {
    const res = await page.goto(`${BASE}/ru/no-such-page/`, { waitUntil: "networkidle" });
    expect(res?.status()).toBe(404);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator("html")).toHaveAttribute("lang", /^ru/);
    await expect(page.locator("#nf-title")).not.toHaveText(/not found/i);
    await settle(page);
    await expectNoHorizontalOverflow(page);
    await expect(page).toHaveScreenshot("404-ru-375.png", { fullPage: true });
  });

  test("password-generator — strength meter and related tools", async ({ page }) => {
    // Seeded xorshift32 instead of crypto.getRandomValues: the WASM generator
    // (getrandom → crypto.getRandomValues on the main thread) becomes repeatable.
    await page.addInitScript(() => {
      let s = 0x9e3779b9 | 0;
      const fill = <T extends ArrayBufferView | null>(arr: T): T => {
        if (!arr) return arr;
        const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
        for (let i = 0; i < bytes.length; i++) {
          s ^= s << 13;
          s ^= s >>> 17;
          s ^= s << 5;
          bytes[i] = s & 0xff;
        }
        return arr;
      };
      Object.defineProperty(crypto, "getRandomValues", { value: fill, configurable: true });
    });
    await open(page, "/en/password-generator/");
    const result = page.locator("[data-pw-result-panel]");
    await expect(result.locator("[data-pw-result]")).not.toBeEmpty();
    await expect(result.locator("[data-pw-strength]")).toBeVisible();
    await expect(result.locator("[data-pw-meter]")).toHaveAttribute("aria-valuetext", /bits/);
    await settle(page);
    await expectNoHorizontalOverflow(page);
    await expect(result).toHaveScreenshot("password-meter-375.png", ELEMENT_SHOT);
    const related = page.locator("section.related");
    await related.scrollIntoViewIfNeeded();
    await expect(related).toHaveScreenshot("password-related-375.png", ELEMENT_SHOT);
  });
});

test.describe("states — desktop 1440", () => {
  test.use({ viewport: DESKTOP });

  test("guide with active table of contents", async ({ page }) => {
    await open(page, "/en/password-generator/");
    await page.locator("#seo-howto").evaluate((h) => h.scrollIntoView({ block: "start" }));
    const toc = page.locator("nav.seo-toc");
    await expect(toc).toBeVisible();
    await expect(toc.locator('[data-toc-link="seo-howto"]')).toHaveAttribute("aria-current", "location");
    await expect(toc.locator('[aria-current="location"]')).toHaveCount(1);
    await expect(page.locator(".seo-toc-compact")).toBeHidden();
    await settle(page);
    await expect(page).toHaveScreenshot("guide-toc-1440.png");
  });

  test("text-diff-viewer — side-by-side example", async ({ page }) => {
    await open(page, "/en/text-diff-viewer/");
    await page.locator("[data-diff-example]").first().click();
    await expect(page.locator('[data-diff-mode][value="side-by-side"]')).toBeChecked();
    await page.locator("[data-diff-compare]").click();
    const panel = page.locator("[data-diff-output-panel]");
    await expect(panel.locator(".d2h-file-side-diff").first()).toBeVisible();
    await expect(panel.locator("[data-diff-position]")).not.toBeEmpty();
    await blur(page);
    await settle(page);
    await expect(panel).toHaveScreenshot("diff-side-by-side-1440.png", ELEMENT_SHOT);
  });

  test("xml-beautifier — mismatched tag diagnostic", async ({ page }) => {
    await open(page, "/en/xml-beautifier/");
    const editor = page.locator("[data-xml-tool] .mdt-cm").first();
    await expect(editor.locator(".cm-content")).toBeVisible();
    await setEditorText(page, editor, '<catalog>\n  <book id="1">\n    <title>XML</titel>\n  </book>\n</catalog>');
    await page.locator("[data-xml-format]").click();
    const diag = page.locator("[data-xml-error]");
    await expect(diag).toBeVisible();
    await expect(diag.locator(".mdt-diag-goto")).toBeVisible();
    await blur(page);
    await settle(page);
    await expect(page.locator("[data-xml-tool]")).toHaveScreenshot("xml-error-1440.png", ELEMENT_SHOT);
  });

  test("yaml-beautifier-validator — indentation diagnostic", async ({ page }) => {
    await open(page, "/en/yaml-beautifier-validator/");
    const editor = page.locator("[data-yaml-input]");
    await expect(editor.locator(".cm-content")).toBeVisible();
    await setEditorText(page, editor, "services:\n  web:\n    image: nginx\n   ports: [80]\n");
    await page.locator("[data-yaml-validate]").click();
    const diag = page.locator("[data-yaml-error]");
    await expect(diag).toBeVisible();
    await expect(diag.locator(".mdt-diag-goto")).toBeVisible();
    await blur(page);
    await settle(page);
    await expect(page.locator("[data-yaml-tool]")).toHaveScreenshot("yaml-error-1440.png", ELEMENT_SHOT);
  });
});
