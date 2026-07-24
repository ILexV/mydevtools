/**
 * Registers the build-generated service worker (production only) and surfaces a
 * "new version available" prompt so users always run the latest deploy instead
 * of getting stuck on a stale cached shell.
 *
 * Update lifecycle:
 *   1. Browser/`registration.update()` finds a new SW with a new CACHE_VERSION.
 *   2. New SW installs + precaches, then enters `waiting` (we do not auto-skip).
 *   3. We show a toast; the user taps "Reload" → we `postMessage("SKIP_WAITING")`.
 *   4. New SW activates, purges old precache, claims clients → `controllerchange`
 *      fires → we reload once into the fresh shell.
 *
 * `scripts/build-sw.mjs` regenerates the precache list + version each build, so
 * there is no manual asset list to maintain and no infinite stale cache: every
 * deploy bumps the version and the activate step deletes the old precache cache.
 */
import { BASE_URL } from "@/lib/url";

const TOAST_TEXT = "A new version is available.";
const TOAST_BUTTON = "Reload";

function styleToast(el: HTMLElement): void {
  el.style.cssText = [
    "position:fixed",
    "z-index:1000",
    "left:50%",
    "bottom:1.25rem",
    "transform:translateX(-50%)",
    "display:flex",
    "align-items:center",
    "gap:0.75rem",
    "max-width:min(92vw,32rem)",
    "padding:0.7rem 0.85rem",
    "border-radius:var(--mdt-radius-sm,0.5rem)",
    "border:1px solid var(--mdt-border,#283039)",
    "background:var(--mdt-surface-raised,#1b2029)",
    "color:var(--mdt-text,#e6eaf0)",
    "font-size:0.9rem",
    "box-shadow:var(--mdt-shadow,0 8px 24px rgba(0,0,0,0.25))",
  ].join(";");
}

function showUpdate(waiting: ServiceWorker): void {
  const toast = document.getElementById("sw-update-toast");
  if (!toast || toast.dataset.bound === "1") return;
  toast.dataset.bound = "1";
  toast.hidden = false;
  toast.textContent = TOAST_TEXT;
  styleToast(toast);

  const btn = document.createElement("button");
  btn.textContent = TOAST_BUTTON;
  btn.style.cssText = [
    "flex-shrink:0",
    "border:0",
    "border-radius:0.4rem",
    "padding:0.4rem 0.85rem",
    "font-weight:600",
    "font-size:0.85rem",
    "cursor:pointer",
    "background:var(--mdt-accent,#2f6df0)",
    "color:var(--mdt-accent-contrast,#ffffff)",
  ].join(";");
  btn.addEventListener("click", () => waiting.postMessage("SKIP_WAITING"));
  toast.appendChild(btn);
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
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    location.reload();
  });
}
