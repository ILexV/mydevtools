# Repository Guidelines

## Project Overview

MyDevTools is a privacy-first collection of multilingual developer utilities. The primary application is a .NET 10 Blazor SSR site in `MyDevToolsApp/MyDevTools.Site`; Razor renders localized HTML, while vanilla browser JavaScript and lazy-loaded Rust/WASM perform user-data processing locally. The repository also contains a separate React/TypeScript UI kit and Storybook workspace; it is not currently the live Razor site's rendering layer.

## Architecture & Data Flow

- Entry point: `MyDevToolsApp/MyDevTools.Site/Program.cs`. It registers Razor Components for SSR only; no interactive Blazor render mode or application API/controller layer is present.
- Request flow: ASP.NET Core middleware handles forwarded headers, errors/HTTPS, sitemap, compression, static/page caching, HEAD requests, culture canonicalization, localization, and antiforgery before mapping static assets and Razor components. Middleware order in `Program.cs` is significant.
- Tool flow: localized route `/{lang}/{tool-slug}` → Razor tool under `Components/Tools/` → `ToolLayout`/SEO metadata and localized `data-*` or JSON configuration → route-selected script under `wwwroot/tools/` → optional dynamic import from `wwwroot/wasm/<domain>/` → Rust computation → DOM/download update.
- Localization: `JsonLocalizationService` preloads JSON from `wwwroot/i18n/{lang}/`, caches it in concurrent dictionaries, and falls back requested language → English → key. URL culture is canonical; supported languages are `en`, `ru`, `es`, `de`, `pt`, `zh`, `fr`, `ja`, `ko`, and `hi`.
- State: browser preferences, favorites, and recent tools use `localStorage`; theme is mirrored to a cookie so SSR can emit the initial `data-theme`.
- WASM: independent domain crates under `wasm/` expose `#[wasm_bindgen]` APIs. `wasm/build.ps1` compiles them and writes web bindings into the site's `wwwroot/wasm/` tree.
- UI kit: `packages/ui-kit` builds an ES-only React library. `apps/storybook` aliases UI-kit source for isolated visual development. Do not assume these components are consumed by the Razor site.

## Key Directories

- `MyDevToolsApp/MyDevTools.Site/Components/Tools/`: routed Razor tool pages.
- `MyDevToolsApp/MyDevTools.Site/Components/{Layout,Pages,Seo,Common}/`: shell, routes, metadata, and shared Razor UI.
- `MyDevToolsApp/MyDevTools.Site/{Middleware,Services}/`: request pipeline, caching, culture, and JSON localization.
- `MyDevToolsApp/MyDevTools.Site/wwwroot/tools/`: browser controllers for individual tools.
- `MyDevToolsApp/MyDevTools.Site/wwwroot/i18n/<lang>/`: current localization source of truth.
- `MyDevToolsApp/MyDevTools.Site/Styles/`: CSS input; `wwwroot/app.css` is generated.
- `wasm/<domain>/`: Rust crates for hash, encoding, cryptography, structured data, passwords, text/image/regex/PDF/QR/IP tools.
- `MyDevToolsApp/Tools/LocalizationValidator/`: standalone .NET localization QA utility; not part of the solution.
- `packages/ui-kit/`: React/TypeScript design-system package.
- `apps/storybook/`: Storybook host and stories for the UI kit.

## Development Commands

Run from the repository root unless a directory change is shown.

```powershell
# Primary site: http://localhost:3311
dotnet run --project MyDevToolsApp/MyDevTools.Site/MyDevTools.Site.csproj
dotnet build MyDevToolsApp/MyDevTools.Site/MyDevTools.Site.csproj

# Site CSS/static asset pipeline
cd MyDevToolsApp/MyDevTools.Site
npm run dev
npm run build

# Generate all default WASM domains, or one domain
pwsh ./wasm/build.ps1 -Configuration Release
pwsh ./wasm/build.ps1 -Configuration Release -Domains hash

# Rust tests
cargo test --workspace --manifest-path wasm/Cargo.toml
cargo test --manifest-path wasm/hash/Cargo.toml

# Localization validation
dotnet run --project MyDevToolsApp/Tools/LocalizationValidator

# Root npm workspace
npm run build
npm run storybook             # port 6006
npm run storybook:build
npm run ui-kit:build
npm run lint -w @mydevtools/ui-kit
npm run lint -w @mydevtools/storybook
```

Debug `dotnet build`/`dotnet run` invokes the site Vite build; Release/publish does not. The Vite prebuild rewrites the service-worker cache version in `wwwroot/sw.js`. Docker Release builds also consume pre-generated CSS and WASM; regenerate and commit those artifacts when their sources change. The WASM script's default list omits the workspace `ipcalc` crate, so use `-Domains ipcalc` explicitly when needed.

## Code Conventions & Common Patterns

- C#/Razor: PascalCase types/files and async `Task`/`await`; inject services with `@inject`/`[Inject]`, constructor-inject middleware, and use structured `ILogger` calls. Preserve middleware ordering.
- Tool pages inherit `ToolComponentBase`, set `LocalizationNamespace`, and use `T()`/`TCommon()`. Use `ToolLayout` and place `MetaTags` inside its content. Do not add tool text to `.resx`; current localization is JSON.
- Naming across layers: `HashCalculator.razor` / route `hash-calculator` / `hash-calculator.js` / `tools/hash-calculator.json`; JavaScript uses camelCase, Rust modules/exports use snake_case.
- Browser code must be SSR-safe: bind after DOM readiness, use delegated handlers or one-time root guards (`WeakSet`/`data-initialized`), cache lazy import promises, and keep user data in the browser. For long file work, follow existing chunking, progress, and `AbortController` patterns.
- Surface localized UI errors. In JS, catch rejected WASM, clipboard, storage, and file operations and treat `AbortError` separately. Rust boundaries validate input and normally return `Result<_, JsValue>`.
- UI-kit components extend native HTML prop types, export named `Props`, spread remaining props, use `cn()` with `mdt-*` classes, and remain stateless composition primitives where possible. TypeScript is strict, ES-module based, and `noEmit` outside Vite builds.
- Adding a tool requires synchronized registration because language/tool catalogs are duplicated. At minimum inspect `Middleware/HeadRequestMiddleware.cs`, `Middleware/CultureRedirectMiddleware.cs`, `Components/App.razor`, layout/home catalogs, route-selected assets, and all locale trees.
- Make surgical changes and follow an existing neighboring tool/component. Generated `wwwroot/app.css` and wasm-bindgen outputs must not be hand-edited.

## Important Files

- `MyDevToolsApp/MyDevToolsApp.slnx`: solution containing the production site.
- `MyDevToolsApp/MyDevTools.Site/Program.cs`: DI, localization initialization, and ordered HTTP pipeline.
- `MyDevToolsApp/MyDevTools.Site/Components/App.razor`: document shell and route-sensitive asset loading.
- `MyDevToolsApp/MyDevTools.Site/Components/Routes.razor`: Razor router and default layout.
- `MyDevToolsApp/MyDevTools.Site/Components/ToolComponentBase.cs`: tool localization contract.
- `MyDevToolsApp/MyDevTools.Site/Services/JsonLocalizationService.cs`: JSON loading/cache/fallback behavior.
- `MyDevToolsApp/MyDevTools.Site/Middleware/CultureRedirectMiddleware.cs`: localized URL policy.
- `MyDevToolsApp/MyDevTools.Site/MyDevTools.Site.csproj`: .NET target and Debug-only Vite hook.
- `MyDevToolsApp/MyDevTools.Site/{package.json,vite.config.js,tailwind.config.js}`: site asset pipeline.
- `wasm/{Cargo.toml,build.ps1}`: Rust workspace and authoritative wasm-bindgen packaging flow.
- `package.json`: npm workspace commands for `apps/*` and `packages/*`.
- `packages/ui-kit/src/index.ts`: public UI-kit barrel.
- `Dockerfile`: .NET 10 Release image; assumes generated browser assets already exist.

## Runtime/Tooling Preferences

- Required: .NET 10 SDK, Rust/rustup with `wasm32-unknown-unknown`, `wasm-bindgen-cli`, and npm. Install WASM prerequisites with `rustup target add wasm32-unknown-unknown` and `cargo install wasm-bindgen-cli --locked`.
- Use npm, not Bun/pnpm/Yarn. Root `package.json` declares `npm@11.12.1` and uses `package-lock.json`; the site has its own `package.json` and lockfile. Node and Rust compiler versions are otherwise unpinned.
- Root npm workspaces and the site Vite project are separate dependency/build contexts.
- Tailwind 3, DaisyUI 4, Vite, and PostCSS generate the site CSS. React 19, TypeScript, Vite, and Storybook drive the UI-kit workspace.
- Trust manifests, scripts, and current source over older prose: several docs contain stale port, `.resx`, Tailwind-version, and feature-status guidance.

## Testing & QA

- Rust is the conventional automated test layer. Run the workspace or affected crate tests; cryptography also has integration fixtures under `wasm/cryptography/tests/`.
- Cryptography's browser WASM smoke is feature-gated:
  ```powershell
  cd wasm/cryptography
  $env:CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER='wasm-bindgen-test-runner'
  cargo test --target wasm32-unknown-unknown --features wasm-test
  ```
- After changing localization, run `dotnet run --project MyDevToolsApp/Tools/LocalizationValidator`. It checks JSON validity, required files/keys, Razor `T()` references, empty values, and untranslated strings; failures exit nonzero.
- UI changes require a real-browser smoke test against the running site, including Console/Network and WASM loading where relevant. Use Playwright/Chrome rather than `curl` or HTML text matching. Check representative English/Russian routes, all ten languages for localization-heavy changes, and the language switcher.
- Storybook provides manual component/a11y review (`npm run storybook`), but accessibility test mode is currently `todo` and there are no story interaction tests.
- No .NET test project, JavaScript test script, CI workflow, or enforced coverage threshold currently exists. Add tests only in the established layer that owns the changed behavior; do not claim repository-wide coverage from a narrowed check.
