/**
 * Site chrome client behavior, bundled once and loaded on every BaseLayout page.
 * SSR-safe: every entry guards for DOM readiness and treats localStorage as
 * untrusted (try/catch → silent degradation, per Stage 8 "safe state recovery").
 *
 * Responsibilities: theme toggle + persistence, locale persistence (no cookie),
 * language-switcher outside-click/escape close. Favorites/recent live in
 * `favorites.ts` (loaded where tool cards / tool pages render).
 */

// ── Theme ───────────────────────────────────────────────────────────────────
function initTheme() {
  const root = document.documentElement;
  const btn = document.querySelector<HTMLButtonElement>("[data-theme-toggle]");
  if (!btn) return;

  function current(): "light" | "dark" {
    return root.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }
  btn.addEventListener("click", () => {
    const next = current() === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* storage unavailable — keep in-memory only */
    }
  });
}

// ── Locale persistence (URL is source of truth; this only remembers choice) ─
function initLocalePersistence() {
  const lang = document.documentElement.lang?.split("-")[0];
  if (!lang) return;
  try {
    localStorage.setItem("mdt.locale", lang);
  } catch {
    /* ignore */
  }
}

// ── Language switcher: close on outside click / escape ──────────────────────
function initLangSwitcher() {
  const details = document.querySelector<HTMLDetailsElement>(".lang-switcher");
  if (!details) return;
  document.addEventListener("click", (e) => {
    if (details.open && !details.contains(e.target as Node)) details.open = false;
  });
  details.addEventListener("keydown", (e) => {
    if (e.key === "Escape") details.open = false;
  });
}

// ── Share / copy-link (tool pages) ──────────────────────────────────────────
// navigator.share where available (mobile), clipboard copy otherwise.
// URL is location.href — always includes locale and Pages base.
const CHECK_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

function flashCopied(btn: HTMLButtonElement): void {
  if (btn.dataset.copied === "1") return;
  const original = btn.innerHTML;
  const originalTitle = btn.title;
  btn.dataset.copied = "1";
  btn.classList.add("copied");
  btn.innerHTML = CHECK_SVG;
  btn.title = btn.getAttribute("data-copied-label") || "Copied!";
  setTimeout(() => {
    delete btn.dataset.copied;
    btn.classList.remove("copied");
    btn.innerHTML = original;
    btn.title = originalTitle;
  }, 1600);
}

function initShare() {
  document.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement)?.closest?.("[data-share]") as HTMLButtonElement | null;
    if (!btn) return;
    const url = window.location.href;
    // navigator.share only on coarse-pointer (mobile) devices — its system
    // sheet is the right UX there; on desktop copy-link is the expectation.
    const preferShare =
      !!navigator.share && window.matchMedia?.("(pointer: coarse)").matches;
    try {
      if (preferShare) {
        await navigator.share({ title: document.title, url });
        return; // system UI gives its own feedback; AbortError = user cancel
      }
      await navigator.clipboard.writeText(url);
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError") return; // user dismissed the share sheet
      // navigator.clipboard requires a secure context (HTTPS); on the GitHub
      // Pages deployment that always holds, so a rejection here is exceptional
      // — skip the "copied" flash rather than fall back to deprecated APIs.
      return;
    }
    flashCopied(btn);
  });
}

// ── MobileNav drawer ──────────────────────────────────────────────────────
// Toggle via [data-nav-toggle], close via [data-nav-close] / scrim / Escape.
// Locks body scroll while open.
function initMobileNav() {
  const nav = document.querySelector<HTMLElement>("[data-mobile-nav]");
  const scrim = document.querySelector<HTMLElement>("[data-nav-close].nav-scrim");
  const toggle = document.querySelector<HTMLButtonElement>("[data-nav-toggle]");
  if (!nav || !scrim || !toggle) return;

  let open = false;
  function setOpen(next: boolean) {
    open = next;
    nav!.hidden = false;
    scrim!.hidden = false;
    // Force reflow so the transition runs from the hidden state.
    void nav!.offsetWidth;
    nav!.classList.toggle("open", next);
    scrim!.classList.toggle("open", next);
    toggle!.setAttribute("aria-expanded", String(next));
    document.body.style.overflow = next ? "hidden" : "";
    if (!next) {
      setTimeout(() => {
        if (!open) {
          nav!.hidden = true;
          scrim!.hidden = true;
        }
      }, 400);
    }
  }
  toggle.addEventListener("click", () => setOpen(true));
  document.addEventListener("click", (e) => {
    if (!open) return;
    if ((e.target as HTMLElement)?.closest?.("[data-nav-close]")) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) setOpen(false);
  });

  // Favorites/recent in the drawer — rendered from the palette island
  // (present on every page) + versioned localStorage; hidden when empty.
  try {
    const island = document.querySelector<HTMLScriptElement>("[data-palette-json]");
    const box = nav.querySelector<HTMLElement>("[data-mnav-favs]");
    const heading = box?.previousElementSibling as HTMLElement | null;
    if (island && box) {
      const index = JSON.parse(island.textContent ?? "{}") as Record<string, { t: string; h: string }>;
      const read = (key: string): string[] => {
        try {
          const raw = localStorage.getItem(key);
          if (!raw) return [];
          const parsed = JSON.parse(raw) as { items?: Array<string | { slug: string }> };
          return (parsed.items ?? []).map((it) => (typeof it === "string" ? it : it.slug));
        } catch {
          return [];
        }
      };
      const slugs = [...new Set([...read("mdt.favorites.v1"), ...read("mdt.recent.v1")])].slice(0, 8);
      const links = slugs
        .map((s) => index[s])
        .filter(Boolean)
        .map((entry) => `<a class="mnav-link" href="${entry.h}" data-nav-close>${entry.t}</a>`);
      if (links.length > 0) {
        box.innerHTML = links.join("");
      } else {
        box.hidden = true;
        if (heading) heading.hidden = true;
      }
    }
  } catch {
    /* island/storage unavailable — drawer keeps its empty placeholder */
  }
}

function boot() {
  initTheme();
  initLocalePersistence();
  initLangSwitcher();
  initShare();
  initMobileNav();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
