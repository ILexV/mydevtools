import { EXPLORER_ROW_HEIGHT, explorerScrollTop, explorerWindow, type ExplorerWindow } from "./explorer-window";

export interface ExplorerColumn {
  key: string;
  label: string;
}

export interface ExplorerTableOptions {
  host: HTMLElement;
  columns: readonly ExplorerColumn[];
  readRows: (start: number, count: number) => Promise<readonly (readonly string[])[]>;
  onError: (error: unknown) => void;
  emptyLabel: string;
  loadingLabel: string;
  rowLabel: (index: number) => string;
  onRowClick?: (index: number) => void;
  /** Extra class for a rendered row, e.g. a diff marker; styled by the page. */
  rowClass?: (row: readonly string[], index: number) => string | undefined;
}

export interface ExplorerTable {
  setColumns(columns: readonly ExplorerColumn[]): void;
  setRowCount(count: number): void;
  refresh(): void;
  scrollToRow(index: number): void;
  destroy(): void;
}

let nextTableId = 0;

/** Bounded DOM and one in-flight range read, including datasets beyond CSS height limits. */
export function createExplorerTable(options: ExplorerTableOptions): ExplorerTable {
  const { host } = options;
  const tableId = `explorer-table-${++nextTableId}`;
  let columns = options.columns;
  let rowCount = 0;
  let activeRow = 0;
  let generation = 0;
  let destroyed = false;
  let busy = false;
  let frame = 0;
  let pending: ExplorerWindow | null = null;
  let renderedStart = -1;
  let renderedCount = 0;
  let forcedAnchor: number | undefined;
  let forcedScrollTop = 0;

  host.classList.add("ds-explorer-table");
  host.setAttribute("role", "grid");
  host.setAttribute("aria-rowcount", "1");
  const headerClip = document.createElement("div");
  headerClip.className = "ds-explorer-header-clip";
  const header = document.createElement("div");
  header.className = "ds-explorer-header";
  header.setAttribute("role", "row");
  header.setAttribute("aria-rowindex", "1");
  headerClip.append(header);
  const viewport = document.createElement("div");
  viewport.className = "ds-explorer-viewport";
  viewport.tabIndex = 0;
  const track = document.createElement("div");
  track.className = "ds-explorer-track";
  const rows = document.createElement("div");
  rows.className = "ds-explorer-rows";
  track.append(rows);
  viewport.append(track);
  const empty = document.createElement("p");
  empty.className = "ds-explorer-empty";
  empty.textContent = options.emptyLabel;
  empty.setAttribute("role", "status");
  const loading = document.createElement("span");
  loading.className = "ds-explorer-loading";
  loading.textContent = options.loadingLabel;
  loading.hidden = true;
  host.replaceChildren(headerClip, viewport, empty, loading);

  /** Keep the row-number track wide enough for the last index, not a fixed 4.5rem. */
  function syncRowTrack() {
    const digits = Math.max(2, String(Math.max(1, rowCount)).length);
    host.style.setProperty("--ds-explorer-row-track", `calc(${digits}ch + 1.7rem)`);
  }

  function updateColumns() {
    syncRowTrack();
    host.style.setProperty("--ds-explorer-template", `var(--ds-explorer-row-track) repeat(${columns.length}, minmax(10rem, 1fr))`);
    host.style.setProperty("--ds-explorer-width", `calc(var(--ds-explorer-row-track) + ${columns.length * 160}px)`);
    host.setAttribute("aria-colcount", String(columns.length + 1));
    const number = document.createElement("div");
    number.className = "ds-explorer-cell ds-explorer-row-number";
    number.textContent = "#";
    number.setAttribute("role", "columnheader");
    header.replaceChildren(number, ...columns.map((column) => {
      const cell = document.createElement("div");
      cell.className = "ds-explorer-cell";
      cell.textContent = column.label;
      cell.title = column.label;
      cell.setAttribute("role", "columnheader");
      return cell;
    }));
  }

  function updateActiveRow() {
    let activeId = "";
    for (const row of rows.children) {
      const selected = Number((row as HTMLElement).dataset.explorerRowIndex) === activeRow;
      row.classList.toggle("is-selected", selected);
      row.setAttribute("aria-selected", String(selected));
      if (selected) activeId = row.id;
    }
    if (activeId) viewport.setAttribute("aria-activedescendant", activeId);
    else viewport.removeAttribute("aria-activedescendant");
  }

  function render(data: readonly (readonly string[])[], window: ExplorerWindow) {
    const fragment = document.createDocumentFragment();
    const count = Math.min(data.length, window.count);
    for (let i = 0; i < count; i++) {
      const index = window.start + i;
      const row = document.createElement("div");
      row.id = `${tableId}-row-${index}`;
      row.className = "ds-explorer-row";
      const extra = options.rowClass?.(data[i] ?? [], index);
      if (extra) row.classList.add(extra);
      row.dataset.explorerRowIndex = String(index);
      row.setAttribute("role", "row");
      row.setAttribute("aria-rowindex", String(index + 2));
      row.setAttribute("aria-label", options.rowLabel(index));
      const number = document.createElement("div");
      number.className = "ds-explorer-cell ds-explorer-row-number";
      const label = String(index + 1);
      number.textContent = label;
      number.title = label;
      number.setAttribute("role", "rowheader");
      row.append(number);
      for (let j = 0; j < columns.length; j++) {
        const cell = document.createElement("div");
        cell.className = "ds-explorer-cell";
        const text = data[i]?.[j] ?? "";
        cell.textContent = text;
        cell.title = text;
        cell.setAttribute("role", "gridcell");
        cell.setAttribute("aria-colindex", String(j + 2));
        row.append(cell);
      }
      fragment.append(row);
    }
    rows.replaceChildren(fragment);
    rows.style.transform = `translateY(${window.offset}px)`;
    renderedStart = window.start;
    renderedCount = window.count;
    updateActiveRow();
  }

  async function loadWindows() {
    if (busy || destroyed) return;
    busy = true;
    loading.hidden = false;
    host.setAttribute("aria-busy", "true");
    try {
      while (pending && !destroyed) {
        const window = pending;
        pending = null;
        const current = generation;
        try {
          const data = await options.readRows(window.start, window.count);
          if (!destroyed && generation === current && !pending) render(data, window);
        } catch (error) {
          if (!destroyed && generation === current && !pending) options.onError(error);
        }
      }
    } finally {
      busy = false;
      if (!destroyed) {
        loading.hidden = true;
        host.setAttribute("aria-busy", "false");
      }
    }
  }

  function requestWindow() {
    frame = 0;
    if (destroyed || rowCount === 0) return;
    const window = explorerWindow(rowCount, viewport.clientHeight, viewport.scrollTop, forcedAnchor);
    track.style.height = `${window.trackHeight}px`;
    if (!busy && renderedStart === window.start && renderedCount === window.count) {
      rows.style.transform = `translateY(${window.offset}px)`;
      return;
    }
    pending = window;
    void loadWindows();
  }

  function scheduleWindow() {
    if (!frame && !destroyed) frame = requestAnimationFrame(requestWindow);
  }

  /** Keep the # header pinned. Transforming the whole header disables sticky. */
  function syncHeaderScroll() {
    if (headerClip.scrollLeft !== viewport.scrollLeft) headerClip.scrollLeft = viewport.scrollLeft;
    host.classList.toggle("is-scrolled-x", viewport.scrollLeft > 0);
  }

  function onScroll() {
    syncHeaderScroll();
    if (forcedAnchor !== undefined && Math.abs(viewport.scrollTop - forcedScrollTop) > 1) forcedAnchor = undefined;
    scheduleWindow();
  }

  function scrollToRow(index: number) {
    if (!rowCount || destroyed) return;
    activeRow = Math.max(0, Math.min(Math.floor(index), rowCount - 1));
    forcedAnchor = activeRow;
    forcedScrollTop = explorerScrollTop(rowCount, viewport.clientHeight, activeRow);
    viewport.scrollTop = forcedScrollTop;
    updateActiveRow();
    scheduleWindow();
  }

  function onKeydown(event: KeyboardEvent) {
    if (!rowCount || event.altKey || event.ctrlKey || event.metaKey) return;
    const page = Math.max(1, Math.floor(viewport.clientHeight / EXPLORER_ROW_HEIGHT));
    let target: number;
    switch (event.key) {
      case "ArrowDown": target = activeRow + 1; break;
      case "ArrowUp": target = activeRow - 1; break;
      case "PageDown": target = activeRow + page; break;
      case "PageUp": target = activeRow - page; break;
      case "Home": target = 0; break;
      case "End": target = rowCount - 1; break;
      case "Enter":
      case " ":
        if (options.onRowClick) {
          event.preventDefault();
          options.onRowClick(activeRow);
        }
        return;
      default: return;
    }
    event.preventDefault();
    scrollToRow(target);
  }

  function onClick(event: MouseEvent) {
    const target = (event.target as Element | null)?.closest<HTMLElement>("[data-explorer-row-index]");
    if (!target || !rows.contains(target)) return;
    activeRow = Number(target.dataset.explorerRowIndex);
    updateActiveRow();
    viewport.focus({ preventScroll: true });
    options.onRowClick?.(activeRow);
  }

  function refresh() {
    generation++;
    renderedStart = -1;
    renderedCount = 0;
    pending = null;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    rows.replaceChildren();
    requestWindow();
  }

  viewport.addEventListener("scroll", onScroll, { passive: true });
  viewport.addEventListener("keydown", onKeydown);
  rows.addEventListener("click", onClick);
  const resize = new ResizeObserver(scheduleWindow);
  resize.observe(viewport);
  updateColumns();
  viewport.hidden = true;
  headerClip.hidden = true;

  return {
    setColumns(next: readonly ExplorerColumn[]) {
      columns = next;
      updateColumns();
      refresh();
    },
    setRowCount(count: number) {
      rowCount = Math.max(0, Math.floor(count));
      syncRowTrack();
      host.setAttribute("aria-rowcount", String(rowCount + 1));
      activeRow = Math.min(activeRow, Math.max(0, rowCount - 1));
      forcedAnchor = undefined;
      viewport.scrollTop = 0;
      syncHeaderScroll();
      viewport.hidden = rowCount === 0;
      headerClip.hidden = rowCount === 0;
      empty.hidden = rowCount !== 0;
      refresh();
    },
    refresh,
    scrollToRow,
    destroy() {
      destroyed = true;
      generation++;
      pending = null;
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("keydown", onKeydown);
      rows.removeEventListener("click", onClick);
      host.removeAttribute("aria-busy");
      host.replaceChildren();
    },
  };
}
