/**
 * Registers the build-generated service worker (production only) and surfaces a
 * "new version available" prompt so users always run the latest deploy instead
 * of getting stuck on a stale cached shell.
 *
 * Update lifecycle:
 *   1. Browser/`registration.update()` finds a new SW with a new CACHE_VERSION.
 *   2. New SW installs + precaches, then enters `waiting` (we do not auto-skip).
 *   3. We show a localized banner; the user taps "Update" → we `postMessage("SKIP_WAITING")`.
 *   4. New SW activates, purges old precache, claims clients → `controllerchange`
 *      fires → we reload once into the fresh shell.
 *
 * `scripts/build-sw.mjs` regenerates the precache list + version each build, so
 * there is no manual asset list to maintain and no infinite stale cache: every
 * deploy bumps the version and the activate step deletes the old precache cache.
 */
import { BASE_URL } from "@/lib/url";

/**
 * Reveal the localized update banner (`#sw-update-prompt`, rendered by
 * InstallPrompt.astro). "Update" promotes the waiting worker; "Later" just
 * hides the banner — the new version still activates once every tab is closed.
 */
function showUpdate(waiting: ServiceWorker): void {
  const banner = document.getElementById("sw-update-prompt");
  if (!banner || banner.dataset.bound === "1") return;
  banner.dataset.bound = "1";
  banner.hidden = false;

  const update = document.getElementById("sw-update-btn") as HTMLButtonElement | null;
  update?.addEventListener("click", () => {
    update.disabled = true;
    waiting.postMessage("SKIP_WAITING");
  });
  document.getElementById("sw-update-dismiss")?.addEventListener("click", () => {
    banner.hidden = true;
  });
}

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register(`${BASE_URL}sw.js`);
      reg.addEventListener("updatefound", () => {
        const next = reg.installing;
        if (!next) return;
        next.addEventListener("statechange", () => {
          // A newly installed SW that has an active controller = an UPDATE.
          if (next.state === "installed" && navigator.serviceWorker.controller) {
            if (reg.waiting) showUpdate(reg.waiting);
          }
        });
      });
      // Page opened mid-update: a worker may already be waiting.
      if (reg.waiting) showUpdate(reg.waiting);
    } catch (err) {
      console.warn("Service worker registration failed:", err);
    }
  });

  // New SW took over after SKIP_WAITING — reload once into the fresh shell.
  // Skip the first-visit claim (no prior controller): that page is already fresh.
  const hadController = !!navigator.serviceWorker.controller;
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing || !hadController) return;
    refreshing = true;
    location.reload();
  });
}
