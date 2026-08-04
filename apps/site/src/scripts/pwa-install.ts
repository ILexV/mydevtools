/**
 * PWA install flow — port of legacy `pwa.js` (banner part; SW registration and
 * the update toast live in `sw-register.ts`).
 *
 * UX contract (legacy parity):
 *   1. `beforeinstallprompt` is captured (preventDefault) and reveals any
 *      `[data-pwa-install]` trigger buttons (home hero) — nothing pops up
 *      automatically.
 *   2. Clicking a trigger shows `#pwa-install-prompt` — unless the app already
 *      runs standalone, no prompt was captured, or the user dismissed before.
 *   3. Install → `prompt()` synchronously inside the gesture (async before it
 *      consumes the Chrome gesture token → NotAllowedError). "Not now" or a
 *      dismissed native choice persists `pwa-install-dismissed` (legacy key,
 *      kept so returning legacy users stay dismissed).
 *   4. `appinstalled` hides the banner and flashes the installed confirmation.
 */

const DISMISS_KEY = "pwa-install-dismissed";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — dismissal stays session-only */
  }
}

function initPwaInstall(): void {
  const banner = document.getElementById("pwa-install-prompt");
  if (!banner) return;
  const installBtn = document.getElementById("pwa-install-btn");
  const dismissBtn = document.getElementById("pwa-install-dismiss");
  const triggers = document.querySelectorAll<HTMLElement>("[data-pwa-install]");

  let deferred: BeforeInstallPromptEvent | null = null;
  const hideBanner = () => {
    banner.hidden = true;
  };

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    // Prompt available → reveal trigger buttons (progressive enhancement:
    // they stay hidden where install is impossible, e.g. Firefox/Safari).
    triggers.forEach((el) => {
      el.hidden = false;
    });
  });

  window.addEventListener("appinstalled", () => {
    deferred = null;
    // Flash the installed confirmation in place of the banner text.
    const message = banner.dataset.installedMessage;
    if (!message) return;
    banner.hidden = false;
    if (installBtn) installBtn.hidden = true;
    if (dismissBtn) dismissBtn.hidden = true;
    banner.querySelector(".pwa-install-text")!.textContent = message;
    setTimeout(hideBanner, 5000);
  });

  triggers.forEach((el) => {
    el.addEventListener("click", () => {
      if (deferred === null) return;
      if (
        window.matchMedia("(display-mode: standalone)").matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true
      ) {
        return;
      }
      let dismissed: string | null = null;
      try {
        dismissed = localStorage.getItem(DISMISS_KEY);
      } catch {
        /* storage unavailable — treat as not dismissed */
      }
      if (dismissed !== "true") banner.hidden = false;
    });
  });

  installBtn?.addEventListener("click", () => {
    if (!deferred) return;
    // Call prompt() synchronously within the user gesture (see header comment).
    const promptEvent = deferred;
    deferred = null;
    hideBanner();
    void promptEvent.prompt();
    void promptEvent.userChoice.then(({ outcome }) => {
      if (outcome === "dismissed") storageSet(DISMISS_KEY, "true");
    });
  });

  dismissBtn?.addEventListener("click", () => {
    storageSet(DISMISS_KEY, "true");
    hideBanner();
  });
}

initPwaInstall();
