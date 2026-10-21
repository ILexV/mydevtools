import { test, expect, type Page } from "@playwright/test";

/**
 * Desktop shell behaviour (`/{lang}/desktop/`), Chromium only. Covers the
 * scenarios that were checked by hand when the shell shipped: windows keep
 * input while hidden, closing asks before discarding input, geometry survives
 * a reload, hotkeys reach the shell from inside a tool iframe, hidden windows
 * load lazily, settings follow another tab, and a broken frame offers a retry.
 */

const DESK = "/en/desktop/";
const LAYOUT_KEY = "mdt.desktop.layout.v1";
const PREFS_KEY = "mdt.desktop.prefs.v1";
const ALT = process.platform === "darwin" ? "Control" : "Alt";

async function openDesk(page: Page, errors: string[] = []): Promise<void> {
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  await page.goto(DESK, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-desk-icons] .desk-icon").first()).toBeVisible();
}

/** Opens a tool through the launcher and waits until its page is live inside the frame. */
async function launch(page: Page, query: string, slug: string): Promise<void> {
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.locator("[data-catalog-input]");
  await expect(input).toBeFocused();
  await input.fill(query);
  await input.press("Enter");
  await expect(page.locator("[data-catalog-dialog]")).not.toBeVisible();
  await expect(page.frameLocator(`iframe[data-tool-slug="${slug}"]`).locator("main.tool")).toBeAttached();
  // The shell tracks input once the page's scripts run, which is before `load`.
  await expect(page.locator(`iframe[data-tool-slug="${slug}"][data-attached]`)).toBeAttached();
}

const visibleWindows = (page: Page) => page.locator(".desk-window:not([hidden])");

/** Windows may overlap and the first click on a background frame only raises it: use the taskbar. */
async function activate(page: Page, slug: string): Promise<void> {
  const frame = page.locator(`iframe[data-tool-slug="${slug}"]`);
  const title = (await frame.getAttribute("title")) ?? slug;
  await page.locator(".desk-task.is-running", { hasText: title }).click();
  await expect(page.locator(".desk-window.is-active iframe")).toHaveAttribute("data-tool-slug", slug);
}

test("two tools side by side keep input across minimize and show desktop", async ({ page }) => {
  const errors: string[] = [];
  await openDesk(page, errors);
  await launch(page, "Base64", "base64-encoder");
  await launch(page, "UUID", "uuid-generator");
  await expect(visibleWindows(page)).toHaveCount(2);

  const input = page.frameLocator('iframe[data-tool-slug="base64-encoder"]').locator("textarea.enc-input");
  await activate(page, "base64-encoder");
  await input.fill("hello desk");

  await page.locator("[data-desk-show]").click();
  await expect(visibleWindows(page)).toHaveCount(0);
  await page.locator("[data-desk-show]").click();
  await expect(visibleWindows(page)).toHaveCount(2);
  await expect(input).toHaveValue("hello desk");
  expect(errors, errors.join("\n")).toEqual([]);
});

test("closing a window with input asks first; staying keeps the text", async ({ page }) => {
  // A slow image keeps the frame's `load` far behind its markup, as on a real network:
  // text typed before `load` must still count as input.
  await page.route("**/base64-encoder/?embed=1", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace("</body>", '<img src="/__slow-load.png" alt=""></body>');
    await route.fulfill({ response, body });
  });
  await page.route("**/__slow-load.png", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await route.fulfill({ status: 404 });
  });
  await openDesk(page);
  await launch(page, "Base64", "base64-encoder");
  const input = page.frameLocator('iframe[data-tool-slug="base64-encoder"]').locator("textarea.enc-input");
  await input.fill("keep me");
  // The fonts are still on their way: this input was typed before the frame's `load`.
  expect(await page.frameLocator('iframe[data-tool-slug="base64-encoder"]').locator("html").evaluate(() => document.readyState)).not.toBe("complete");

  const close = page.locator(".desk-window:not([hidden]) [data-close]");
  await close.click();
  await expect(page.locator("[data-discard-dialog]")).toBeVisible();
  await page.locator("[data-discard-stay]").click();
  await expect(input).toHaveValue("keep me");

  await close.click();
  await page.locator("[data-discard-close]").click();
  await expect(page.locator('iframe[data-tool-slug="base64-encoder"]')).toHaveCount(0);
});

test("window geometry survives a reload; a minimized window loads only when restored", async ({ page }) => {
  await openDesk(page);
  await launch(page, "Base64", "base64-encoder");
  await launch(page, "UUID", "uuid-generator");

  // Dock UUID left from the title bar (outside any text field), then minimize Base64.
  const uuidTitle = page.locator(".desk-window:not([hidden])", { has: page.locator('iframe[data-tool-slug="uuid-generator"]') }).locator(".desk-window-title");
  await uuidTitle.focus();
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  const base64Id = await page.locator('iframe[data-tool-slug="base64-encoder"]').getAttribute("data-tool-id");
  expect(base64Id).toBeTruthy();
  await page.locator(`.desk-window[data-window-id="${base64Id}"] .desk-window-title`).focus();
  await page.keyboard.press("Alt+Shift+ArrowDown");

  await page.waitForFunction((key) => {
    const layout = JSON.parse(localStorage.getItem(key) ?? "null");
    return layout?.windows?.some((record: { slug: string; mode: string }) => record.slug === "base64-encoder" && record.mode === "minimized")
      && layout.windows.some((record: { slug: string; dock?: string }) => record.slug === "uuid-generator" && record.dock === "left");
  }, LAYOUT_KEY);

  await page.reload({ waitUntil: "domcontentloaded" });
  const uuidFrame = page.locator('iframe[data-tool-slug="uuid-generator"]');
  await expect(uuidFrame).toHaveAttribute("src", /uuid-generator\/\?embed=1$/);
  const box = await uuidFrame.locator("xpath=ancestor::article[contains(@class,'desk-window')]").boundingBox();
  // Docked left: flush with the stage edge, give or take the dock gutter.
  expect(box?.x ?? -1).toBeLessThanOrEqual(12);

  const base64Frame = page.locator('iframe[data-tool-slug="base64-encoder"]');
  await expect(base64Frame).toBeAttached();
  await expect(base64Frame).not.toHaveAttribute("src", /./);
  await page.locator(".desk-task.is-running", { hasText: "Base64" }).click();
  await expect(base64Frame).toHaveAttribute("src", /base64-encoder\/\?embed=1$/);
  await expect(page.frameLocator('iframe[data-tool-slug="base64-encoder"]').locator("main.tool")).toBeAttached();
});

test("desktop hotkeys work while focus is inside a tool iframe", async ({ page }) => {
  await openDesk(page);
  await launch(page, "Base64", "base64-encoder");
  await launch(page, "UUID", "uuid-generator");

  const base64 = page.frameLocator('iframe[data-tool-slug="base64-encoder"]');
  await activate(page, "base64-encoder");
  await base64.locator("textarea.enc-input").focus();

  // Ctrl/⌘+K from a text field inside the frame opens the shell launcher.
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator("[data-catalog-dialog]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-catalog-dialog]")).not.toBeVisible();

  // Window switching from inside the frame activates the other window.
  await base64.locator("textarea.enc-input").focus();
  await page.keyboard.press(`${ALT}+Backquote`);
  const active = page.locator(".desk-window.is-active iframe");
  await expect(active).toHaveAttribute("data-tool-slug", "uuid-generator");

  // Alt+Shift+arrows stay with the text field (word selection), and dock outside it.
  await page.keyboard.press(`${ALT}+Backquote`);
  await expect(active).toHaveAttribute("data-tool-slug", "base64-encoder");
  await base64.locator("textarea.enc-input").focus();
  await page.keyboard.press("Alt+Shift+ArrowUp");
  await expect(page.locator(".desk-window.is-active")).not.toHaveClass(/is-max/);
  // Leave the field: keyboard focus stays in the frame, on its body.
  await base64.locator("textarea.enc-input").evaluate((field: HTMLTextAreaElement) => field.blur());
  await page.keyboard.press("Alt+Shift+ArrowUp");
  await expect(page.locator(".desk-window.is-active")).toHaveClass(/is-max/);
});

test("shortcut changes saved in another tab reach this one", async ({ page, context }) => {
  await openDesk(page);
  const before = await page.locator("[data-desk-icons] .desk-icon").count();
  const other = await context.newPage();
  await openDesk(other);
  // A fresh desk writes its preferences on the first change; Apply in settings saves the defaults.
  await other.locator("[data-desk-settings]").click();
  await other.locator("[data-settings-apply]").click();
  await other.waitForFunction((key) => localStorage.getItem(key) !== null, PREFS_KEY);
  await other.evaluate((key) => {
    const prefs = JSON.parse(localStorage.getItem(key)!);
    prefs.shortcuts = prefs.shortcuts.slice(1);
    localStorage.setItem(key, JSON.stringify(prefs));
  }, PREFS_KEY);
  await expect(page.locator("[data-desk-icons] .desk-icon")).toHaveCount(before - 1);
});

test("broken saved layout still opens the desk", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "{not json"), LAYOUT_KEY);
  const errors: string[] = [];
  await openDesk(page, errors);
  await expect(visibleWindows(page)).toHaveCount(0);
  expect(errors, errors.join("\n")).toEqual([]);
});

test("a tool page that fails to load offers a retry inside its window", async ({ page }) => {
  let fail = true;
  await page.route("**/en/uuid-generator/?embed=1", (route) =>
    fail ? route.fulfill({ status: 404, contentType: "text/html", body: "<!doctype html><title>Not found</title><p>Gone</p>" }) : route.fallback(),
  );
  await openDesk(page);
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator("[data-catalog-input]").fill("UUID");
  await page.locator("[data-catalog-input]").press("Enter");
  const error = page.locator(".desk-window:not([hidden]) .desk-frame-error");
  await expect(error).toBeVisible();
  fail = false;
  await error.locator("button").click();
  await expect(error).toBeHidden();
  await expect(page.frameLocator('iframe[data-tool-slug="uuid-generator"]').locator("main.tool")).toBeAttached();
});
