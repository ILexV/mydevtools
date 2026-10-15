/**
 * Desktop shell controller. Shortcuts, floating windows and the taskbar live
 * here; each tool runs in its own iframe (`?embed=1`) so the page controllers
 * keep their one-root-per-document assumption. The address bar stays on
 * `/{lang}/desktop/`. Full tool pages remain the canonical URLs.
 */

import "@/scripts/favorites.ts";
import { cascadeBounds, dockBounds, dragBounds, resizeBounds, restoreUnderPointer, snapTarget } from "./bounds.ts";
import { hasUserInput, type InputSnapshot } from "./dirty.ts";
import {
  ENTRY_KEY,
  LAYOUT_KEY,
  PREFS_KEY,
  SKIP_KEY,
  defaultPrefs,
  parseLayout,
  parsePrefs,
  serializeLayout,
  serializePrefs,
  type DeskPrefs,
} from "./persistence.ts";
import { desktopReducer } from "./reducer.ts";
import { arrangeShortcuts, cellSize, moveShortcut, packedPositions, stripColumns } from "./shortcuts.ts";
import type { Bounds, DeskSize, DeskState, DeskWindow, ResizeEdge, ShortcutCell } from "./types.ts";
import { emptyDesk } from "./types.ts";
import { clearWallpaperBlob, loadWallpaperBlob, prepareWallpaper, saveWallpaperBlob } from "./wallpaper.ts";

interface ToolInfo {
  slug: string;
  title: string;
  description: string;
  monogram: string;
  category: string;
  href: string;
}

interface CategoryInfo {
  id: string;
  label: string;
  icon: string;
}

interface Payload {
  tools: ToolInfo[];
  categories: CategoryInfo[];
  strings: Record<string, string>;
}

const EDGES: ResizeEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

export function bootDesktop(): void {
  const dataEl = document.getElementById("desk-data");
  if (!dataEl?.textContent) return;
  let payload: Payload;
  try {
    payload = JSON.parse(dataEl.textContent) as Payload;
  } catch {
    return;
  }

  const tools = new Map(payload.tools.map((tool) => [tool.slug, tool]));
  const categories = new Map(payload.categories.map((category) => [category.id, category]));
  const slugs = new Set(tools.keys());
  const categoryIds = new Set(categories.keys());
  const text = (key: string) => payload.strings[key] || key;

  let prefs = parsePrefs(readKey(PREFS_KEY), slugs, categoryIds) ?? defaultPrefs(payload.categories.map((category) => category.id));
  let state: DeskState = parseLayout(readKey(LAYOUT_KEY), slugs, categoryIds) ?? emptyDesk;
  let saveTimer = 0;
  let ready = false;
  let selectedShortcut: string | null = null;
  let tileFor: string | null = null;
  let imageUrl: string | null = null;
  let draftUrl: string | null = null;
  let draftBlob: Blob | null = null;
  let draftRemoveImage = false;

  const stage = must<HTMLElement>("[data-desk-stage]");
  const iconHost = must<HTMLElement>("[data-desk-icons]");
  const windowHost = must<HTMLElement>("[data-desk-windows]");
  const taskHost = must<HTMLElement>("[data-desk-tasks]");
  const snap = must<HTMLElement>("[data-desk-snap]");
  const bg = must<HTMLElement>("[data-desk-bg]");
  const menu = must<HTMLElement>("[data-desk-menu]");
  const catalogDialog = must<HTMLDialogElement>("[data-catalog-dialog]");
  const settingsDialog = must<HTMLDialogElement>("[data-settings-dialog]");
  const overviewDialog = must<HTMLDialogElement>("[data-overview-dialog]");
  const discardDialog = must<HTMLDialogElement>("[data-discard-dialog]");
  const helpDialog = must<HTMLDialogElement>("[data-help-dialog]");
  const tileDialog = must<HTMLDialogElement>("[data-tile-dialog]");

  document.querySelector("[data-desk-search]")?.addEventListener("click", () => openCatalog());
  document.querySelector("[data-desk-catalog]")?.addEventListener("click", () => openCatalog());
  document.querySelector("[data-desk-settings]")?.addEventListener("click", () => openSettings());
  document.querySelector("[data-desk-show]")?.addEventListener("click", () => {
      dispatch({ type: state.concealed ? "reveal" : "conceal" });
    });
  document.querySelector("[data-desk-overview]")?.addEventListener("click", () => openOverview());
  document.querySelectorAll("[data-desk-exit]").forEach((node) => {
    node.addEventListener("click", () => {
      try {
        sessionStorage.setItem(SKIP_KEY, "1");
      } catch {
        /* session storage unavailable — the home page may bounce back */
      }
    });
  });
  document.querySelector("[data-theme-toggle]")?.addEventListener("click", toggleTheme);
  for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog.desk-dialog")) {
    dialog.querySelectorAll("[data-dialog-close]").forEach((button) => {
      button.addEventListener("click", () => dialog.close());
    });
  }
  document.addEventListener("click", (event) => {
    const details = document.querySelector<HTMLDetailsElement>(".desk-lang");
    if (details?.open && !details.contains(event.target as Node)) details.open = false;
  });
  document.addEventListener("keydown", onKey);
  document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && !menu.contains(event.target as Node)) hideMenu();
  });
  stage.addEventListener("contextmenu", (event) => {
    if ((event.target as HTMLElement).closest(".desk-window, .desk-icon")) return;
    event.preventDefault();
    openSurfaceMenu(event.clientX, event.clientY);
  });
  window.addEventListener("resize", () => dispatch({ type: "clamp", desk: deskSize() }));
  window.addEventListener("beforeunload", (event) => {
    if (dirtyIds(state.windows.map((record) => record.id)).length === 0) return;
    event.preventDefault();
    event.returnValue = "";
  });
  wireSettings();
  wireOverview();
  wireTile();

  void restoreImage().finally(() => {
    applyWallpaper(prefs, imageUrl);
    ready = true;
    const clamped = desktopReducer(state, { type: "clamp", desk: deskSize() });
    if (clamped !== state) {
      state = clamped;
      scheduleSave();
    }
    render();
  });

  function dispatch(action: Parameters<typeof desktopReducer>[1]): void {
    const next = desktopReducer(state, action);
    if (next === state) return;
    state = next;
    render();
    if (ready) scheduleSave();
  }

  function render(): void {
    renderIcons();
    renderWindows();
    renderTasks();
    document.body.classList.toggle("is-concealed", state.concealed);
    const count = document.querySelector<HTMLElement>("[data-desk-count]");
    if (count) {
      count.hidden = state.windows.length === 0;
      count.textContent = String(state.windows.length);
    }
  }

  function renderIcons(): void {
    if (prefs.shortcuts.length === 0) {
      iconHost.style.width = "auto";
      iconHost.style.height = "auto";
      iconHost.replaceChildren();
      const empty = document.createElement("button");
      empty.type = "button";
      empty.className = "desk-empty";
      empty.textContent = text("EmptyDesktop");
      empty.addEventListener("click", () => openCatalog());
      iconHost.append(empty);
      return;
    }
    const size = cellSize(prefs.iconSize);
    const desk = deskSize();
    const columns = stripColumns(prefs.shortcuts.length, Math.max(0, desk.width - 24), desk.height, size, prefs.positions, prefs.shortcuts);
    const rowsFit = Math.max(1, Math.floor((desk.height || size.h) / size.h));
    const layout = arrangeShortcuts(prefs.shortcuts, prefs.positions, columns, rowsFit, prefs.positions);
    iconHost.style.width = `${layout.columns * size.w}px`;
    iconHost.style.height = `${layout.rows * size.h}px`;
    iconHost.replaceChildren();
    for (const id of prefs.shortcuts) {
      const cell = layout.positions[id];
      if (!cell) continue;
      iconHost.append(renderIcon(id, cell, size));
    }
  }

  function renderIcon(id: string, cell: ShortcutCell, size: { w: number; h: number }): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "desk-icon";
    button.dataset.shortcutId = id;
    button.style.left = `${cell.column * size.w}px`;
    button.style.top = `${cell.row * size.h}px`;
    button.style.width = `${size.w}px`;
    button.setAttribute("aria-pressed", String(selectedShortcut === id));
    const info = shortcutInfo(id);
    button.style.setProperty("--mdt-cat", `var(--mdt-cat-${info.category})`);
    button.title = info.label;
    const tile = document.createElement("span");
    tile.className = "desk-icon-tile";
    if (info.icon) tile.innerHTML = svgWrap(info.icon);
    else {
      tile.dataset.len = String(Math.min(4, [...info.mark].length));
      tile.textContent = info.mark;
    }
    const label = document.createElement("span");
    label.className = "desk-icon-label";
    label.textContent = info.label;
    button.append(tile, label);
    if (id.startsWith("tool:") && window.MDT?.favorites.isFavorite(id.slice(5))) {
      const star = document.createElement("span");
      star.className = "desk-icon-fav";
      star.textContent = "★";
      star.setAttribute("aria-hidden", "true");
      button.append(star);
    }
    if (shortcutIsOpen(id)) {
      const dot = document.createElement("span");
      dot.className = "desk-icon-dot";
      button.append(dot);
    }
    button.addEventListener("click", () => {
      selectedShortcut = id;
      iconHost.querySelectorAll<HTMLButtonElement>(".desk-icon").forEach((icon) => {
        icon.setAttribute("aria-pressed", String(icon === button));
      });
    });
    button.addEventListener("dblclick", () => openShortcut(id, false));
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectedShortcut = id;
      openShortcutMenu(id, event.clientX, event.clientY);
    });
    if (!prefs.locked) button.addEventListener("pointerdown", (event) => startIconDrag(event, id, button));
    return button;
  }

  function renderWindows(): void {
    const live = new Set(state.windows.map((record) => record.id));
    for (const node of windowHost.querySelectorAll<HTMLElement>("[data-window-id]")) {
      if (!live.has(node.dataset.windowId || "")) node.remove();
    }
    for (const record of state.windows) {
      let node = windowHost.querySelector<HTMLElement>(`[data-window-id="${CSS.escape(record.id)}"]`);
      if (!node) {
        node = createWindow(record);
        windowHost.append(node);
      }
      placeWindow(node, record);
    }
  }

  function createWindow(record: DeskWindow): HTMLElement {
    const node = document.createElement("article");
    node.className = "desk-window";
    node.dataset.windowId = record.id;
    node.tabIndex = -1;
    const info = record.kind === "tool" ? toolInfo(record.slug) : folderInfo(record.slug);
    node.style.setProperty("--mdt-cat", `var(--mdt-cat-${info.category})`);

    const header = document.createElement("header");
    header.className = "desk-window-title";
    header.tabIndex = 0;
    const mark = document.createElement("span");
    mark.className = "desk-window-mark";
    mark.textContent = info.mark;
    const name = document.createElement("h2");
    name.className = "desk-window-name";
    const actions = document.createElement("div");
    actions.className = "desk-window-actions";
    header.append(mark, name, actions);
    if (record.kind === "tool") {
      actions.append(
        winButton("Favorite", "☆", () => {
          window.MDT?.favorites.toggle(record.slug);
          render();
        }, "data-fav"),
        winButton("Help", "?", () => showHelp(record.slug)),
        winButton("OpenFull", "↗", () => {
          const tool = tools.get(record.slug);
          if (tool) location.assign(tool.href);
        }),
      );
    }
    actions.append(
      winButton("TileWith", "▦", () => openTile(record.id)),
      winButton("Minimize", "–", () => dispatch({ type: "minimize", id: record.id })),
      winButton("Maximize", "□", () => toggleMax(record.id), "data-max"),
      winButton("Close", "×", () => void closeWindows([record.id])),
    );
    header.addEventListener("dblclick", (event) => {
      if ((event.target as HTMLElement).closest("button")) return;
      toggleMax(record.id);
    });
    header.addEventListener("pointerdown", (event) => startWindowDrag(event, record.id, header));

    const body = document.createElement("div");
    body.className = "desk-window-body";
    if (record.kind === "folder") body.append(folderBody(record.slug));
    else body.append(toolFrame(record));

    node.append(header, body);
    for (const edge of EDGES) {
      const handle = document.createElement("div");
      handle.className = `desk-resize edge-${edge}`;
      handle.addEventListener("pointerdown", (event) => startResize(event, record.id, edge));
      node.append(handle);
    }
    node.addEventListener("pointerdown", (event) => {
      if (state.activeId === record.id) return;
      if ((event.target as HTMLElement).closest(".desk-window-title button, .desk-resize")) return;
      event.preventDefault();
      event.stopPropagation();
      dispatch({ type: "activate", id: record.id });
    });
    return node;
  }

  function placeWindow(node: HTMLElement, record: DeskWindow): void {
    const active = state.activeId === record.id;
    node.classList.toggle("is-active", active);
    node.classList.toggle("is-max", record.mode === "maximized");
    node.hidden = state.concealed || record.mode === "minimized";
    if (node.hidden) node.setAttribute("inert", "");
    else node.removeAttribute("inert");
    node.style.zIndex = String(record.z);
    if (record.mode === "maximized") {
      node.style.left = "0";
      node.style.top = "0";
      node.style.width = "100%";
      node.style.height = "100%";
    } else {
      node.style.left = `${record.bounds.x}px`;
      node.style.top = `${record.bounds.y}px`;
      node.style.width = `${record.bounds.width}px`;
      node.style.height = `${record.bounds.height}px`;
    }
    const fav = node.querySelector<HTMLButtonElement>("[data-fav]");
    if (fav && record.kind === "tool") {
      const on = window.MDT?.favorites.isFavorite(record.slug) === true;
      fav.dataset.labelKey = on ? "Unfavorite" : "Favorite";
      fav.textContent = on ? "★" : "☆";
    }
    const info = record.kind === "tool" ? toolInfo(record.slug) : folderInfo(record.slug);
    const name = node.querySelector(".desk-window-name");
    if (name) name.textContent = windowTitle(record, info.label);
    const restore = record.mode === "maximized" || !!record.dock;
    for (const button of node.querySelectorAll<HTMLButtonElement>(".desk-win-btn")) {
      const key = button.dataset.labelKey === "Maximize" && restore ? "Restore" : button.dataset.labelKey;
      if (!key) continue;
      button.setAttribute("aria-label", text(key));
      button.title = text(key);
    }
    const maxBtn = node.querySelector<HTMLButtonElement>("[data-max]");
    if (maxBtn) maxBtn.textContent = restore ? "❐" : "□";
    const frame = node.querySelector("iframe");
    if (frame) frame.style.pointerEvents = active && !node.hidden ? "auto" : "none";
  }

  function toolFrame(record: DeskWindow): HTMLElement {
    const tool = tools.get(record.slug);
    const wrap = document.createElement("div");
    wrap.className = "desk-frame-wrap";
    const frame = document.createElement("iframe");
    frame.className = "desk-frame";
    frame.title = tool?.title || record.slug;
    frame.setAttribute("allow", "camera; clipboard-read; clipboard-write");
    if (tool) frame.src = `${tool.href}?embed=1`;
    const error = document.createElement("div");
    error.className = "desk-frame-error";
    error.hidden = true;
    const message = document.createElement("p");
    message.textContent = text("LoadError");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "ds-btn";
    retry.textContent = text("Retry");
    retry.addEventListener("click", () => {
      error.hidden = true;
      frame.src = frame.src;
    });
    error.append(message, retry);
    frame.addEventListener("error", () => {
      error.hidden = false;
    });
    wrap.append(frame, error);
    return wrap;
  }

  function folderBody(category: string): HTMLElement {
    const grid = document.createElement("div");
    grid.className = "desk-folder";
    for (const tool of payload.tools.filter((item) => item.category === category)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "desk-folder-tool";
      button.style.setProperty("--mdt-cat", `var(--mdt-cat-${tool.category})`);
      const mark = document.createElement("span");
      mark.className = "desk-icon-tile";
      mark.dataset.len = String(Math.min(4, [...tool.monogram].length));
      mark.textContent = tool.monogram;
      const label = document.createElement("span");
      label.textContent = tool.title;
      button.append(mark, label);
      button.addEventListener("click", () => openTool(tool.slug, false));
      button.addEventListener("dblclick", (event) => {
        event.preventDefault();
        openTool(tool.slug, false);
      });
      grid.append(button);
    }
    return grid;
  }

  function renderTasks(): void {
    taskHost.replaceChildren();
    const seen = new Set<string>();
    for (const id of prefs.pinned) {
      if (pinnedHasWindow(id)) continue;
      seen.add(id);
      taskHost.append(taskButton(shortcutInfo(id).label, false, () => openShortcut(id, false)));
    }
    for (const record of [...state.windows].sort((a, b) => a.z - b.z)) {
      const info = record.kind === "tool" ? toolInfo(record.slug) : folderInfo(record.slug);
      const button = taskButton(windowTitle(record, info.label), state.activeId === record.id && !state.concealed && record.mode !== "minimized", () => {
        if (state.activeId === record.id && record.mode !== "minimized" && !state.concealed) dispatch({ type: "minimize", id: record.id });
        else dispatch({ type: "activate", id: record.id });
      });
      if (record.mode === "minimized") button.classList.add("is-min");
      taskHost.append(button);
    }
    if (seen.size === 0 && state.windows.length === 0) {
      const hint = document.createElement("span");
      hint.className = "desk-task-hint";
      hint.textContent = text("Catalog");
      taskHost.append(hint);
    }
  }

  function taskButton(label: string, pressed: boolean, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "desk-task";
    button.textContent = label;
    button.setAttribute("aria-pressed", String(pressed));
    button.addEventListener("click", onClick);
    return button;
  }

  function openTool(slug: string, fresh: boolean): void {
    if (!tools.has(slug)) return;
    const copies = state.windows.filter((record) => record.kind === "tool" && record.slug === slug);
    const instance = fresh ? Math.max(0, ...copies.map((record) => record.instance)) + 1 : copies[0]?.instance ?? 1;
    dispatch({
      type: "open-tool",
      id: `tool-${slug}-${instance}-${crypto.randomUUID()}`,
      slug,
      instance,
      bounds: cascadeBounds(state.windows.length, deskSize(), iconStripWidth()),
      fresh,
    });
    window.MDT?.recent.record(slug);
  }

  function openFolder(category: string): void {
    if (!categories.has(category)) return;
    dispatch({
      type: "open-folder",
      id: `folder-${category}-${crypto.randomUUID()}`,
      category,
      bounds: cascadeBounds(state.windows.length, deskSize(), iconStripWidth()),
    });
  }

  function openShortcut(id: string, fresh: boolean): void {
    if (id.startsWith("cat:")) openFolder(id.slice(4));
    else if (id.startsWith("tool:")) openTool(id.slice(5), fresh);
  }

  function toggleMax(id: string): void {
    const record = state.windows.find((item) => item.id === id);
    if (!record) return;
    if (record.mode === "maximized" || record.dock) dispatch({ type: "restore", id });
    else dispatch({ type: "maximize", id });
  }

  async function closeWindows(ids: string[]): Promise<void> {
    const dirty = dirtyIds(ids);
    if (dirty.length > 0 && !(await askDiscard(dirty.length > 1))) return;
    dispatch({ type: "close-many", ids });
  }

  function dirtyIds(ids: readonly string[]): string[] {
    return ids.filter((id) => {
      const frame = document.querySelector<HTMLIFrameElement>(`[data-window-id="${CSS.escape(id)}"] iframe`);
      if (!frame) return false;
      try {
        return hasUserInput(snapshotFrame(frame));
      } catch {
        return false;
      }
    });
  }

  function askDiscard(many: boolean): Promise<boolean> {
    const title = discardDialog.querySelector("[data-discard-title]");
    const body = discardDialog.querySelector("[data-discard-body]");
    if (title) title.textContent = text("DiscardTitle");
    if (body) body.textContent = text(many ? "DiscardMany" : "DiscardBody");
    showDeskDialog(discardDialog);
    return new Promise((resolve) => {
      const stay = discardDialog.querySelector<HTMLButtonElement>("[data-discard-stay]");
      const close = discardDialog.querySelector<HTMLButtonElement>("[data-discard-close]");
      const finish = (value: boolean) => {
        stay?.removeEventListener("click", onStay);
        close?.removeEventListener("click", onClose);
        discardDialog.removeEventListener("cancel", onCancel);
        if (discardDialog.open) discardDialog.close();
        resolve(value);
      };
      const onStay = () => finish(false);
      const onClose = () => finish(true);
      const onCancel = (event: Event) => {
        event.preventDefault();
        finish(false);
      };
      stay?.addEventListener("click", onStay);
      close?.addEventListener("click", onClose);
      discardDialog.addEventListener("cancel", onCancel);
    });
  }

  function startWindowDrag(event: PointerEvent, id: string, header: HTMLElement): void {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    dispatch({ type: "activate", id });
    const record = state.windows.find((item) => item.id === id);
    if (!record) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = record.bounds;
    const wasFloating = record.mode === "maximized" || !!record.dock;
    const titleBox = header.getBoundingClientRect();
    const grab = titleBox.width > 0 ? (event.clientX - titleBox.left) / titleBox.width : 0.5;
    let dragging = false;
    let current = origin;
    const stageBox = () => stage.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      const box = stageBox();
      const pointerX = ev.clientX - box.left;
      const pointerY = ev.clientY - box.top;
      if (!dragging) {
        dragging = true;
        if (header.setPointerCapture) header.setPointerCapture(event.pointerId);
        current = wasFloating
          ? restoreUnderPointer(record.previousBounds ?? origin, pointerX, pointerY, grab, deskSize())
          : dragBounds(origin, ev.clientX - startX, ev.clientY - startY, deskSize());
      } else if (wasFloating) {
        current = dragBounds(current, ev.movementX, ev.movementY, deskSize());
      } else {
        current = dragBounds(origin, ev.clientX - startX, ev.clientY - startY, deskSize());
      }
      const node = header.closest<HTMLElement>(".desk-window");
      if (node) {
        node.classList.remove("is-max");
        node.style.left = `${current.x}px`;
        node.style.top = `${current.y}px`;
        node.style.width = `${current.width}px`;
        node.style.height = `${current.height}px`;
      }
      showSnap(snapTarget(pointerX, pointerY, deskSize()));
    };
    const onUp = (ev: PointerEvent) => {
      header.removeEventListener("pointermove", onMove);
      header.removeEventListener("pointerup", onUp);
      snap.hidden = true;
      if (!dragging) return;
      const box = stageBox();
      const target = snapTarget(ev.clientX - box.left, ev.clientY - box.top, deskSize());
      if (target === "max") dispatch({ type: "maximize", id });
      else if (target === "left" || target === "right") dispatch({ type: "dock", id, side: target, desk: deskSize() });
      else dispatch({ type: "move", id, bounds: current });
    };
    header.addEventListener("pointermove", onMove);
    header.addEventListener("pointerup", onUp);
  }

  function startResize(event: PointerEvent, id: string, edge: ResizeEdge): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const record = state.windows.find((item) => item.id === id);
    if (!record || record.mode === "maximized") return;
    dispatch({ type: "activate", id });
    const origin = record.dock ? dockBounds(deskSize(), record.dock) : record.bounds;
    const startX = event.clientX;
    const startY = event.clientY;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    let current = origin;
    const onMove = (ev: PointerEvent) => {
      current = resizeBounds(origin, edge, ev.clientX - startX, ev.clientY - startY, deskSize());
      const node = document.querySelector<HTMLElement>(`[data-window-id="${CSS.escape(id)}"]`);
      if (!node) return;
      node.style.left = `${current.x}px`;
      node.style.top = `${current.y}px`;
      node.style.width = `${current.width}px`;
      node.style.height = `${current.height}px`;
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      dispatch({ type: "move", id, bounds: current });
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }

  function showSnap(target: "left" | "right" | "max" | null): void {
    if (!target) {
      snap.hidden = true;
      return;
    }
    const desk = deskSize();
    const bounds: Bounds =
      target === "max"
        ? { x: 8, y: 8, width: Math.max(0, desk.width - 16), height: Math.max(0, desk.height - 16) }
        : dockBounds(desk, target);
    snap.hidden = false;
    snap.style.left = `${bounds.x}px`;
    snap.style.top = `${bounds.y}px`;
    snap.style.width = `${bounds.width}px`;
    snap.style.height = `${bounds.height}px`;
  }

  function startIconDrag(event: PointerEvent, id: string, button: HTMLButtonElement): void {
    if (event.button !== 0 || prefs.locked) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    const onMove = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      if (!dragging && button.setPointerCapture) button.setPointerCapture(event.pointerId);
      dragging = true;
      button.classList.add("is-dragging");
      const cell = cellAt(ev.clientX, ev.clientY);
      iconHost.querySelectorAll(".is-drop").forEach((node) => node.classList.remove("is-drop"));
      if (cell) iconHost.querySelector(`[data-shortcut-id="${CSS.escape(shortcutAt(cell) || "")}"]`)?.classList.add("is-drop");
    };
    const onUp = (ev: PointerEvent) => {
      button.removeEventListener("pointermove", onMove);
      button.removeEventListener("pointerup", onUp);
      document.removeEventListener("keydown", onKey);
      button.classList.remove("is-dragging");
      iconHost.querySelectorAll(".is-drop").forEach((node) => node.classList.remove("is-drop"));
      if (!dragging) return;
      ev.preventDefault();
      ev.stopPropagation();
      const cell = cellAt(ev.clientX, ev.clientY);
      if (!cell) return;
      const size = cellSize(prefs.iconSize);
      const desk = deskSize();
      const columns = stripColumns(prefs.shortcuts.length, desk.width, desk.height, size, prefs.positions, prefs.shortcuts);
      const rows = Math.max(1, Math.floor(desk.height / size.h));
      const laid = arrangeShortcuts(prefs.shortcuts, prefs.positions, columns, rows, prefs.positions);
      const positions = { ...prefs.positions };
      for (const shortcut of prefs.shortcuts) {
        if (!positions[shortcut] && laid.positions[shortcut]) positions[shortcut] = laid.positions[shortcut];
      }
      const next = moveShortcut(positions, prefs.shortcuts, id, cell);
      if (next === positions) return;
      prefs = { ...prefs, positions: next };
      scheduleSave();
      render();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      dragging = false;
      button.removeEventListener("pointermove", onMove);
      button.removeEventListener("pointerup", onUp);
      button.classList.remove("is-dragging");
      document.removeEventListener("keydown", onKey);
    };
    button.addEventListener("pointermove", onMove);
    button.addEventListener("pointerup", onUp);
    document.addEventListener("keydown", onKey);
  }

  function onKey(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === "k" || event.code === "KeyK")) {
      if (event.altKey) return;
      event.preventDefault();
      if (catalogDialog.open) catalogDialog.close();
      else openCatalog();
      return;
    }
    if (event.key === "Escape") hideMenu();
    const typing = event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable='true']");
    if (typing) return;
    const title = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(".desk-window-title") : null;
    if (title && event.key.startsWith("Arrow")) {
      const id = title.closest<HTMLElement>(".desk-window")?.dataset.windowId;
      nudgeWindow(id, event);
      return;
    }
    if (!selectedShortcut || prefs.locked) return;
    if ((event.ctrlKey || event.metaKey) && event.key.startsWith("Arrow")) {
      event.preventDefault();
      nudgeShortcut(selectedShortcut, event.key, event.shiftKey);
    } else if (event.key === "Enter" && selectedShortcut) {
      openShortcut(selectedShortcut, false);
    }
  }

  function nudgeWindow(id: string | undefined, event: KeyboardEvent): void {
    if (!id) return;
    const record = state.windows.find((item) => item.id === id);
    if (!record || record.mode !== "normal" || record.dock) return;
    event.preventDefault();
    const step = 16;
    const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    const bounds = event.shiftKey
      ? resizeBounds(record.bounds, "se", dx, dy, deskSize())
      : dragBounds(record.bounds, dx, dy, deskSize());
    dispatch({ type: "move", id, bounds });
  }

  function nudgeShortcut(id: string, key: string, grow: boolean): void {
    const size = cellSize(prefs.iconSize);
    const desk = deskSize();
    const columns = stripColumns(prefs.shortcuts.length, desk.width, desk.height, size, prefs.positions, prefs.shortcuts);
    const rows = Math.max(1, Math.floor(desk.height / size.h), Math.ceil(prefs.shortcuts.length / columns));
    const laid = arrangeShortcuts(prefs.shortcuts, prefs.positions, columns, rows, prefs.positions);
    const origin = laid.positions[id];
    if (!origin) return;
    const delta = key === "ArrowLeft" ? [-1, 0] : key === "ArrowRight" ? [1, 0] : key === "ArrowUp" ? [0, -1] : [0, 1];
    const destination = {
      column: origin.column + (grow ? 0 : delta[0]),
      row: origin.row + (grow ? 0 : delta[1]),
    };
    if (grow) return;
    const positions = { ...prefs.positions };
    for (const shortcut of prefs.shortcuts) {
      if (!positions[shortcut] && laid.positions[shortcut]) positions[shortcut] = laid.positions[shortcut];
    }
    const next = moveShortcut(positions, prefs.shortcuts, id, destination);
    if (next === positions) return;
    prefs = { ...prefs, positions: next };
    scheduleSave();
    render();
  }

  function showDeskDialog(dialog: HTMLDialogElement): void {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.addEventListener(
      "close",
      () => {
        opener?.focus();
      },
      { once: true },
    );
    dialog.showModal();
  }

  function openCatalog(): void {
    const input = catalogDialog.querySelector<HTMLInputElement>("[data-catalog-input]");
    if (input) input.value = "";
    fillCatalog("");
    showDeskDialog(catalogDialog);
    input?.focus();
  }

  function fillCatalog(query: string): void {
    const host = catalogDialog.querySelector<HTMLElement>("[data-catalog-results]");
    if (!host) return;
    host.replaceChildren();
    const needle = query.trim().toLowerCase();
    let hits = 0;
    for (const category of payload.categories) {
      const inCategory = payload.tools.filter((tool) => {
        if (tool.category !== category.id) return false;
        if (!needle) return true;
        return `${tool.title} ${tool.description} ${tool.slug} ${category.label}`.toLowerCase().includes(needle);
      });
      if (inCategory.length === 0) continue;
      hits += inCategory.length;
      const group = document.createElement("section");
      group.className = "desk-cat-group";
      const head = document.createElement("header");
      const heading = document.createElement("h3");
      heading.textContent = category.label;
      head.append(heading, pinButton(catShortcut(category.id)));
      const grid = document.createElement("div");
      grid.className = "desk-cat-grid";
      for (const tool of inCategory) {
        const row = document.createElement("div");
        row.className = "desk-cat-row";
        const open = document.createElement("button");
        open.type = "button";
        open.className = "desk-cat-open";
        open.textContent = tool.title;
        open.addEventListener("click", () => {
          catalogDialog.close();
          openTool(tool.slug, false);
        });
        row.append(open, pinButton(toolShortcut(tool.slug)));
        grid.append(row);
      }
      group.append(head, grid);
      host.append(group);
    }
    if (hits === 0) {
      const empty = document.createElement("p");
      empty.className = "desk-muted";
      empty.textContent = text("NoResults");
      host.append(empty);
    }
  }

  function pinButton(id: string): HTMLButtonElement {
    const pinned = prefs.shortcuts.includes(id);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "desk-pin";
    button.setAttribute("aria-pressed", String(pinned));
    const label = !pinned ? "PinShortcut" : id.startsWith("cat:") ? "UnpackFolder" : "RemoveShortcut";
    button.setAttribute("aria-label", text(label));
    button.title = text(label);
    button.textContent = pinned ? "✓" : "+";
    button.addEventListener("click", () => {
      toggleShortcut(id);
      fillCatalog(catalogDialog.querySelector<HTMLInputElement>("[data-catalog-input]")?.value || "");
    });
    return button;
  }

  function toggleShortcut(id: string): void {
    if (prefs.shortcuts.includes(id)) {
      if (id.startsWith("cat:")) unpackCategory(id.slice(4));
      else removeShortcut(id);
      return;
    }
    prefs = { ...prefs, shortcuts: [...prefs.shortcuts, id] };
    const laid = currentLayout();
    if (laid.positions[id]) prefs = { ...prefs, positions: { ...prefs.positions, [id]: laid.positions[id] } };
    scheduleSave();
    render();
  }

  function removeShortcut(id: string): void {
    const positions = { ...prefs.positions };
    delete positions[id];
    prefs = {
      ...prefs,
      shortcuts: prefs.shortcuts.filter((shortcut) => shortcut !== id),
      pinned: prefs.pinned.filter((shortcut) => shortcut !== id),
      positions,
    };
    if (selectedShortcut === id) selectedShortcut = null;
    scheduleSave();
    render();
  }

  function unpackCategory(category: string): void {
    const id = catShortcut(category);
    const positions = { ...prefs.positions };
    delete positions[id];
    const shortcuts = prefs.shortcuts.filter((shortcut) => shortcut !== id);
    for (const tool of payload.tools) {
      if (tool.category !== category) continue;
      const shortcut = toolShortcut(tool.slug);
      if (!shortcuts.includes(shortcut)) shortcuts.push(shortcut);
    }
    prefs = { ...prefs, shortcuts, positions };
    const laid = currentLayout();
    const nextPositions = { ...prefs.positions };
    for (const shortcut of shortcuts) {
      if (!nextPositions[shortcut] && laid.positions[shortcut]) nextPositions[shortcut] = laid.positions[shortcut];
    }
    prefs = { ...prefs, positions: nextPositions };
    scheduleSave();
    render();
  }

  function openOverview(): void {
    fillOverview("");
    showDeskDialog(overviewDialog);
    overviewDialog.querySelector<HTMLInputElement>("[data-overview-input]")?.focus();
  }

  function fillOverview(query: string): void {
    const host = overviewDialog.querySelector<HTMLElement>("[data-overview-list]");
    if (!host) return;
    host.replaceChildren();
    const needle = query.trim().toLowerCase();
    for (const record of [...state.windows].sort((a, b) => b.z - a.z)) {
      const info = record.kind === "tool" ? toolInfo(record.slug) : folderInfo(record.slug);
      const label = windowTitle(record, info.label);
      if (needle && !label.toLowerCase().includes(needle)) continue;
      const row = document.createElement("div");
      row.className = "desk-overview-row";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "desk-cat-open";
      open.textContent = label;
      if (record.id === state.activeId) open.setAttribute("aria-current", "true");
      open.addEventListener("click", () => {
        overviewDialog.close();
        dispatch({ type: "activate", id: record.id });
      });
      const frame = document.querySelector<HTMLIFrameElement>(`[data-window-id="${CSS.escape(record.id)}"] iframe`);
      if (frame) {
        try {
          if (hasUserInput(snapshotFrame(frame))) open.classList.add("is-dirty");
        } catch {
          /* a frame that is not readable yet has no input to warn about */
        }
      }
      const close = document.createElement("button");
      close.type = "button";
      close.className = "ds-btn";
      close.textContent = text("Close");
      close.addEventListener("click", () => {
        void closeWindows([record.id]).then(() => fillOverview(query));
      });
      row.append(open, close);
      host.append(row);
    }
  }

  function openTile(id: string): void {
    const others = state.windows.filter((record) => record.id !== id);
    if (others.length === 0) {
      dispatch({ type: "dock", id, side: "left", desk: deskSize() });
      return;
    }
    tileFor = id;
    const host = tileDialog.querySelector<HTMLElement>("[data-tile-list]");
    if (!host) return;
    host.replaceChildren();
    for (const record of others) {
      const info = record.kind === "tool" ? toolInfo(record.slug) : folderInfo(record.slug);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ds-btn";
      button.textContent = windowTitle(record, info.label);
      button.addEventListener("click", () => {
        host.querySelectorAll<HTMLElement>("[data-companion]").forEach((node) => {
          node.removeAttribute("aria-pressed");
          delete node.dataset.companion;
        });
        button.setAttribute("aria-pressed", "true");
        button.dataset.companion = record.id;
      });
      host.append(button);
    }
    showDeskDialog(tileDialog);
  }

  function wireTile(): void {
    tileDialog.querySelectorAll<HTMLButtonElement>("[data-ratio]").forEach((button) => {
      button.addEventListener("click", () => {
        const companion = tileDialog.querySelector<HTMLElement>("[data-companion]")?.dataset.companion;
        const ratio = button.dataset.ratio;
        if (!tileFor || !companion || (ratio !== "1:1" && ratio !== "2:1" && ratio !== "1:2")) return;
        dispatch({ type: "tile", id: tileFor, companionId: companion, ratio, desk: deskSize() });
        tileDialog.close();
      });
    });
  }

  function wireOverview(): void {
    overviewDialog.querySelector<HTMLInputElement>("[data-overview-input]")?.addEventListener("input", (event) => {
      fillOverview((event.target as HTMLInputElement).value);
    });
    overviewDialog.querySelector("[data-close-others]")?.addEventListener("click", () => {
      const keep = state.activeId;
      const ids = state.windows.map((record) => record.id).filter((id) => id !== keep);
      void closeWindows(ids).then(() => fillOverview(""));
    });
  }

  function wireSettings(): void {
    catalogDialog.querySelector<HTMLInputElement>("[data-catalog-input]")?.addEventListener("input", (event) => {
      fillCatalog((event.target as HTMLInputElement).value);
    });
    catalogDialog.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      const input = catalogDialog.querySelector<HTMLInputElement>("[data-catalog-input]");
      if (event.key === "Enter" && event.target === input) {
        event.preventDefault();
        catalogDialog.querySelector<HTMLButtonElement>(".desk-cat-open")?.click();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
      if ((event.key === "Home" || event.key === "End") && event.target === input) return;
      const items = [...catalogDialog.querySelectorAll<HTMLButtonElement>(".desk-cat-open")];
      if (items.length === 0) return;
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "ArrowUp" && index === 0) {
        event.preventDefault();
        input?.focus();
        return;
      }
      event.preventDefault();
      const next =
        event.key === "Home" ? 0
        : event.key === "End" ? items.length - 1
        : event.key === "ArrowDown" ? (index < 0 ? 0 : Math.min(items.length - 1, index + 1))
        : index <= 0 ? items.length - 1 : index - 1;
      items[next]?.focus();
    });
    settingsDialog.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((button) => {
      button.addEventListener("click", () => {
        settingsDialog.querySelectorAll("[data-preset]").forEach((node) => node.removeAttribute("aria-checked"));
        button.setAttribute("aria-checked", "true");
        previewSettings();
      });
    });
    settingsDialog.querySelector<HTMLInputElement>("[data-dim]")?.addEventListener("input", previewSettings);
    settingsDialog.querySelectorAll<HTMLInputElement>("[data-fit]").forEach((input) => input.addEventListener("change", previewSettings));
    settingsDialog.querySelector<HTMLInputElement>("[data-wallpaper-file]")?.addEventListener("change", (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (!file) return;
      void prepareWallpaper(file)
        .then((prepared) => {
          draftBlob = prepared.blob;
          draftRemoveImage = false;
          if (draftUrl) URL.revokeObjectURL(draftUrl);
          draftUrl = URL.createObjectURL(prepared.blob);
          const warning = settingsDialog.querySelector<HTMLElement>("[data-image-warning]");
          if (warning) warning.hidden = !prepared.tooSmall;
          previewSettings();
        })
        .catch(() => {
          const warning = settingsDialog.querySelector<HTMLElement>("[data-image-warning]");
          if (warning) {
            warning.hidden = false;
            warning.textContent = text("ImageInvalid");
          }
        });
    });
    settingsDialog.querySelector("[data-remove-image]")?.addEventListener("click", () => {
      draftBlob = null;
      draftRemoveImage = true;
      if (draftUrl) URL.revokeObjectURL(draftUrl);
      draftUrl = null;
      previewSettings();
    });
    settingsDialog.querySelector("[data-settings-apply]")?.addEventListener("click", () => void applySettings());
    settingsDialog.querySelector("[data-settings-cancel]")?.addEventListener("click", () => {
      draftBlob = null;
      draftRemoveImage = false;
      if (draftUrl) URL.revokeObjectURL(draftUrl);
      draftUrl = null;
      applyWallpaper(prefs, imageUrl);
      settingsDialog.close();
    });
    settingsDialog.querySelector("[data-align]")?.addEventListener("click", () => {
      const laid = currentLayout();
      prefs = { ...prefs, positions: packedPositions(prefs.shortcuts, laid.columns, laid.rows) };
      scheduleSave();
      render();
    });
    settingsDialog.querySelector("[data-restore-icons]")?.addEventListener("click", () => {
      prefs = { ...prefs, shortcuts: payload.categories.map((category) => catShortcut(category.id)), positions: {}, pinned: [] };
      scheduleSave();
      render();
      reflectSettings();
    });
    settingsDialog.querySelector("[data-reset-layout]")?.addEventListener("click", () => {
      void closeWindows(state.windows.map((record) => record.id));
    });
  }

  function openSettings(): void {
    draftBlob = null;
    draftRemoveImage = false;
    reflectSettings();
    showDeskDialog(settingsDialog);
  }

  function reflectSettings(): void {
    settingsDialog.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((button) => {
      button.setAttribute("aria-checked", String(button.dataset.preset === prefs.preset));
    });
    const dim = settingsDialog.querySelector<HTMLInputElement>("[data-dim]");
    if (dim) dim.value = String(prefs.dim);
    settingsDialog.querySelectorAll<HTMLInputElement>("[data-fit]").forEach((input) => {
      input.checked = input.value === prefs.fit;
    });
    const remember = settingsDialog.querySelector<HTMLInputElement>("[data-remember]");
    if (remember) remember.checked = readKey(ENTRY_KEY) === "1";
    settingsDialog.querySelectorAll<HTMLInputElement>("[data-icon-size]").forEach((input) => {
      input.checked = input.value === prefs.iconSize;
    });
    const locked = settingsDialog.querySelector<HTMLInputElement>("[data-lock]");
    if (locked) locked.checked = prefs.locked;
    const warning = settingsDialog.querySelector<HTMLElement>("[data-image-warning]");
    if (warning) {
      warning.hidden = true;
      warning.textContent = text("ImageTooSmall");
    }
  }

  function previewSettings(): void {
    const next = readSettingsForm();
    const url = draftRemoveImage ? null : draftUrl || imageUrl;
    applyWallpaper({ ...prefs, ...next, hasImage: !!url }, url);
  }

  function readSettingsForm(): Pick<DeskPrefs, "preset" | "fit" | "dim" | "iconSize" | "locked"> {
    const presetButton = settingsDialog.querySelector<HTMLButtonElement>("[data-preset][aria-checked='true']");
    const preset = (presetButton?.dataset.preset || prefs.preset) as DeskPrefs["preset"];
    const fitInput = settingsDialog.querySelector<HTMLInputElement>("[data-fit]:checked");
    const dim = Number(settingsDialog.querySelector<HTMLInputElement>("[data-dim]")?.value ?? prefs.dim);
    const icon = settingsDialog.querySelector<HTMLInputElement>("[data-icon-size]:checked");
    return {
      preset,
      fit: fitInput?.value === "contain" ? "contain" : "cover",
      dim: Number.isFinite(dim) ? dim : prefs.dim,
      iconSize: icon?.value === "large" ? "large" : "regular",
      locked: settingsDialog.querySelector<HTMLInputElement>("[data-lock]")?.checked === true,
    };
  }

  async function applySettings(): Promise<void> {
    const form = readSettingsForm();
    let hasImage = prefs.hasImage;
    try {
      if (draftRemoveImage) {
        await clearWallpaperBlob();
        if (imageUrl) URL.revokeObjectURL(imageUrl);
        imageUrl = null;
        hasImage = false;
      } else if (draftBlob) {
        await saveWallpaperBlob(draftBlob);
        if (imageUrl) URL.revokeObjectURL(imageUrl);
        imageUrl = draftUrl;
        draftUrl = null;
        hasImage = true;
      }
    } catch {
      const warning = settingsDialog.querySelector<HTMLElement>("[data-image-warning]");
      if (warning) {
        warning.hidden = false;
        warning.textContent = text("ImageInvalid");
      }
      return;
    }
    draftBlob = null;
    draftRemoveImage = false;
    prefs = { ...prefs, ...form, hasImage };
    try {
      localStorage.setItem(ENTRY_KEY, settingsDialog.querySelector<HTMLInputElement>("[data-remember]")?.checked ? "1" : "0");
    } catch {
      /* preference stays in memory for this visit */
    }
    applyWallpaper(prefs, imageUrl);
    scheduleSave();
    render();
    settingsDialog.close();
  }

  async function restoreImage(): Promise<void> {
    if (!prefs.hasImage) return;
    try {
      const blob = await loadWallpaperBlob();
      if (!blob) {
        prefs = { ...prefs, hasImage: false };
        return;
      }
      imageUrl = URL.createObjectURL(blob);
    } catch {
      prefs = { ...prefs, hasImage: false };
    }
  }

  function applyWallpaper(next: Pick<DeskPrefs, "preset" | "fit" | "dim" | "hasImage">, url: string | null): void {
    bg.className = `desk-bg wp-${next.preset}`;
    bg.classList.toggle("has-image", !!url);
    bg.classList.toggle("fit-contain", next.fit === "contain");
    if (url) bg.style.setProperty("--desk-image", `url("${url}")`);
    else bg.style.removeProperty("--desk-image");
    bg.style.setProperty("--desk-dim", String(next.dim / 100));
  }

  function openShortcutMenu(id: string, x: number, y: number): void {
    const info = shortcutInfo(id);
    const items: { label: string; run: () => void }[] = [
      { label: text("Open"), run: () => openShortcut(id, false) },
    ];
    if (id.startsWith("tool:")) {
      items.push({ label: text("OpenAnother"), run: () => openShortcut(id, true) });
      const slug = id.slice(5);
      const favorite = window.MDT?.favorites.isFavorite(slug) === true;
      items.push({
        label: text(favorite ? "Unfavorite" : "Favorite"),
        run: () => {
          window.MDT?.favorites.toggle(slug);
          render();
        },
      });
    }
    if (id.startsWith("cat:")) items.push({ label: text("UnpackFolder"), run: () => unpackCategory(id.slice(4)) });
    else items.push({ label: text("RemoveShortcut"), run: () => removeShortcut(id) });
    const pinned = prefs.pinned.includes(id);
    items.push({
      label: text(pinned ? "UnpinBar" : "PinBar"),
      run: () => {
        prefs = {
          ...prefs,
          pinned: pinned ? prefs.pinned.filter((item) => item !== id) : [...prefs.pinned, id],
        };
        scheduleSave();
        render();
      },
    });
    showMenu(items, x, y);
    void info;
  }

  function openSurfaceMenu(x: number, y: number): void {
    showMenu(
      [
        { label: text("Settings"), run: () => openSettings() },
        { label: text("AlignIcons"), run: () => settingsDialog.querySelector<HTMLButtonElement>("[data-align]")?.click() },
        {
          label: text("LockIcons"),
          run: () => {
            prefs = { ...prefs, locked: !prefs.locked };
            scheduleSave();
            render();
          },
        },
        { label: text("ShowDesktop"), run: () => dispatch({ type: state.concealed ? "reveal" : "conceal" }) },
      ],
      x,
      y,
    );
  }

  function showMenu(items: { label: string; run: () => void }[], x: number, y: number): void {
    menu.replaceChildren();
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "desk-menu-item";
      button.role = "menuitem";
      button.textContent = item.label;
      button.addEventListener("click", () => {
        hideMenu();
        item.run();
      });
      menu.append(button);
    }
    menu.hidden = false;
    menu.style.left = `${Math.min(x, window.innerWidth - 220)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - menu.offsetHeight - 8)}px`;
  }

  function hideMenu(): void {
    menu.hidden = true;
  }

  function showHelp(slug: string): void {
    const tool = tools.get(slug);
    const title = helpDialog.querySelector("[data-help-title]");
    const body = helpDialog.querySelector("[data-help-body]");
    if (title) title.textContent = tool?.title || slug;
    if (body) body.textContent = tool?.description || "";
    showDeskDialog(helpDialog);
  }

  function toggleTheme(): void {
    const root = document.documentElement;
    const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* theme stays for this document */
    }
  }

  function shortcutInfo(id: string): { label: string; mark: string; category: string; icon?: string } {
    if (id.startsWith("cat:")) return folderInfo(id.slice(4));
    return toolInfo(id.slice(5));
  }

  function toolInfo(slug: string): { label: string; mark: string; category: string } {
    const tool = tools.get(slug);
    return { label: tool?.title || slug, mark: tool?.monogram || slug.slice(0, 2).toUpperCase(), category: tool?.category || "encoding" };
  }

  function folderInfo(category: string): { label: string; mark: string; category: string; icon?: string } {
    const info = categories.get(category);
    return { label: info?.label || category, mark: info?.label.slice(0, 1) || "•", category, icon: info?.icon };
  }

  function windowTitle(record: DeskWindow, label: string): string {
    if (record.kind !== "tool") return label;
    const copies = state.windows.filter((item) => item.kind === "tool" && item.slug === record.slug);
    if (copies.length < 2) return label;
    return `${label} (${record.instance})`;
  }

  function shortcutIsOpen(id: string): boolean {
    if (id.startsWith("cat:")) return state.windows.some((record) => record.kind === "folder" && record.slug === id.slice(4));
    if (id.startsWith("tool:")) return state.windows.some((record) => record.kind === "tool" && record.slug === id.slice(5));
    return false;
  }

  function pinnedHasWindow(id: string): boolean {
    return shortcutIsOpen(id);
  }

  function currentLayout() {
    const size = cellSize(prefs.iconSize);
    const desk = deskSize();
    const columns = stripColumns(prefs.shortcuts.length, desk.width, desk.height, size, prefs.positions, prefs.shortcuts);
    const rows = Math.max(1, Math.floor((desk.height || size.h) / size.h));
    return arrangeShortcuts(prefs.shortcuts, prefs.positions, columns, rows, prefs.positions);
  }

  function cellAt(clientX: number, clientY: number): ShortcutCell | null {
    const box = iconHost.getBoundingClientRect();
    const size = cellSize(prefs.iconSize);
    const column = Math.floor((clientX - box.left) / size.w);
    const row = Math.floor((clientY - box.top + iconHost.scrollTop) / size.h);
    if (column < 0 || row < 0) return null;
    return { column, row };
  }

  function shortcutAt(cell: ShortcutCell): string | null {
    const size = cellSize(prefs.iconSize);
    const desk = deskSize();
    const columns = stripColumns(prefs.shortcuts.length, desk.width, desk.height, size, prefs.positions, prefs.shortcuts);
    const rows = Math.max(1, Math.floor((desk.height || size.h) / size.h));
    const laid = arrangeShortcuts(prefs.shortcuts, prefs.positions, columns, rows, prefs.positions);
    return Object.entries(laid.positions).find(([, value]) => value.column === cell.column && value.row === cell.row)?.[0] ?? null;
  }

  function iconStripWidth(): number {
    return iconHost.getBoundingClientRect().width;
  }

  function deskSize(): DeskSize {
    return { width: stage.clientWidth, height: stage.clientHeight };
  }

  function scheduleSave(): void {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      writeKey(LAYOUT_KEY, serializeLayout(state));
      writeKey(PREFS_KEY, serializePrefs(prefs));
    }, 400);
  }
}

function snapshotFrame(frame: HTMLIFrameElement): InputSnapshot {
  const doc = frame.contentDocument;
  const view = frame.contentWindow;
  if (!doc || !view) return { fileCount: 0, texts: [], editors: [] };
  let fileCount = 0;
  const texts: string[] = [];
  // `instanceof HTMLInputElement` uses the parent window and misses every
  // node inside the tool iframe. Use the frame's own constructors.
  for (const element of doc.querySelectorAll("input, textarea")) {
    if (element instanceof view.HTMLInputElement) {
      const type = element.type;
      if (["hidden", "checkbox", "radio", "button", "submit", "reset", "range", "color"].includes(type)) continue;
      if (element.readOnly || element.disabled) continue;
      if (type === "file") {
        fileCount += element.files?.length ?? 0;
        continue;
      }
      texts.push(element.value);
    } else if (element instanceof view.HTMLTextAreaElement && !element.readOnly && !element.disabled) {
      texts.push(element.value);
    }
  }
  const editors = [...doc.querySelectorAll(".cm-content")].map((node) => node.textContent ?? "");
  return { fileCount, texts, editors };
}

function winButton(key: string, glyph: string, onClick: () => void, attr?: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "desk-win-btn";
  button.dataset.labelKey = key;
  button.textContent = glyph;
  if (attr) button.setAttribute(attr, "");
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function svgWrap(body: string): string {
  return `<svg viewBox="0 0 20 20" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

function toolShortcut(slug: string): string {
  return `tool:${slug}`;
}

function catShortcut(category: string): string {
  return `cat:${category}`;
}

function must<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing desktop element ${selector}`);
  return node;
}

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* quota or private mode — the desk still works for this visit */
  }
}

declare global {
  interface Window {
    MDT?: {
      favorites: { isFavorite: (slug: string) => boolean; toggle: (slug: string) => boolean; list: () => string[] };
      recent: { list: () => { slug: string; ts: number }[]; clear: () => void; record: (slug: string) => void };
    };
  }
}
