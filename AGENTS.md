# AGENTS.md - Developer Guide for AI Coding Agents

This document provides essential information for AI coding agents working on MyDevTools.app.

## Project Overview

**MyDevTools.app** is a privacy-first developer tools web application built with:
- **.NET 10** with Blazor SSR (Server-Side Rendering)
- **Rust/WebAssembly** for client-side data processing
- **Tailwind CSS** (v4) via Vite for styling
- **Multi-language support** (English, Russian, Spanish)

**Core Principle**: ALL user data processing happens in the browser via WASM. The server only handles SSR and static file serving.

## Build, Test & Run Commands

### .NET/Blazor Application

```powershell
# Navigate to site directory
cd MyDevToolsApp\MyDevTools.Site

# Run development server (includes CSS build via npm)
dotnet run

# Build (Debug)
dotnet build

# Build (Release)
dotnet build -c Release

# Clean build artifacts
dotnet clean
```

The application runs at `https://localhost:5001` (or port from `launchSettings.json`).

### WASM Modules (Rust)

```powershell
# Build all WASM modules (from repo root)
cd wasm
.\build.ps1 -Configuration Release

# Build specific domain only
.\build.ps1 -Configuration Release -Domains @('hash')

# Debug build (faster, larger files)
.\build.ps1 -Configuration Debug

# Test all Rust modules
cargo test

# Test specific module
cd wasm/hash
cargo test

# Test with output for debugging
cargo test -- --nocapture

# Clean Rust artifacts
cargo clean
```

**WASM modules output to**: `MyDevToolsApp/MyDevTools.Site/wwwroot/wasm/<domain>/`

Available domains: `hash`, `encoding`, `cryptography`, `structured_data`, `password`, `text_tools`, `image_tools`, `regex_tool`, `qrcode`

### CSS/Frontend Build

```powershell
cd MyDevToolsApp\MyDevTools.Site

# Build CSS with Vite (Tailwind v4)
npm run build

# Development mode with watch
npm run dev
```

## Code Style Guidelines

### C#/Blazor

**Naming Conventions:**
- PascalCase for classes, methods, properties, public fields
- camelCase for private fields, parameters, local variables
- Prefix private fields with underscore: `_logger`, `_cache`

**Type System:**
- Nullable reference types are ENABLED (`<Nullable>enable</Nullable>`)
- Use `string?` for nullable strings, `string` for non-null
- Use `default!` for required parameters: `public string Title { get; set; } = default!;`

**Imports:**
```csharp
// Global usings are enabled
// Explicit usings for Resources
using MyDevTools.Site.Resources;
using System.Text.Json;
```

**Component Structure:**
```razor
@page "/{lang}/tool-name"
@using MyDevTools.Site.Resources
@inject NavigationManager Navigation

<!-- SEO Components -->
<MetaTags Title="@AppStrings.Tool_Title" Description="@AppStrings.Tool_Description" CurrentUrl="@Navigation.Uri" />
<HreflangLinks ToolPath="tool-name" />
<JsonLdTool ToolName="@AppStrings.Tool_Title" Description="@AppStrings.Tool_Description" CurrentUrl="@Navigation.Uri" />

<!-- Tool Layout -->
<ToolLayout Title="@AppStrings.Tool_Title" Description="@AppStrings.Tool_Description">
    <!-- Tool content -->
</ToolLayout>

@code {
    /// <summary>
    /// XML documentation for parameters and important members
    /// </summary>
    [Parameter]
    public string Lang { get; set; } = "en";
}
```

**XML Comments:**
- Add XML documentation (`/// <summary>`) for:
  - All public classes and interfaces
  - Component parameters (`[Parameter]`)
  - Service methods
- Place `@code` block XML comments INSIDE the block, not before directives

**Services:**
- Register services in `Program.cs`
- Use dependency injection via `@inject` in components
- Prefer scoped services for per-request state

### Rust/WASM

**Naming Conventions:**
- snake_case for functions, variables, modules
- PascalCase for types, enums, traits
- SCREAMING_SNAKE_CASE for constants

**Module Structure:**
```rust
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn exported_function(input: &[u8]) -> Vec<u8> {
    // Implementation
}

// Private helper functions
fn internal_helper(data: &str) -> String {
    // Implementation
}
```

**Cargo.toml Requirements:**
```toml
[lib]
crate-type = ["cdylib", "rlib"]  # Both for WASM and native tests

[dependencies]
wasm-bindgen = "0.2"
```

**Error Handling:**
- Use `Result<T, E>` for fallible operations
- Convert errors to strings for WASM boundary: `.map_err(|e| e.to_string())?`
- Use `#[wasm_bindgen]` return type: `Result<JsValue, JsValue>` when needed

**Testing:**
- Write unit tests for all logic functions
- Keep tests native (no wasm-bindgen-test unless necessary)
- Use `#[cfg(test)]` for test modules

### JavaScript (Client-Side)

**Placement:**
- Embed JavaScript in `<script>` tags within `.razor` files
- Keep JavaScript close to the component it serves

**WASM Loading Pattern:**
```javascript
let wasmModulePromise = null;

async function getWasm() {
    if (!wasmModulePromise) {
        wasmModulePromise = import('/wasm/domain/domain.js').then(async (m) => {
            await m.default();
            return m;
        });
    }
    return wasmModulePromise;
}
```

**Event Handling with Blazor SSR Enhanced Navigation:**
```javascript
// Use event delegation for persistent handlers
document.addEventListener('click', (e) => {
    if (e.target.closest('#my-button')) {
        handleClick(e);
    }
});

// OR reinitialize on navigation
function init() {
    // Setup handlers
}
document.addEventListener('DOMContentLoaded', init);
document.addEventListener('enhancedload', init);
```

### Localization

**REQUIRED: Use Strongly-Typed Resources**
```razor
@using MyDevTools.Site.Resources

<!-- ✅ CORRECT -->
<h1>@AppStrings.Tool_Title</h1>
<button>@AppStrings.Tool_Action</button>

<!-- ❌ WRONG: Magic strings -->
<h1>@L["Tool_Title"]</h1>
```

**Adding New Translations:**
1. Open `Resources/AppStrings.resx` in Visual Studio
2. Add key (e.g., `MyTool_Title`) with English value
3. Visual Studio auto-generates `AppStrings.Designer.cs`
4. Add translations in `AppStrings.ru.resx` and `AppStrings.es.resx`

**Naming Convention for Resource Keys:**
- `ToolName_Element`: e.g., `HashCalculator_Title`, `JsonBeautifier_Description`
- `Common_Element`: for shared strings: `Common_Loading`, `Common_Error`

## Architecture Rules

### ❌ PROHIBITED
- Processing user data on the server
- Sending files/text/JSON/XML to backend
- Using ASP.NET API endpoints for tool logic
- WebSocket/SignalR for interactivity
- Creating unique layouts for each tool (use `ToolLayout`)
- Using magic strings for localization
- Placing XML comments before `@page` or `@inject` (they render as text)

### ✅ REQUIRED
- Server-Side Rendering for HTML only
- Client-side WASM for ALL data processing
- Privacy-first: data never leaves browser
- Use `ToolLayout` component for all tools
- Include SEO components: `MetaTags`, `HreflangLinks`, `JsonLdTool`
- Strongly-typed resources via `AppStrings.*`
- Lazy-load WASM modules (separate bundle per domain)

## File Structure

```
/
├── MyDevToolsApp/
│   ├── MyDevToolsApp.slnx          # Solution file
│   └── MyDevTools.Site/
│       ├── Program.cs               # App configuration
│       ├── Components/
│       │   ├── Layout/
│       │   │   ├── MainLayout.razor
│       │   │   └── ToolLayout.razor # Base layout for ALL tools
│       │   ├── Common/              # Reusable UI components
│       │   ├── Seo/                 # SEO components
│       │   ├── Tools/               # Individual tool components
│       │   └── Pages/
│       ├── Services/                # Dependency injection services
│       ├── Middleware/              # ASP.NET middleware
│       ├── Resources/
│       │   ├── AppStrings.resx      # English (default)
│       │   ├── AppStrings.ru.resx   # Russian
│       │   ├── AppStrings.es.resx   # Spanish
│       │   └── AppStrings.Designer.cs # Auto-generated
│       ├── wwwroot/
│       │   ├── wasm/                # WASM build outputs
│       │   └── app.css              # Generated by Vite
│       ├── package.json             # npm/Vite config
│       └── MyDevTools.Site.csproj
└── wasm/
    ├── Cargo.toml                   # Workspace manifest
    ├── build.ps1                    # WASM build script
    ├── hash/                        # Hash algorithms domain
    ├── encoding/                    # Base64, Hex, etc.
    ├── cryptography/                # Encryption, keys, X.509
    └── structured_data/             # JSON/XML/YAML
```

## Creating a New Tool

1. **Create component**: `MyDevToolsApp/MyDevTools.Site/Components/Tools/YourTool.razor`
2. **Add localization**: Add keys to `Resources/AppStrings.resx` (and `.ru.resx`, `.es.resx`)
3. **Follow template**:
   - Use `@page "/{lang}/tool-name"`
   - Include SEO components
   - Use `ToolLayout`
   - Embed client-side JavaScript in `<script>` tag
4. **Load WASM**: Use lazy loading pattern for WASM modules
5. **Test**: All supported languages (`/en/`, `/ru/`, `/es/`)

## Common Patterns

### URL Structure
- Multi-language: `/{lang}/tool-name` where `lang` ∈ {en, ru, es}
- Root `/` redirects to user's browser language

### Component Parameters
```csharp
[Parameter, EditorRequired]  // Required parameter
public string Title { get; set; } = default!;

[Parameter]  // Optional parameter
public string? Description { get; set; }
```

### Dependency Injection
```razor
@inject NavigationManager Navigation
@inject ILocalizationService Localization
```

### Data Attributes for JavaScript
```razor
<div id="tool-root"
     data-loading="@AppStrings.Common_Loading"
     data-error="@AppStrings.Common_Error">
</div>
```

## Reference Documentation

- **README.md** - Project overview and principles
- **DEVELOPMENT.md** - Detailed development guide
- **ARCHITECTURE.md** - System architecture
- **TOOL_DEVELOPMENT_GUIDE.md** - ⭐ **ВАЖНО!** Руководство по созданию инструментов (JavaScript, события, типичные проблемы)
- **LOCALIZATION_GUIDE.md** - Localization details
- **WASM_INTEGRATION.md** - WASM integration patterns
- **PROJECT_STRUCTURE.md** - Directory structure
- **crypto-roadmap.md** - Cryptography feature roadmap

## ⚠️ Критически важно при создании инструментов

**ВСЕГДА читайте [TOOL_DEVELOPMENT_GUIDE.md](./TOOL_DEVELOPMENT_GUIDE.md) перед созданием нового инструмента!**

Этот документ содержит:
- ✅ Правильные паттерны обработки событий для Blazor SSR
- ✅ Решения типичных проблем (кнопки не работают, редиректы, CDN блокируется)
- ✅ Шаблоны кода для быстрого старта
- ✅ Чеклист перед коммитом

Несоблюдение этих рекомендаций приводит к проблемам с обработчиками событий!
