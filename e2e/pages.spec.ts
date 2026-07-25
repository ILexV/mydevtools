import { test, expect, type Page } from "@playwright/test";

/**
 * Visual baselines for the stable, key surfaces.
 * Baselines are committed next to this file under `pages.spec.ts-snapshots/`.
 * Global determinism (reduceMotion / SW block / animations disabled / fonts
 * ready) is set in playwright.config.ts; here we only navigate + settle.
 */

const BASE = "/mydevtools";

async function settle(page: Page, path: string) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  // One rAF so the reduced-motion-frozen state has painted.
  await page.evaluate(() => {
    const { promise, resolve } = Promise.withResolvers<null>();
    requestAnimationFrame(() => resolve(null));
    return promise;
  });
}

test.describe("Prism visual baselines", () => {
  test("home — light, desktop", async ({ page }) => {
    await settle(page, "/en/");
    await expect(page).toHaveScreenshot("home-light-desktop.png");
  });

  test("home — dark, desktop", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("theme", "dark"));
    await settle(page, "/en/");
    await expect(page).toHaveScreenshot("home-dark-desktop.png");
  });

  test("home — light, mobile 375", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 740 });
    await settle(page, "/en/");
    await expect(page).toHaveScreenshot("home-light-mobile.png");
  });

  test("tool — uuid-generator (text tool), desktop", async ({ page }) => {
    await settle(page, "/en/uuid-generator/");
    await expect(page).toHaveScreenshot("tool-uuid-desktop.png");
  });

  test("tool — image-compressor (file/WASM tool), desktop", async ({ page }) => {
    await settle(page, "/en/image-compressor/");
    await expect(page).toHaveScreenshot("tool-image-desktop.png");
  });

  test("design showcase — desktop", async ({ page }) => {
    await settle(page, "/design/");
    await expect(page).toHaveScreenshot("design-showcase.png");
  });
});
