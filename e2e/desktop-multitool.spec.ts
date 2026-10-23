import { test, expect, type Page } from "@playwright/test";

/**
 * Desktop multi-tool features (roadmap stage 6), Chromium: ready-made
 * scenarios, live window links, files dropped on the desk, dragging a result,
 * the desk clipboard, moving a window out and back, and the `/launch/` entry.
 */

const DESK = "/en/desktop/";

async function openDesk(page: Page, errors: string[]): Promise<void> {
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    // The analytics endpoint does not exist on the preview server.
    if (message.type() === "error" && !message.text().includes("Failed to load resource")) errors.push(`console: ${message.text()}`);
  });
  await page.goto(DESK, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-desk-icons] .desk-icon").first()).toBeVisible();
}

async function launch(page: Page, query: string, slug: string): Promise<void> {
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.locator("[data-catalog-input]");
  await expect(input).toBeFocused();
  await input.fill(query);
  await input.press("Enter");
  await expect(page.frameLocator(`iframe[data-tool-slug="${slug}"]`).locator("main.tool")).toBeAttached();
  await expect(page.locator(`iframe[data-tool-slug="${slug}"][data-attached]`)).toBeAttached();
}

const windowOf = (page: Page, slug: string) => page.locator(".desk-window", { has: page.locator(`iframe[data-tool-slug="${slug}"]`) });

test("an empty desk offers scenarios; one click opens the tools side by side", async ({ page }) => {
  const errors: string[] = [];
  await openDesk(page, errors);
  const card = page.locator("[data-desk-starters]");
  await expect(card).toBeVisible();
  await card.locator('[data-scenario="release"]').click();
  await expect(page.locator('iframe[data-tool-slug="hash-calculator"]')).toBeAttached();
  await expect(page.locator('iframe[data-tool-slug="file-signature"]')).toBeAttached();
  await expect(card).toBeHidden();
  const left = await windowOf(page, "hash-calculator").boundingBox();
  const right = await windowOf(page, "file-signature").boundingBox();
  expect(left && right && left.x + left.width <= right.x + 1).toBeTruthy();

  await page.locator("[data-desk-workspaces]").click();
  await expect(page.locator("[data-scenario-list] [data-scenario]")).toHaveCount(7);
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});

test("a linked window follows the source result as it changes", async ({ page }) => {
  const errors: string[] = [];
  await openDesk(page, errors);
  await launch(page, "Base64", "base64-encoder");
  const source = page.frameLocator('iframe[data-tool-slug="base64-encoder"]');
  await source.locator("textarea.enc-input").fill("hello");
  await source.locator("[data-b64-encode]").click();
  await expect(source.locator("[data-b64-output]")).toHaveValue("aGVsbG8=");

  await windowOf(page, "base64-encoder").locator("[data-link]").click();
  await page.locator(".desk-menu-item", { hasText: "URL Encoder" }).click();
  const target = page.frameLocator('iframe[data-tool-slug="url-encoder"]');
  await expect(target.locator("textarea.url-input")).toHaveValue("aGVsbG8=");
  await expect(windowOf(page, "url-encoder")).toHaveClass(/is-linked/);

  await page.locator(".desk-task.is-running", { hasText: "Base64" }).click();
  await source.locator("textarea.enc-input").fill("hello desk");
  await source.locator("[data-b64-encode]").click();
  await expect(target.locator("textarea.url-input")).toHaveValue("aGVsbG8gZGVzaw==");

  // Closing the source drops the link.
  await windowOf(page, "base64-encoder").locator("[data-close]").click();
  // The source holds typed input, so the desk asks first.
  await expect(page.locator("[data-discard-dialog]")).toBeVisible();
  await page.locator("[data-discard-close]").click();
  await expect(page.locator('iframe[data-tool-slug="base64-encoder"]')).toHaveCount(0);
  await expect(windowOf(page, "url-encoder")).not.toHaveClass(/is-linked/);
  expect(errors).toEqual([]);
});

test("a file dropped on the wallpaper opens in the chosen tool", async ({ page }) => {
  const errors: string[] = [];
  await openDesk(page, errors);
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(["hello file"], "notes.pdf", { type: "application/pdf" }));
    return data;
  });
  const stage = page.locator("[data-desk-stage]");
  await stage.dispatchEvent("dragover", { dataTransfer: transfer, clientX: 700, clientY: 400 });
  await stage.dispatchEvent("drop", { dataTransfer: transfer, clientX: 700, clientY: 400 });
  const menu = page.locator("[data-desk-menu]");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".desk-menu-label").first()).toContainText("notes.pdf");
  await expect(menu.locator(".desk-menu-item").first()).toContainText("PDF");
  await menu.locator(".desk-menu-item", { hasText: "Hash Calculator" }).click();
  const hash = page.frameLocator('iframe[data-tool-slug="hash-calculator"]');
  await expect(hash.locator("[data-hash-files]")).toContainText("notes.pdf");
  expect(errors).toEqual([]);
});

test("copies made in windows land in the desk clipboard and paste into another window", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors: string[] = [];
  await openDesk(page, errors);
  await expect(page.locator('[data-widget="clipboard"]')).toBeVisible();
  await launch(page, "Base64", "base64-encoder");
  const source = page.frameLocator('iframe[data-tool-slug="base64-encoder"]');
  await source.locator("textarea.enc-input").fill("clip me");
  await source.locator("[data-b64-encode]").click();
  await source.locator("[data-b64-copy]").click();
  const clip = page.locator('[data-widget="clipboard"] .desk-clip-paste');
  await expect(clip.first()).toContainText("Y2xpcCBtZQ==");

  await launch(page, "URL Encoder", "url-encoder");
  const target = page.frameLocator('iframe[data-tool-slug="url-encoder"]');
  await target.locator("textarea.url-input").click();
  await clip.first().click();
  await expect(target.locator("textarea.url-input")).toHaveValue("Y2xpcCBtZQ==");
  expect(errors).toEqual([]);
});

test("a window moves to its own browser window and comes back", async ({ page }) => {
  const errors: string[] = [];
  await openDesk(page, errors);
  await launch(page, "UUID", "uuid-generator");
  await windowOf(page, "uuid-generator").locator(".desk-window-title").click({ button: "right", position: { x: 120, y: 12 } });
  const popupPromise = page.waitForEvent("popup");
  await page.locator(".desk-menu-item", { hasText: "Move to a separate window" }).click();
  const popup = await popupPromise;
  await expect(popup.locator("main.tool")).toBeAttached();
  await expect(page.locator('iframe[data-tool-slug="uuid-generator"]')).toHaveCount(0);
  await expect(page.locator(".desk-task.is-external")).toHaveCount(1);
  await popup.locator(".embed-return").click();
  await expect(page.locator('iframe[data-tool-slug="uuid-generator"]')).toBeAttached();
  await expect(page.locator(".desk-task.is-external")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("/launch/ forwards to the desk and the manifest declares file handlers", async ({ page, request }) => {
  await page.goto("/launch/");
  await expect(page).toHaveURL(/\/en\/desktop\/$/);
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest.file_handlers[0].action).toBe("/launch/");
  expect(manifest.file_handlers[0].accept["application/pdf"]).toContain(".pdf");
  expect(manifest.shortcuts[0].url).toBe("/launch/");
});
