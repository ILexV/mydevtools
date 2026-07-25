/**
 * Favorites + recent tools engine. Versioned localStorage schema (Stage 8:
 * "versioned localStorage schema"), SSR-safe, degrades silently when storage
 * is unavailable or corrupt.
 *
 *   mdt.favorites.v1 = { v: 1, items: string[] }            // slugs, order = user adds
 *   mdt.recent.v1     = { v: 1, items: { slug, ts }[] }      // LIFO, dedup, cap 10
 *
 * Wired into pages via data attributes:
 *   [data-catalog-json]        JSON island: { slug: { title, href, category } }
 *   [data-fav-slot][data-slug] a star badge slot on a tool card (read-only indicator)
 *   [data-fav-section]         container rendered with favorite tool links (home)
 *   [data-recent-section]      container rendered with recent tool links (home)
 *   [data-fav-toggle][data-slug] a toggle button (tool page)
 *
 * Also records a "recent" visit on every page exposing [data-visit-slug].
 */
export {};
const FAV_KEY = "mdt.favorites.v1";
const RECENT_KEY = "mdt.recent.v1";
const RECENT_CAP = 10;


function readJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
function writeJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable — keep in-memory state only */
  }
}

function loadFavorites(): string[] {
  const data = readJSON<{ v: number; items?: string[] }>(FAV_KEY);
  return Array.isArray(data?.items) ? data.items.filter((s) => typeof s === "string") : [];
}
function saveFavorites(items: string[]): void {
  writeJSON(FAV_KEY, { v: 1, items });
}
function loadRecent(): { slug: string; ts: number }[] {
  const data = readJSON<{ v: number; items?: { slug: string; ts: number }[] }>(RECENT_KEY);
  return Array.isArray(data?.items) ? data.items.filter((x) => x && typeof x.slug === "string") : [];
}
function saveRecent(items: { slug: string; ts: number }[]): void {
  writeJSON(RECENT_KEY, { v: 1, items });
}

// In-memory mirrors so the UI updates even when persistence is unavailable.
let favs = loadFavorites();
let recent = loadRecent();

function isFavorite(slug: string): boolean {
  return favs.includes(slug);
}
function toggleFavorite(slug: string): boolean {
  const i = favs.indexOf(slug);
  if (i === -1) favs.push(slug);
  else favs.splice(i, 1);
  saveFavorites(favs);
  render();
  return i === -1;
}
function recordRecent(slug: string): void {
  recent = recent.filter((x) => x.slug !== slug);
  recent.unshift({ slug, ts: Date.now() });
  if (recent.length > RECENT_CAP) recent.length = RECENT_CAP;
  saveRecent(recent);
}

type CatalogIndex = Record<string, { title: string; href: string; category: string }>;

function catalogIndex(): CatalogIndex | null {
  const island = document.querySelector<HTMLScriptElement>("[data-catalog-json]");
  if (!island) return null;
  try {
    return JSON.parse(island.textContent || "{}") as CatalogIndex;
  } catch {
    return null;
  }
}

function star(filled: boolean): string {
  return filled
    ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 18.9 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z"/></svg>'
    : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 18.9 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z"/></svg>';
}

function render(): void {
  // Card badges.
  document.querySelectorAll<HTMLElement>("[data-fav-slot][data-slug]").forEach((slot) => {
    const slug = slot.getAttribute("data-slug") || "";
    const on = favs.includes(slug);
    slot.innerHTML = star(on);
    // aria-pressed drives color via CSS; keep the attribute in sync (the
    // [data-fav-toggle] loop below also sets it, but a slot may carry only
    // data-fav-slot on some hosts).
    if ("ariaPressed" in slot) slot.setAttribute("aria-pressed", String(on));
  });
  // Toggle button label.
  document.querySelectorAll<HTMLButtonElement>("[data-fav-toggle]").forEach((btn) => {
    const slug = btn.getAttribute("data-slug") || "";
    btn.setAttribute("aria-pressed", String(favs.includes(slug)));
  });
  // Home sections (need catalog index).
  const index = catalogIndex();
  if (index) {
    renderSection("[data-fav-section]", favs, index);
    renderSection(
      "[data-recent-section]",
      recent.map((r) => r.slug),
      index,
    );
  }
}

function renderSection(selector: string, slugs: string[], index: CatalogIndex): void {
  const container = document.querySelector<HTMLElement>(selector);
  if (!container) return;
  const visible = slugs.filter((s) => index[s]);
  if (visible.length === 0) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }
  container.hidden = false;
  container.innerHTML = visible
    .map(
      (slug) =>
        `<a class="chip" href="${index[slug].href}">${escapeHtml(index[slug].title)}</a>`,
    )
    .join("");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

function init() {
  // Favorite toggle buttons (tool page).
  document.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement)?.closest?.("[data-fav-toggle]") as HTMLButtonElement | null;
    if (btn) {
      e.preventDefault();
      toggleFavorite(btn.getAttribute("data-slug") || "");
    }
  });
  // Record recent visit (tool page).
  const visit = document.querySelector<HTMLElement>("[data-visit-slug]");
  if (visit) recordRecent(visit.getAttribute("data-visit-slug") || "");
  render();
}

// Public API (mirrors the legacy window.MyDevToolsFavorites shape, namespaced).
declare global {
  interface Window {
    MDT?: {
      favorites: {
        isFavorite: (s: string) => boolean;
        toggle: (s: string) => boolean;
        list: () => string[];
      };
      recent: { list: () => { slug: string; ts: number }[]; clear: () => void };
    };
  }
}
window.MDT = {
  favorites: { isFavorite, toggle: toggleFavorite, list: () => [...favs] },
  recent: { list: () => [...recent], clear: () => { recent = []; saveRecent(recent); render(); } },
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
