import { formatBytes } from "@/lib/format";
import {
  addHistoryEntry, groupHistoryByDay, HTTP_HISTORY_ENABLED_KEY, type HistoryBackend, type HttpHistoryEntry,
} from "@/tools/http-history";

export interface HistoryPanelStrings {
  History: string;
  SavedRequests: string;
  HistoryToday: string;
  HistoryYesterday: string;
  HistoryEmpty: string;
  HistoryOff: string;
  HistoryClearConfirm: string;
  HistoryDelete: string;
  HistoryLoadError: string;
  HistorySaveError: string;
  HistoryBodyDropped: string;
  UntitledRequest: string;
  Lang: string;
}

interface HistoryPanelOptions {
  strings: HistoryPanelStrings;
  /** Null while the agent copy is locked: nothing is read or written. */
  backend(): HistoryBackend | null;
  open(entry: HttpHistoryEntry): void;
  errorLabel(code: string): string;
}

function readEnabled(): boolean {
  try {
    return localStorage.getItem(HTTP_HISTORY_ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * History view of the HTTP client sidebar: a toggle in place of the request
 * tree, the «Record history» switch (off by default), entries by day, opening
 * an entry as a new request, deleting one and clearing all.
 */
export function bindHistoryPanel(root: HTMLElement, options: HistoryPanelOptions): {
  record(entry: HttpHistoryEntry): void;
  reload(): void;
} {
  const s = options.strings;
  const toggle = root.querySelector<HTMLButtonElement>("[data-http-history-toggle]")!;
  const panel = root.querySelector<HTMLElement>("[data-http-history-panel]")!;
  const tree = root.querySelector<HTMLElement>("[data-http-saved-list]")!;
  const title = root.querySelector<HTMLElement>("#http-saved-title > span")!;
  const enabledBox = panel.querySelector<HTMLInputElement>("[data-http-history-enabled]")!;
  const list = panel.querySelector<HTMLElement>("[data-http-history-list]")!;
  const empty = panel.querySelector<HTMLElement>("[data-http-history-empty]")!;
  const clear = panel.querySelector<HTMLButtonElement>("[data-http-history-clear]")!;
  const error = panel.querySelector<HTMLElement>("[data-http-history-error]")!;
  let entries: HttpHistoryEntry[] = [];
  let loaded = false;
  let revision = 0;
  enabledBox.checked = readEnabled();

  const showError = (text: string | null): void => {
    error.textContent = text ?? "";
    error.hidden = !text;
  };

  function dayLabel(day: string): string {
    const today = new Date();
    const key = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    if (day === key(today)) return s.HistoryToday;
    if (day === key(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1))) return s.HistoryYesterday;
    const [year, month, date] = day.split("-").map(Number) as [number, number, number];
    return new Intl.DateTimeFormat(s.Lang, { day: "numeric", month: "long", year: "numeric" }).format(new Date(year, month - 1, date));
  }

  function render(): void {
    if (panel.hidden) return;
    const time = new Intl.DateTimeFormat(s.Lang, { hour: "2-digit", minute: "2-digit" });
    list.replaceChildren(...groupHistoryByDay(entries).map((group) => {
      const section = document.createElement("li");
      section.className = "http-history-day";
      const heading = document.createElement("h3");
      heading.textContent = dayLabel(group.day);
      const items = document.createElement("ul");
      items.append(...group.entries.map((entry) => {
        const item = document.createElement("li");
        item.className = "http-history-item";
        const open = document.createElement("button");
        open.type = "button";
        open.className = "http-history-open";
        open.dataset.httpHistoryId = entry.id;
        open.title = entry.request.url;
        const method = document.createElement("span");
        method.className = "http-history-method mono";
        method.textContent = entry.request.method;
        const url = document.createElement("span");
        url.className = "http-history-url mono";
        url.textContent = entry.request.url || entry.request.name || s.UntitledRequest;
        const meta = document.createElement("span");
        meta.className = "http-history-meta";
        const status = document.createElement("span");
        status.className = `http-history-status${entry.status === null || entry.status >= 400 ? " is-error" : ""}`;
        status.textContent = entry.status === null ? options.errorLabel(entry.error ?? "") : String(entry.status);
        meta.append(status, [
          entry.elapsedMs !== undefined ? `${entry.elapsedMs} ms` : "",
          entry.sizeBytes !== undefined ? formatBytes(entry.sizeBytes) : "",
          time.format(entry.at),
          entry.bodyDropped ? s.HistoryBodyDropped : "",
        ].filter(Boolean).map((part) => ` · ${part}`).join(""));
        open.append(method, url, meta);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "ds-btn ds-btn-small ds-btn-ghost http-history-delete";
        remove.dataset.httpHistoryDelete = entry.id;
        remove.textContent = "×";
        remove.title = s.HistoryDelete;
        remove.setAttribute("aria-label", s.HistoryDelete);
        item.append(open, remove);
        return item;
      }));
      section.append(heading, items);
      return section;
    }));
    empty.textContent = enabledBox.checked ? s.HistoryEmpty : s.HistoryOff;
    empty.hidden = entries.length > 0;
    clear.hidden = entries.length === 0;
  }

  async function load(): Promise<void> {
    const backend = options.backend();
    const current = ++revision;
    if (!backend) {
      entries = [];
      loaded = false;
      render();
      return;
    }
    try {
      const next = await backend.load();
      if (current !== revision) return;
      entries = next;
      loaded = true;
      showError(null);
    } catch {
      if (current !== revision) return;
      showError(s.HistoryLoadError);
    }
    render();
  }

  async function change(apply: (list: HttpHistoryEntry[]) => HttpHistoryEntry[]): Promise<void> {
    const backend = options.backend();
    if (!backend) return;
    revision++;
    try {
      entries = await backend.update(apply);
      loaded = true;
      showError(null);
    } catch {
      showError(s.HistorySaveError);
    }
    render();
  }

  toggle.addEventListener("click", () => {
    const show = panel.hidden;
    panel.hidden = !show;
    tree.hidden = show;
    toggle.setAttribute("aria-pressed", String(show));
    title.textContent = show ? s.History : s.SavedRequests;
    if (show) {
      render();
      if (!loaded) void load();
    }
  });
  enabledBox.addEventListener("change", () => {
    try {
      if (enabledBox.checked) localStorage.setItem(HTTP_HISTORY_ENABLED_KEY, "1");
      else localStorage.removeItem(HTTP_HISTORY_ENABLED_KEY);
    } catch {
      // Without storage the switch lasts for this page only.
    }
    render();
  });
  list.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const removeId = event.target.closest<HTMLElement>("[data-http-history-delete]")?.dataset.httpHistoryDelete;
    if (removeId) {
      void change((current) => current.filter((entry) => entry.id !== removeId));
      return;
    }
    const openId = event.target.closest<HTMLElement>("[data-http-history-id]")?.dataset.httpHistoryId;
    const entry = entries.find((candidate) => candidate.id === openId);
    if (entry) options.open(entry);
  });
  clear.addEventListener("click", () => {
    if (window.confirm(s.HistoryClearConfirm)) void change(() => []);
  });

  return {
    record(entry) {
      if (!enabledBox.checked) return;
      void change((current) => addHistoryEntry(current, entry));
    },
    reload() {
      loaded = false;
      if (!panel.hidden) void load();
    },
  };
}
