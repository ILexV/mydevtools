# Releasing MyDevTools to GitHub Pages

The new frontend is a **static** Astro build published from a local machine.
No build runs on GitHub — only the finished `apps/site/dist` is pushed to the
`gh-pages` branch. Ordinary tools compute in the browser; the optional Windows
Local Agent executes HTTP requests on the user's machine. The deploy contains no secrets.

## Prerequisites (pinned)

| Tool | Version | Pin |
| --- | --- | --- |
| Node.js | 25 (LTS 22+ also works) | `.nvmrc` |
| npm | 11+ | `package.json#packageManager` |
| Rust toolchain | 1.88.0 | `rust-toolchain.toml` |
| `wasm32-unknown-unknown` target | via rustup | — |
| `wasm-bindgen-cli` | 0.2.108 | `cargo install wasm-bindgen-cli --locked` |
| PowerShell (`pwsh`) | 7+ (for `wasm/build.ps1`) | — |

One-time Rust setup:

```powershell
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --locked
```

The download page also requires the generated Windows x64 Local Agent:

```powershell
npm run build:agent
npm run test:agent
```

This uses the independent Rust workspace in `apps/local-agent`. On Windows,
install MSVC Build Tools and the Windows SDK; on Linux, install the MinGW-w64
cross-compiler (`x86_64-w64-mingw32-gcc`). The packaging script selects the host's
Windows target, builds the executable and generates
`public/downloads/local-agent.json` from Cargo's version, SHA-256 and file size.
Both downloads are gitignored. The localized download pages fail the build if
the binary or metadata is missing or disagrees. Do not publish a page pointing
to a fabricated release. The binary is currently unsigned; the page explains
SmartScreen and distinguishes a checksum from a publisher signature.

Before publishing a native release, run the executable on Windows 10/11 x64:
open from the download, pair with the HTTPS site, minimize/close to tray, reopen
from the tray, enable/disable per-user autostart, sign out/in, and exit while
a request is active. Check Explorer restart, 100%/150% display scaling, and the
English/Russian window labels. Linux HTTP smoke plus Windows cross-compilation
does **not** verify these OS interactions. No automatic updater is installed.

Browser smoke should include a target without CORS, a UTF-8 request body,
duplicate response headers, a binary-body download, cancellation, and disconnect
while a request is active. Confirm that a new request clears the previous result
and that reconnect stays disabled until revocation completes. Download the EXE
from the description page and compare its SHA-256 with the displayed release
metadata; downloads must bypass the service worker's runtime cache.

Native release 0.1.1 fixes error 87 on startup by querying the Run registry value
with explicit type flags (`RRF_RT_ANY | RRF_NOEXPAND`), rather than zero flags.
Read failures are reported separately from changes to autostart. Verify both a
missing Run value and the enable → readback → disable → readback transition.
Existing users must exit the old process and replace the EXE; there is no updater.
The same release embeds the MyDevTools icon for the executable, window and tray,
restores the native caption through default `WM_NCCREATE` handling, and uses
DPI-scaled Segoe UI controls with consistent backgrounds.

The HTTP workspace now uses a companion sidebar and a single request/response
surface. Request Params/Headers tables support repeated keys, disabled rows,
and keyboard-accessible add/remove controls; editing Params updates the URL
and editing the URL replaces the table. The original URL encoding is untouched
until a table edit (table edits use `URLSearchParams` encoding). Body and
Settings remain separate tabs. No request or response data is persisted.

HTTP-client smoke must exercise URL ↔ Params synchronization (including
Unicode, repeated keys and unchecked rows), Headers/Body/Settings keyboard
navigation, response Body/Headers tabs, and the collapsible companion sidebar
at desktop and 375px widths in both themes. The read-only response viewer loads
CodeMirror lazily. Pretty JSON preserves source tokens, including large numbers
and duplicate keys; Raw retains decoded source text and downloads retain exact
response bytes. Invalid/truncated JSON stays Raw. Pretty output is bounded to
2 MiB characters and 64 nested containers; responses beyond those formatting
bounds also stay Raw. Check that canceling or starting another request cannot
reveal a stale asynchronously loaded editor.


## Build → preview → deploy → smoke test

All commands run from the repo root.

```powershell
# 1. Full reproducible build: i18n → WASM → Windows agent → Astro → dist smoke.
$env:ANALYTICS_ENABLED = 'true'
npm run build:pages

# 2. Preview the built dist locally at the site root before publishing.
npm run preview:site          # http://localhost:4321/en/

# 3. Dry-run the deploy (verifies artifact completeness, does NOT push).
npm run deploy:pages

# 4. Publish to the gh-pages branch.
npm run deploy:pages -- --push
```

After the first push: GitHub → **Settings → Pages → Source = branch `gh-pages` / root `/`**.
The site is served at `https://mydevtools.app/` (custom domain from `public/CNAME`; `https://ilexv.github.io/mydevtools/` redirects there).

## Anonymous operation analytics and private dashboard

The owner requires **`ANALYTICS_ENABLED=true` for every production build and
publication**, unless explicitly requesting analytics to be disabled. The
compiler still defaults to off for an unconfigured checkout. Anonymous ingestion
has already been deployed and verified; never accidentally replace the live
site with a default-disabled build.

The Worker route must stay `mydevtools.app/api/analytics/*`, never the entire
site. Staging uses a separate dataset and no production route. Worker/zone and
Pages publication each require owner approval; the new scripts do not deploy
automatically.

The hidden `/admin/analytics/` dashboard requires owner-only Cloudflare Access
on both the dashboard and `/api/analytics/reports` (base paths and descendants).
Its report handler requires the Access application audience and a separate
read-only SQL token in the Worker secret store; never expose that token to the
site build or browser. Configure and verify Access **before** publishing the
dashboard. Public `/api/analytics/event` and `/api/analytics/vote` must remain
outside Access protection; review rate-limit coverage for both paths.

See [analytics setup, private dashboard, privacy inventory, tool matrix, SQL reports and rollback](../../docs/analytics.md).
Local Wrangler ingestion 204 responses do not prove Analytics Engine persistence:
confirm a real write and private SQL readback. A local Access identity simulation
does not prove production authorization; verify actual owner login separately.

The expanded release requires separate production/staging `ANALYTICS_HISTORY`
KV bindings and production cron `15 0 * * *` (daily 00:15 UTC). Namespaces are
already created and committed as non-secret bindings; staging has no cron.
Deploy the updated Worker before the enabled Pages artifact, then bootstrap the
protected archive POST and verify KV readback. Successful/failed terminal
payloads now require duration/reason; cached older clients may temporarily lose
counters, but their local computation is unaffected. Existing stored points
remain unclassified rather than receiving invented measurements.


## Browser support policy

Declared in `apps/site/package.json#browserslist`:

```
defaults, supports es6-module, supports wasm
```

Rationale: the site is an ES-module static build and every tool computes via
WebAssembly or modern JS — browsers without ESM/WASM are unsupported by design
(the no-JS shell still renders, but tools stay inert). `defaults` (~Baseline
Widely Available: Chrome/Edge 107+, Firefox 104+, Safari 16+) is the floor.

Compile targets:

- **JS/TS**: Vite 8 default (`baseline-widely-available`) — never older than
  the browserslist floor, so no explicit override in `astro.config.mjs`.
- **CSS**: no prefixer/downleveling; only Baseline features are allowed
  (custom properties, `:focus-visible`, grid). Check new CSS against the
  browserslist floor before use.

## What `build:pages` does

`validate:i18n` → `build:wasm` (regenerates all 11 WASM domains into
`apps/site/src/generated/wasm/`) → `build:agent` (Windows executable + release metadata)
→ `build:site` (`astro build` + `node build-sw.mjs`) → `test:smoke`
(static routes, release download/metadata and the existing site contracts).
Astro empties `dist/` before each build. Agent downloads bypass the PWA runtime
cache and use versioned URLs; the executable is not precached.

> `src/generated/` is gitignored, so `npm run build:wasm` (all 11 domains,
> `ipcalc` included) must run on a fresh checkout and whenever Rust sources change.

The service-worker cache version hashes both the precache revisions and the
worker template. Installation uses `Request(..., { cache: "reload" })` so
stable URLs (especially locale `index.html` files) are fetched afresh instead
of copying an earlier release from the browser's HTTP cache. After accepting
an update, check the **contents** of a cached locale home, not only the new
cache name: its offline catalog must contain newly published tools.

## Smoke test (post-deploy)

> **`.nojekyll` is mandatory.** GitHub Pages runs Jekyll on branch deploys,
> which silently skips `_astro/` → all CSS/JS return 404 and the site renders
> unstyled. `apps/site/public/.nojekyll` ships in every `dist`, and
> `deploy-pages.mjs` refuses to publish without it.

Open the published Pages URL in a fresh browser profile (no local cache):

- Home loads, search works, language switcher works.
- A text tool, a file/WASM tool, and an image tool operate correctly.
- Console/Network clean; WASM loads only on tool pages.
- Service worker registers (`/sw.js`), offline shell works after a visit.
- A second publish + hard refresh serves the new version (SW update prompt).

## Visual regression (optional, local/CI)

Playwright captures baseline screenshots of the key surfaces (home light/dark +
mobile, a text tool, a file/WASM tool, the design showcase) and diffs them.
Baselines live in `e2e/pages.spec.ts-snapshots/` (platform-suffixed, e.g.
`*-chromium-linux.png`, captured on the Linux build machine) and are committed. The suite lives at the **repo root**
`e2e/` (not under `apps/site/`) so Playwright's tsconfig loader never touches
`apps/site/tsconfig.json` (`extends astro/tsconfigs/strict` is only resolvable
by Astro's own TS tooling).

```powershell
npm run test:visual           # build:site → diff vs committed baselines
npm run test:visual:update    # regenerate baselines after an intentional change
```

Determinism: `reduceMotion: "reduce"` freezes every `@keyframes` (ambient spin,
monogram drift), `serviceWorkers: "block"` prevents stale-cache serving,
`animations: "disabled"` at capture, and each shot awaits `document.fonts.ready`.
Pixel baselines are Chromium-only (font AA/shaping differs per engine). The
cross-engine matrix below covers Firefox + WebKit functionally.

## Cross-browser matrix (optional, local/CI)

A separate `e2e/cross-browser.spec.ts` runs on **Chromium, Firefox and WebKit**
and asserts what must hold in every engine — no console/page errors, no
horizontal overflow (desktop + mobile 375), header + h1 present, theme toggle
flips `data-theme`. It does NOT pixel-diff (baselines are engine-specific).

```powershell
npm run test:crossbrowser     # build:site → run matrix on all 3 engines
```

Run once after `npm run test:visual` to cover all engines. Firefox + WebKit
binaries must be present (`npx playwright install firefox webkit`).

## Rollback

The `gh-pages` branch is a linear series of deploy commits. To revert:

```powershell
git fetch origin gh-pages
git log origin/gh-pages --oneline               # find the last good deploy
# Re-deploy a previous dist: check out that commit's tree, or simply re-run
# `npm run deploy:pages -- --push` from the earlier source commit.
```

Because each deploy is a force-pushed orphan commit of the full dist, rollback
= republish the previous build. Keep the `dist/` (or the source commit) for the
last known-good release until the new one is verified.
