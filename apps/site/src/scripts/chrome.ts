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
      if ((err as DOMException)?.name === "AbortError") return;
      // Clipboard API unavailable (permissions / insecure context) — legacy fallback.
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
      if (!ok) return;
    }
    flashCopied(btn);
  });
}

function boot() {
  initTheme();
  initLocalePersistence();
  initLangSwitcher();
  initShare();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
