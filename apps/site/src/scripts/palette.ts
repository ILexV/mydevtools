/**
 * Command palette client behavior (Stage 8). Loaded once per page via
 * BaseLayout; markup + data island come from `components/Palette.astro`.
 *
 * Open:  header search button [data-search-open], Ctrl/Cmd+K, or "/" outside
 *        editable elements. On the home page "/" stays with the inline catalog
 *        search (it owns that shortcut there); Ctrl+K/button still work.
 * Close: Esc, backdrop click, selecting a result.
 * Empty query: favorites + recent (via window.MDT, storage-safe).
 * SSR-safe: binds after DOM readiness, no storage access of its own.
 */
export {};

interface PaletteEntry {
  t: string; // title
  h: string; // href (locale + base aware, build-time)
  c: string; // category label
  k: string; // keywords (space-separated)
}
interface PaletteItem {
  slug: string;
  e: PaletteEntry;
}

const MAX_RESULTS = 12;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest?.('input, textarea, select, [contenteditable="true"]');
}

function boot(): void {
  const paletteRoot = document.querySelector<HTMLElement>("[data-palette]");
  const paletteInput = paletteRoot?.querySelector<HTMLInputElement>("[data-palette-input]");
  const paletteResults = paletteRoot?.querySelector<HTMLElement>("[data-palette-results]");
  if (!paletteRoot || !paletteInput || !paletteResults) return;
  const root: HTMLElement = paletteRoot;
  const input: HTMLInputElement = paletteInput;
  const results: HTMLElement = paletteResults;

  let index: Record<string, PaletteEntry> = {};
  try {
    index = JSON.parse(
      document.querySelector("[data-palette-json]")?.textContent || "{}",
    ) as Record<string, PaletteEntry>;
  } catch {
    return; // corrupt island — palette stays inert
  }
  const all: PaletteItem[] = Object.entries(index).map(([slug, e]) => ({ slug, e }));

  const labels = {
    noResults: root.getAttribute("data-label-noresults") || "No results",
    hint: root.getAttribute("data-label-hint") || "Type to search",
    favorites: root.getAttribute("data-label-favorites") || "Favorites",
    recent: root.getAttribute("data-label-recent") || "Recent",
  };

  let isOpen = false;
  let active = -1;
  let current: PaletteItem[] = [];
  let lastFocus: HTMLElement | null = null;

  function optionHtml(i: number): string {
    const { e } = current[i];
    return (
      `<div class="palette-option" role="option" id="palette-opt-${i}" data-index="${i}" ` +
      `data-active="false" aria-selected="false">` +
      `<span class="palette-opt-title">${escapeHtml(e.t)}</span>` +
      `<span class="palette-opt-cat">${escapeHtml(e.c)}</span></div>`
    );
  }

  function markActive(): void {
    results.querySelectorAll<HTMLElement>(".palette-option").forEach((opt) => {
      const on = Number(opt.getAttribute("data-index")) === active;
      opt.setAttribute("data-active", String(on));
      opt.setAttribute("aria-selected", String(on));
      if (on) {
        input.setAttribute("aria-activedescendant", opt.id);
        opt.scrollIntoView({ block: "nearest" });
      }
    });
  }

  function renderGroup(label: string, items: PaletteItem[], offset: number): string {
    if (items.length === 0) return "";
    let html = `<div class="palette-group">${escapeHtml(label)}</div>`;
    for (let i = 0; i < items.length; i++) html += optionHtml(offset + i);
    return html;
  }

  function render(): void {
    const q = input.value.trim().toLowerCase();
    active = -1;
    if (q === "") {
      const favSlugs = window.MDT?.favorites.list() ?? [];
      const recentSlugs = (window.MDT?.recent.list() ?? []).map((r) => r.slug);
      const favs = favSlugs.filter((s) => index[s]).map((slug) => ({ slug, e: index[slug] }));
      const recent = recentSlugs
        .filter((s) => index[s] && !favSlugs.includes(s))
        .map((slug) => ({ slug, e: index[slug] }));
      current = [...favs, ...recent];
      if (current.length === 0) {
        results.innerHTML = `<div class="palette-empty">${escapeHtml(labels.hint)}</div>`;
        return;
      }
      results.innerHTML =
        renderGroup(labels.favorites, favs, 0) + renderGroup(labels.recent, recent, favs.length);
    } else {
      current = all
        .filter(({ e }) => `${e.t} ${e.c} ${e.k}`.toLowerCase().includes(q))
        .slice(0, MAX_RESULTS);
      if (current.length === 0) {
        results.innerHTML = `<div class="palette-empty">${escapeHtml(labels.noResults)}</div>`;
        return;
      }
      results.innerHTML = current.map((_, i) => optionHtml(i)).join("");
    }
    if (current.length > 0) {
      active = 0;
      markActive();
    }
  }

  function openPalette(): void {
    if (isOpen) return;
    isOpen = true;
    lastFocus = document.activeElement as HTMLElement | null;
    root.hidden = false;
    document.body.style.overflow = "hidden";
    input.value = "";
    render();
    input.focus();
  }

  function closePalette(): void {
    if (!isOpen) return;
    isOpen = false;
    root.hidden = true;
    document.body.style.overflow = "";
    lastFocus?.focus?.();
  }

  function go(i: number): void {
    const item = current[i];
    if (item) window.location.href = item.e.h;
  }

  input.addEventListener("input", render);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && current.length > 0) {
      e.preventDefault();
      active = (active + 1) % current.length;
      markActive();
    } else if (e.key === "ArrowUp" && current.length > 0) {
      e.preventDefault();
      active = (active - 1 + current.length) % current.length;
      markActive();
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      go(active);
    }
  });
  results.addEventListener("click", (e) => {
    const opt = (e.target as HTMLElement).closest<HTMLElement>(".palette-option");
    if (opt) go(Number(opt.getAttribute("data-index")));
  });
  results.addEventListener("mousemove", (e) => {
    const opt = (e.target as HTMLElement).closest<HTMLElement>(".palette-option");
    if (!opt) return;
    const i = Number(opt.getAttribute("data-index"));
    if (i !== active) {
      active = i;
      markActive();
    }
  });

  // Capture phase on window: run before browser defaults (Ctrl+K address-bar
  // focus on some browsers) and before any sibling listeners. `e.code` is
  // layout-independent, so Ctrl+K works regardless of keyboard layout.
  window.addEventListener(
    "keydown",
    (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "k" || e.code === "KeyK")) {
        e.preventDefault();
        if (isOpen) closePalette();
        else openPalette();
        return;
      }
      if (e.key === "Escape" && isOpen) {
        closePalette();
        return;
      }
      if (e.key === "/" && !isOpen && !isEditable(e.target)) {
        e.preventDefault();
        openPalette();
      }
    },
    true,
  );

  document.querySelector("[data-search-open]")?.addEventListener("click", openPalette);
  root.querySelector("[data-palette-close]")?.addEventListener("click", closePalette);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
