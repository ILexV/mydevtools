import type { LocaleCode } from "../../registry/locales.ts";
import type { ToolId } from "../../registry/tools.ts";
import {
  ANALYTICS_REPORT_ENDPOINT,
  REPORT_PERIODS,
  type AnalyticsReport,
  type DailyOperationCounts,
  type OperationCounts,
  type ReportPeriod,
  type ToolOperationCounts,
} from "./reports.ts";

interface AdminLocale {
  code: LocaleCode;
  nativeName: string;
  bcp47: string;
  dir: "ltr" | "rtl";
}

interface AdminClientData {
  defaultLocale: LocaleCode;
  locales: AdminLocale[];
  strings: Record<LocaleCode, Record<string, string>>;
  toolTitles: Record<LocaleCode, Partial<Record<ToolId, string>>>;
  homePaths: Record<LocaleCode, string>;
}

type ReportState = "loading" | "auth" | "configuration" | "upstream" | "network" | "timeout" | "empty";

const REQUEST_TIMEOUT_MS = 15_000;
const SVG_NS = "http://www.w3.org/2000/svg";
const DEFAULT_PERIOD: ReportPeriod = 30;

class HttpReportError extends Error {
  constructor(readonly status: number) {
    super(`Report request failed with HTTP ${status}`);
  }
}

let initialized = false;
let data: AdminClientData;
let locale: LocaleCode;
let period: ReportPeriod;
let currentReport: AnalyticsReport | null = null;
let currentState: ReportState = "loading";
let currentController: AbortController | null = null;
let requestSequence = 0;
let countFormat: Intl.NumberFormat;
let fullDayFormat: Intl.DateTimeFormat;
let shortDayFormat: Intl.DateTimeFormat;
let generatedAtFormat: Intl.DateTimeFormat;


function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing analytics element: ${id}`);
  return element as T;
}

function svgById(id: string): SVGSVGElement {
  const element = document.getElementById(id);
  if (!(element instanceof SVGSVGElement)) throw new Error(`Missing analytics SVG: ${id}`);
  return element;
}

function parseClientData(): AdminClientData {
  const source = document.getElementById("admin-analytics-data");
  if (!(source instanceof HTMLScriptElement) || !source.textContent) throw new Error("Missing analytics localization data");
  return JSON.parse(source.textContent) as AdminClientData;
}

function isLocale(value: string | null): value is LocaleCode {
  return value !== null && data.locales.some((entry) => entry.code === value);
}

function isPeriod(value: string | null): value is `${ReportPeriod}` {
  return value !== null && REPORT_PERIODS.some((entry) => String(entry) === value);
}

function tr(key: string, params: Record<string, string | number> = {}): string {
  const template = data.strings[locale]?.[key] ?? data.strings[data.defaultLocale]?.[key] ?? key;
  return Object.entries(params).reduce(
    (result, [name, value]) => result.replaceAll(`{${name}}`, String(value)),
    template,
  );
}

function configureFormatters(language: string): void {
  countFormat = new Intl.NumberFormat(language, { maximumFractionDigits: 2 });
  fullDayFormat = new Intl.DateTimeFormat(language, {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  shortDayFormat = new Intl.DateTimeFormat(language, {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  });
  generatedAtFormat = new Intl.DateTimeFormat(language, {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatCount(value: number): string {
  return countFormat.format(value);
}

function formatDate(day: string, short = false): string {
  return (short ? shortDayFormat : fullDayFormat).format(new Date(`${day}T00:00:00Z`));
}

function formatGeneratedAt(value: string): string {
  return generatedAtFormat.format(new Date(value));
}

function setUrlSetting(name: "lang" | "days", value: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set(name, value);
  history.replaceState(history.state, "", url);
}

function updatePeriodControls(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-period]").forEach((button) => {
    const selected = button.dataset.period === String(period);
    button.classList.toggle("on", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function updateThemeLabel(): void {
  const button = byId<HTMLButtonElement>("admin-theme");
  const isDark = document.documentElement.dataset.theme === "dark";
  const label = tr(isDark ? "ThemeLight" : "ThemeDark");
  button.setAttribute("aria-label", label);
  button.title = label;
}

function applyLocale(nextLocale: LocaleCode): void {
  locale = nextLocale;
  const meta = data.locales.find((entry) => entry.code === locale);
  configureFormatters(meta?.bcp47 ?? locale);
  document.documentElement.lang = meta?.bcp47 ?? locale;
  document.documentElement.dir = meta?.dir ?? "ltr";
  document.title = `${tr("Title")} — MyDevTools`;

  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
    const key = element.dataset.i18n;
    if (key) element.textContent = tr(key);
  });

  const localeSelect = byId<HTMLSelectElement>("admin-locale");
  localeSelect.value = locale;
  localeSelect.setAttribute("aria-label", tr("Language"));
  const home = byId<HTMLAnchorElement>("admin-home");
  home.href = data.homePaths[locale];
  home.setAttribute("aria-label", tr("Home"));
  byId<HTMLAnchorElement>("admin-logout").textContent = tr("Logout");
  byId<HTMLButtonElement>("admin-refresh").textContent = tr("Refresh");
  byId<HTMLAnchorElement>("report-sign-in").textContent = tr("SignIn");
  byId<HTMLButtonElement>("report-retry").textContent = tr("Retry");
  updateThemeLabel();

  if (currentReport && currentState !== "empty") renderReport(currentReport);
  else renderState(currentState);
}

function renderState(state: ReportState): void {
  currentState = state;
  const container = byId<HTMLElement>("report-state");
  const dashboard = byId<HTMLElement>("report-dashboard");
  const spinner = byId<HTMLElement>("report-state-spinner");
  const signIn = byId<HTMLAnchorElement>("report-sign-in");
  const retry = byId<HTMLButtonElement>("report-retry");
  const title = byId<HTMLElement>("report-state-title");
  const message = byId<HTMLElement>("report-state-message");
  const keys: Record<ReportState, [string, string]> = {
    loading: ["LoadingTitle", "LoadingMessage"],
    auth: ["AuthTitle", "AuthMessage"],
    configuration: ["ConfigTitle", "ConfigMessage"],
    upstream: ["UpstreamTitle", "UpstreamMessage"],
    network: ["NetworkTitle", "NetworkMessage"],
    timeout: ["TimeoutTitle", "TimeoutMessage"],
    empty: ["EmptyTitle", "EmptyMessage"],
  };

  currentReport = state === "empty" ? currentReport : null;
  container.hidden = false;
  dashboard.hidden = true;
  spinner.hidden = state !== "loading";
  signIn.hidden = state !== "auth";
  retry.hidden = state === "loading" || state === "auth" || state === "empty";
  title.textContent = tr(keys[state][0]);
  message.textContent = tr(keys[state][1]);

  if (state === "auth") {
    const target = new URL(window.location.href);
    target.hash = "";
    signIn.href = target.toString();
  }
}

function setRequestBusy(busy: boolean): void {
  const refresh = byId<HTMLButtonElement>("admin-refresh");
  refresh.disabled = busy;
  refresh.setAttribute("aria-busy", String(busy));
}

function createSvg<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

function appendSvgText(parent: SVGElement, text: string, attributes: Record<string, string>): void {
  const element = createSvg("text", attributes);
  element.textContent = text;
  parent.append(element);
}

function renderChart(entries: DailyOperationCounts[]): void {
  const svg = svgById("activity-chart");
  svg.replaceChildren();

  const title = createSvg("title", { id: "activity-chart-title" });
  title.textContent = tr("ChartLabel");
  const descriptions = entries.map((entry) => tr("ChartPoint", {
    day: formatDate(entry.day),
    started: formatCount(entry.started),
    completed: formatCount(entry.completed),
    failed: formatCount(entry.failed),
  }));
  const desc = createSvg("desc", { id: "activity-chart-desc" });
  desc.textContent = `${tr("ActivityDescription")} ${descriptions.join(". ")}`;
  svg.append(title, desc);
  if (entries.length === 0) return;


  const width = 760;
  const height = 280;
  const margin = { top: 18, right: 18, bottom: 38, left: 64 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const maximum = Math.max(1, ...entries.flatMap((entry) => [entry.started, entry.completed, entry.failed]));
  const timestamps = entries.map((entry) => Date.parse(`${entry.day}T00:00:00Z`));
  const minTime = Math.min(...timestamps);
  const maxTime = Math.max(...timestamps);
  const xFor = (index: number): number => maxTime === minTime
    ? margin.left + plotWidth / 2
    : margin.left + ((timestamps[index] - minTime) / (maxTime - minTime)) * plotWidth;
  const yFor = (value: number): number => margin.top + plotHeight - (value / maximum) * plotHeight;

  const grid = createSvg("g", { "aria-hidden": "true" });
  for (const fraction of [0, 0.5, 1]) {
    const y = margin.top + plotHeight - fraction * plotHeight;
    grid.append(createSvg("line", {
      x1: String(margin.left), y1: String(y), x2: String(width - margin.right), y2: String(y),
      stroke: "var(--mdt-border)", "stroke-width": "1",
    }));
    appendSvgText(grid, formatCount(maximum * fraction), {
      x: String(margin.left - 10), y: String(y + 4), "text-anchor": "end",
      fill: "currentColor", "font-size": "11", "font-family": "var(--mdt-font-mono)",
    });
  }
  svg.append(grid);

  const labelIndexes = [...new Set([0, Math.floor((entries.length - 1) / 2), entries.length - 1])];
  const labels = createSvg("g", { "aria-hidden": "true" });
  for (const index of labelIndexes) {
    appendSvgText(labels, formatDate(entries[index].day, true), {
      x: String(xFor(index)), y: String(height - 10), "text-anchor": index === 0 ? "start" : index === entries.length - 1 ? "end" : "middle",
      fill: "currentColor", "font-size": "11", "font-family": "var(--mdt-font-mono)",
    });
  }
  svg.append(labels);

  const series: Array<{ key: keyof OperationCounts; color: string }> = [
    { key: "started", color: "var(--mdt-accent)" },
    { key: "completed", color: "var(--mdt-success)" },
    { key: "failed", color: "var(--mdt-danger)" },
  ];
  for (const { key, color } of series) {
    const points = entries.map((entry, index) => `${xFor(index).toFixed(2)},${yFor(entry[key]).toFixed(2)}`);
    if (points.length > 1) {
      svg.append(createSvg("polyline", {
        points: points.join(" "), fill: "none", stroke: color, "stroke-width": "2.5",
        "stroke-linecap": "round", "stroke-linejoin": "round", "vector-effect": "non-scaling-stroke",
        "aria-hidden": "true",
      }));
    }
    entries.forEach((entry, index) => {
      const circle = createSvg("circle", {
        cx: String(xFor(index)), cy: String(yFor(entry[key])), r: entries.length > 45 ? "2" : "3",
        fill: color, stroke: "var(--mdt-surface-raised)", "stroke-width": "1.5", "aria-hidden": "true",
      });
      const pointTitle = createSvg("title");
      pointTitle.textContent = tr("ChartPoint", {
        day: formatDate(entry.day),
        started: formatCount(entry.started),
        completed: formatCount(entry.completed),
        failed: formatCount(entry.failed),
      });
      circle.append(pointTitle);
      svg.append(circle);
    });
  }
}

function toolTitle(tool: ToolId): string {
  return data.toolTitles[locale]?.[tool] ?? tr("UnknownTool", { tool });
}

function appendCell(row: HTMLTableRowElement, value: string, labelKey: string): void {
  const cell = document.createElement("td");
  cell.dataset.label = tr(labelKey);
  cell.textContent = value;
  row.append(cell);
}

function renderTools(tools: ToolOperationCounts[]): void {
  const body = byId<HTMLTableSectionElement>("tools-body");
  body.replaceChildren();
  const ranked = [...tools]
    .filter((tool) => tool.started > 0 || tool.completed > 0 || tool.failed > 0)
    .sort((a, b) => b.completed - a.completed || b.started - a.started || b.failed - a.failed || a.tool.localeCompare(b.tool));

  ranked.forEach((tool, index) => {
    const row = document.createElement("tr");
    appendCell(row, formatCount(index + 1), "Rank");
    appendCell(row, toolTitle(tool.tool), "Tool");
    appendCell(row, formatCount(tool.started), "Starts");
    appendCell(row, formatCount(tool.completed), "Successes");
    appendCell(row, formatCount(tool.failed), "Failures");
    body.append(row);
  });
}

function renderReport(report: AnalyticsReport): void {
  currentReport = report;
  const state = byId<HTMLElement>("report-state");
  const dashboard = byId<HTMLElement>("report-dashboard");
  state.hidden = true;
  dashboard.hidden = false;

  byId<HTMLElement>("summary-started").textContent = formatCount(report.summary.started);
  byId<HTMLElement>("summary-completed").textContent = formatCount(report.summary.completed);
  byId<HTMLElement>("summary-failed").textContent = formatCount(report.summary.failed);
  const generated = byId<HTMLTimeElement>("report-generated");
  generated.dateTime = report.generatedAt;
  generated.textContent = formatGeneratedAt(report.generatedAt);
  byId<HTMLElement>("report-dataset").textContent = tr(
    report.dataset === "mydevtools_tool_usage_staging" ? "DatasetStaging" : "DatasetProduction",
  );

  const sampled = report.maximumSampleInterval > 1;
  const estimateBadge = byId<HTMLElement>("report-estimate-badge");
  const estimateNote = byId<HTMLElement>("report-estimate-note");
  estimateBadge.hidden = !sampled;
  estimateBadge.textContent = tr("WeightedEstimate");
  estimateNote.hidden = !sampled;
  estimateNote.textContent = sampled ? tr("EstimateNote", { interval: formatCount(report.maximumSampleInterval) }) : "";

  const lastDay = new Date(report.generatedAt);
  lastDay.setUTCHours(0, 0, 0, 0);
  const firstDay = new Date(lastDay);
  firstDay.setUTCDate(firstDay.getUTCDate() - report.periodDays);
  const byDay = new Map(report.daily.map((entry) => [entry.day, entry]));
  const daily: DailyOperationCounts[] = [];
  for (let timestamp = firstDay.getTime(); timestamp <= lastDay.getTime(); timestamp += 86_400_000) {
    const day = new Date(timestamp).toISOString().slice(0, 10);
    daily.push(byDay.get(day) ?? { day, started: 0, completed: 0, failed: 0 });
  }
  renderChart(daily);
  renderTools(report.tools);
}

function clearMetrics(): void {
  currentReport = null;
  for (const id of ["summary-started", "summary-completed", "summary-failed"]) byId<HTMLElement>(id).textContent = "0";
  const generated = byId<HTMLTimeElement>("report-generated");
  generated.textContent = "";
  generated.dateTime = "";
  byId<HTMLElement>("report-dataset").textContent = "";
  byId<HTMLElement>("report-estimate-note").textContent = "";
  byId<HTMLTableSectionElement>("tools-body").replaceChildren();
  svgById("activity-chart").replaceChildren();
  byId<HTMLElement>("report-dashboard").hidden = true;
}

function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseCounts(value: unknown): OperationCounts | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as { started?: unknown; completed?: unknown; failed?: unknown };
  if (!isNonnegativeNumber(candidate.started) || !isNonnegativeNumber(candidate.completed) || !isNonnegativeNumber(candidate.failed)) return null;
  return { started: candidate.started, completed: candidate.completed, failed: candidate.failed };
}

function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseReport(value: unknown, expectedPeriod: ReportPeriod): AnalyticsReport | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as {
    periodDays?: unknown;
    generatedAt?: unknown;
    dataset?: unknown;
    summary?: unknown;
    tools?: unknown;
    daily?: unknown;
    maximumSampleInterval?: unknown;
  };
  if (candidate.periodDays !== expectedPeriod || typeof candidate.generatedAt !== "string" || !candidate.generatedAt.endsWith("Z")) return null;
  if (!Number.isFinite(Date.parse(candidate.generatedAt))) return null;
  if (candidate.dataset !== "mydevtools_tool_usage" && candidate.dataset !== "mydevtools_tool_usage_staging") return null;
  if (!isNonnegativeNumber(candidate.maximumSampleInterval)) return null;
  const summary = parseCounts(candidate.summary);
  if (!summary || !Array.isArray(candidate.tools) || !Array.isArray(candidate.daily)) return null;

  const tools: ToolOperationCounts[] = [];
  for (const item of candidate.tools) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const tool = item as { tool?: unknown; maximumSampleInterval?: unknown };
    const counts = parseCounts(item);
    if (!counts || typeof tool.tool !== "string" || !isNonnegativeNumber(tool.maximumSampleInterval) || tool.maximumSampleInterval < 1) return null;
    tools.push({ tool: tool.tool as ToolId, ...counts, maximumSampleInterval: tool.maximumSampleInterval });
  }
  const daily: DailyOperationCounts[] = [];
  for (const item of candidate.daily) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const dailyItem = item as { day?: unknown };
    const counts = parseCounts(item);
    if (!counts || !validDay(dailyItem.day)) return null;
    daily.push({ day: dailyItem.day, ...counts });
  }

  return {
    periodDays: expectedPeriod,
    generatedAt: candidate.generatedAt,
    dataset: candidate.dataset,
    summary,
    tools,
    daily,
    maximumSampleInterval: candidate.maximumSampleInterval,
  };
}

async function loadReport(): Promise<void> {
  const requestedPeriod = period;
  const sequence = ++requestSequence;
  currentController?.abort();
  const controller = new AbortController();
  currentController = controller;
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  clearMetrics();
  renderState("loading");
  setRequestBusy(true);

  try {
    const response = await fetch(`${ANALYTICS_REPORT_ENDPOINT}?days=${requestedPeriod}`, {
      method: "POST",
      body: null,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new HttpReportError(response.status);
    const report = parseReport(await response.json(), requestedPeriod);
    if (!report) throw new Error("Invalid analytics report response");
    if (sequence !== requestSequence) return;
    if (report.summary.started === 0 && report.summary.completed === 0 && report.summary.failed === 0) {
      currentReport = report;
      renderState("empty");
    } else {
      renderReport(report);
    }
  } catch (error) {
    if (sequence !== requestSequence) return;
    if (error instanceof DOMException && error.name === "AbortError" && !timedOut) return;
    if (timedOut) renderState("timeout");
    else if (error instanceof HttpReportError) {
      if (error.status === 401 || error.status === 403) renderState("auth");
      else if (error.status === 503) renderState("configuration");
      else if (error.status === 504) renderState("timeout");
      else renderState("upstream");
    } else if (!navigator.onLine) renderState("network");
    else if (error instanceof TypeError) renderState("auth");
    else renderState("upstream");
  } finally {
    window.clearTimeout(timeout);
    if (sequence === requestSequence) {
      currentController = null;
      setRequestBusy(false);
    }
  }
}

function bindEvents(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-period]").forEach((button) => {
    button.addEventListener("click", () => {
      const value = button.dataset.period ?? null;
      if (!isPeriod(value)) return;
      period = Number(value) as ReportPeriod;
      setUrlSetting("days", value);
      updatePeriodControls();
      void loadReport();
    });
  });

  byId<HTMLButtonElement>("admin-refresh").addEventListener("click", () => void loadReport());
  byId<HTMLButtonElement>("report-retry").addEventListener("click", () => void loadReport());
  byId<HTMLSelectElement>("admin-locale").addEventListener("change", (event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (!isLocale(value)) return;
    setUrlSetting("lang", value);
    applyLocale(value);
  });
  byId<HTMLButtonElement>("admin-theme").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch {}
    updateThemeLabel();
  });
  byId<HTMLAnchorElement>("admin-logout").addEventListener("click", () => {
    currentController?.abort();
    requestSequence += 1;
    clearMetrics();
  });
  window.addEventListener("pagehide", () => {
    currentController?.abort();
    currentController = null;
    requestSequence += 1;
    clearMetrics();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) void loadReport();
  });
}

export function initAdminAnalytics(): void {
  if (initialized) return;
  const root = document.getElementById("admin-analytics");
  if (!(root instanceof HTMLElement)) return;
  initialized = true;
  data = parseClientData();
  const search = new URLSearchParams(window.location.search);
  const requestedLocale = search.get("lang");
  const requestedPeriod = search.get("days");
  locale = isLocale(requestedLocale) ? requestedLocale : data.defaultLocale;
  period = isPeriod(requestedPeriod) ? Number(requestedPeriod) as ReportPeriod : DEFAULT_PERIOD;
  setUrlSetting("lang", locale);
  setUrlSetting("days", String(period));
  updatePeriodControls();
  bindEvents();
  applyLocale(locale);
  void loadReport();
}
