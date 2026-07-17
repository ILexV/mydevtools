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

function boot() {
  initTheme();
  initLocalePersistence();
  initLangSwitcher();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
