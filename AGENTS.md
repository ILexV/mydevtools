# AGENTS.md

## What To Know
- Main app: `MyDevToolsApp/MyDevTools.Site` (`net10.0` Blazor SSR). Root solution: `MyDevToolsApp/MyDevToolsApp.slnx`.
- Tool pages live in `MyDevToolsApp/MyDevTools.Site/Components/Tools/` and should use `ToolLayout`; put `MetaTags` inside the layout content.
- Tool localization is JSON-based through `ToolComponentBase` (`T()`, `TCommon()`) and files under `MyDevToolsApp/MyDevTools.Site/wwwroot/i18n/{lang}/...`; do not add new tool text to `.resx`.
- The server is SSR/static only. User data processing belongs in browser JS/WASM.
- Adding a new tool usually means updating the hard-coded slug lists in `Middleware/HeadRequestMiddleware.cs` and `Middleware/CultureRedirectMiddleware.cs`.
- Supported languages are `en`, `ru`, `es`, `de`, `pt`, `zh`, `fr`, `ja`, `ko`, `hi`.

## Run It
- Site dev: `dotnet run --project MyDevToolsApp/MyDevTools.Site/MyDevTools.Site.csproj`.
- Local site URL: `http://localhost:3311` from `launchSettings.json`.
- Site build: `dotnet build MyDevToolsApp/MyDevTools.Site/MyDevTools.Site.csproj`.
- CSS build/watch: `cd MyDevToolsApp/MyDevTools.Site; npm run build` or `npm run dev`.
- `npm run build` writes `wwwroot/app.css`; do not edit that file by hand.
- Debug `dotnet build`/`dotnet run` triggers the Vite build target in the site project; Release does not.
- WASM build: `pwsh ./wasm/build.ps1 -Configuration Release` or `-Domains @('hash')`.
- WASM prerequisites: `rustup target add wasm32-unknown-unknown` and `cargo install wasm-bindgen-cli --locked`.
- Rust tests: `cd wasm/<crate>; cargo test`.
- Localization checks: `cd MyDevToolsApp/Tools/LocalizationValidator; dotnet run` after changing `wwwroot/i18n`.
- There are currently no .NET test projects in the repo.

## Verify
- If asked to open or check the site, use Playwright tools against a running server; do not rely on `curl` or text matching.
- Trust project files and scripts over prose when they disagree.

## Working Style
- For ambiguous or multi-interpretation tasks, state assumptions explicitly and ask instead of guessing.
- Prefer the simplest implementation that satisfies the request; avoid speculative abstractions, configurability, and impossible-scenario handling.
- Make surgical changes: touch only code required for the task, match local style, and do not clean up unrelated code unless asked.
- Remove only the unused code created by your own change; mention unrelated dead code without deleting it.
- For non-trivial work, define a short goal-driven plan with concrete verification steps and keep iterating until those checks pass.
- These guidelines bias toward caution over speed; use judgment for trivial edits.
