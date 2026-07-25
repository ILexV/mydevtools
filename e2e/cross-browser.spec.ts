import { test, expect, type Page } from "@playwright/test";

/**
 * Functional cross-engine matrix (TODO §325) — runs on Chromium, Firefox and
 * WebKit. Pixel baselines are engine-specific (font AA / shaping differ), so
 * this file does NOT screenshot; it asserts the things that must hold in every
 * engine: clean console, no horizontal overflow, key elements present, and the
 * theme toggle actually flips `data-theme`.
 */

const BASE = "/mydevtools";

/** Pages that exercise the distinct layout families. */
const PAGES: ReadonlyArray<readonly [string, string]> = [
  ["home", "/en/"],
  ["text-tool", "/en/uuid-generator/"],
  ["file-tool", "/en/image-compressor/"],
];

async function load(page: Page, path: string, errors: string[]) {
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => document.fonts.ready);
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

for (const [label, path] of PAGES) {
  test.describe(`${label}`, () => {
    test("desktop: no console errors, no horizontal overflow, header+h1 present", async ({
      page,
    }) => {
      const errors: string[] = [];
      await load(page, path, errors);
      await expect(page.locator("header.site-header")).toBeVisible();
      await expect(page.locator("h1")).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(2);
      expect(errors, errors.join("\n")).toEqual([]);
    });

    test("mobile 375: no horizontal overflow", async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 740 });
      const errors: string[] = [];
      await load(page, path, errors);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(2);
    });
  });
}

test("theme toggle flips data-theme (home)", async ({ page }) => {
  await load(page, "/en/", []);
  const before = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  await page.locator("[data-theme-toggle]").click();
  const after = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  expect(after, `theme: ${before} → ${after}`).not.toBe(before);
});
