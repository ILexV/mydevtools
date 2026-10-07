/**
 * Shared DOM rendering for the cron-parser and cron-generator results: the
 * vertical next-run timeline (absolute timestamp + "in …" relative time
 * snapshotted at evaluation, "Show next 5" up to 10, search-horizon and
 * `@reboot` / never-fires explanations, evaluation time zone + cron rules
 * line), the five coloured field capsules (minute … weekday) and the
 * persisted next-run date format (localStorage `cron-date-format`, common to
 * both tools). Styles live in `cron-ui.css`; pure logic in `cron-timeline.ts`.
 */
import { formatPlural, formatString } from "@/lib/format";
import { announce } from "@/scripts/tool-ui";
import { CRON_FIELDS, CRON_SEARCH_YEARS, cronNextRuns, formatCronDate, toLocalIso, type CronSchedule } from "@/tools/cron-core";
import {
  TIMELINE_MAX,
  cronFieldValues,
  relativeTimeParts,
  timelineView,
  utcOffsetLabel,
} from "@/tools/cron-timeline";

const DATE_FORMAT_KEY = "cron-date-format";

/** Saved date format, applied to `select` when it is one of its options. */
export function restoreDateFormat(select: HTMLSelectElement | null): string {
  let saved = "locale";
  try {
    saved = localStorage.getItem(DATE_FORMAT_KEY) || "locale";
  } catch {
    /* storage unavailable */
  }
  if (select && [...select.options].some((o) => o.value === saved)) select.value = saved;
  return select?.value || saved;
}

export function saveDateFormat(format: string): void {
  try {
    localStorage.setItem(DATE_FORMAT_KEY, format);
  } catch {
    /* storage unavailable */
  }
}

/** Locale strings the timeline needs (camelCased keys from the tool namespace; plural variants via `_one`/`_few`…). */
export interface CronTimelineStrings {
  lang: string;
  /** "Show next {0}" (plural on {0}). */
  timelineShowMore: string;
  /** "Only {0} runs within the next {1} years…" (plural on {0}). */
  timelineHorizon: string;
  /** "No runs within the next {0} years…" */
  noUpcomingRuns: string;
  /** Why `@reboot` lists no times. */
  timelineReboot: string;
  /** "Calculated at {0} in {1} ({2})." — time, IANA zone, UTC offset. */
  timelineContext: string;
  /** Day-field (Vixie OR) and daylight-saving rules of the engine. */
  timelineRules: string;
  /** Polite announcement after a successful submission. */
  announceUpdated: string;
  [plural: string]: unknown;
}

/** Outcome of one evaluation: a schedule (runs computed now) or `@reboot` (null). */
export type CronEvaluation = { schedule: CronSchedule | null };

export interface CronTimeline {
  /** Compute up to 10 runs from "now" (one snapshot) and render the first five. */
  show(evaluation: CronEvaluation): void;
  /** Re-render the same snapshot in another date format (presentation only). */
  setFormat(format: string): void;
  clear(): void;
  /** Announce "Schedule updated" once (call after an explicit, successful submission). */
  announceUpdate(): void;
}

const relativeCache = new Map<string, Intl.RelativeTimeFormat>();
const clockCache = new Map<string, Intl.DateTimeFormat>();
const intlLocale = (lang: string) => (lang === "zh" ? "zh-CN" : lang);

function relativeFormat(lang: string): Intl.RelativeTimeFormat {
  let rtf = relativeCache.get(lang);
  if (!rtf) {
    rtf = new Intl.RelativeTimeFormat(intlLocale(lang), { numeric: "always", style: "long" });
    relativeCache.set(lang, rtf);
  }
  return rtf;
}

/** Clock for the "Calculated at" line; follows the 12h/24h choice of the date-format select. */
function clockFormat(lang: string, format: string): Intl.DateTimeFormat {
  const hour12 = format === "locale-12h" || format === "american";
  const key = `${lang}|${hour12}`;
  let fmt = clockCache.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(intlLocale(lang), { hour: "2-digit", minute: "2-digit", hour12 });
    clockCache.set(key, fmt);
  }
  return fmt;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Timeline controller bound to `host` (an empty container inside the results
 * panel). Runs are snapshotted at `show()`: relative times are not ticking,
 * and the "Calculated at …" line says when they were computed.
 */
export function createCronTimeline(host: HTMLElement, strings: CronTimelineStrings, initialFormat: string): CronTimeline {
  const lang = strings.lang;
  let format = initialFormat;
  let runs: Date[] = [];
  let now = new Date();
  let reboot = false;
  let expansions = 0;
  let active = false;

  function render() {
    host.replaceChildren();
    if (!active) return;
    if (reboot) {
      host.append(el("p", "ds-empty cron-timeline-empty", strings.timelineReboot));
      return;
    }
    if (!runs.length) {
      host.append(el("p", "ds-empty cron-timeline-empty", formatString(strings.noUpcomingRuns, CRON_SEARCH_YEARS)));
    } else {
      const view = timelineView(runs.length, expansions);
      const list = el("ol", "cron-timeline");
      for (const run of runs.slice(0, view.visible)) {
        const li = el("li", "cron-run");
        const abs = el("time", "cron-run-abs", formatCronDate(run, format, lang));
        abs.dateTime = toLocalIso(run);
        const { value, unit } = relativeTimeParts(now.getTime(), run.getTime());
        li.append(abs, el("span", "cron-run-rel", relativeFormat(lang).format(value, unit)));
        list.append(li);
      }
      host.append(list);
      if (view.shortfall) {
        host.append(el("p", "ds-hint cron-timeline-note", formatPlural(strings, "timelineHorizon", runs.length, lang, CRON_SEARCH_YEARS)));
      }
      if (view.more > 0) {
        const more = el("button", "ds-btn ds-btn-small ds-btn-ghost cron-timeline-more", formatPlural(strings, "timelineShowMore", view.more, lang));
        more.type = "button";
        more.addEventListener("click", () => {
          const firstNew = view.visible;
          expansions++;
          render();
          // Keep keyboard focus in the list: move to the first newly shown run.
          const target = host.querySelectorAll<HTMLElement>(".cron-run")[firstNew];
          if (target) {
            target.tabIndex = -1;
            target.focus();
          }
        });
        host.append(more);
      }
    }
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    const offset = utcOffsetLabel(-now.getTimezoneOffset());
    const context = el("p", "ds-hint cron-timeline-context");
    context.append(
      el("span", "", formatString(strings.timelineContext, clockFormat(lang, format).format(now), zone || offset, offset)),
      " ",
      el("span", "", strings.timelineRules),
    );
    host.append(context);
  }

  return {
    show({ schedule }) {
      active = true;
      expansions = 0;
      now = new Date();
      reboot = schedule === null;
      // Bounded: at most TIMELINE_MAX runs within the engine's search horizon.
      runs = schedule ? cronNextRuns(schedule, now, TIMELINE_MAX) : [];
      render();
    },
    setFormat(next) {
      format = next;
      render();
    },
    clear() {
      active = false;
      runs = [];
      render();
    },
    announceUpdate() {
      announce(strings.announceUpdated);
    },
  };
}

/**
 * Fill the five field capsules (`[data-cron-cap="<field>"]` inside `list`)
 * from an expanded expression; hides the list when there are no fields
 * (`@reboot`, cleared input).
 */
export function setFieldCapsules(list: HTMLElement | null, expanded: string | null): void {
  if (!list) return;
  const values = cronFieldValues(expanded);
  list.hidden = !values;
  for (const [i, field] of CRON_FIELDS.entries()) {
    const value = list.querySelector<HTMLElement>(`[data-cron-cap="${field}"]`);
    if (value) value.textContent = values?.[i] ?? "";
  }
}
