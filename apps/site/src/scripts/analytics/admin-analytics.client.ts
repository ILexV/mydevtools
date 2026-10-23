import type { LocaleCode } from "../../registry/locales.ts";
import type { ToolId } from "../../registry/tools.ts";
import {
  DESK_EVENT_PAIRS,
  DURATION_BUCKETS,
  TOOL_ERROR_CATEGORIES,
  VOTE_CHOICES,
  type DeskEventType,
} from "./events.ts";
import {
  ANALYTICS_ARCHIVE_ENDPOINT,
  ANALYTICS_HISTORY_ENDPOINT,
  ANALYTICS_REPORT_ENDPOINT,
  REPORT_PERIODS,
  type AnalyticsDataset,
  type AnalyticsHistory,
  type AnalyticsReport,
  type DailyOperationCounts,
  type DeskEventCounts,
  type MonthlyAnalyticsSnapshot,
  type OperationCounts,
  type PeriodMetrics,
  type ReportDurationBucket,
  type ReportErrorCategory,
  type ReportPeriod,
  type ToolOperationCounts,
  type VoteCounts,
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
  voteStrings: Record<LocaleCode, Record<string, string>>;
  toolTitles: Record<LocaleCode, Record<ToolId, string>>;
  homePaths: Record<LocaleCode, string>;
}


type ReportState = "loading" | "auth" | "configuration" | "upstream" | "network" | "timeout";
type CountKey = keyof OperationCounts;

const REQUEST_TIMEOUT_MS = 15_000;
const SVG_NS = "http://www.w3.org/2000/svg";
const DEFAULT_PERIOD: ReportPeriod = 30;
const COUNT_KEYS: CountKey[] = ["started", "completed", "failed", "cancelled"];
const REPORT_DURATION_BUCKETS: ReportDurationBucket[] = [...DURATION_BUCKETS, "unclassified"];
const REPORT_ERROR_CATEGORIES: ReportErrorCategory[] = [...TOOL_ERROR_CATEGORIES, "unclassified"];
const DATASETS: AnalyticsDataset[] = ["mydevtools_tool_usage", "mydevtools_tool_usage_staging"];
const PERIOD_METRIC_KEYS = ["summary", "tools", "durations", "errors", "votes", "desk", "maximumSampleInterval"] as const;
// A Worker deployed before desktop events omits `desk`; treat that as no desktop data.
const LEGACY_PERIOD_METRIC_KEYS = PERIOD_METRIC_KEYS.filter((key) => key !== "desk");
const DESK_EVENT_LABEL_KEYS: Record<DeskEventType, string> = {
  desk_opened: "DeskOpened",
  desk_windows: "DeskWindows",
  desk_transfer: "DeskTransfer",
  desk_workspace: "DeskWorkspace",
  desk_file_drop: "DeskFileDrop",
  desk_popout: "DeskPopout",
  desk_clipboard: "DeskClipboard",
  desk_launch: "DeskLaunch",
};
const DESK_DETAIL_LABEL_KEYS: Record<string, string> = {
  once: "DeskDetailOnce",
  link: "DeskDetailLink",
  builtin: "DeskDetailBuiltin",
  saved: "DeskDetailSaved",
  file_handler: "DeskDetailFileHandler",
  share_target: "DeskDetailShareTarget",
};
// Window-count buckets are numeric and need no translation.
const DESK_WINDOW_LABELS: Record<string, string> = { "1": "1", "2": "2", "3": "3", "4_5": "4–5", "6_plus": "6+" };
const DESK_EVENT_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const DESK_DETAIL_PATTERN = /^(?:[a-z0-9]+(?:_[a-z0-9]+)*)?$/;
const HISTORICAL_DESK_EVENT_MAX_LENGTH = 64;
const HISTORICAL_DESK_DETAIL_MAX_LENGTH = 32;
const CANONICAL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HISTORICAL_TOOL_ID_MAX_LENGTH = 96;
const HISTORICAL_VOTE_CHOICE_MAX_LENGTH = 91;

class HttpReportError extends Error {
  constructor(readonly status: number) {
    super(`Report request failed with HTTP ${status}`);
  }
}

class InvalidReportError extends Error {
  constructor() {
    super("Invalid analytics response");
  }
}

let initialized = false;
let data: AdminClientData;
let locale: LocaleCode;
let period: ReportPeriod;
let selectedYear: number;
let currentReport: AnalyticsReport | null = null;
let currentHistory: AnalyticsHistory | null = null;
let currentState: ReportState = "loading";
let currentController: AbortController | null = null;
let requestSequence = 0;
let countFormat: Intl.NumberFormat;
let percentFormat: Intl.NumberFormat;
let fullDayFormat: Intl.DateTimeFormat;
let shortDayFormat: Intl.DateTimeFormat;
let generatedAtFormat: Intl.DateTimeFormat;
let monthFormat: Intl.DateTimeFormat;

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function parseClientData(): AdminClientData {
  const source = document.getElementById("admin-analytics-data");
  if (!(source instanceof HTMLScriptElement) || !source.textContent) throw new Error("Missing analytics localization data");
  const parsed: unknown = JSON.parse(source.textContent);
  if (!isPlainObject(parsed)) throw new Error("Invalid analytics localization data");
  return parsed as unknown as AdminClientData;
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

function voteLabel(choice: string): string {
  const key = VOTE_CHOICES.find((entry) => entry.id === choice)?.labelKey;
  if (!key) return choice;
  return data.voteStrings[locale]?.[key] ?? data.voteStrings[data.defaultLocale]?.[key] ?? choice;
}

/** Retired (historical) desktop events and details fall back to their raw identifiers. */
function deskEventLabel(event: string): string {
  const key = DESK_EVENT_LABEL_KEYS[event as DeskEventType];
  return key ? tr(key) : event;
}

function deskDetailLabel(event: string, detail: string): string {
  if (detail === "") return "—";
  if (event === "desk_windows" && Object.hasOwn(DESK_WINDOW_LABELS, detail)) return DESK_WINDOW_LABELS[detail]!;
  const key = DESK_DETAIL_LABEL_KEYS[detail];
  return key ? tr(key) : detail;
}

function configureFormatters(language: string): void {
  countFormat = new Intl.NumberFormat(language, { maximumFractionDigits: 0 });
  percentFormat = new Intl.NumberFormat(language, { maximumFractionDigits: 1, signDisplay: "exceptZero" });
  fullDayFormat = new Intl.DateTimeFormat(language, { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
  shortDayFormat = new Intl.DateTimeFormat(language, { timeZone: "UTC", day: "numeric", month: "short" });
  generatedAtFormat = new Intl.DateTimeFormat(language, { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" });
  monthFormat = new Intl.DateTimeFormat(language, { timeZone: "UTC", month: "long", year: "numeric" });
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

function setUrlSetting(name: "lang" | "days" | "year", value: string): void {
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
  document.querySelectorAll<HTMLElement>("[data-i18n-aria]").forEach((element) => {
    const key = element.dataset.i18nAria;
    if (key) element.setAttribute("aria-label", tr(key));
  });

  const localeSelect = byId<HTMLSelectElement>("admin-locale");
  localeSelect.value = locale;
  localeSelect.setAttribute("aria-label", tr("Language"));
  const home = byId<HTMLAnchorElement>("admin-home");
  home.href = data.homePaths[locale];
  home.setAttribute("aria-label", tr("Home"));
  byId<HTMLAnchorElement>("admin-logout").textContent = tr("Logout");
  byId<HTMLButtonElement>("admin-refresh").textContent = tr("Refresh");
  byId<HTMLButtonElement>("archive-refresh").textContent = tr("ArchiveRefresh");
  byId<HTMLAnchorElement>("report-sign-in").textContent = tr("SignIn");
  byId<HTMLButtonElement>("report-retry").textContent = tr("Retry");
  updateThemeLabel();

  if (currentReport && currentHistory) {
    renderReport(currentReport);
    renderHistory(currentHistory);
  } else {
    renderState(currentState);
  }
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
  };

  container.hidden = false;
  dashboard.hidden = true;
  spinner.hidden = state !== "loading";
  signIn.hidden = state !== "auth";
  retry.hidden = state === "loading" || state === "auth";
  title.textContent = tr(keys[state][0]);
  message.textContent = tr(keys[state][1]);

  if (state === "auth") {
    const target = new URL(window.location.href);
    target.hash = "";
    signIn.href = target.toString();
  }
}

function setRequestBusy(busy: boolean): void {
  for (const id of ["admin-refresh", "archive-refresh"]) {
    const button = byId<HTMLButtonElement>(id);
    button.disabled = busy;
    button.setAttribute("aria-busy", String(busy));
  }
  byId<HTMLSelectElement>("history-year").disabled = busy;
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
    cancelled: formatCount(entry.cancelled),
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
  const maximum = Math.max(1, ...entries.flatMap((entry) => COUNT_KEYS.map((key) => entry[key])));
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

  const series: Array<{ key: CountKey; color: string }> = [
    { key: "started", color: "var(--mdt-accent)" },
    { key: "completed", color: "var(--mdt-success)" },
    { key: "failed", color: "var(--mdt-danger)" },
    { key: "cancelled", color: "var(--mdt-warning)" },
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
        cancelled: formatCount(entry.cancelled),
      });
      circle.append(pointTitle);
      svg.append(circle);
    });
  }
}

function durationLabel(bucket: ReportDurationBucket): string {
  const keys: Record<ReportDurationBucket, string> = {
    lt_100ms: "DurationLt100ms",
    "100ms_1s": "Duration100ms1s",
    "1s_5s": "Duration1s5s",
    "5s_30s": "Duration5s30s",
    gte_30s: "DurationGte30s",
    unclassified: "Unclassified",
  };
  return tr(keys[bucket]);
}

function errorLabel(category: ReportErrorCategory): string {
  const keys: Record<ReportErrorCategory, string> = {
    invalid_input: "ErrorInvalidInput",
    unsupported_format: "ErrorUnsupportedFormat",
    wasm_unavailable: "ErrorWasmUnavailable",
    processing_error: "ErrorProcessing",
    unclassified: "Unclassified",
  };
  return tr(keys[category]);
}

function createDistribution<K extends string>(
  title: string,
  counts: Record<K, number>,
  keys: readonly K[],
  labelFor: (key: K) => string,
  kind: "durations" | "errors",
): HTMLElement {
  const section = document.createElement("section");
  section.className = `distribution distribution-${kind}`;
  const heading = document.createElement("h3");
  heading.textContent = title;
  section.append(heading);
  const total = keys.reduce((sum, key) => sum + counts[key], 0);
  for (const key of keys) {
    const row = document.createElement("div");
    row.className = "distribution-row";
    const label = document.createElement("span");
    label.className = "distribution-label";
    label.textContent = labelFor(key);
    const track = document.createElement("span");
    track.className = "distribution-track";
    track.setAttribute("aria-hidden", "true");
    const fill = document.createElement("span");
    fill.className = "distribution-fill";
    fill.style.width = `${total === 0 ? 0 : Math.min(100, (counts[key] / total) * 100)}%`;
    track.append(fill);
    const count = document.createElement("span");
    count.className = "tabular";
    count.textContent = formatCount(counts[key]);
    row.append(label, track, count);
    section.append(row);
  }
  return section;
}

function renderGlobalDistributions(report: PeriodMetrics): void {
  byId("duration-distribution").replaceChildren(createDistribution(
    tr("DurationTitle"), report.durations, REPORT_DURATION_BUCKETS, durationLabel, "durations",
  ));
  byId("error-distribution").replaceChildren(createDistribution(
    tr("ErrorsTitle"), report.errors, REPORT_ERROR_CATEGORIES, errorLabel, "errors",
  ));
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
  const ranked = [...tools].sort((a, b) =>
    b.completed - a.completed || b.started - a.started || b.failed - a.failed || b.cancelled - a.cancelled || a.tool.localeCompare(b.tool));

  ranked.forEach((tool, index) => {
    const row = document.createElement("tr");
    row.className = "tool-row";
    appendCell(row, formatCount(index + 1), "Rank");
    appendCell(row, toolTitle(tool.tool), "Tool");
    appendCell(row, formatCount(tool.started), "Starts");
    appendCell(row, formatCount(tool.completed), "Successes");
    appendCell(row, formatCount(tool.failed), "Failures");
    appendCell(row, formatCount(tool.cancelled), "Cancellations");

    const detailRow = document.createElement("tr");
    detailRow.className = "tool-detail";
    const detailCell = document.createElement("td");
    detailCell.colSpan = 6;
    const detailGrid = document.createElement("div");
    detailGrid.className = "tool-detail-grid";
    detailGrid.append(
      createDistribution(tr("CompletedDurations"), tool.durations, REPORT_DURATION_BUCKETS, durationLabel, "durations"),
      createDistribution(tr("FailureCategories"), tool.errors, REPORT_ERROR_CATEGORIES, errorLabel, "errors"),
    );
    detailCell.append(detailGrid);
    detailRow.append(detailCell);
    body.append(row, detailRow);
  });
}

function renderVotes(votes: VoteCounts[]): void {
  const container = byId("vote-totals");
  container.replaceChildren();
  const ranked = [...votes].sort((a, b) => b.votes - a.votes || a.choice.localeCompare(b.choice));
  for (const vote of ranked) {
    const item = document.createElement("dl");
    item.className = "vote-total";
    const label = document.createElement("dt");
    label.textContent = voteLabel(vote.choice);
    const count = document.createElement("dd");
    count.className = "tabular";
    count.textContent = formatCount(vote.votes);
    item.append(label, count);
    container.append(item);
  }
}

function renderDesk(desk: DeskEventCounts[]): void {
  const body = byId<HTMLTableSectionElement>("desk-body");
  body.replaceChildren();
  for (const entry of desk) {
    const row = document.createElement("tr");
    appendCell(row, deskEventLabel(entry.event), "DeskEvent");
    appendCell(row, deskDetailLabel(entry.event, entry.detail), "DeskDetail");
    appendCell(row, formatCount(entry.count), "DeskCount");
    body.append(row);
  }
}

function renderComparison(report: AnalyticsReport): void {
  const comparison = report.comparison;
  for (const key of COUNT_KEYS) {
    const element = byId(`comparison-${key}`);
    if (!comparison) {
      element.textContent = tr("ComparisonUnavailable");
      continue;
    }
    const current = report.summary[key];
    const previous = comparison.summary[key];
    const delta = current - previous;
    const deltaText = delta > 0 ? `+${formatCount(delta)}` : formatCount(delta);
    const percent = previous === 0
      ? current === 0 ? percentFormat.format(0) + "%" : tr("ComparisonNoBaseline")
      : percentFormat.format((delta / previous) * 100) + "%";
    element.textContent = tr("ComparisonValue", {
      delta: deltaText,
      percent,
      previous: formatCount(previous),
    });
  }
  byId("comparison-note").textContent = comparison
    ? tr("ComparisonRange", { from: formatGeneratedAt(comparison.rangeFrom), to: formatGeneratedAt(comparison.rangeTo) })
    : tr("Comparison90Note");
}

function renderReport(report: AnalyticsReport): void {
  currentReport = report;
  for (const key of COUNT_KEYS) byId(`summary-${key}`).textContent = formatCount(report.summary[key]);
  const generated = byId<HTMLTimeElement>("report-generated");
  generated.dateTime = report.generatedAt;
  generated.textContent = formatGeneratedAt(report.generatedAt);
  byId("report-range").textContent = tr("CurrentRange", {
    from: formatGeneratedAt(report.rangeFrom),
    to: formatGeneratedAt(report.rangeTo),
  });
  byId("report-dataset").textContent = tr(
    report.dataset === "mydevtools_tool_usage_staging" ? "DatasetStaging" : "DatasetProduction",
  );

  const maximumSampleInterval = Math.max(report.maximumSampleInterval, report.comparison?.maximumSampleInterval ?? 0);
  const sampled = maximumSampleInterval > 1;
  const estimateBadge = byId("report-estimate-badge");
  const estimateNote = byId("report-estimate-note");
  estimateBadge.hidden = !sampled;
  estimateBadge.textContent = tr("WeightedEstimate");
  estimateNote.hidden = !sampled;
  estimateNote.textContent = sampled ? tr("EstimateNote", { interval: formatCount(maximumSampleInterval) }) : "";

  renderComparison(report);
  renderChart(report.daily);
  renderGlobalDistributions(report);
  renderTools(report.tools);
  renderVotes(report.votes);
  renderDesk(report.desk);
}

function renderHistoryDetails(snapshot: MonthlyAnalyticsSnapshot): HTMLElement {
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = tr("HistoryDetails");
  const content = document.createElement("div");
  content.className = "history-month-details";
  content.append(
    createDistribution(tr("CompletedDurations"), snapshot.durations, REPORT_DURATION_BUCKETS, durationLabel, "durations"),
    createDistribution(tr("FailureCategories"), snapshot.errors, REPORT_ERROR_CATEGORIES, errorLabel, "errors"),
  );
  const voteSection = document.createElement("section");
  voteSection.className = "distribution";
  const heading = document.createElement("h3");
  heading.textContent = tr("VotesTitle");
  voteSection.append(heading);
  for (const vote of snapshot.votes) {
    const row = document.createElement("div");
    row.className = "distribution-row";
    const label = document.createElement("span");
    label.className = "distribution-label";
    label.textContent = voteLabel(vote.choice);
    const spacer = document.createElement("span");
    const count = document.createElement("span");
    count.className = "tabular";
    count.textContent = formatCount(vote.votes);
    row.append(label, spacer, count);
    voteSection.append(row);
  }
  content.append(voteSection);
  if (snapshot.desk.length > 0) {
    const deskSection = document.createElement("section");
    deskSection.className = "distribution";
    const deskHeading = document.createElement("h3");
    deskHeading.textContent = tr("DeskTitle");
    deskSection.append(deskHeading);
    for (const entry of snapshot.desk) {
      const row = document.createElement("div");
      row.className = "distribution-row";
      const label = document.createElement("span");
      label.className = "distribution-label";
      label.textContent = deskEventLabel(entry.event);
      const detail = document.createElement("span");
      detail.className = "distribution-label";
      detail.textContent = deskDetailLabel(entry.event, entry.detail);
      const count = document.createElement("span");
      count.className = "tabular";
      count.textContent = formatCount(entry.count);
      row.append(label, detail, count);
      deskSection.append(row);
    }
    content.append(deskSection);
  }
  details.append(summary, content);
  return details;
}

function renderHistory(historyReport: AnalyticsHistory): void {
  currentHistory = historyReport;
  selectedYear = historyReport.year;
  setUrlSetting("year", String(selectedYear));
  const select = byId<HTMLSelectElement>("history-year");
  select.replaceChildren();
  const years = historyReport.years.includes(selectedYear)
    ? [...historyReport.years].sort((a, b) => b - a)
    : [...historyReport.years, selectedYear].sort((a, b) => b - a);
  for (const year of years) {
    const option = document.createElement("option");
    option.value = String(year);
    option.textContent = String(year);
    option.selected = year === selectedYear;
    select.append(option);
  }

  byId("history-generated").textContent = tr("HistoryGenerated", {
    generated: formatGeneratedAt(historyReport.generatedAt),
  });
  const container = byId("history-months");
  container.replaceChildren();
  const empty = byId("history-empty");
  empty.hidden = historyReport.months.length !== 0;

  for (const snapshot of [...historyReport.months].sort((a, b) => b.month.localeCompare(a.month))) {
    const article = document.createElement("article");
    article.className = "history-month";
    const head = document.createElement("div");
    head.className = "history-month-head";
    const heading = document.createElement("h3");
    heading.textContent = monthFormat.format(new Date(`${snapshot.month}-01T00:00:00Z`));
    const status = document.createElement("span");
    status.className = "ds-chip";
    status.textContent = tr(snapshot.complete ? "HistoryComplete" : "HistoryProvisional");
    head.append(heading, status);
    const counts = document.createElement("dl");
    for (const key of COUNT_KEYS) {
      const item = document.createElement("div");
      const label = document.createElement("dt");
      label.textContent = tr(key === "cancelled" ? "Cancelled" : key[0].toUpperCase() + key.slice(1));
      const count = document.createElement("dd");
      count.className = "tabular";
      count.textContent = formatCount(snapshot.summary[key]);
      item.append(label, count);
      counts.append(item);
    }
    const generated = document.createElement("p");
    generated.className = "note";
    generated.textContent = tr("SnapshotGenerated", { generated: formatGeneratedAt(snapshot.generatedAt) });
    article.append(head, counts, generated);
    if (snapshot.maximumSampleInterval > 1) {
      const estimate = document.createElement("p");
      estimate.className = "note";
      estimate.textContent = tr("EstimateNote", { interval: formatCount(snapshot.maximumSampleInterval) });
      article.append(estimate);
    }
    article.append(renderHistoryDetails(snapshot));
    container.append(article);
  }
}

function revealDashboard(): void {
  byId("report-state").hidden = true;
  byId("report-dashboard").hidden = false;
}

function clearPrivateData(): void {
  currentReport = null;
  currentHistory = null;
  for (const key of COUNT_KEYS) {
    byId(`summary-${key}`).textContent = "0";
    byId(`comparison-${key}`).textContent = "";
  }
  const generated = byId<HTMLTimeElement>("report-generated");
  generated.textContent = "";
  generated.dateTime = "";
  for (const id of ["report-range", "report-dataset", "comparison-note", "report-estimate-note", "history-generated"]) {
    byId(id).textContent = "";
  }
  for (const id of ["tools-body", "vote-totals", "desk-body", "duration-distribution", "error-distribution", "history-months", "history-year"]) {
    byId(id).replaceChildren();
  }
  svgById("activity-chart").replaceChildren();
  byId("report-estimate-badge").hidden = true;
  byId("history-empty").hidden = true;
  byId("report-dashboard").hidden = true;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}


function parseIso(value: unknown): string | null {
  if (typeof value !== "string" || !value.endsWith("Z") || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseCounts(value: unknown): OperationCounts | null {
  if (!isPlainObject(value) || !hasExactKeys(value, COUNT_KEYS)) return null;
  if (!COUNT_KEYS.every((key) => isCount(value[key]))) return null;
  return {
    started: value.started as number,
    completed: value.completed as number,
    failed: value.failed as number,
    cancelled: value.cancelled as number,
  };
}

function parseDistribution<K extends string>(value: unknown, keys: readonly K[]): Record<K, number> | null {
  if (!isPlainObject(value) || !hasExactKeys(value, keys)) return null;
  if (!keys.every((key) => isCount(value[key]))) return null;
  return Object.fromEntries(keys.map((key) => [key, value[key] as number])) as Record<K, number>;
}

function validHistoricalId(value: string, maximumLength: number): boolean {
  return value.length <= maximumLength && CANONICAL_SLUG_PATTERN.test(value);
}

function parseTool(value: unknown, isValidTool: (tool: string) => boolean): ToolOperationCounts<string> | null {
  const keys = [...COUNT_KEYS, "tool", "maximumSampleInterval", "durations", "errors"];
  if (!isPlainObject(value) || !hasExactKeys(value, keys)) return null;
  const counts = parseCounts(Object.fromEntries(COUNT_KEYS.map((key) => [key, value[key]])));
  const durations = parseDistribution(value.durations, REPORT_DURATION_BUCKETS);
  const errors = parseDistribution(value.errors, REPORT_ERROR_CATEGORIES);
  if (!counts || typeof value.tool !== "string" || !isValidTool(value.tool) || !isCount(value.maximumSampleInterval) || !durations || !errors) return null;
  const operationTotal = COUNT_KEYS.reduce((total, key) => total + counts[key], 0);
  if ((operationTotal === 0) !== (value.maximumSampleInterval === 0)) return null;
  if (sumDistribution(durations) !== counts.completed || sumDistribution(errors) !== counts.failed) return null;
  return {
    tool: value.tool,
    ...counts,
    maximumSampleInterval: value.maximumSampleInterval,
    durations,
    errors,
  };
}

function parseVote(value: unknown, isValidChoice: (choice: string) => boolean): VoteCounts<string> | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ["choice", "votes", "maximumSampleInterval"])) return null;
  if (typeof value.choice !== "string" || !isValidChoice(value.choice)) return null;
  if (!isCount(value.votes) || !isCount(value.maximumSampleInterval)) return null;
  if ((value.votes === 0) !== (value.maximumSampleInterval === 0)) return null;
  return { choice: value.choice, votes: value.votes, maximumSampleInterval: value.maximumSampleInterval };
}

function parseDeskEntry(value: unknown, historical: boolean): DeskEventCounts | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ["event", "detail", "count", "maximumSampleInterval"])) return null;
  const { event, detail } = value;
  if (typeof event !== "string" || typeof detail !== "string") return null;
  if (historical) {
    if (event.length > HISTORICAL_DESK_EVENT_MAX_LENGTH || !DESK_EVENT_PATTERN.test(event)) return null;
    if (detail.length > HISTORICAL_DESK_DETAIL_MAX_LENGTH || !DESK_DETAIL_PATTERN.test(detail)) return null;
  } else if (!DESK_EVENT_PAIRS.some((pair) => pair.event === event && pair.detail === detail)) {
    return null;
  }
  if (!isCount(value.count) || !isCount(value.maximumSampleInterval)) return null;
  if ((value.count === 0) !== (value.maximumSampleInterval === 0)) return null;
  return { event, detail, count: value.count, maximumSampleInterval: value.maximumSampleInterval };
}

/** Current reports list every catalogued pair once; snapshots may hold retired pairs. */
function parseDesk(value: unknown, historical: boolean): DeskEventCounts[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const desk: DeskEventCounts[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const entry = parseDeskEntry(item, historical);
    const key = entry ? `${entry.event}\u0000${entry.detail}` : "";
    if (!entry || seen.has(key)) return null;
    seen.add(key);
    desk.push(entry);
  }
  if (!historical && value.length !== 0 && seen.size !== DESK_EVENT_PAIRS.length) return null;
  return desk;
}

function sumCounts(entries: OperationCounts[]): OperationCounts {
  return entries.reduce<OperationCounts>((total, entry) => ({
    started: total.started + entry.started,
    completed: total.completed + entry.completed,
    failed: total.failed + entry.failed,
    cancelled: total.cancelled + entry.cancelled,
  }), { started: 0, completed: 0, failed: 0, cancelled: 0 });
}

function sameCounts(left: OperationCounts, right: OperationCounts): boolean {
  return COUNT_KEYS.every((key) => left[key] === right[key]);
}

function sumDistribution<K extends string>(counts: Record<K, number>): number {
  return Object.values<number>(counts).reduce((sum, count) => sum + count, 0);
}

function summedToolDistribution<K extends ReportDurationBucket | ReportErrorCategory>(
  tools: ToolOperationCounts<string>[],
  key: "durations" | "errors",
  categories: readonly K[],
): Record<K, number> {
  return Object.fromEntries(categories.map((category) => [
    category,
    tools.reduce((sum, tool) => sum + tool[key][category as never], 0),
  ])) as Record<K, number>;
}

function sameDistribution<K extends string>(left: Record<K, number>, right: Record<K, number>, keys: readonly K[]): boolean {
  return keys.every((key) => left[key] === right[key]);
}

function parsePeriodMetrics(value: unknown, extraKeys?: readonly string[]): PeriodMetrics | null;
function parsePeriodMetrics(value: unknown, extraKeys: readonly string[], catalog: "historical"): PeriodMetrics<string, string> | null;
function parsePeriodMetrics(
  value: unknown,
  extraKeys: readonly string[] = [],
  catalog: "current" | "historical" = "current",
): PeriodMetrics<string, string> | null {
  if (
    !isPlainObject(value) ||
    !(hasExactKeys(value, [...PERIOD_METRIC_KEYS, ...extraKeys]) || hasExactKeys(value, [...LEGACY_PERIOD_METRIC_KEYS, ...extraKeys]))
  ) return null;
  const summary = parseCounts(value.summary);
  const durations = parseDistribution(value.durations, REPORT_DURATION_BUCKETS);
  const errors = parseDistribution(value.errors, REPORT_ERROR_CATEGORIES);
  if (!summary || !durations || !errors || !Array.isArray(value.tools) || !Array.isArray(value.votes) || !isCount(value.maximumSampleInterval)) return null;

  const historical = catalog === "historical";
  const knownTools = new Set<string>(Object.keys(data.toolTitles[data.defaultLocale]));
  const knownChoices = new Set<string>(VOTE_CHOICES.map((choice) => choice.id));
  const tools: ToolOperationCounts<string>[] = [];
  const seenTools = new Set<string>();
  for (const item of value.tools) {
    const tool = parseTool(item, historical
      ? (id) => validHistoricalId(id, HISTORICAL_TOOL_ID_MAX_LENGTH)
      : (id) => knownTools.has(id));
    if (!tool || seenTools.has(tool.tool)) return null;
    seenTools.add(tool.tool);
    tools.push(tool);
  }
  if (!historical && (seenTools.size !== knownTools.size || [...knownTools].some((tool) => !seenTools.has(tool)))) return null;

  const votes: VoteCounts<string>[] = [];
  const seenVotes = new Set<string>();
  for (const item of value.votes) {
    const vote = parseVote(item, historical
      ? (id) => validHistoricalId(id, HISTORICAL_VOTE_CHOICE_MAX_LENGTH)
      : (id) => knownChoices.has(id));
    if (!vote || seenVotes.has(vote.choice)) return null;
    seenVotes.add(vote.choice);
    votes.push(vote);
  }
  if (!historical && (seenVotes.size !== knownChoices.size || [...knownChoices].some((choice) => !seenVotes.has(choice)))) return null;
  const desk = parseDesk(value.desk, historical);
  if (!desk) return null;

  if (!sameCounts(sumCounts(tools), summary)) return null;
  if (sumDistribution(durations) !== summary.completed || sumDistribution(errors) !== summary.failed) return null;
  if (!sameDistribution(durations, summedToolDistribution(tools, "durations", REPORT_DURATION_BUCKETS), REPORT_DURATION_BUCKETS)) return null;
  if (!sameDistribution(errors, summedToolDistribution(tools, "errors", REPORT_ERROR_CATEGORIES), REPORT_ERROR_CATEGORIES)) return null;
  const maximum = Math.max(
    0,
    ...tools.map((tool) => tool.maximumSampleInterval),
    ...votes.map((vote) => vote.maximumSampleInterval),
    ...desk.map((entry) => entry.maximumSampleInterval),
  );
  if (value.maximumSampleInterval !== maximum) return null;
  return { summary, tools, durations, errors, votes, desk, maximumSampleInterval: value.maximumSampleInterval };
}

function parseDaily(value: unknown): DailyOperationCounts | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ["day", ...COUNT_KEYS]) || !validDay(value.day)) return null;
  const counts = parseCounts(Object.fromEntries(COUNT_KEYS.map((key) => [key, value[key]])));
  return counts ? { day: value.day, ...counts } : null;
}

function expectedUtcDays(from: string, to: string): string[] {
  const first = new Date(from);
  first.setUTCHours(0, 0, 0, 0);
  const last = new Date(Date.parse(to) - 1);
  last.setUTCHours(0, 0, 0, 0);
  const days: string[] = [];
  for (let timestamp = first.getTime(); timestamp <= last.getTime(); timestamp += 86_400_000) {
    days.push(new Date(timestamp).toISOString().slice(0, 10));
  }
  return days;
}

function parseReport(value: unknown, expectedPeriod: ReportPeriod): AnalyticsReport | null {
  const extraKeys = ["periodDays", "generatedAt", "dataset", "rangeFrom", "rangeTo", "daily", "comparison"];
  const metrics = parsePeriodMetrics(value, extraKeys);
  if (!metrics || !isPlainObject(value) || value.periodDays !== expectedPeriod || !DATASETS.includes(value.dataset as AnalyticsDataset)) return null;
  const generatedAt = parseIso(value.generatedAt);
  const rangeFrom = parseIso(value.rangeFrom);
  const rangeTo = parseIso(value.rangeTo);
  if (!generatedAt || !rangeFrom || !rangeTo || rangeTo !== generatedAt || Date.parse(rangeTo) - Date.parse(rangeFrom) !== expectedPeriod * 86_400_000) return null;
  if (!Array.isArray(value.daily)) return null;
  const daily: DailyOperationCounts[] = [];
  const seenDays = new Set<string>();
  for (const item of value.daily) {
    const entry = parseDaily(item);
    if (!entry || seenDays.has(entry.day)) return null;
    seenDays.add(entry.day);
    daily.push(entry);
  }
  const expectedDays = expectedUtcDays(rangeFrom, rangeTo);
  if (daily.length !== expectedDays.length || expectedDays.some((day, index) => daily[index]?.day !== day)) return null;
  if (!sameCounts(sumCounts(daily), metrics.summary)) return null;

  let comparison: AnalyticsReport["comparison"] = null;
  if (expectedPeriod === 90) {
    if (value.comparison !== null) return null;
  } else {
    const comparisonExtras = ["periodDays", "rangeFrom", "rangeTo"];
    const comparisonMetrics = parsePeriodMetrics(value.comparison, comparisonExtras);
    if (!comparisonMetrics || !isPlainObject(value.comparison) || value.comparison.periodDays !== expectedPeriod) return null;
    const comparisonFrom = parseIso(value.comparison.rangeFrom);
    const comparisonTo = parseIso(value.comparison.rangeTo);
    if (!comparisonFrom || !comparisonTo || comparisonTo !== rangeFrom) return null;
    if (Date.parse(comparisonTo) - Date.parse(comparisonFrom) !== expectedPeriod * 86_400_000) return null;
    comparison = { ...comparisonMetrics, periodDays: expectedPeriod, rangeFrom: comparisonFrom, rangeTo: comparisonTo } as AnalyticsReport["comparison"];
  }

  return {
    ...metrics,
    periodDays: expectedPeriod,
    generatedAt,
    dataset: value.dataset as AnalyticsDataset,
    rangeFrom,
    rangeTo,
    daily,
    comparison,
  };
}

function validMonth(value: unknown, year: number): value is string {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || !value.startsWith(`${year}-`)) return false;
  return true;
}

function parseSnapshot(value: unknown, year: number, dataset: AnalyticsDataset, historyGeneratedAt: string): MonthlyAnalyticsSnapshot | null {
  const extras = ["month", "complete", "generatedAt", "dataset"];
  const metrics = parsePeriodMetrics(value, extras, "historical");
  if (!metrics || !isPlainObject(value) || !validMonth(value.month, year) || typeof value.complete !== "boolean" || value.dataset !== dataset) return null;
  const generatedAt = parseIso(value.generatedAt);
  if (!generatedAt) return null;
  const monthIndex = Number(value.month.slice(5, 7)) - 1;
  const start = Date.UTC(year, monthIndex, 1);
  const end = Date.UTC(year, monthIndex + 1, 1);
  const snapshotTime = Date.parse(generatedAt);
  const historyTime = Date.parse(historyGeneratedAt);
  if (start > historyTime || snapshotTime > historyTime || (value.complete ? snapshotTime < end : snapshotTime < start || snapshotTime >= end)) return null;
  return {
    ...metrics,
    month: value.month,
    complete: value.complete,
    generatedAt,
    dataset,
  };
}

function parseHistory(value: unknown, expectedYear: number): AnalyticsHistory | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ["generatedAt", "dataset", "year", "years", "months"])) return null;
  const generatedAt = parseIso(value.generatedAt);
  if (!generatedAt || !DATASETS.includes(value.dataset as AnalyticsDataset) || value.year !== expectedYear || !Array.isArray(value.years) || !Array.isArray(value.months) || value.months.length > 12) return null;
  const currentYear = new Date(generatedAt).getUTCFullYear();
  const years: number[] = [];
  const seenYears = new Set<number>();
  for (const year of value.years) {
    if (!Number.isSafeInteger(year) || year < 2000 || year > currentYear || seenYears.has(year)) return null;
    seenYears.add(year);
    years.push(year);
  }
  const months: MonthlyAnalyticsSnapshot[] = [];
  const seenMonths = new Set<string>();
  for (const item of value.months) {
    const snapshot = parseSnapshot(item, expectedYear, value.dataset as AnalyticsDataset, generatedAt);
    if (!snapshot || seenMonths.has(snapshot.month)) return null;
    seenMonths.add(snapshot.month);
    months.push(snapshot);
  }
  return { generatedAt, dataset: value.dataset as AnalyticsDataset, year: expectedYear, years, months };
}

async function fetchJson(endpoint: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: "POST",
    body: null,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new HttpReportError(response.status);
  return response.json();
}

function renderRequestFailure(error: unknown, timedOut: boolean): void {
  clearPrivateData();
  if (timedOut) renderState("timeout");
  else if (error instanceof HttpReportError) {
    if (error.status === 401 || error.status === 403) renderState("auth");
    else if (error.status === 503) renderState("configuration");
    else if (error.status === 504) renderState("timeout");
    else renderState("upstream");
  } else if (!navigator.onLine) renderState("network");
  else if (error instanceof TypeError) renderState("auth");
  else renderState("upstream");
}

async function loadDashboard(archiveFirst = false): Promise<void> {
  const requestedPeriod = period;
  const requestedYear = selectedYear;
  const sequence = ++requestSequence;
  currentController?.abort();
  const controller = new AbortController();
  currentController = controller;
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  clearPrivateData();
  renderState("loading");
  setRequestBusy(true);

  try {
    let archivedHistory: AnalyticsHistory | null = null;
    if (archiveFirst) {
      const currentYear = new Date().getUTCFullYear();
      const archiveValue = await fetchJson(ANALYTICS_ARCHIVE_ENDPOINT, controller.signal);
      archivedHistory = parseHistory(archiveValue, currentYear);
      if (!archivedHistory) throw new InvalidReportError();
    }
    const [reportValue, historyValue] = await Promise.all([
      fetchJson(`${ANALYTICS_REPORT_ENDPOINT}?days=${requestedPeriod}`, controller.signal),
      archivedHistory === null
        ? fetchJson(`${ANALYTICS_HISTORY_ENDPOINT}?year=${requestedYear}`, controller.signal)
        : Promise.resolve(null),
    ]);
    const report = parseReport(reportValue, requestedPeriod);
    const historyReport = archivedHistory ?? parseHistory(historyValue, requestedYear);
    if (!report || !historyReport || report.dataset !== historyReport.dataset) throw new InvalidReportError();
    if (sequence !== requestSequence) return;
    renderReport(report);
    renderHistory(historyReport);
    revealDashboard();
  } catch (error) {
    if (sequence !== requestSequence) return;
    if (error instanceof DOMException && error.name === "AbortError" && !timedOut) return;
    renderRequestFailure(error, timedOut);
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
      void loadDashboard();
    });
  });

  byId<HTMLButtonElement>("admin-refresh").addEventListener("click", () => void loadDashboard());
  byId<HTMLButtonElement>("archive-refresh").addEventListener("click", () => void loadDashboard(true));
  byId<HTMLButtonElement>("report-retry").addEventListener("click", () => void loadDashboard());
  byId<HTMLSelectElement>("history-year").addEventListener("change", (event) => {
    const year = Number((event.currentTarget as HTMLSelectElement).value);
    const currentYear = new Date().getUTCFullYear();
    if (!Number.isSafeInteger(year) || year < 2000 || year > currentYear) return;
    selectedYear = year;
    setUrlSetting("year", String(year));
    void loadDashboard();
  });
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
    clearPrivateData();
  });
  window.addEventListener("pagehide", () => {
    currentController?.abort();
    currentController = null;
    requestSequence += 1;
    clearPrivateData();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) void loadDashboard();
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
  const requestedYear = Number(search.get("year"));
  const currentYear = new Date().getUTCFullYear();
  locale = isLocale(requestedLocale) ? requestedLocale : data.defaultLocale;
  period = isPeriod(requestedPeriod) ? Number(requestedPeriod) as ReportPeriod : DEFAULT_PERIOD;
  selectedYear = Number.isSafeInteger(requestedYear) && requestedYear >= 2000 && requestedYear <= currentYear
    ? requestedYear
    : currentYear;
  setUrlSetting("lang", locale);
  setUrlSetting("days", String(period));
  setUrlSetting("year", String(selectedYear));
  updatePeriodControls();
  bindEvents();
  applyLocale(locale);
  void loadDashboard();
}
