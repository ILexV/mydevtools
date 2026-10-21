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
cross-compiler (`x86_64-w64-mingw32-gcc`). Both hosts also need NSIS 3 (`makensis`).
The packaging script selects the host's Windows target, builds the executable,
wraps it in the per-user installer `installer/mydevtools-agent.nsi`, and generates
`public/downloads/local-agent.json` from Cargo's version and the installer's
SHA-256 and file size. The installer and metadata are gitignored. The localized
download pages fail the build if the installer or metadata is missing or disagrees.
Do not publish a page pointing at a fabricated release. The installer is currently
unsigned; the page explains SmartScreen and distinguishes a checksum from a
publisher signature.

Before publishing a native release, run the executable on Windows 10/11 x64:
open from the download, pair with the HTTPS site, minimize/close to tray, reopen
from the tray, enable/disable per-user autostart, sign out/in, and exit while
a request is active. Check Explorer restart, 100%/150% display scaling, and the
English/Russian window labels. Linux HTTP smoke plus Windows cross-compilation
does **not** verify these OS interactions. No automatic updater is installed.

Browser smoke should include a target without CORS, a UTF-8 request body,
duplicate response headers, a binary-body download, cancellation, and disconnect
while a request is active. Confirm that a new request clears the previous result
and that reconnect stays disabled until revocation completes. Download the installer
from the description page and compare its SHA-256 with the displayed release
metadata; downloads must bypass the service worker's runtime cache.

Native release 0.1.1 fixes error 87 on startup by querying the Run registry value
with explicit type flags (`RRF_RT_ANY | RRF_NOEXPAND`), rather than zero flags.
Read failures are reported separately from changes to autostart. Verify both a
missing Run value and the enable → readback → disable → readback transition.
The download is a per-user installer. Running it stops an open agent and replaces
the copy in `%LOCALAPPDATA%\MyDevTools\Agent`. There is no background updater.
The same release embeds the MyDevTools icon for the executable, window and tray,
restores the native caption through default `WM_NCCREATE` handling, and uses
DPI-scaled Segoe UI controls with consistent backgrounds.

The HTTP workspace uses a saved-request sidebar and a single request/response
surface with a compact connection indicator/settings disclosure. Request Params/Headers tables support repeated keys, disabled rows,
and keyboard-accessible add/remove controls; editing Params updates the URL
and editing the URL updates active parameter rows while retaining disabled rows.
The original URL encoding is untouched until a table edit (`URLSearchParams` encoding).
Body and Settings remain separate tabs. Requests autosave locally; responses do not.

HTTP-client smoke must exercise URL ↔ Params synchronization (including
Unicode, repeated keys and unchecked rows), Headers/Body/Settings keyboard
navigation, response Body/Headers tabs, and the compact connection settings
at desktop and 375px widths in both themes. The read-only response viewer loads
CodeMirror lazily. Pretty JSON preserves source tokens, including large numbers
and duplicate keys; Raw retains decoded source text and downloads retain exact
response bytes. Invalid/truncated JSON stays Raw. Pretty output is bounded to
2 MiB characters and 64 nested containers; responses beyond those formatting
bounds also stay Raw. Check that canceling or starting another request cannot
reveal a stale asynchronously loaded editor.

The browser remembers the origin-bound companion bearer token in
`mdt.local-agent.session.v1`; it never stores the one-time pairing code or responses.
Reloads and locale changes restore the connection.
Disconnect, expiry and an unauthorized response remove the record. Native
sessions still expire after eight hours and disappear on agent restart;
protocol v1 detects a lost native session on the first authorized operation,
not through the public info endpoint. A temporary agent outage retains the
record: start the agent and click Connect with an empty code to retry.
Blocked browser storage leaves the live connection usable and shows a warning.

The request body now uses the shared lazy CodeMirror editor with Text/JSON/HTML/XML
language selection, search/folding/undo, and Ctrl/Cmd-Enter to send. Formatting
JSON is explicit and preserves exact numeric lexemes and duplicate keys using
the response formatter's existing bounds. Invalid JSON stays unchanged.
Nonempty bodies get the selected format's Content-Type unless an enabled header
already supplies it. A failed editor load leaves the plain textarea usable.
Response source views highlight JSON, HTML, XML and JavaScript; Raw never
reformats the decoded text.

Complete HTML/XHTML responses within the 1 MiB preview limit offer an explicit
static preview. The existing allowlist sanitizer removes styles and active
content; navigation/resource URLs are removed as well. The frame has an empty
sandbox (no scripts or same-origin permission), no referrer, and a restrictive
CSP. It is not a full webpage renderer: no scripts, forms, external resources,
navigation or original CSS. Source view and byte-exact downloads remain intact.
Smoke with hostile HTML containing scripts, refresh, image URLs, links, forms,
iframes and SVG: markup must render without requests to those URLs or access to
the parent page. Also exercise reload/locale restore, disconnect + reload,
invalid JSON, format switching without text loss, Content-Type override, and
Ctrl/Cmd-Enter submission.

Saved-request smoke: create and rename two requests, edit JSON and disabled
duplicate parameters/headers, switch immediately before the debounce fires,
reload/reopen and verify exact selected request restoration. Confirm deleting
one request leaves the other intact, and switching clears the previous response.
New/switch/delete are disabled during sending. Check first-run setup opens,
successful pairing collapses it, and settings can be reopened from the indicator.
The separate `mdt.http-workspace.v1` record stores request credentials in plain
browser storage; its privacy notice must remain visible. A failed quota write
must not erase the previous saved record or permit a switch that loses unsaved input.

Folder-tree smoke: load a previous flat workspace and verify exact request
contents survive; create nested folders, rename/reparent them, move requests,
collapse an unrelated branch and reload. Reparent options must exclude the
folder itself and descendants. Deleting a folder promotes its contents to the
parent and preserves request bodies. Entries show one compact method/name row
with the full URL in the tooltip. Exercise pointer resize, arrow keys and
Home/End (192–480px), reload to confirm width, and 375px stacked layout where the
separator is hidden. Check both themes and localized labels for clipping.

The request tree now uses flat Explorer rows, icon-only header actions, and no
persistent footer action panel. Right-click an item (or blank space for root),
Shift+F10, or the header menu button opens target-specific actions without
switching the active request. Move opens a destination dialog for keyboard/touch.
Internal native drag-and-drop moves requests/folders into a folder or root
blank space; external drags and self/descendant folder destinations are rejected.
Hovering a collapsed destination for 650ms expands it in place without replacing
the native drag source. Smoke this with real pointer down/move/up, not only
synthetic drop events; also verify root drops, invalid cycles, context-menu
rename of a nonactive request, Escape/focus return, and persistence after reload.
Check menu bounds at 375px in all locales and both themes. Privacy text remains
available in the compact help disclosure below the tree.

In desktop embed mode (`?embed=1`), HTTP fills the window without a second
border, rounded frame, or outer gutters. Above 64rem the workspace uses the
iframe viewport height: the tree and request/response content scroll internally,
and the response fills the remaining height. Resize to 1440×900 and 1100×600;
check the Body editor does not overlap the response and a long response keeps
its final-URL footer inside the viewport. At 375px retain the stacked layout
and document scrolling without horizontal overflow. Check both themes and
confirm the standalone page still has its normal card framing.

HTTP Client belongs to the `networking` category (Network utilities), not
Converters. Catalog, palette and desktop folder use the same registry entry.
Saved desktop preferences track seen catalog categories so the new folder is
added once without resetting existing shortcuts/custom folders; subsequent
user removal remains respected. Smoke an existing customized desktop and all
localized catalog labels. Other converter tools remain in their original group.


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
`apps/site/src/generated/wasm/`) → `build:agent` (Windows installer + release metadata)
→ `build:site` (`astro build` + `node build-sw.mjs`) → `test:smoke`
(static routes, release download/metadata and the existing site contracts).
Astro empties `dist/` before each build. Agent downloads bypass the PWA runtime
cache and use versioned URLs; the installer is not precached.

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
