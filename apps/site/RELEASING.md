# Releasing MyDevTools to GitHub Pages

The new frontend is a **static** Astro build published from a local machine.
No build runs on GitHub — only the finished `apps/site/dist` is pushed to the
`gh-pages` branch. All computation stays client-side; the deploy contains no
secrets.

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

## Build → preview → deploy → smoke test

All commands run from the repo root.

```powershell
# 1. Full reproducible build: i18n check → WASM → Astro site → dist smoke.
npm run build:pages

# 2. Preview the built dist locally under the /mydevtools/ base before publishing.
npm run preview:site          # http://localhost:4321/mydevtools/en/

# 3. Dry-run the deploy (verifies artifact completeness, does NOT push).
npm run deploy:pages

# 4. Publish to the gh-pages branch.
npm run deploy:pages -- --push
```

After the first push: GitHub → **Settings → Pages → Source = branch `gh-pages` / root `/`**.
The site is served at `https://<user>.github.io/mydevtools/`.

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

`validate:i18n` → `build:wasm` (regenerates the 10 default WASM domains into
`apps/site/src/generated/wasm/`) → `build:site` (`astro build` + `node build-sw.mjs`)
→ `test:smoke` (static dist smoke). Astro empties `dist/` before each build.

> **Note on `ipcalc`:** `wasm/build.ps1`'s default domain list omits the
> `ipcalc` crate. Its generated artifacts are committed; regenerate explicitly
> with `pwsh wasm/build.ps1 -Configuration Release -WasmOutRoot apps/site/src/generated/wasm -Domains ipcalc`
> only when its Rust source changes.

## Smoke test (post-deploy)

> **`.nojekyll` is mandatory.** GitHub Pages runs Jekyll on branch deploys,
> which silently skips `_astro/` → all CSS/JS return 404 and the site renders
> unstyled. `apps/site/public/.nojekyll` ships in every `dist`, and
> `deploy-pages.mjs` refuses to publish without it.

Open the published Pages URL in a fresh browser profile (no local cache):

- Home loads, search works, language switcher works.
- A text tool, a file/WASM tool, and an image tool operate correctly.
- Console/Network clean; WASM loads only on tool pages.
- Service worker registers (`/mydevtools/sw.js`), offline shell works after a visit.
- A second publish + hard refresh serves the new version (SW update prompt).

## Visual regression (optional, local/CI)

Playwright captures baseline screenshots of the key surfaces (home light/dark +
mobile, a text tool, a file/WASM tool, the design showcase) and diffs them.
Baselines live in `e2e/pages.spec.ts-snapshots/` (platform-suffixed, e.g.
`*-chromium-win32.png`) and are committed. The suite lives at the **repo root**
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
Chromium-only; Firefox/Safari are a separate (manual or CI multi-browser) gap.

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
