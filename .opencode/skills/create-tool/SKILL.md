---
name: create-tool
description: Scaffolds a new MyDevTools tool (Razor + JS) ensuring Blazor SSR compatibility and project conventions.
---

# Create Tool Skill

Use this skill to create a new tool. It enforces the **Blazor SSR Event Delegation** pattern and **Privacy-First** architecture.

## 1. Gather Requirements
If not provided, ask the user for:
- **Tool Name** (PascalCase, e.g., `JsonValidator`)
- **Route Name** (kebab-case, e.g., `json-validator`)

## 2. Create Razor Component
**Path:** `MyDevToolsApp/MyDevTools.Site/Components/Tools/{ToolName}.razor`

**Template:**
```razor
@page "/{lang}/{route-name}"
@using MyDevTools.Site.Resources
@inject NavigationManager Navigation

<MetaTags Title="@AppStrings.{ToolName}_Title"
          Description="@AppStrings.{ToolName}_Description"
          CurrentUrl="@Navigation.Uri" />

<HreflangLinks ToolPath="{route-name}" />

<JsonLdTool ToolName="@AppStrings.{ToolName}_Title"
            Description="@AppStrings.{ToolName}_Description"
            CurrentUrl="@Navigation.Uri" />

<ToolLayout Title="@AppStrings.{ToolName}_Title" Description="@AppStrings.{ToolName}_Description">
    <div id="{route-name}-root"
         data-loading="@AppStrings.Common_Loading"
         data-error="@AppStrings.Common_Error">
        
        <!-- Tool UI Implementation -->
        <div class="card bg-base-100 shadow-xl">
            <div class="card-body">
                <input id="{route-name}-input" type="text" class="input input-bordered" placeholder="Input" />
                <button id="{route-name}-action-btn" class="btn btn-primary">Action</button>
                <div id="{route-name}-output" class="mt-4 hidden"></div>
            </div>
        </div>

    </div>
</ToolLayout>

@code {
    [Parameter] public string Lang { get; set; } = "en";
}
```

## 3. Create JavaScript Logic
**Path:** `MyDevToolsApp/MyDevTools.Site/wwwroot/tools/{route-name}.js`

**Template:**
```javascript
(function () {
    const initializedRoots = new WeakSet();

    function getElements() {
        const root = document.getElementById('{route-name}-root');
        if (!root) return null;
        // Select other elements scoped to root if needed, or by ID
        return { root };
    }

    // --- EVENT DELEGATION (Required for Blazor SSR) ---
    function bindDelegatedHandlersOnce() {
        if (window.__mydevtools_{toolname_lower}_bound) return;
        window.__mydevtools_{toolname_lower}_bound = true;

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof HTMLElement)) return;

            if (target.id === '{route-name}-action-btn') {
                // Handle click
                console.log('Action clicked');
            }
        });
    }

    bindDelegatedHandlersOnce();

    // --- INITIALIZATION ---
    function initIfPresent() {
        const els = getElements();
        if (!els || initializedRoots.has(els.root)) return;
        initializedRoots.add(els.root);
        
        // Initial setup logic here
    }

    initIfPresent();

    // Observe DOM for navigation updates
    try {
        new MutationObserver(() => initIfPresent())
            .observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
})();
```

## 4. Final Instructions
Tell the user to:
1.  **Add Resources:** Add `{ToolName}_Title` and `{ToolName}_Description` to `Resources/AppStrings.resx`.
2.  **Register Script:** Add logic to `Components/App.razor`:
    ```csharp
    private bool Is{ToolName} => CurrentPath.Contains("/{route-name}", StringComparison.OrdinalIgnoreCase);
    ```
    ```razor
    @if (Is{ToolName}) { <script src="@Assets["tools/{route-name}.js"]"></script> }
    ```
