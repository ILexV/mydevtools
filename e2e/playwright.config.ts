import { defineConfig, devices } from "@playwright/test";

/**
 * Visual regression for the Astro site (FRONTEND_REBUILD_TODO §324).
 *
 * Lives at the repo root (outside apps/site) so Playwright's tsconfig loader
 * never touches `apps/site/tsconfig.json` — which `extends astro/tsconfigs/
 * strict` and is only resolvable by Astro's own TS tooling, not Playwright's.
 * The standalone `e2e/tsconfig.json` has no such extends.
 *
 * Determinism (baselines must not flap run-to-run):
 *  - reduceMotion "reduce"  → the global @media (prefers-reduced-motion)
 *    block freezes every @keyframes (ambient spin, monogram drift, hero rise).
 *  - serviceWorkers "block" → precache SW can't serve stale HTML/CSS.
 *  - animations "disabled"  → freezes any residual motion at capture.
 *  - each capture awaits document.fonts.ready so Inter isn't mid-swap.
 *
 * Run:    `npm run test:visual`         (diff vs committed baselines)
 * Update: `npm run test:visual:update`  (regenerate baselines after an
 *                                       intentional visual change)
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  outputDir: "./_out",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01, // tolerance for Chromium patch-level AA drift
      animations: "disabled",
    },
  },
  use: {
    baseURL: "http://localhost:4123",
    viewport: { width: 1440, height: 900 },
    reduceMotion: "reduce",
    serviceWorkers: "block",
    colorScheme: "light",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx astro preview --port 4123",
    cwd: "../apps/site",
    url: "http://localhost:4123/mydevtools/en/",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
