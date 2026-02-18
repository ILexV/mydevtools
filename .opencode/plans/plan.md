# Plan: Remove JSRuntime from Razor Components

The goal is to remove all `JSRuntime` dependencies from `.razor` files in `MyDevTools.Site`, as the application is intended to rely on Server-Side Rendering (SSR) and client-side WASM/JS without Blazor's JS interop interfering during rendering.

## Identified Occurrences

1.  **`Components/Layout/ToolLayout.razor`**
    *   **Usage**: Injects `IJSRuntime` to call `window.MyDevToolsRecent.addRecent` via `eval` in `OnAfterRenderAsync`.
    *   **Action**: Remove the injection and the entire `AddToRecent` logic.

2.  **`Components/Sections/HeroSection.razor`**
    *   **Usage**: Injects `IJSRuntime` to initialize/destroy `HeroAnimation` and show PWA install prompt.
    *   **Action**: Remove the injection, `OnAfterRenderAsync`, `DisposeAsync`, and `InstallPWA` methods.

3.  **`Components/Sections/ToolsSection.razor`**
    *   **Usage**: Injects `IJSRuntime` but seemingly unused (based on code review).
    *   **Action**: Remove the unused injection.

## Step-by-Step Plan

1.  **Modify `ToolLayout.razor`**:
    *   Remove `@inject IJSRuntime JSRuntime`.
    *   Remove `OnAfterRenderAsync` method.
    *   Remove `AddToRecent` method.
    *   Remove `ExtractSlugFromUrl` method (helper for `AddToRecent`).

2.  **Modify `HeroSection.razor`**:
    *   Remove `@inject IJSRuntime JSRuntime`.
    *   Remove `@implements IAsyncDisposable`.
    *   Remove `OnAfterRenderAsync` method.
    *   Remove `InstallPWA` method.
    *   Remove `DisposeAsync` method.
    *   Remove `isDisposed` field.
    *   *Note*: The PWA button in the template already has an `onclick` attribute with inline JS (`document.getElementById...`), so removing the C# method `InstallPWA` won't break the button if it relies on that inline JS. However, the button's `onclick` in the file `HeroSection.razor` (line 60) is:
        ```html
        onclick="(function(){ var el = document.getElementById('pwa-install-prompt'); if(el) el.style.display = 'flex'; })(); return false;"
        ```
        It does NOT call the C# method. The C# method `InstallPWA` is unused in the template! It was likely dead code or intended for a different button.

3.  **Modify `ToolsSection.razor`**:
    *   Remove `@inject IJSRuntime JSRuntime`.

## Verification
*   After changes, run `dotnet build` to ensure no compilation errors.
*   Verify the application starts and pages load without "JSRuntime not initialized" errors.
