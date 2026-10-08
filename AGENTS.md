# Repository Guidelines

## Project Overview

MyDevTools is a privacy-first collection of 39 multilingual developer utilities. The **live site** is a static Astro build in `apps/site`, published to GitHub Pages at https://mydevtools.app/ (custom domain via `apps/site/public/CNAME`, branch `gh-pages`; the old https://ilexv.github.io/mydevtools/ redirects there). All computation runs in the browser: vanilla TypeScript controllers plus lazy-loaded Rust/WASM, no server runtime.

The former .NET 10 Blazor SSR site (`MyDevToolsApp/`) and the React UI kit (`packages/ui-kit`, `apps/storybook`) are **legacy**: kept for reference, not deployed, and not used by the Astro site. Do not add features there.

## Architecture & Data Flow

- Config: `apps/site/astro.config.mjs` — `output: "static"`, `site: https://mydevtools.app`, `base: "/"`, `trailingSlash: "always"`, `build.format: "directory"` (each route emits `index.html` so deep links survive Pages). `@/*` aliases `src/`.
- Registries are the single source of truth (`apps/site/src/registry/`): `tools.ts` (39 tools: slug, category, WASM domain, capabilities), `categories.ts` (13), `locales.ts` (10 languages, native names, og:locale, hreflang), `catalog.ts` (grouping/related), `validate.ts` (build-time assertions). Routes, home catalog, search, command palette, related tools and sitemap are all derived from them.
- Routes: `src/pages/index.astro` (root language redirect), `[lang]/index.astro` (home), `[lang]/[slug].astro` (tool page via `getStaticPaths` over LOCALES × TOOLS; picks the component from the `TOOL_COMPONENTS` map), plus `404.astro`, `offline.astro`, `design.astro` (design-system showcase), `sitemap.xml.ts`, `manifest.webmanifest.ts`.
- Tool flow: `/{lang}/{slug}/` → `src/tools/<PascalName>.astro` (markup + localized strings as an inline JSON island) → `src/tools/<slug>.client.ts` controller → optional `src/scripts/wasm/<domain>-client.ts` → dynamic import of `src/generated/wasm/<domain>/` bindings; heavy/file work runs in `src/workers/*.worker.ts` (protocol in `scripts/wasm/worker-protocol.ts`: start/progress/result/error/cancel, 1 MiB chunks).
- Localization: JSON in `src/i18n/locales/<lang>/{common,home,categories}.json` and `tools/<slug>.json`. Rendered at build time with `t()` from `src/i18n/messages.ts` (fallback locale → en → key, `{param}` interpolation); pluralization via `src/lib/format.ts` (`Intl.PluralRules`). Languages: `en`, `ru`, `es`, `de`, `pt`, `zh`, `fr`, `ja`, `ko`, `hi`.
- SEO/PWA: `components/Seo.astro` (head, canonical, hreflang ×10 + x-default, JSON-LD — all URLs keep the trailing slash the site is served with; a slash-less canonical 301-redirects), `sitemap.xml.ts` (lastmod per page from git via `lib/lastmod.ts`), `ToolSeoContent.astro` (visible SEO block from locale `Seo_*` keys), base-aware manifest, service worker generated after build by `build-sw.mjs` from `scripts/sw-template.js`, PWA install prompt (`InstallPrompt.astro`, `scripts/pwa-install.ts`).
- Client state: favorites, recent tools, theme, locale and per-tool settings live in versioned `localStorage` keys (schema: `docs/inventory/client-state.md`). Some legacy keys are imported once on first visit.
- Design: "Prism" design system — tokens and layers in `src/styles/global.css` (`--mdt-*` variables, `ds-*` component classes), self-hosted Inter/JetBrains Mono, icons in `components/Icon.astro`. Spec: `docs/design/stage2-design-system.md`.

## Key Directories

- `apps/site/src/{pages,layouts,components}/`: routes, `BaseLayout.astro`, shared shell (Header, Footer, Palette, ToolCard, Seo).
- `apps/site/src/tools/`: per-tool `.astro` shells, `.client.ts` controllers and pure helpers (`base64.ts`, `uuid.ts`, …).
- `apps/site/src/scripts/`: global browser scripts (palette, favorites, chrome, sw-register, codemirror-loader) and `wasm/` domain clients.
- `apps/site/src/generated/wasm/`: wasm-bindgen output — **gitignored, must be generated** (`npm run build:wasm`).
- `apps/site/{test,scripts}/`: unit tests (node:test) and build tooling (`validate-i18n.mjs`, `smoke-dist.mjs`).
- `apps/site/public/`: static files copied to `dist` (icons, `robots.txt`, `.nojekyll`).
- `wasm/<domain>/`: Rust crates (hash, encoding, cryptography, structured_data, password, text_tools, image_tools, regex_tool, qrcode, pdf, ipcalc).
- `e2e/`: Playwright visual-regression and cross-browser suites (kept at repo root on purpose).
- `scripts/deploy-pages.mjs`: publishes `apps/site/dist` to `gh-pages`.
- `docs/inventory/`: parity inventory (tools, locales, client state, SEO, parity fixtures); `docs/design/`: design direction and spec.
- `FRONTEND_REBUILD_TODO.md`: migration checklist, decisions and known deviations from legacy.
- Legacy: `MyDevToolsApp/` (Blazor), `packages/ui-kit/`, `apps/storybook/`.

## Development Commands

Run from the repository root (npm workspaces).

```bash
npm install                                  # all workspaces
npm run build:wasm                           # wasm/build.ps1 → apps/site/src/generated/wasm (all 11 domains)
pwsh -Command './wasm/build.ps1 -Configuration Release -WasmOutRoot apps/site/src/generated/wasm -Domains ipcalc'   # one domain

npm run dev -w @mydevtools/site              # http://localhost:3312/
npm run check:site                           # astro check
npm run validate:i18n                        # locale JSON parity/empty/untranslated
npm run verify -w @mydevtools/site           # check + i18n + unit + build + dist smoke
npm run build:site                           # astro build + service worker
npm run preview:site                         # http://localhost:4321/en/

npm run build:pages                          # validate:i18n → build:wasm → build:site → test:smoke
npm run deploy:pages                         # dry run: verifies dist, no push
npm run deploy:pages -- --push               # force-push dist as an orphan commit to origin/gh-pages
                                             #   then pings IndexNow with pages changed vs old gh-pages (--no-indexnow to skip)
node scripts/indexnow.mjs [--all] [--submit] # IndexNow dry run / manual resubmit (key: apps/site/public/<32-hex>.txt)

npm run test:visual                          # Playwright pixel baselines (Chromium)
npm run test:crossbrowser                    # Chromium/Firefox/WebKit functional matrix
cargo test --workspace --manifest-path wasm/Cargo.toml
```

`build:wasm` must run before the first `astro build` on a fresh checkout (and whenever Rust sources change) — WASM tools import the generated bindings. Full release procedure and rollback: `apps/site/RELEASING.md`.

## Code Conventions & Common Patterns

- Naming across layers: registry slug `hash-calculator` → `src/tools/HashCalculator.astro` → `src/tools/hash-calculator.client.ts` → `src/i18n/locales/<lang>/tools/hash-calculator.json`. TS uses camelCase; Rust modules/exports use snake_case.
- Adding a tool: entry in `registry/tools.ts`, import + key in `TOOL_COMPONENTS` in `pages/[lang]/[slug].astro`, locale JSON for all 10 languages, a WASM client if needed. `validate.ts` fails the build on unknown categories or missing locale namespaces.
- Never hard-code absolute paths: use `withBase()` / `localizedPath()` from `src/lib/url.ts` (keeps the site movable between a subpath and the domain root).
- Strings reach client code via the JSON island in the `.astro` shell, not via runtime fetches. Do not add tool text outside locale JSON.
- Browser code: bind once per root (guard), cache lazy import promises, keep user data in the browser, surface localized errors, treat `AbortError` separately, use workers + chunking + progress + `AbortController` for large files. No SharedArrayBuffer.
- Privacy: do not persist tool input (json/xml beautifiers deliberately don't); store only explicit user settings.
- Tool UI: build tools from the shared layer — `src/styles/tool-ui.css` (`ds-*` classes), `src/components/tool/{Field,FileButton,FileDrop,Progress,OutputPanel,StatusMessage}.astro`, `src/scripts/tool-ui.ts` (`copyWithFeedback`, `bindDropzone`), code editors are CodeMirror 6 (npm `@codemirror/*`), lazy-loaded via `src/scripts/codemirror-loader.ts` → `codemirror-kit.ts` only on editor pages and themed by `src/styles/codemirror.css`. Catalog, mapping and rules: `docs/qa/tool-ui-kit.md`. Don't re-declare buttons/fields/file/progress styles locally; style controller-created DOM with `ds-*` classes (Astro scoped CSS doesn't reach it); toggle visibility with `el.hidden` (global `[hidden]` wins); runtime states are `is-*`.
- Styling: use Prism tokens (`--mdt-*`) and `ds-*` classes; keep only layout-specific CSS in scoped `<style>` blocks; tool pages scope the category accent via `--mdt-cat`. Only Baseline CSS (browserslist: `defaults, supports es6-module, supports wasm`).
- Rust boundaries validate input and return `Result<_, JsValue>`. Do not hand-edit wasm-bindgen output.
- Make surgical changes and follow a neighboring tool. Comments in English.

## Runtime/Tooling Preferences

- Node 25 (`.nvmrc`), npm 11 (`packageManager`; npm only, not Bun/pnpm/Yarn), Rust 1.88.0 (`rust-toolchain.toml`) with `wasm32-unknown-unknown`, `wasm-bindgen-cli` 0.2.108 (must match `wasm/Cargo.lock`), PowerShell 7 (`pwsh`) for `wasm/build.ps1`.
- One-time setup: `rustup target add wasm32-unknown-unknown`, `cargo install wasm-bindgen-cli --version 0.2.108 --locked`; on Linux without sudo, `dotnet tool install -g PowerShell` provides `pwsh`.
- The `cryptography` crate depends on `ring`, which compiles C for wasm32 and needs **clang + llvm-ar** (gcc cannot target wasm). On Debian/Ubuntu: `sudo apt install clang llvm`.
- Pass several domains to `build.ps1` from bash via `pwsh -Command './wasm/build.ps1 … -Domains a,b'` — with `pwsh -File`-style invocation the comma list is taken as one folder name.
- Pages specifics: `public/CNAME` (`mydevtools.app`) is mandatory — the deploy force-pushes an orphan commit, so without it the custom domain is dropped; the deploy script refuses to publish without it. `.nojekyll` is mandatory (otherwise Jekyll drops `_astro/` and CSS/JS 404); the deploy script refuses to publish without it. No build runs on GitHub — dist is built locally and pushed.
- Trust code, registries and scripts over prose; legacy docs (`ARCHITECTURE.md`, `DEVELOPMENT.md`, `TOOL_DEVELOPMENT_GUIDE.md`, `WASM_INTEGRATION.md`, etc.) describe the Blazor site.

## Testing & QA

- `npm run verify -w @mydevtools/site` is the default gate after any site change: `astro check`, i18n validator, unit tests (`apps/site/test/*.test.ts`, node:test with `--experimental-strip-types`), build, dist smoke (routes, manifest, SW, JSON-LD, 404).
- Rust: `cargo test --workspace --manifest-path wasm/Cargo.toml`; cryptography browser smoke is feature-gated (`--target wasm32-unknown-unknown --features wasm-test` with `wasm-bindgen-test-runner`).
- UI changes require a real-browser check of the built site (`preview:site`) with Playwright/Chrome: Console/Network clean, WASM loads only where needed, representative en/ru routes (all 10 languages for localization changes), language switcher, both themes, mobile 375 px without horizontal overflow.
- Visual baselines in `e2e/pages.spec.ts-snapshots/` are `*-chromium-linux.png` (captured on the Linux build machine); regenerate deliberately with `npm run test:visual:update` after intentional visual changes. On another OS Playwright looks for `*-<platform>.png` and won't find them.
- Deploying (`deploy:pages -- --push`) publishes to the public site: do it only when the owner asks, then smoke-test the live URL (see `apps/site/RELEASING.md`).
