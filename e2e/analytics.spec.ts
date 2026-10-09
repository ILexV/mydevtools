import { test, expect, type Page, type Route } from "@playwright/test";

// Run against a dist built with the same ANALYTICS_ENABLED value as this command.
const enabled = process.env.ANALYTICS_ENABLED === "true";
const endpoint = "**/api/analytics/event";
type CapturedEvent = { body: unknown; headers: Record<string, string> };

async function collect(page: Page, respond: (route: Route) => Promise<void> = (route) => route.fulfill({ status: 204 })) {
  const events: CapturedEvent[] = [];
  await page.route(endpoint, async (route) => {
    events.push({ body: route.request().postDataJSON(), headers: await route.request().allHeaders() });
    await respond(route);
  });
  return events;
}

async function openFormatter(page: Page) {
  await page.goto("/en/json-beautifier/", { waitUntil: "networkidle" });
  await expect(page.locator("[data-json-editor] .cm-content")).toBeVisible();
}

async function enterJson(page: Page, value: string) {
  const editor = page.locator("[data-json-editor] .cm-content");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(value);
}

async function settled(page: Page) {
  // Let input/change handlers and their microtasks finish, without a timer race.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

// Requests are independent; delivery order is not an analytics guarantee.
function orderedBodies(events: CapturedEvent[]) {
  return events.map((entry) => entry.body).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

const success = [
  { tool: "json-beautifier", event: "tool_completed" },
  { tool: "json-beautifier", event: "tool_started" },
];

test("analytics — explicit processing is opt-in; private input never enters requests", async ({ page, context }) => {
  await context.addCookies([{ name: "private-session", value: "must-not-leave-browser", url: "http://localhost:4123" }]);
  const events = await collect(page);
  await openFormatter(page);
  await settled(page);
  expect(events).toEqual([]);

  await page.locator("[data-json-format]").click();
  await settled(page);
  expect(events).toEqual([]); // Empty input fails local preflight.

  await enterJson(page, '{"secret":"PRIVATE_TOKEN_123","filename":"private.txt","url":"https://private.example/"}');
  await page.locator("[data-json-indent]").selectOption("2");
  await settled(page);
  expect(events).toEqual([]); // Typing and automatic settings formatting are not launches.

  await page.locator("[data-json-format]").click();
  await expect(page.locator("[data-json-editor] .cm-content")).toContainText('"secret": "PRIVATE_TOKEN_123"');
  if (enabled) {
    await expect.poll(() => orderedBodies(events)).toEqual(success);
    for (const event of events) {
      expect(event.headers.cookie).toBeUndefined();
      expect(event.headers.referer).toBeUndefined();
      expect(JSON.stringify(event.body)).not.toContain("PRIVATE_TOKEN_123");
      expect(JSON.stringify(event.body)).not.toContain("private.txt");
      expect(JSON.stringify(event.body)).not.toContain("private.example");
    }
  } else {
    await settled(page);
    expect(events).toEqual([]);
  }
});

test.describe("enabled analytics", () => {
  test.skip(!enabled, "Requires ANALYTICS_ENABLED=true for both the site build and the test command.");

  test("processing errors send failed, not completed; repeat actions are counted separately", async ({ page }) => {
    const events = await collect(page);
    await openFormatter(page);
    await enterJson(page, '{"private":"SECRET_ERROR_DATA",}');
    await page.locator("[data-json-format]").click();
    await expect(page.locator("[data-json-error]")).toBeVisible();
    const failure = [
      { tool: "json-beautifier", event: "tool_failed" },
      { tool: "json-beautifier", event: "tool_started" },
    ];
    await expect.poll(() => orderedBodies(events)).toEqual(failure);
    await page.locator("[data-json-format]").click();
    await expect.poll(() => orderedBodies(events)).toEqual([...failure, ...failure].sort((a, b) => a.event.localeCompare(b.event)));
  });

  for (const status of [429, 500]) {
    test(`${status} telemetry responses cannot break successful processing or cause retries`, async ({ page }) => {
      const events = await collect(page, (route) => route.fulfill({ status, body: "unavailable" }));
      await openFormatter(page);
      await enterJson(page, '{"ok":true}');
      await page.locator("[data-json-format]").click();
      await expect(page.locator("[data-json-editor] .cm-content")).toContainText('"ok": true');
      await expect(page.locator("[data-json-error]")).toBeHidden();
      await expect.poll(() => orderedBodies(events)).toEqual(success);
      await settled(page);
      expect(events).toHaveLength(2);
    });
  }

  test("a pending telemetry request times out without delaying the result", async ({ page }) => {
    const failures: string[] = [];
    page.on("requestfailed", (request) => {
      if (request.url().endsWith("/api/analytics/event")) failures.push(request.url());
    });
    const events = await collect(page, async () => { /* Deliberately no response: exercise AbortController. */ });
    await openFormatter(page);
    await enterJson(page, '{"ok":true}');
    await page.locator("[data-json-format]").click();
    await expect(page.locator("[data-json-editor] .cm-content")).toContainText('"ok": true', { timeout: 1000 });
    await expect.poll(() => orderedBodies(events)).toEqual(success);
    await expect.poll(() => failures.length, { timeout: 6000 }).toBe(2);
  });

  test("offline processing remains usable and events are lost rather than queued", async ({ page, context }) => {
    const events = await collect(page);
    await openFormatter(page);
    await context.setOffline(true);
    await enterJson(page, '{"offline":true}');
    await page.locator("[data-json-format]").click();
    await expect(page.locator("[data-json-editor] .cm-content")).toContainText('"offline": true');
    await context.setOffline(false);
    await settled(page);
    expect(events).toEqual([]);
  });

  for (const signal of ["doNotTrack", "globalPrivacyControl"] as const) {
    test(`${signal} disables telemetry without disabling tools`, async ({ page }) => {
      await page.addInitScript((property) => {
        Object.defineProperty(navigator, property, { configurable: true, get: () => property === "doNotTrack" ? "1" : true });
      }, signal);
      const events = await collect(page);
      await openFormatter(page);
      await enterJson(page, '{"private":true}');
      await page.locator("[data-json-format]").click();
      await expect(page.locator("[data-json-editor] .cm-content")).toContainText('"private": true');
      await settled(page);
      expect(events).toEqual([]);
    });
  }
});
