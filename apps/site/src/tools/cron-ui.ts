/**
 * DOM helpers shared by the cron-parser and cron-generator controllers:
 * next-run list rendering and the persisted next-run date format
 * (localStorage `cron-date-format`, common to both tools).
 */
import { formatCronDate } from "@/tools/cron-core";

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

/** Render next runs as an ordered list, or a single message (`@reboot`, never fires). */
export function renderNextRuns(host: HTMLElement, runs: Date[] | string, format: string, lang: string): void {
  host.replaceChildren();
  if (typeof runs === "string") {
    const p = document.createElement("p");
    p.className = "ds-empty";
    p.textContent = runs;
    host.append(p);
    return;
  }
  const list = document.createElement("ol");
  list.className = "ds-code-block cron-next";
  for (const run of runs) {
    const li = document.createElement("li");
    li.textContent = formatCronDate(run, format, lang);
    list.append(li);
  }
  host.append(list);
}
