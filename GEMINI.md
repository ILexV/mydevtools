# GEMINI.md — Project Context & Instructions

## 📌 Project Overview
**MyDevTools.app** is a privacy-first, web-based suite of developer tools (hash calculators, encoders, formatters).
*   **Core Philosophy:** **Privacy-First.** All data processing happens strictly in the user's browser (Client-Side). No user data is ever sent to the server for processing.
*   **Architecture:** Blazor Web App (Server-Side Rendering for HTML/SEO) + WebAssembly (Rust) for heavy computation + JavaScript for UI interactivity.
*   **Current State:** Active development (.NET 10).

## 🛠 Tech Stack
*   **Framework:** .NET 10 (Blazor Web App).
*   **Rendering:** Server-Side Rendering (SSR) for initial HTML/SEO.
*   **Computation:** Rust compiled to WebAssembly (`wasm32-unknown-unknown`).
*   **Interactivity:** Vanilla JavaScript (via `wwwroot/tools/`) & Blazor Components.
*   **Localization:** Built-in .NET localization with URL routing (`/{lang}/...`) and strongly-typed resources.

## 📂 Key Directory Structure
*   **`MyDevToolsApp/`**: Main .NET Solution.
    *   `MyDevTools.Site/`: The Blazor Web App project.
        *   `Components/Tools/`: Razor pages for individual tools (must use `ToolLayout`).
        *   `Resources/`: `.resx` files for localization (`AppStrings`).
        *   `wwwroot/`: Static assets, including compiled WASM and JS logic.
*   **`wasm/`**: Rust Workspace for WebAssembly modules.
    *   `hash/`, `encoding/`, `cryptography/`, `structured_data/`: Individual Rust crates.
    *   `build.ps1`: PowerShell script to build WASM modules and copy artifacts to `wwwroot`.

## 🚀 Build & Run Commands

### Prerequisites
*   .NET 10 SDK
*   Rust Toolchain (`rustup target add wasm32-unknown-unknown`)
*   `wasm-bindgen-cli` (`cargo install wasm-bindgen-cli --locked`)

### Web Application (.NET)
Run from `MyDevToolsApp/MyDevTools.Site/`:
```powershell
dotnet run
# OR
dotnet watch
```
*   **URL:** `https://localhost:5001` (Auto-redirects to `/{lang}/`)

### WebAssembly (Rust)
Run from project root or `wasm/` directory:
```powershell
# Build all modules (Release)
pwsh ./wasm/build.ps1 -Configuration Release

# Build specific domain
pwsh ./wasm/build.ps1 -Domains @('hash')
```

## 📏 Development Conventions

### 1. Architectural Rules (Strict)
*   **NO** server-side processing of user input (JSON, files, text).
*   **NO** API endpoints for data transformation.
*   **YES** to WASM (Rust) for complex logic and JS for UI manipulation.
*   **YES** to SSR only for serving HTML, SEO tags, and initial state.

### 2. New Tools
*   Create a Razor component in `Components/Tools/`.
*   **MUST** use `<ToolLayout>`:
    ```razor
    <ToolLayout Title="@AppStrings.MyTool_Title" Description="...">
        <!-- Content -->
    </ToolLayout>
    ```
*   Add SEO components (`MetaTags`, `JsonLdTool`, `HreflangLinks`).
*   Implement logic in a corresponding JS file in `wwwroot/tools/`.

### 3. Localization
*   **NEVER** use hardcoded strings in UI.
*   Use `AppStrings.resx` (English), `.ru.resx`, `.es.resx`.
*   Access via strongly-typed class: `@AppStrings.MyKey` (NOT `StringLocalizer["MyKey"]`).

### 4. WASM Integration
*   Keep WASM modules small and domain-specific (Lazy Loading).
*   Export functions using `wasm-bindgen`.
*   Load WASM in JS only when needed.

### 5. Blazor SSR Specifics
*   Beware of "Enhanced Navigation". Events bound via `addEventListener` might be lost on navigation.
*   Use **event delegation** (bind to `document`) or re-initialize on `enhancedload` event.

## 📄 Key Documentation Files
*   `README.md`: General overview.
*   `PROJECT_STRUCTURE.md`: Detailed file organization.
*   `DEVELOPMENT.md`: Detailed setup and workflow guide.
*   `LOCALIZATION_GUIDE.md`: How to add translations.
