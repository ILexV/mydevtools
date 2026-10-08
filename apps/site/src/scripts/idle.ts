/**
 * Run decorative work (hero canvas, typing demo) only after the page has
 * loaded and the main thread is idle, so it never competes with first paint,
 * LCP or input readiness (Lighthouse TBT). Falls back to a short timeout where
 * requestIdleCallback is missing (Safari).
 */
export function whenIdle(cb: () => void, timeout = 2500): void {
  const run = () => {
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(() => cb(), { timeout });
    else setTimeout(cb, 300);
  };
  if (document.readyState === "complete") run();
  else window.addEventListener("load", run, { once: true });
}
