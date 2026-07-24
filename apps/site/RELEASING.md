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

## What `build:pages` does

`validate:i18n` → `build:wasm` (regenerates the 10 default WASM domains into
`apps/site/src/generated/wasm/`) → `build:site` (`astro build` + `node build-sw.mjs`)
→ `test:smoke` (static dist smoke). Astro empties `dist/` before each build.

> **Note on `ipcalc`:** `wasm/build.ps1`'s default domain list omits the
> `ipcalc` crate. Its generated artifacts are committed; regenerate explicitly
> with `pwsh wasm/build.ps1 -Configuration Release -WasmOutRoot apps/site/src/generated/wasm -Domains ipcalc`
> only when its Rust source changes.

## Smoke test (post-deploy)

Open the published Pages URL in a fresh browser profile (no local cache):

- Home loads, search works, language switcher works.
- A text tool, a file/WASM tool, and an image tool operate correctly.
- Console/Network clean; WASM loads only on tool pages.
- Service worker registers (`/mydevtools/sw.js`), offline shell works after a visit.
- A second publish + hard refresh serves the new version (SW update prompt).

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
