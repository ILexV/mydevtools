/**
 * Desktop shell controller. Shortcuts, floating windows and the taskbar live
 * here; each tool runs in its own iframe (`?embed=1`) so the page controllers
 * keep their one-root-per-document assumption. The address bar stays on
 * `/{lang}/desktop/`. Full tool pages remain the canonical URLs.
 */

import "@/scripts/favorites.ts";
import { cascadeBounds, denormalizeBounds, dockBounds, dragBounds, resizeBounds, restoreUnderPointer, snapTarget } from "./bounds.ts";
import { trackUserInput } from "./dirty.ts";
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
import { createTaskPreview } from "./task-preview.ts";
import type { Bounds, DeskSize, DeskState, DeskWindow, ResizeEdge, ShortcutCell } from "./types.ts";
import { emptyDesk } from "./types.ts";
import { clearWallpaperBlob, loadWallpaperBlob, prepareWallpaper, saveWallpaperBlob } from "./wallpaper.ts";
import {
  captureWorkspace,
  isWorkspaceName,
  moveWidget,
  shiftWidget,
  type SavedWorkspace,
  type WidgetId,
} from "./workspaces.ts";

interface ToolInfo {
  slug: string;
  title: string;
  description: string;
  monogram: string;
  icon?: string;
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
  icons: Record<string, string>;
}

/** What a tile needs: a category colour and either a category glyph or a tool monogram. */
interface TileInfo {
  label: string;
  mark: string;
  category: string;
  icon?: string;
}

/** A context-menu row. `checked` draws a tick and uses menuitemradio. */
type MenuEntry =
  | { kind: "label"; label: string }
  | { kind: "item"; label: string; checked?: boolean; icon?: string; run: () => void }
  | { kind: "separator" };

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
  const glyph = (name: string, size = 16) => svgWrap(payload.icons[name] || "", size);
  /** Launcher filter: every tool, only what is on the desk, or one category. */
  let catalogScope = "all";

  let prefs = parsePrefs(readKey(PREFS_KEY), slugs, categoryIds) ?? defaultPrefs(payload.categories.map((category) => category.id));
  let state: DeskState = parseLayout(readKey(LAYOUT_KEY), slugs, categoryIds) ?? emptyDesk;
  // Folders open as popovers now; folder windows saved by an older version are dropped.
  const folderIds = state.windows.filter((record) => record.kind === "folder").map((record) => record.id);
  if (folderIds.length > 0) state = desktopReducer(state, { type: "close-many", ids: folderIds });
  let saveTimer = 0;
  let ready = false;
  let selectedShortcut: string | null = null;
  let selectedShortcuts = new Set<string>();
  type ShortcutSnapshot = Pick<DeskPrefs, "shortcuts" | "positions" | "pinned">;
  const shortcutHistory: ShortcutSnapshot[] = [];
  let layoutNoticeDismissed = false;
  let cancelShortcutGesture: (() => void) | null = null;
  /** Set between the pointerup of an icon drag and the click the browser fires right after it. */
  let iconDragJustEnded = false;
  let tileFor: string | null = null;
  let imageUrl: string | null = null;
  let draftUrl: string | null = null;
  let draftBlob: Blob | null = null;
  let draftRemoveImage = false;

  const stage = must<HTMLElement>("[data-desk-stage]");
  const widgetHost = must<HTMLElement>("[data-desk-widgets]");
  const iconHost = must<HTMLElement>("[data-desk-icons]");
  const windowHost = must<HTMLElement>("[data-desk-windows]");
  const taskHost = must<HTMLElement>("[data-desk-tasks]");
  const frameInput = new WeakMap<HTMLIFrameElement, () => boolean>();
  const snap = must<HTMLElement>("[data-desk-snap]");
  const bg = must<HTMLElement>("[data-desk-bg]");
  const menu = must<HTMLElement>("[data-desk-menu]");
  const pop = must<HTMLElement>("[data-desk-pop]");
  /** Shortcut id whose folder popover is open, or null. */
  let popFor: string | null = null;
  const catalogDialog = must<HTMLDialogElement>("[data-catalog-dialog]");
  const settingsDialog = must<HTMLDialogElement>("[data-settings-dialog]");
  const overviewDialog = must<HTMLDialogElement>("[data-overview-dialog]");
  const discardDialog = must<HTMLDialogElement>("[data-discard-dialog]");
  const helpDialog = must<HTMLDialogElement>("[data-help-dialog]");
  const tileDialog = must<HTMLDialogElement>("[data-tile-dialog]");
  const taskPreview = createTaskPreview(taskHost, {
    strings: payload.strings,
    describe(id) {
      const record = state.windows.find((item) => item.id === id);
      if (!record) return null;
      const info = record.kind === "tool" ? toolInfo(record.slug) : folderInfo(record.slug);
      return {
        title: windowTitle(record, info.label),
        state: record.mode === "minimized" ? "minimized" : state.activeId === id && !state.concealed ? "active" : "open",
        dirty: dirtyIds([id]).length > 0,
      };
    },
    activate: (id) => dispatch({ type: "activate", id }),
    close: (id) => closeWindows([id]),
  });

  document.querySelectorAll("[data-layout-undo]").forEach((button) => button.addEventListener("click", undoShortcutLayout));
  document.querySelector("[data-layout-dismiss]")?.addEventListener("click", () => {
    layoutNoticeDismissed = true;
    const notice = document.querySelector<HTMLElement>("[data-layout-notice]");
    if (notice) notice.hidden = true;
  });
  stage.addEventListener("pointerdown", startSelectionRectangle);
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
  document.querySelector("[data-hint-dismiss]")?.addEventListener("click", () => {
    prefs = { ...prefs, hintDismissed: true };
    scheduleSave();
    render();
  });
  document.addEventListener("pointerdown", (event) => {
    const target = event.target as HTMLElement;
    if (!menu.hidden && !menu.contains(target)) hideMenu();
    // The folder's own shortcut toggles it in its click handler.
    if (popFor && !pop.contains(target) && !isPopAnchor(target)) hidePop(false);
  });
  // Focus moving into a tool iframe never reaches this document as a pointerdown.
  window.addEventListener("blur", () => {
    hidePop(false);
    cancelShortcutGesture?.();
  });
  pop.addEventListener("focusout", (event) => {
    const next = event.relatedTarget as HTMLElement | null;
    if (!next || pop.contains(next) || isPopAnchor(next)) return;
    hidePop(false);
  });
  pop.addEventListener("keydown", onPopKey);
  stage.addEventListener("contextmenu", (event) => {
    if ((event.target as HTMLElement).closest(".desk-window, .desk-icon, .desk-widget")) return;
    event.preventDefault();
    openSurfaceMenu(event.clientX, event.clientY);
  });
  window.addEventListener("resize", () => {
    hidePop(false);
    taskPreview.hide();
    cancelShortcutGesture?.();
    dispatch({ type: "clamp", desk: deskSize() });
  });
  window.addEventListener("storage", (event) => {
    if (event.key === "mdt.favorites.v1" || event.key === "mdt.recent.v1") render();
  });
  window.addEventListener("beforeunload", (event) => {
    if (ready) flushSave();
    if (dirtyIds(state.windows.map((record) => record.id)).length === 0) return;
    event.preventDefault();
    event.returnValue = "";
  });
  wireSettings();
  wireOverview();
  wireTile();
  wireWorkspaces();
  startClock();

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
    cancelShortcutGesture?.();
    renderWidgets();
    renderIcons();
    renderWindows();
    renderTasks();
    for (const id of selectedShortcuts) if (!prefs.shortcuts.includes(id)) selectedShortcuts.delete(id);
    document.querySelectorAll<HTMLButtonElement>("[data-layout-undo]").forEach((button) => { button.disabled = shortcutHistory.length === 0; });
    const notice = document.querySelector<HTMLElement>("[data-layout-notice]");
    if (notice) notice.hidden = layoutNoticeDismissed || shortcutHistory.length === 0;
    document.body.classList.toggle("is-concealed", state.concealed);
    document.body.dataset.density = prefs.density;
    document.body.dataset.iconSize = prefs.iconSize;
    const hint = document.querySelector<HTMLElement>("[data-desk-hint]");
    if (hint) hint.hidden = prefs.hintDismissed;
    const count = document.querySelector<HTMLElement>("[data-desk-count]");
    if (count) {
      count.hidden = state.windows.length === 0;
      count.textContent = String(state.windows.length);
    }
    document.querySelector("[data-desk-show]")?.setAttribute("aria-pressed", String(state.concealed));
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
    const size = iconCell();
    const desk = deskSize();
    const columns = stripColumns(prefs.shortcuts.length, iconAreaWidth(desk.width), desk.height, size, prefs.positions, prefs.shortcuts);
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
    button.setAttribute("aria-pressed", String(selectedShortcuts.has(id)));
    if (!prefs.locked && !prefs.hintDismissed) button.setAttribute("aria-describedby", "desk-move-hint");
    if (!prefs.locked) {
      button.setAttribute("aria-keyshortcuts", "Control+ArrowLeft Control+ArrowRight Control+ArrowUp Control+ArrowDown");
    }
    const info = shortcutInfo(id);
    button.style.setProperty("--mdt-cat", `var(--mdt-cat-${info.category})`);
    button.title = info.label;
    button.classList.toggle("is-folder", id.startsWith("cat:"));
    const tile = makeTile(info, "desk-icon-tile");
    const label = document.createElement("span");
    label.className = "desk-icon-label";
    label.textContent = info.label;
    button.append(tile, label);
    if (id.startsWith("tool:") && window.MDT?.favorites.isFavorite(id.slice(5))) {
      const star = document.createElement("span");
      star.className = "desk-icon-fav";
      star.innerHTML = glyph("star", 11);
      star.setAttribute("aria-hidden", "true");
      tile.append(star);
    }
    if (shortcutIsOpen(id)) {
      const dot = document.createElement("span");
      dot.className = "desk-icon-dot";
      tile.append(dot);
    }
    button.addEventListener("focus", () => { selectedShortcut = id; });
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      selectedShortcut = id;
      if (event.ctrlKey || event.metaKey) {
        if (selectedShortcuts.has(id)) selectedShortcuts.delete(id);
        else selectedShortcuts.add(id);
      } else if (!selectedShortcuts.has(id)) {
        selectedShortcuts = new Set([id]);
      }
      reflectShortcutSelection();
      button.focus({ preventScroll: true });
      if (selectedShortcuts.has(id)) startIconDrag(event, id, button);
    });
    // A click opens; modified clicks select, and a drag never opens anything.
    button.addEventListener("click", (event) => {
      if (iconDragJustEnded) {
        iconDragJustEnded = false;
        return;
      }
      if (event.ctrlKey || event.metaKey) {
        if (event.detail === 0) {
          if (selectedShortcuts.has(id)) selectedShortcuts.delete(id);
          else selectedShortcuts.add(id);
          reflectShortcutSelection();
        }
        return;
      }
      selectedShortcuts = new Set([id]);
      reflectShortcutSelection();
      // A double click out of habit must not close the popover the first click opened.
      if (event.detail > 1) return;
      if (popFor === id) hidePop(true);
      else openShortcut(id, false, button);
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectedShortcut = id;
      openShortcutMenu(id, event.clientX, event.clientY);
    });
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
    const mark = makeTile(info, "desk-window-mark");
    const name = document.createElement("h2");
    name.className = "desk-window-name";
    const actions = document.createElement("div");
    actions.className = "desk-window-actions";
    header.append(mark, name, actions);
    if (record.kind === "tool") {
      actions.append(
        winButton("Favorite", glyph("star"), () => {
          window.MDT?.favorites.toggle(record.slug);
          render();
        }, "data-fav"),
        winButton("Help", glyph("help"), () => showHelp(record.slug)),
      );
    }
    const more = winButton("WindowMenu", glyph("more"), () => {
      const box = more.getBoundingClientRect();
      openWindowMenu(record.id, box.right - 220, box.bottom + 4);
    });
    more.setAttribute("aria-haspopup", "menu");
    const gap = document.createElement("span");
    gap.className = "desk-window-gap";
    actions.append(
      more,
      gap,
      winButton("Minimize", glyph("minimize"), () => dispatch({ type: "minimize", id: record.id })),
      winButton("Maximize", glyph("maximize"), () => toggleMax(record.id), "data-max"),
      winButton("Close", glyph("close"), () => void closeWindows([record.id]), "data-close"),
    );
    header.addEventListener("dblclick", (event) => {
      if ((event.target as HTMLElement).closest("button")) return;
      toggleMax(record.id);
    });
    header.addEventListener("contextmenu", (event) => {
      if ((event.target as HTMLElement).closest("button")) return;
      event.preventDefault();
      dispatch({ type: "activate", id: record.id });
      openWindowMenu(record.id, event.clientX, event.clientY);
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
    const body = node.querySelector(".desk-window-body");
    // A hidden frame leaves the tab order. A visible frame behind the active
    // one keeps its title reachable, but its tool document does not.
    if (node.hidden) node.setAttribute("inert", "");
    else node.removeAttribute("inert");
    if (node.hidden || !active) body?.setAttribute("inert", "");
    else body?.removeAttribute("inert");
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
      fav.classList.toggle("is-on", on);
      fav.setAttribute("aria-pressed", String(on));
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
    if (maxBtn && maxBtn.dataset.glyph !== String(restore)) {
      maxBtn.dataset.glyph = String(restore);
      maxBtn.innerHTML = glyph(restore ? "restore" : "maximize");
    }
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
    frame.addEventListener("load", () => {
      if (frame.contentDocument) frameInput.set(frame, trackUserInput(frame.contentDocument));
    });
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
      const mark = makeTile(toolInfo(tool.slug), "desk-icon-tile");
      const label = document.createElement("span");
      label.className = "desk-folder-label";
      label.textContent = tool.title;
      button.title = tool.title;
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
    taskPreview.hide();
    taskHost.replaceChildren();
    const seen = new Set<string>();
    for (const id of prefs.pinned) {
      if (pinnedHasWindow(id)) continue;
      seen.add(id);
      const button = taskButton(shortcutInfo(id), shortcutInfo(id).label, false, () => {
        if (popFor === id) hidePop(false);
        else openShortcut(id, false, button);
      });
      button.classList.add("is-pinned");
      button.dataset.popAnchor = id;
      taskHost.append(button);
    }
    for (const record of [...state.windows].sort((a, b) => a.z - b.z)) {
      const info = record.kind === "tool" ? toolInfo(record.slug) : folderInfo(record.slug);
      const button = taskButton(info, windowTitle(record, info.label), state.activeId === record.id && !state.concealed && record.mode !== "minimized", () => {
        if (state.activeId === record.id && record.mode !== "minimized" && !state.concealed) dispatch({ type: "minimize", id: record.id });
        else dispatch({ type: "activate", id: record.id });
      });
      button.classList.add("is-running");
      if (record.mode === "minimized") button.classList.add("is-min");
      taskPreview.bind(button, record.id);
      taskHost.append(button);
    }
  }

  function taskButton(info: TileInfo, label: string, pressed: boolean, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "desk-task";
    button.title = label;
    button.style.setProperty("--mdt-cat", `var(--mdt-cat-${info.category})`);
    const name = document.createElement("span");
    name.className = "desk-task-name";
    name.textContent = label;
    button.append(makeTile(info, "desk-task-tile"), name);
    button.setAttribute("aria-pressed", String(pressed));
    button.addEventListener("click", onClick);
    return button;
  }

  function openTool(slug: string, fresh: boolean): void {
    if (!tools.has(slug)) return;
    window.MDT?.recent.record(slug);
    const copies = state.windows.filter((record) => record.kind === "tool" && record.slug === slug);
    const instance = fresh ? Math.max(0, ...copies.map((record) => record.instance)) + 1 : copies[0]?.instance ?? 1;
    const before = state;
    dispatch({
      type: "open-tool",
      id: `tool-${slug}-${instance}-${crypto.randomUUID()}`,
      slug,
      instance,
      bounds: cascadeBounds(state.windows.length, windowDesk(), iconStripWidth(), slug),
      fresh,
    });
    if (state === before) renderWidgets();
  }

  function openShortcut(id: string, fresh: boolean, anchor?: HTMLElement | null): void {
    if (id.startsWith("tool:")) {
      hidePop(false);
      openTool(id.slice(5), fresh);
      return;
    }
    if (!id.startsWith("cat:")) return;
    const from = anchor ?? iconHost.querySelector<HTMLElement>(`[data-shortcut-id="${CSS.escape(id)}"]`);
    if (from) showPop(id, from);
    else {
      catalogScope = id.slice(4);
      openLauncherScoped();
    }
  }

  function openLauncherScoped(): void {
    const input = catalogDialog.querySelector<HTMLInputElement>("[data-catalog-input]");
    if (input) input.value = "";
    fillCatalog("");
    showDeskDialog(catalogDialog);
    input?.focus();
  }

  /**
   * Folder popover: the category's tools in a small glass panel beside its
   * shortcut (above a taskbar button). Choosing a tool, Escape, a click on
   * another shortcut, a window or the wallpaper closes it. Replaces folder windows.
   */
  function showPop(id: string, anchor: HTMLElement): void {
    const category = id.slice(4);
    const info = folderInfo(category);
    const list = payload.tools.filter((tool) => tool.category === category);
    popFor = id;
    pop.replaceChildren();
    pop.style.setProperty("--mdt-cat", `var(--mdt-cat-${category})`);
    pop.style.setProperty("--desk-tile", `var(--desk-tile-${category})`);
    const head = document.createElement("header");
    head.className = "desk-pop-head";
    const title = document.createElement("h2");
    title.id = "desk-pop-title";
    title.textContent = info.label;
    const count = document.createElement("span");
    count.className = "desk-pop-count";
    count.textContent = String(list.length);
    head.append(makeTile(info, "desk-pop-tile"), title, count);
    const grid = document.createElement("div");
    grid.className = "desk-pop-grid";
    const columns = list.length <= 4 ? list.length : list.length <= 6 ? 3 : list.length <= 9 ? 3 : 4;
    grid.style.setProperty("--pop-cols", String(Math.max(1, columns)));
    for (const tool of list) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "desk-pop-tool";
      button.title = tool.description;
      const mark = makeTile(toolInfo(tool.slug), "desk-pop-tool-tile");
      if (shortcutIsOpen(toolShortcut(tool.slug))) {
        const dotEl = document.createElement("span");
        dotEl.className = "desk-icon-dot";
        mark.append(dotEl);
      }
      const name = document.createElement("span");
      name.className = "desk-pop-name";
      name.textContent = tool.title;
      button.append(mark, name);
      button.addEventListener("click", () => {
        hidePop(false);
        openTool(tool.slug, false);
      });
      grid.append(button);
    }
    pop.append(head, grid);
    pop.hidden = false;
    placePop(anchor);
    iconHost.querySelectorAll(".desk-icon.is-open-pop").forEach((node) => node.classList.remove("is-open-pop"));
    anchor.classList.add("is-open-pop");
    pop.querySelector<HTMLButtonElement>(".desk-pop-tool")?.focus({ preventScroll: true });
  }

  /** Right of the shortcut when it fits, else left; above the anchor when it sits in the taskbar. */
  function placePop(anchor: HTMLElement): void {
    const box = anchor.getBoundingClientRect();
    const stageBox = stage.getBoundingClientRect();
    const width = pop.offsetWidth;
    const height = pop.offsetHeight;
    const gap = 10;
    let left: number;
    let top: number;
    let side: string;
    if (box.top >= stageBox.bottom - 4) {
      left = box.left + box.width / 2 - width / 2;
      top = box.top - height - gap;
      side = "bottom";
    } else {
      side = "left";
      left = box.right + gap;
      if (left + width > stageBox.right - 8) {
        left = box.left - width - gap;
        side = "right";
      }
      top = box.top - 6;
    }
    left = Math.max(stageBox.left + 8, Math.min(left, stageBox.right - width - 8));
    top = Math.max(stageBox.top + 8, Math.min(top, stageBox.bottom - height - 8));
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
    pop.dataset.from = side;
  }

  /** The shortcut or pinned taskbar button of the open folder: its own click toggles the popover. */
  function isPopAnchor(node: HTMLElement): boolean {
    if (!popFor || !node.closest) return false;
    const id = CSS.escape(popFor);
    return !!node.closest(`[data-shortcut-id="${id}"], [data-pop-anchor="${id}"]`);
  }

    function hidePop(returnFocus: boolean): void {
    if (!popFor) return;
    const id = popFor;
    popFor = null;
    pop.hidden = true;
    pop.replaceChildren();
    document.querySelectorAll(".is-open-pop").forEach((node) => node.classList.remove("is-open-pop"));
    if (returnFocus) iconHost.querySelector<HTMLElement>(`[data-shortcut-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  }

  /** Arrows walk the grid, Home/End jump, Escape closes back to the shortcut. */
  function onPopKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      hidePop(true);
      return;
    }
    const items = [...pop.querySelectorAll<HTMLButtonElement>(".desk-pop-tool")];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const columns = Number(pop.querySelector<HTMLElement>(".desk-pop-grid")?.style.getPropertyValue("--pop-cols")) || 1;
    const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns };
    let next = index;
    if (event.key in step) next = index + step[event.key];
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else return;
    event.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, next))]?.focus();
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
        return frameInput.get(frame)?.() ?? false;
      } catch {
        return false;
      }
    });
  }

  function askDiscard(many: boolean, copy?: { title: string; body: string; confirm: string }): Promise<boolean> {
    const title = discardDialog.querySelector("[data-discard-title]");
    const body = discardDialog.querySelector("[data-discard-body]");
    if (title) title.textContent = copy?.title ?? text("DiscardTitle");
    if (body) body.textContent = copy?.body ?? text(many ? "DiscardMany" : "DiscardBody");
    const close = discardDialog.querySelector<HTMLButtonElement>("[data-discard-close]");
    const previousConfirm = close?.textContent ?? "";
    if (close && copy) close.textContent = copy.confirm;
    showDeskDialog(discardDialog);
    return new Promise((resolve) => {
      const stay = discardDialog.querySelector<HTMLButtonElement>("[data-discard-stay]");
      const finish = (value: boolean) => {
        stay?.removeEventListener("click", onStay);
        close?.removeEventListener("click", onClose);
        discardDialog.removeEventListener("cancel", onCancel);
        if (close) close.textContent = previousConfirm;
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
    // Capture on press: a quick flick off the title (onto a tool iframe) must not drop the drag.
    header.setPointerCapture?.(event.pointerId);
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

  function reflectShortcutSelection(): void {
    for (const icon of iconHost.querySelectorAll<HTMLButtonElement>("[data-shortcut-id]")) {
      icon.setAttribute("aria-pressed", String(selectedShortcuts.has(icon.dataset.shortcutId!)));
    }
  }

  function commitShortcutLayout(patch: Partial<ShortcutSnapshot>): void {
    const before = { shortcuts: prefs.shortcuts, positions: prefs.positions, pinned: prefs.pinned };
    const next = { ...before, ...patch };
    if (JSON.stringify(before) === JSON.stringify(next)) return;
    shortcutHistory.push(before);
    layoutNoticeDismissed = false;
    if (shortcutHistory.length > 20) shortcutHistory.shift();
    prefs = { ...prefs, ...next };
    scheduleSave();
    render();
  }

  function undoShortcutLayout(): void {
    const previous = shortcutHistory.pop();
    if (!previous) return;
    cancelShortcutGesture?.();
    hidePop(false);
    prefs = { ...prefs, ...previous };
    scheduleSave();
    render();
  }

  function startSelectionRectangle(event: PointerEvent): void {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, a, input, .desk-window, .desk-widget, .desk-hint")) return;
    event.preventDefault();
    const previous = new Set(selectedShortcuts);
    const base = event.ctrlKey || event.metaKey ? previous : new Set<string>();
    selectedShortcuts = new Set(base);
    selectedShortcut = null;
    reflectShortcutSelection();
    const bounds = stage.getBoundingClientRect();
    const band = document.createElement("div");
    band.className = "desk-selection-band";
    band.setAttribute("aria-hidden", "true");
    const icons = [...iconHost.querySelectorAll<HTMLElement>("[data-shortcut-id]")].map((node) => ({ id: node.dataset.shortcutId!, box: node.getBoundingClientRect() }));
    const startX = event.clientX;
    const startY = event.clientY;
    stage.setPointerCapture(event.pointerId);
    const move = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4 && !band.isConnected) return;
      if (!band.isConnected) stage.append(band);
      const x = Math.max(bounds.left, Math.min(bounds.right, ev.clientX));
      const y = Math.max(bounds.top, Math.min(bounds.bottom, ev.clientY));
      const left = Math.min(startX, x);
      const top = Math.min(startY, y);
      const right = Math.max(startX, x);
      const bottom = Math.max(startY, y);
      Object.assign(band.style, { left: `${left - bounds.left}px`, top: `${top - bounds.top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
      selectedShortcuts = new Set(base);
      for (const { id, box } of icons) {
        if (box.right > left && box.left < right && box.bottom > top && box.top < bottom) selectedShortcuts.add(id);
      }
      selectedShortcut = selectedShortcuts.values().next().value ?? null;
      reflectShortcutSelection();
    };
    const finish = (cancel: boolean) => {
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerup", up);
      stage.removeEventListener("pointercancel", up);
      stage.removeEventListener("lostpointercapture", up);
      document.removeEventListener("keydown", key);
      cancelShortcutGesture = null;
      if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
      band.remove();
      if (cancel) {
        selectedShortcuts = previous;
        selectedShortcut = previous.values().next().value ?? null;
        reflectShortcutSelection();
      }
    };
    const up = (ev: PointerEvent) => finish(ev.type !== "pointerup");
    const key = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") { ev.preventDefault(); finish(true); }
    };
    cancelShortcutGesture = () => finish(true);
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerup", up);
    stage.addEventListener("pointercancel", up);
    stage.addEventListener("lostpointercapture", up);
    document.addEventListener("keydown", key);
  }

  function startIconDrag(event: PointerEvent, id: string, button: HTMLButtonElement): void {
    if (event.button !== 0 || prefs.locked) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const size = iconCell();
    const laid = currentLayout();
    const positions = { ...prefs.positions, ...laid.positions };
    const ids = [...selectedShortcuts];
    const selected = new Set(ids);
    const stageBox = stage.getBoundingClientRect();
    const hostBox = iconHost.getBoundingClientRect();
    const maxColumns = Math.max(1, Math.floor(iconAreaWidth(stageBox.width) / size.w));
    const maxRows = Math.max(laid.rows, Math.floor(stageBox.height / size.h));
    const previews: HTMLElement[] = [];
    const targets: HTMLElement[] = [];
    const icons = [...iconHost.querySelectorAll<HTMLElement>("[data-shortcut-id]")];
    let dragging = false;
    let cancelled = false;
    let lastCell = "";
    let plan = positions;
    const clearPreview = () => {
      for (const node of previews) node.remove();
      for (const node of targets) node.remove();
      for (const node of icons) {
        node.classList.remove("is-dragging", "is-swap-preview", "is-covered");
        node.style.removeProperty("translate");
      }
    };
    button.setPointerCapture(event.pointerId);
    const onMove = (ev: PointerEvent) => {
      if (cancelled) return;
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      if (!dragging) {
        hidePop(false);
        for (const node of icons) {
          if (!selected.has(node.dataset.shortcutId!)) continue;
          const box = node.getBoundingClientRect();
          const preview = node.cloneNode(true) as HTMLElement;
          preview.classList.add("is-drag-preview");
          preview.removeAttribute("data-shortcut-id");
          preview.removeAttribute("title");
          preview.setAttribute("aria-hidden", "true");
          preview.inert = true;
          preview.tabIndex = -1;
          Object.assign(preview.style, { left: `${box.left - stageBox.left}px`, top: `${box.top - stageBox.top}px`, width: `${box.width}px` });
          stage.append(preview);
          previews.push(preview);
          node.classList.add("is-dragging");
        }
        dragging = true;
      }
      for (const preview of previews) preview.style.translate = `${ev.clientX - startX}px ${ev.clientY - startY}px`;
      const cell = cellAt(ev.clientX, ev.clientY);
      const cellKey = cell ? `${cell.column}:${cell.row}` : "outside";
      if (cellKey === lastCell) return;
      lastCell = cellKey;
      plan = cell ? moveShortcut(positions, prefs.shortcuts, id, cell, ids) : positions;
      if (ids.some((key) => plan[key]!.column >= maxColumns || plan[key]!.row >= maxRows) ||
          ev.clientX < stageBox.left || ev.clientX >= stageBox.right || ev.clientY < stageBox.top || ev.clientY >= stageBox.bottom) plan = positions;
      for (const target of targets) target.remove();
      targets.length = 0;
      const valid = plan !== positions || (cell?.column === positions[id]!.column && cell?.row === positions[id]!.row);
      for (const preview of previews) preview.classList.toggle("is-invalid", !valid);
      const occupiedSources = new Set<string>();
      for (const key of prefs.shortcuts) {
        if (!selected.has(key) && plan[key] !== positions[key]) occupiedSources.add(`${plan[key]!.column}:${plan[key]!.row}`);
      }
      for (const node of icons) {
        const key = node.dataset.shortcutId!;
        const from = positions[key]!;
        const to = plan[key]!;
        node.classList.toggle("is-swap-preview", !selected.has(key) && to !== from);
        node.classList.toggle("is-covered", selected.has(key) && occupiedSources.has(`${from.column}:${from.row}`));
        node.style.translate = selected.has(key) ? "" : `${(to.column - from.column) * size.w}px ${(to.row - from.row) * size.h}px`;
      }
      if (!valid) return;
      for (const key of ids) {
        const target = document.createElement("div");
        target.className = "desk-drop-target";
        target.setAttribute("aria-hidden", "true");
        Object.assign(target.style, {
          left: `${hostBox.left - stageBox.left + plan[key]!.column * size.w}px`,
          top: `${hostBox.top - stageBox.top + plan[key]!.row * size.h - iconHost.scrollTop}px`,
          width: `${size.w}px`, height: `${size.h}px`,
        });
        stage.append(target);
        targets.push(target);
      }
    };
    const finish = () => {
      button.removeEventListener("pointermove", onMove);
      button.removeEventListener("pointerup", onUp);
      button.removeEventListener("pointercancel", onUp);
      button.removeEventListener("lostpointercapture", onUp);
      document.removeEventListener("keydown", onDragKey);
      cancelShortcutGesture = null;
      if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
      clearPreview();
      if (dragging) {
        iconDragJustEnded = true;
        window.setTimeout(() => { iconDragJustEnded = false; }, 0);
      }
    };
    const onUp = (ev: PointerEvent) => {
      if (dragging && ev.type === "pointerup") onMove(ev);
      finish();
      if (!dragging) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (!cancelled && ev.type === "pointerup" && plan !== positions) commitShortcutLayout({ positions: plan });
    };
    const onDragKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !dragging) return;
      ev.preventDefault();
      cancelled = true;
      clearPreview();
    };
    cancelShortcutGesture = () => { cancelled = true; finish(); };
    button.addEventListener("pointermove", onMove);
    button.addEventListener("pointerup", onUp);
    button.addEventListener("pointercancel", onUp);
    button.addEventListener("lostpointercapture", onUp);
    document.addEventListener("keydown", onDragKey);
  }

  function onKey(event: KeyboardEvent): void {
    if (!menu.hidden) {
      const items = [...menu.querySelectorAll<HTMLButtonElement>(".desk-menu-item")];
      if (event.key === "Escape") {
        event.preventDefault();
        hideMenu();
        return;
      }
      if (items.length > 0 && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === "Home" ? 0
          : event.key === "End" ? items.length - 1
          : event.key === "ArrowDown" ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length;
        items[next]?.focus();
        return;
      }
    }
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
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z" && !event.altKey) {
      if (shortcutHistory.length > 0) { event.preventDefault(); undoShortcutLayout(); }
      return;
    }
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
    } else if (event.key === "Enter" && selectedShortcut && !(event.target as HTMLElement).closest?.(".desk-icon")) {
      openShortcut(selectedShortcut, false, null);
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
    if (grow) return;
    const positions = { ...prefs.positions, ...currentLayout().positions };
    const origin = positions[id];
    if (!origin) return;
    const delta = key === "ArrowLeft" ? [-1, 0] : key === "ArrowRight" ? [1, 0] : key === "ArrowUp" ? [0, -1] : [0, 1];
    const ids = selectedShortcuts.has(id) ? [...selectedShortcuts] : [id];
    const next = moveShortcut(positions, prefs.shortcuts, id, { column: origin.column + delta[0], row: origin.row + delta[1] }, ids);
    if (next === positions) return;
    const size = iconCell();
    const desk = deskSize();
    const columns = Math.max(1, Math.floor(iconAreaWidth(desk.width) / size.w));
    const rows = Math.max(currentLayout().rows, Math.floor(desk.height / size.h));
    if (ids.some((key) => next[key]!.column >= columns || next[key]!.row >= rows)) return;
    commitShortcutLayout({ positions: next });
    iconHost.querySelector<HTMLElement>(`[data-shortcut-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
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
    catalogScope = "all";
    fillCatalog("");
    showDeskDialog(catalogDialog);
    input?.focus();
  }

  /** Left rail of the launcher: all tools, what is pinned on the desk, then each category with its size. */
  function fillCatalogNav(): void {
    const nav = catalogDialog.querySelector<HTMLElement>("[data-catalog-nav]");
    if (!nav) return;
    nav.replaceChildren();
    const onDesk = payload.tools.filter((tool) => prefs.shortcuts.includes(toolShortcut(tool.slug))).length
      + payload.categories.filter((category) => prefs.shortcuts.includes(catShortcut(category.id))).length;
    const entries: { id: string; label: string; count: number; category?: string }[] = [
      { id: "all", label: text("AllTools"), count: payload.tools.length },
      { id: "desk", label: text("OnDesktop"), count: onDesk },
      ...payload.categories.map((category) => ({
        id: category.id,
        label: category.label,
        count: payload.tools.filter((tool) => tool.category === category.id).length,
        category: category.id,
      })),
    ];
    for (const entry of entries) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "desk-nav-item";
      if (entry.category) button.style.setProperty("--mdt-cat", `var(--mdt-cat-${entry.category})`);
      button.setAttribute("aria-current", String(catalogScope === entry.id));
      const name = document.createElement("span");
      name.textContent = entry.label;
      const count = document.createElement("span");
      count.className = "desk-nav-count";
      count.textContent = String(entry.count);
      if (entry.category) button.append(makeTile(folderInfo(entry.category), "desk-nav-tile"));
      button.append(name, count);
      button.addEventListener("click", () => {
        catalogScope = entry.id;
        fillCatalog(catalogDialog.querySelector<HTMLInputElement>("[data-catalog-input]")?.value || "");
        catalogDialog.querySelector<HTMLElement>("[data-catalog-results]")?.scrollTo({ top: 0 });
      });
      nav.append(button);
    }
  }

  function fillCatalog(query: string): void {
    fillCatalogNav();
    const host = catalogDialog.querySelector<HTMLElement>("[data-catalog-results]");
    if (!host) return;
    host.replaceChildren();
    const needle = query.trim().toLowerCase();
    let hits = 0;
    for (const category of payload.categories) {
      if (catalogScope !== "all" && catalogScope !== "desk" && catalogScope !== category.id) continue;
      const folderPinned = prefs.shortcuts.includes(catShortcut(category.id));
      const inCategory = payload.tools.filter((tool) => {
        if (tool.category !== category.id) return false;
        if (catalogScope === "desk" && !folderPinned && !prefs.shortcuts.includes(toolShortcut(tool.slug))) return false;
        if (!needle) return true;
        return `${tool.title} ${tool.description} ${tool.slug} ${category.label}`.toLowerCase().includes(needle);
      });
      if (inCategory.length === 0) continue;
      hits += inCategory.length;
      const group = document.createElement("section");
      group.className = "desk-cat-group";
      group.style.setProperty("--mdt-cat", `var(--mdt-cat-${category.id})`);
      const head = document.createElement("header");
      const heading = document.createElement("h3");
      heading.textContent = category.label;
      head.append(heading, pinButton(catShortcut(category.id), true));
      const grid = document.createElement("div");
      grid.className = "desk-cat-grid";
      for (const tool of inCategory) {
        const cell = document.createElement("div");
        cell.className = "desk-cat-cell";
        cell.style.setProperty("--mdt-cat", `var(--mdt-cat-${tool.category})`);
        const open = document.createElement("button");
        open.type = "button";
        open.className = "desk-cat-open";
        open.title = tool.description;
        const name = document.createElement("span");
        name.className = "desk-cat-name";
        name.textContent = tool.title;
        open.append(makeTile(toolInfo(tool.slug), "desk-cat-tile"), name);
        if (shortcutIsOpen(toolShortcut(tool.slug))) {
          const dot = document.createElement("span");
          dot.className = "desk-icon-dot";
          open.querySelector(".desk-cat-tile")?.append(dot);
        }
        open.addEventListener("click", () => {
          catalogDialog.close();
          openTool(tool.slug, false);
        });
        cell.append(open, pinButton(toolShortcut(tool.slug), false));
        grid.append(cell);
      }
      group.append(head, grid);
      host.append(group);
    }
    if (hits === 0) {
      const empty = document.createElement("p");
      empty.className = "desk-launcher-empty";
      empty.textContent = text("NoResults");
      host.append(empty);
    }
  }

  /** Pin toggle: plus puts the shortcut on the desk, a tick takes it off (a folder unpacks). */
  function pinButton(id: string, labelled: boolean): HTMLButtonElement {
    const pinned = prefs.shortcuts.includes(id);
    const button = document.createElement("button");
    button.type = "button";
    button.className = labelled ? "desk-pin desk-pin-wide" : "desk-pin";
    button.setAttribute("aria-pressed", String(pinned));
    const label = !pinned ? "PinShortcut" : id.startsWith("cat:") ? "UnpackFolder" : "RemoveShortcut";
    button.setAttribute("aria-label", text(label));
    button.title = text(label);
    button.innerHTML = glyph(pinned ? "check" : "plus", 13);
    if (labelled) {
      const name = document.createElement("span");
      name.textContent = text(label);
      button.append(name);
    }
    button.addEventListener("click", () => {
      toggleShortcut(id);
      fillCatalog(catalogDialog.querySelector<HTMLInputElement>("[data-catalog-input]")?.value || "");
      catalogDialog.querySelector<HTMLElement>(`[data-pin-id="${CSS.escape(id)}"]`)?.focus();
    });
    button.dataset.pinId = id;
    return button;
  }

  function toggleShortcut(id: string): void {
    if (prefs.shortcuts.includes(id)) {
      if (id.startsWith("cat:")) unpackCategory(id.slice(4));
      else removeShortcut(id);
      return;
    }
    const shortcuts = [...prefs.shortcuts, id];
    const laid = currentLayout(shortcuts);
    commitShortcutLayout({ shortcuts, positions: { ...prefs.positions, ...laid.positions } });
  }

  function removeShortcut(id: string): void {
    const positions = { ...prefs.positions };
    delete positions[id];
    if (selectedShortcut === id) selectedShortcut = null;
    commitShortcutLayout({
      shortcuts: prefs.shortcuts.filter((shortcut) => shortcut !== id),
      pinned: prefs.pinned.filter((shortcut) => shortcut !== id),
      positions,
    });
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
    const laid = currentLayout(shortcuts, positions);
    commitShortcutLayout({ shortcuts, positions: { ...positions, ...laid.positions } });
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
    const others = overviewDialog.querySelector<HTMLButtonElement>("[data-close-others]");
    if (others) others.disabled = state.windows.length < 2;
    const needle = query.trim().toLowerCase();
    for (const record of [...state.windows].sort((a, b) => b.z - a.z)) {
      const info = record.kind === "tool" ? toolInfo(record.slug) : folderInfo(record.slug);
      const label = windowTitle(record, info.label);
      if (needle && !label.toLowerCase().includes(needle)) continue;
      const row = document.createElement("div");
      row.className = "desk-overview-row";
      row.style.setProperty("--mdt-cat", `var(--mdt-cat-${info.category})`);
      const open = document.createElement("button");
      open.type = "button";
      open.className = "desk-overview-open";
      const name = document.createElement("span");
      name.className = "desk-overview-name";
      name.textContent = label;
      open.append(makeTile(info, "desk-task-tile"), name);
      if (record.mode === "minimized") {
        const badge = document.createElement("span");
        badge.className = "desk-overview-state";
        badge.textContent = text("Minimized");
        open.append(badge);
      }
      if (record.id === state.activeId) open.setAttribute("aria-current", "true");
      open.addEventListener("click", () => {
        overviewDialog.close();
        dispatch({ type: "activate", id: record.id });
      });
      const frame = document.querySelector<HTMLIFrameElement>(`[data-window-id="${CSS.escape(record.id)}"] iframe`);
      if (frame) {
        try {
          if (frameInput.get(frame)?.()) open.classList.add("is-dirty");
        } catch {
          /* a frame that is not readable yet has no input to warn about */
        }
      }
      const close = document.createElement("button");
      close.type = "button";
      close.className = "desk-win-btn";
      close.dataset.close = "";
      close.innerHTML = glyph("close");
      close.setAttribute("aria-label", `${text("Close")}: ${label}`);
      close.title = text("Close");
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
      button.className = "desk-overview-open";
      button.style.setProperty("--mdt-cat", `var(--mdt-cat-${info.category})`);
      const name = document.createElement("span");
      name.className = "desk-overview-name";
      name.textContent = windowTitle(record, info.label);
      button.append(makeTile(info, "desk-task-tile"), name);
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
      const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
      if (horizontal && event.target === input) return;
      if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
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
      const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
      const next =
        event.key === "Home" ? 0
        : event.key === "End" ? items.length - 1
        : forward ? (index < 0 ? 0 : Math.min(items.length - 1, index + 1))
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
    settingsDialog.querySelectorAll("[data-settings-cancel]").forEach((button) => {
      button.addEventListener("click", () => {
        draftBlob = null;
        draftRemoveImage = false;
        if (draftUrl) URL.revokeObjectURL(draftUrl);
        draftUrl = null;
        applyWallpaper(prefs, imageUrl);
        settingsDialog.close();
      });
    });
    settingsDialog.querySelector("[data-align]")?.addEventListener("click", () => {
      const laid = currentLayout();
      commitShortcutLayout({ positions: packedPositions(prefs.shortcuts, laid.columns, laid.rows) });
    });
    settingsDialog.querySelector("[data-restore-icons]")?.addEventListener("click", () => {
      commitShortcutLayout({ shortcuts: payload.categories.map((category) => catShortcut(category.id)), positions: {}, pinned: [] });
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
    showDimValue(prefs.dim);
    settingsDialog.querySelectorAll<HTMLInputElement>("[data-fit]").forEach((input) => {
      input.checked = input.value === prefs.fit;
    });
    const remember = settingsDialog.querySelector<HTMLInputElement>("[data-remember]");
    if (remember) remember.checked = readKey(ENTRY_KEY) === "1";
    settingsDialog.querySelectorAll<HTMLInputElement>("[data-icon-size]").forEach((input) => {
      input.checked = input.value === prefs.iconSize;
    });
    settingsDialog.querySelectorAll<HTMLInputElement>("[data-density]").forEach((input) => {
      input.checked = input.value === prefs.density;
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
    showDimValue(next.dim);
    const url = draftRemoveImage ? null : draftUrl || imageUrl;
    applyWallpaper({ ...prefs, ...next, hasImage: !!url }, url);
  }

  function showDimValue(dim: number): void {
    const output = settingsDialog.querySelector<HTMLOutputElement>("[data-dim-value]");
    if (output) output.textContent = `${dim}%`;
  }

  function readSettingsForm(): Pick<DeskPrefs, "preset" | "fit" | "dim" | "iconSize" | "density" | "locked"> {
    const presetButton = settingsDialog.querySelector<HTMLButtonElement>("[data-preset][aria-checked='true']");
    const preset = (presetButton?.dataset.preset || prefs.preset) as DeskPrefs["preset"];
    const fitInput = settingsDialog.querySelector<HTMLInputElement>("[data-fit]:checked");
    const dim = Number(settingsDialog.querySelector<HTMLInputElement>("[data-dim]")?.value ?? prefs.dim);
    const icon = settingsDialog.querySelector<HTMLInputElement>("[data-icon-size]:checked");
    const density = settingsDialog.querySelector<HTMLInputElement>("[data-density]:checked");
    return {
      preset,
      fit: fitInput?.value === "contain" ? "contain" : "cover",
      dim: Number.isFinite(dim) ? dim : prefs.dim,
      iconSize: icon?.value === "large" ? "large" : "regular",
      density: density?.value === "compact" ? "compact" : "comfortable",
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
      if (!blob || !(await wallpaperBlobDecodes(blob))) {
        prefs = { ...prefs, hasImage: false };
        if (blob) await clearWallpaperBlob().catch(() => undefined);
        scheduleSave();
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
    const items: MenuEntry[] = [
      { kind: "item", label: text("Open"), run: () => openShortcut(id, false, null) },
    ];
    if (id.startsWith("tool:")) {
      items.push({ kind: "item", label: text("OpenAnother"), run: () => openShortcut(id, true) });
      const slug = id.slice(5);
      const favorite = window.MDT?.favorites.isFavorite(slug) === true;
      items.push({
        kind: "item",
        label: text(favorite ? "Unfavorite" : "Favorite"),
        run: () => {
          window.MDT?.favorites.toggle(slug);
          render();
        },
      });
    }
    if (id.startsWith("cat:")) items.push({ kind: "item", label: text("UnpackFolder"), run: () => unpackCategory(id.slice(4)) });
    else items.push({ kind: "item", label: text("RemoveShortcut"), run: () => removeShortcut(id) });
    const pinned = prefs.pinned.includes(id);
    items.push({
      kind: "item",
      label: text(pinned ? "UnpinBar" : "PinBar"),
      run: () => {
        commitShortcutLayout({ pinned: pinned ? prefs.pinned.filter((item) => item !== id) : [...prefs.pinned, id] });
      },
    });
    showMenu(items, x, y);
    void info;
  }

  function openSurfaceMenu(x: number, y: number): void {
    const chooseSize = (iconSize: DeskPrefs["iconSize"]) => {
      prefs = { ...prefs, iconSize };
      scheduleSave();
      render();
    };
    const chooseDensity = (density: DeskPrefs["density"]) => {
      prefs = { ...prefs, density };
      scheduleSave();
      render();
    };
    showMenu(
      [
        { kind: "label", label: text("IconSize") },
        { kind: "item", label: text("IconRegular"), checked: prefs.iconSize === "regular", run: () => chooseSize("regular") },
        { kind: "item", label: text("IconLarge"), checked: prefs.iconSize === "large", run: () => chooseSize("large") },
        { kind: "label", label: text("Density") },
        { kind: "item", label: text("DensityComfortable"), checked: prefs.density === "comfortable", run: () => chooseDensity("comfortable") },
        { kind: "item", label: text("DensityCompact"), checked: prefs.density === "compact", run: () => chooseDensity("compact") },
        { kind: "label", label: text("Widgets") },
        { kind: "item", label: text("Favorites"), checked: prefs.widgets.includes("favorites"), run: () => toggleWidget("favorites") },
        { kind: "item", label: text("Recent"), checked: prefs.widgets.includes("recent"), run: () => toggleWidget("recent") },
        { kind: "separator" },
        { kind: "item", label: text("AlignIcons"), icon: "apps", run: () => settingsDialog.querySelector<HTMLButtonElement>("[data-align]")?.click() },
        {
          kind: "item",
          label: text("LockIcons"),
          icon: "lock",
          checked: prefs.locked,
          run: () => {
            prefs = { ...prefs, locked: !prefs.locked };
            scheduleSave();
            render();
          },
        },
        { kind: "item", label: text("ShowDesktop"), icon: "desktop", run: () => dispatch({ type: state.concealed ? "reveal" : "conceal" }) },
        { kind: "separator" },
        { kind: "item", label: text("Settings"), icon: "settings", run: () => openSettings() },
      ],
      x,
      y,
    );
  }

  function showMenu(items: MenuEntry[], x: number, y: number): void {
    menu.replaceChildren();
    for (const item of items) {
      if (item.kind === "separator") {
        const line = document.createElement("hr");
        line.className = "desk-menu-sep";
        menu.append(line);
        continue;
      }
      if (item.kind === "label") {
        const label = document.createElement("p");
        label.className = "desk-menu-label";
        label.role = "presentation";
        label.textContent = item.label;
        menu.append(label);
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "desk-menu-item";
      button.role = item.checked === undefined ? "menuitem" : "menuitemradio";
      if (item.checked !== undefined) button.setAttribute("aria-checked", String(item.checked));
      const lead = document.createElement("span");
      lead.className = "desk-menu-icon";
      lead.setAttribute("aria-hidden", "true");
      if (item.icon) lead.innerHTML = glyph(item.icon);
      const name = document.createElement("span");
      name.textContent = item.label;
      button.append(lead, name);
      if (item.checked) {
        const mark = document.createElement("span");
        mark.className = "desk-menu-check";
        mark.setAttribute("aria-hidden", "true");
        mark.innerHTML = glyph("check", 14);
        button.append(mark);
      }
      button.addEventListener("click", () => {
        hideMenu();
        item.run();
      });
      menu.append(button);
    }
    menu.hidden = false;
    const width = menu.offsetWidth || 220;
    const height = menu.offsetHeight || 280;
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
    menu.querySelector<HTMLButtonElement>(".desk-menu-item")?.focus();
  }

  function hideMenu(): void {
    menu.hidden = true;
  }

  /** Window menu (the ⋮ button and a right click on the title): full page, second copy, tiling. */
  function openWindowMenu(id: string, x: number, y: number): void {
    const record = state.windows.find((item) => item.id === id);
    if (!record) return;
    const items: MenuEntry[] = [];
    if (record.kind === "tool") {
      items.push(
        {
          kind: "item",
          label: text("OpenFull"),
          icon: "external",
          run: () => {
            const tool = tools.get(record.slug);
            if (tool) location.assign(tool.href);
          },
        },
        { kind: "item", label: text("OpenAnother"), icon: "windows", run: () => openTool(record.slug, true) },
      );
    }
    items.push({ kind: "item", label: text("TileWith"), icon: "tile", run: () => openTile(record.id) });
    if (record.kind === "tool") items.push({ kind: "item", label: text("Help"), icon: "help", run: () => showHelp(record.slug) });
    showMenu(items, x, y);
  }

  /** Category-coloured tile with a glyph (folders) or a monogram (tools). One look for desk, launcher, taskbar and frames. */
  function makeTile(info: TileInfo, className: string): HTMLSpanElement {
    const tile = document.createElement("span");
    tile.className = `desk-tile ${className}`;
    tile.style.setProperty("--mdt-cat", `var(--mdt-cat-${info.category})`);
    tile.style.setProperty("--desk-tile", `var(--desk-tile-${info.category})`);
    tile.setAttribute("aria-hidden", "true");
    if (info.icon) tile.innerHTML = svgWrap(info.icon, 22);
    else {
      const mark = document.createElement("span");
      mark.className = "desk-tile-mark";
      mark.dataset.len = String(Math.min(4, [...info.mark].length));
      mark.textContent = info.mark;
      tile.append(mark);
    }
    return tile;
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

  function toolInfo(slug: string): TileInfo {
    const tool = tools.get(slug);
    return {
      label: tool?.title || slug,
      mark: tool?.monogram || slug.slice(0, 2).toUpperCase(),
      category: tool?.category || "encoding",
      icon: tool?.icon,
    };
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
    // A folder counts as open while any of its tools has a window.
    if (id.startsWith("cat:")) return state.windows.some((record) => record.kind === "tool" && tools.get(record.slug)?.category === id.slice(4));
    if (id.startsWith("tool:")) return state.windows.some((record) => record.kind === "tool" && record.slug === id.slice(5));
    return false;
  }

  function pinnedHasWindow(id: string): boolean {
    return id.startsWith("tool:") && shortcutIsOpen(id);
  }

  function iconCell(): { w: number; h: number } {
    return cellSize(prefs.iconSize, prefs.density);
  }

  function currentLayout(shortcuts = prefs.shortcuts, positions = prefs.positions) {
    const size = iconCell();
    const desk = deskSize();
    const columns = stripColumns(shortcuts.length, iconAreaWidth(desk.width), desk.height, size, positions, shortcuts);
    const rows = Math.max(1, Math.floor((desk.height || size.h) / size.h));
    return arrangeShortcuts(shortcuts, positions, columns, rows, positions);
  }

  function cellAt(clientX: number, clientY: number): ShortcutCell | null {
    const box = iconHost.getBoundingClientRect();
    const size = iconCell();
    const column = Math.floor((clientX - box.left) / size.w);
    const row = Math.floor((clientY - box.top + iconHost.scrollTop) / size.h);
    if (column < 0 || row < 0) return null;
    return { column, row };
  }


  function iconStripWidth(): number {
    return iconHost.getBoundingClientRect().width;
  }

  /** Shortcut columns stop before the widget column so icons are not covered by it. */
  function iconAreaWidth(stageWidth: number): number {
    return Math.max(0, stageWidth - 24 - widgetGutter());
  }

  /** New windows open in the area left of the widget column. A saved layout may still cover it. */
  function windowDesk(): DeskSize {
    const desk = deskSize();
    return { width: Math.max(0, desk.width - widgetGutter()), height: desk.height };
  }

  function widgetGutter(): number {
    if (widgetHost.hidden) return 0;
    return (widgetHost.getBoundingClientRect().width || 264) + 16;
  }

  function deskSize(): DeskSize {
    return { width: stage.clientWidth, height: stage.clientHeight };
  }

  function fill(key: string, params: Record<string, string | number>): string {
    return Object.entries(params).reduce((line, [name, value]) => line.replaceAll(`{${name}}`, String(value)), text(key));
  }

  function toggleWidget(id: WidgetId): void {
    const visible = prefs.widgets.includes(id);
    prefs = { ...prefs, widgets: visible ? prefs.widgets.filter((item) => item !== id) : [...prefs.widgets, id] };
    scheduleSave();
    render();
  }

  function renderWidgets(): void {
    widgetHost.hidden = prefs.widgets.length === 0;
    widgetHost.replaceChildren();
    if (widgetHost.hidden) return;
    for (const id of prefs.widgets) widgetHost.append(renderWidget(id));
  }

  function renderWidget(id: WidgetId): HTMLElement {
    const collapsed = prefs.widgetsCollapsed.includes(id);
    const items = widgetItems(id);
    const section = document.createElement("section");
    section.className = "desk-widget";
    section.classList.toggle("is-collapsed", collapsed);
    section.dataset.widget = id;
    section.setAttribute("aria-label", text(id === "favorites" ? "Favorites" : "Recent"));

    const head = document.createElement("div");
    head.className = "desk-widget-head";
    const badge = document.createElement("span");
    badge.className = "desk-widget-icon";
    badge.innerHTML = glyph(id === "favorites" ? "star" : "history", 14);
    const title = document.createElement("h2");
    title.textContent = text(id === "favorites" ? "Favorites" : "Recent");
    const peek = document.createElement("span");
    peek.className = "desk-widget-peek";
    peek.textContent = String(items.length);
    peek.hidden = !collapsed;
    const fold = document.createElement("button");
    fold.type = "button";
    fold.className = "desk-win-btn";
    fold.dataset.labelKey = collapsed ? "ExpandWidget" : "CollapseWidget";
    fold.innerHTML = glyph("chevron", 14);
    fold.classList.add("desk-widget-fold");
    fold.setAttribute("aria-expanded", String(!collapsed));
    fold.addEventListener("click", () => {
      const next = collapsed
        ? prefs.widgetsCollapsed.filter((item) => item !== id)
        : [...prefs.widgetsCollapsed, id];
      prefs = { ...prefs, widgetsCollapsed: next };
      scheduleSave();
      render();
    });
    const more = document.createElement("button");
    more.type = "button";
    more.className = "desk-win-btn";
    more.dataset.labelKey = "WidgetActions";
    more.innerHTML = glyph("more");
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      const box = more.getBoundingClientRect();
      showMenu(
        [
          { kind: "item", label: text(collapsed ? "ExpandWidget" : "CollapseWidget"), run: () => fold.click() },
          { kind: "item", label: text("MoveWidgetUp"), run: () => reorderWidget(id, -1) },
          { kind: "item", label: text("MoveWidgetDown"), run: () => reorderWidget(id, 1) },
          { kind: "item", label: text("HideWidget"), run: () => toggleWidget(id) },
        ],
        box.left,
        box.bottom,
      );
    });
    head.append(badge, title, peek, fold, more);
    head.addEventListener("pointerdown", (event) => startWidgetDrag(event, id, head));

    const list = document.createElement("ul");
    list.className = "desk-widget-body";
    if (items.length === 0) {
      const empty = document.createElement("li");
      empty.className = "desk-widget-empty";
      empty.textContent = text(id === "favorites" ? "NoFavorites" : "NoRecent");
      list.append(empty);
    }
    for (const item of items) {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "desk-widget-item";
      button.style.setProperty("--mdt-cat", `var(--mdt-cat-${toolInfo(item.slug).category})`);
      const mark = makeTile(toolInfo(item.slug), "desk-task-tile");
      const name = document.createElement("span");
      name.className = "desk-widget-name";
      name.textContent = item.title;
      button.append(mark, name);
      button.addEventListener("click", () => openTool(item.slug, false));
      row.append(button);
      list.append(row);
    }
    section.append(head, list);
    for (const button of section.querySelectorAll<HTMLButtonElement>(".desk-win-btn")) {
      const key = button.dataset.labelKey;
      if (!key) continue;
      button.setAttribute("aria-label", text(key));
      button.title = text(key);
    }
    return section;
  }

  function widgetItems(id: WidgetId): { slug: string; title: string }[] {
    const source = id === "favorites"
      ? (window.MDT?.favorites.list() ?? [])
      : (window.MDT?.recent.list() ?? []).map((entry) => entry.slug);
    const seen = new Set<string>();
    const items: { slug: string; title: string }[] = [];
    for (const slug of source) {
      if (seen.has(slug) || !tools.has(slug)) continue;
      seen.add(slug);
      items.push({ slug, title: toolInfo(slug).label });
    }
    return items;
  }

  function reorderWidget(id: WidgetId, delta: -1 | 1): void {
    const next = shiftWidget(prefs.widgets, id, delta);
    if (next.join() === prefs.widgets.join()) return;
    prefs = { ...prefs, widgets: next };
    scheduleSave();
    render();
  }

  function startWidgetDrag(event: PointerEvent, id: WidgetId, head: HTMLElement): void {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const startY = event.clientY;
    let dragging = false;
    let drop: { id: WidgetId; after: boolean } | null = null;
    head.setPointerCapture?.(event.pointerId);
    const onMove = (ev: PointerEvent) => {
      if (!dragging && Math.abs(ev.clientY - startY) < 4) return;
      dragging = true;
      drop = widgetDrop(ev.clientY, id);
      widgetHost.querySelectorAll(".is-drop-before, .is-drop-after").forEach((node) => {
        node.classList.remove("is-drop-before", "is-drop-after");
      });
      if (!drop) return;
      widgetHost.querySelector(`[data-widget="${drop.id}"]`)?.classList.add(drop.after ? "is-drop-after" : "is-drop-before");
    };
    const onUp = () => {
      head.removeEventListener("pointermove", onMove);
      head.removeEventListener("pointerup", onUp);
      widgetHost.querySelectorAll(".is-drop-before, .is-drop-after").forEach((node) => {
        node.classList.remove("is-drop-before", "is-drop-after");
      });
      if (!dragging || !drop) return;
      const next = moveWidget(prefs.widgets, id, drop.id, drop.after);
      if (next.join() === prefs.widgets.join()) return;
      prefs = { ...prefs, widgets: next };
      scheduleSave();
      render();
    };
    head.addEventListener("pointermove", onMove);
    head.addEventListener("pointerup", onUp);
  }

  function widgetDrop(clientY: number, dragging: WidgetId): { id: WidgetId; after: boolean } | null {
    for (const node of widgetHost.querySelectorAll<HTMLElement>("[data-widget]")) {
      const widgetId = node.dataset.widget;
      if (widgetId !== "favorites" && widgetId !== "recent") continue;
      if (widgetId === dragging) continue;
      const box = node.getBoundingClientRect();
      if (clientY < box.top || clientY > box.bottom) continue;
      return { id: widgetId, after: clientY > box.top + box.height / 2 };
    }
    return null;
  }

  function wireWorkspaces(): void {
    const dialog = must<HTMLDialogElement>("[data-workspaces-dialog]");
    const renameDialog = must<HTMLDialogElement>("[data-workspace-rename]");
    const deleteDialog = must<HTMLDialogElement>("[data-workspace-delete]");
    const nameInput = must<HTMLInputElement>("[data-workspace-name]");
    const renameInput = must<HTMLInputElement>("[data-workspace-rename-name]");
    let renameId: string | null = null;
    let deleteId: string | null = null;

    nameInput.addEventListener("input", () => updateWorkspaceSave());
    nameInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      must<HTMLButtonElement>("[data-workspace-save]").click();
    });
    must<HTMLButtonElement>("[data-workspace-save]").addEventListener("click", () => {
      const name = nameInput.value.trim();
      const windows = captureWorkspace(state.windows, deskSize());
      if (!isWorkspaceName(name) || windows.length === 0 || prefs.workspaces.length >= 16) return;
      prefs = {
        ...prefs,
        workspaces: [...prefs.workspaces, { id: crypto.randomUUID(), name, windows }],
      };
      nameInput.value = "";
      scheduleSave();
      renderWorkspaceList();
    });
    must<HTMLButtonElement>("[data-workspace-rename-save]").addEventListener("click", () => {
      const name = renameInput.value.trim();
      if (!renameId || !isWorkspaceName(name)) return;
      prefs = {
        ...prefs,
        workspaces: prefs.workspaces.map((workspace) => (workspace.id === renameId ? { ...workspace, name } : workspace)),
      };
      renameId = null;
      scheduleSave();
      renameDialog.close();
      renderWorkspaceList();
    });
    must<HTMLButtonElement>("[data-workspace-delete-confirm]").addEventListener("click", () => {
      if (!deleteId) return;
      prefs = { ...prefs, workspaces: prefs.workspaces.filter((workspace) => workspace.id !== deleteId) };
      deleteId = null;
      scheduleSave();
      deleteDialog.close();
      renderWorkspaceList();
    });

    function openWorkspaces(): void {
      nameInput.value = "";
      renderWorkspaceList();
      showDeskDialog(dialog);
      nameInput.focus();
    }

    function renderWorkspaceList(): void {
      const list = must<HTMLElement>("[data-workspace-list]");
      const empty = must<HTMLElement>("[data-workspace-empty]");
      list.replaceChildren();
      empty.hidden = prefs.workspaces.length > 0;
      for (const workspace of prefs.workspaces) list.append(workspaceCard(workspace));
      updateWorkspaceSave();
    }

    function updateWorkspaceSave(): void {
      const nothing = must<HTMLElement>("[data-workspace-nothing]");
      const limit = must<HTMLElement>("[data-workspace-limit]");
      const save = must<HTMLButtonElement>("[data-workspace-save]");
      const windows = captureWorkspace(state.windows, deskSize());
      nothing.hidden = windows.length > 0;
      limit.hidden = prefs.workspaces.length < 16;
      save.disabled = !isWorkspaceName(nameInput.value.trim()) || windows.length === 0 || prefs.workspaces.length >= 16;
    }

    function workspaceCard(workspace: SavedWorkspace): HTMLElement {
      const card = document.createElement("article");
      card.className = "desk-workspace-card";
      const heading = document.createElement("h3");
      heading.textContent = workspace.name;
      const count = document.createElement("p");
      count.className = "desk-muted";
      count.textContent = fill("WorkspaceTools", { count: workspace.windows.length });
      const actions = document.createElement("div");
      actions.className = "desk-workspace-actions";
      actions.append(
        workspaceButton("AddToOpen", () => void activateWorkspace(workspace, false), true),
        workspaceButton("ReplaceDesk", () => void activateWorkspace(workspace, true), false),
        workspaceButton("RenameWorkspace", () => {
          renameId = workspace.id;
          renameInput.value = workspace.name;
          showDeskDialog(renameDialog);
          renameInput.focus();
        }, false),
        workspaceButton("DeleteWorkspace", () => {
          deleteId = workspace.id;
          const body = deleteDialog.querySelector("[data-workspace-delete-body]");
          if (body) body.textContent = fill("DeleteWorkspaceBody", { name: workspace.name });
          showDeskDialog(deleteDialog);
        }, false),
      );
      card.append(heading, count, actions);
      return card;
    }

    function workspaceButton(key: string, onClick: () => void, primary: boolean): HTMLButtonElement {
      const button = document.createElement("button");
      button.type = "button";
      button.className = primary ? "ds-btn ds-btn-primary" : "ds-btn";
      button.textContent = text(key);
      button.addEventListener("click", onClick);
      return button;
    }

    async function activateWorkspace(workspace: SavedWorkspace, replace: boolean): Promise<void> {
      if (replace && dirtyIds(state.windows.map((record) => record.id)).length > 0) {
        const confirmed = await askDiscard(true, {
          title: text("ReplaceTitle"),
          body: text("ReplaceBody"),
          confirm: text("ReplaceConfirm"),
        });
        if (!confirmed) return;
      }
      const before = new Set(state.windows.map((record) => record.id));
      dispatch({
        type: "apply-workspace",
        replace,
        windows: workspace.windows.map((window) => ({
          id: `tool-${window.slug}-ws-${crypto.randomUUID()}`,
          slug: window.slug,
          instance: 1,
          bounds: denormalizeBounds(window.bounds, deskSize()),
          mode: window.mode,
        })),
      });
      for (const record of state.windows) {
        if (!before.has(record.id) && record.kind === "tool") window.MDT?.recent.record(record.slug);
      }
      if (dialog.open) dialog.close();
    }

    document.querySelector("[data-desk-workspaces]")?.addEventListener("click", () => openWorkspaces());
  }

  function flushSave(): void {
    window.clearTimeout(saveTimer);
    saveTimer = 0;
    writeKey(LAYOUT_KEY, serializeLayout(state));
    writeKey(PREFS_KEY, serializePrefs(prefs));
  }

  function scheduleSave(): void {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flushSave, 400);
  }
}

/** Taskbar clock in the page language. Ticks on the minute, not every second. */
function startClock(): void {
  const time = document.querySelector<HTMLElement>("[data-clock-time]");
  const date = document.querySelector<HTMLElement>("[data-clock-date]");
  if (!time || !date) return;
  const locale = document.documentElement.lang || undefined;
  const timeFormat = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
  const dateFormat = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" });
  const tick = () => {
    const now = new Date();
    time.textContent = timeFormat.format(now);
    date.textContent = dateFormat.format(now);
    window.setTimeout(tick, 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
  };
  tick();
}

/** A stored wallpaper must decode as a raster. Anything else falls back to the preset. */
async function wallpaperBlobDecodes(blob: Blob): Promise<boolean> {
  if (!blob.type.startsWith("image/") || blob.type === "image/svg+xml" || blob.size === 0) return false;
  try {
    const bitmap = await createImageBitmap(blob);
    const ok = bitmap.width > 0 && bitmap.height > 0;
    bitmap.close();
    return ok;
  } catch {
    return false;
  }
}

function winButton(key: string, svg: string, onClick: () => void, attr?: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "desk-win-btn";
  button.dataset.labelKey = key;
  button.innerHTML = svg;
  if (attr) button.setAttribute(attr, "");
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function svgWrap(body: string, size = 22): string {
  return `<svg viewBox="0 0 20 20" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
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
