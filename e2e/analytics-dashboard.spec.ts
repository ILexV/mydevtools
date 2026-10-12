import { test, expect, type Page } from "@playwright/test";
import { TOOLS } from "../apps/site/src/registry/tools";
import { DURATION_BUCKETS, TOOL_ERROR_CATEGORIES, VOTE_CHOICES } from "../apps/site/src/scripts/analytics/events";
import type { AnalyticsReport } from "../apps/site/src/scripts/analytics/reports";

const dayMs = 86_400_000;
const counts = (total = 0) => ({ started: total, completed: total, failed: 0, cancelled: 0 });
const durations = (total = 0) => Object.fromEntries([...DURATION_BUCKETS, "unclassified"].map((key) => [key, key === "lt_100ms" ? total : 0]));
const errors = () => Object.fromEntries([...TOOL_ERROR_CATEGORIES, "unclassified"].map((key) => [key, 0]));

function metrics(total = 0, sampling = 1) {
  return {
    summary: counts(total),
    tools: TOOLS.map(({ slug }) => {
      const value = slug === "word-counter" ? total : 0;
      return { tool: slug, ...counts(value), maximumSampleInterval: value ? sampling : 0, durations: durations(value), errors: errors() };
    }),
    durations: durations(total),
    errors: errors(),
    votes: VOTE_CHOICES.map(({ id }) => ({ choice: id, votes: 0, maximumSampleInterval: 0 })),
    maximumSampleInterval: total ? sampling : 0,
  };
}

function fixture(rangeTo = "2026-10-12T12:00:00.000Z", previous = metrics()): AnalyticsReport {
  const end = Date.parse(rangeTo);
  const rangeFrom = new Date(end - 7 * dayMs).toISOString();
  const daily = [];
  for (let time = Date.parse(rangeFrom.slice(0, 10)); time < end; time += dayMs) {
    daily.push({ day: new Date(time).toISOString().slice(0, 10), ...counts(daily.length === 0 ? 3 : 0) });
  }
  return {
    ...metrics(3),
    periodDays: 7,
    generatedAt: rangeTo,
    dataset: "mydevtools_tool_usage_staging",
    rangeFrom,
    rangeTo,
    daily,
    comparison: { ...previous, periodDays: 7, rangeFrom: new Date(end - 14 * dayMs).toISOString(), rangeTo: rangeFrom },
  };
}

async function openDashboard(
  page: Page,
  report: AnalyticsReport,
  provisional = false,
  historicalMetrics: object = metrics(),
) {
  const history = {
    generatedAt: report.generatedAt,
    dataset: report.dataset,
    year: 2026,
    years: provisional ? [2026] : [],
    months: provisional ? [{ ...historicalMetrics, month: "2026-09", complete: false, generatedAt: "2026-09-30T23:00:00.000Z", dataset: report.dataset }] : [],
  };
  await page.route("**/api/analytics/reports/summary**", (route) => route.fulfill({ json: report }));
  await page.route("**/api/analytics/reports/history**", (route) => route.fulfill({ json: history }));
  await page.goto("/admin/analytics/?lang=en&days=7&year=2026");
}

test("analytics dashboard accepts a half-open period ending exactly at UTC midnight", async ({ page }) => {
  await openDashboard(page, fixture("2026-10-12T00:00:00.000Z"));
  await expect(page.locator("#summary-completed")).toHaveText("3");
  await expect(page.locator("#tools-body .tool-row").first()).toBeVisible();
});

test("analytics dashboard retains provisional history across a month boundary", async ({ page }) => {
  await openDashboard(page, fixture(), true);
  await expect(page.locator("#summary-completed")).toHaveText("3");
  await expect(page.locator("#history-months .history-month")).toBeVisible();
  await expect(page.locator("#archive-refresh")).toBeEnabled();
});

test("analytics dashboard keeps retired historical catalogs and vote totals available", async ({ page }) => {
  const historicalMetrics = {
    summary: counts(4),
    tools: [{
      tool: "retired-tool",
      ...counts(4),
      maximumSampleInterval: 3,
      durations: durations(4),
      errors: errors(),
    }],
    durations: durations(4),
    errors: errors(),
    votes: [{ choice: "retired-proposal", votes: 7, maximumSampleInterval: 2 }],
    maximumSampleInterval: 3,
  };

  await openDashboard(page, fixture(), true, historicalMetrics);

  await expect(page.locator("#report-dashboard")).toBeVisible();
  await expect(page.locator("#tools-body .tool-row").first()).toBeVisible();
  const historyMonth = page.locator("#history-months .history-month");
  await expect(historyMonth).toBeVisible();
  await historyMonth.locator("summary").click();
  const voteSection = historyMonth.locator(".history-month-details > .distribution").last();
  await expect(voteSection.locator(".distribution-label")).toHaveText("retired-proposal");
  await expect(voteSection.locator(".distribution-row .tabular")).toHaveText("7");
});

test("analytics comparison discloses sampling in an otherwise unsampled report", async ({ page }) => {
  await openDashboard(page, fixture(undefined, metrics(30, 10)));
  await expect(page.locator("#summary-completed")).toHaveText("3");
  await expect(page.locator("#comparison-completed")).toContainText("-27");
  await expect(page.locator("#report-estimate-badge")).toBeVisible();
});
