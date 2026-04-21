# UI Kit Migration Map

## Goal

This document maps the current Blazor UI patterns to the new Storybook reference stories in the standalone `ui-kit` workspace.

It is not an implementation checklist for React pages yet. It is a migration reference that answers four questions:

- what exists in the current Blazor app
- which Storybook story now represents that pattern
- how ready that area is for migration
- what is still missing before a real React page can be built

## Status Levels

| Level | Meaning |
| --- | --- |
| `ready for page assembly` | The visual and structural pattern is clear enough to compose into a first React page. |
| `pattern-ready, logic-missing` | The shell and interaction model are clear, but real logic, state, or integrations are still absent. |
| `reference-only` | The Storybook story captures intent, but the real React page would still need substantial new work or new components. |

## Baseline Component Coverage

These stories define the reusable building blocks that the migration patterns are built from.

| Current need in Blazor app | Storybook story | Status | Notes |
| --- | --- | --- | --- |
| Primary and secondary actions across tools | `Button.stories.tsx` | `ready for page assembly` | Covers action hierarchy, sizes, and icon-bearing actions. |
| Icon-only actions like copy, favorite, search, theme | `IconButton.stories.tsx` | `ready for page assembly` | Good base for toolbars and shell actions. |
| Text and numeric inputs | `Input.stories.tsx` | `ready for page assembly` | Already aligned with `Field` semantics. |
| Large editor-like text entry | `Textarea.stories.tsx` | `ready for page assembly` | Used by editor and encode/decode patterns. |
| Compact settings selections | `Select.stories.tsx` | `ready for page assembly` | Used in settings sidebars and route/language shell stories. |
| State messaging and privacy notices | `Alert.stories.tsx` | `ready for page assembly` | Covers info, success, warning, and danger semantics. |
| Reusable surface shell | `Card.stories.tsx` | `ready for page assembly` | Base surface for shell, metrics, and content blocks. |
| Label + control + helper/error wrapper | `Field.stories.tsx` | `ready for page assembly` | Includes improved `aria` binding behavior. |
| Reusable block shell | `PanelCard.stories.tsx` | `ready for page assembly` | Useful for settings and local tool modules. |
| Shared tool panel semantics | `ToolPanel.stories.tsx` | `ready for page assembly` | Supports input/settings/output panel split. |
| File drag/drop entry | `FileDropZone.stories.tsx` | `ready for page assembly` | Keyboard and disabled states already covered in component work. |
| Shared page wrapper for tools | `ToolPageLayout.stories.tsx` | `ready for page assembly` | Good enough to scaffold first React tool pages. |

## Generic Migration Patterns

These stories capture recurring layouts before tying them to one specific tool.

| Current Blazor pattern | Source references | Storybook story | Status | Missing pieces for real React migration |
| --- | --- | --- | --- | --- |
| Text-heavy input/output tool | `JsonBeautifier.razor`, `WordCounter.razor`, `TextCaseConverter` family | `ToolPatterns.stories.tsx` -> `TextTransformer` | `pattern-ready, logic-missing` | Editor state, parsing/validation logic, clipboard feedback, persistence if needed. |
| File-heavy conversion dashboard | `ImageConverter.razor`, file-based converters | `ToolPatterns.stories.tsx` -> `FileConversionDashboard` | `pattern-ready, logic-missing` | Real upload pipeline, result generation, preview loading states, download URLs. |

## Concrete Tool Pilot Coverage

These stories are the strongest migration references because they map to real current tools.

| Current Blazor tool | Main source file | Storybook story | Status | Why it matters | Missing pieces |
| --- | --- | --- | --- | --- | --- |
| Hash calculator | `MyDevToolsApp/MyDevTools.Site/Components/Tools/HashCalculator.razor` | `HashCalculatorPattern.stories.tsx` | `pattern-ready, logic-missing` | Covers text input, file input, dense sidebar, multiple result rows, copy actions. | Real hashing pipeline, algorithm data model, file processing, async result states. |
| JSON beautifier | `MyDevToolsApp/MyDevTools.Site/Components/Tools/JsonBeautifier.razor` | `JsonBeautifierPattern.stories.tsx` | `pattern-ready, logic-missing` | Covers editor-first workspace, dense toolbar, quick settings, result metrics. | Real editor behavior, parse errors, formatting engine, file open/save hooks. |
| Base64 encoder | `MyDevToolsApp/MyDevTools.Site/Components/Tools/Base64Encoder.razor` | `Base64EncoderPattern.stories.tsx` | `pattern-ready, logic-missing` | Covers dual text/file intake, symmetric encode/decode actions, output preview state. | Real mode switching, binary/text preview branching, file download generation. |
| QR code generator | `MyDevToolsApp/MyDevTools.Site/Components/Tools/QrCodeGenerator.razor` | `QrCodeGeneratorPattern.stories.tsx` | `pattern-ready, logic-missing` | Covers preview-first generator workflow with compact settings and export actions. | Real QR rendering, color/style controls, logo composition, export pipeline. |
| Image resizer | `MyDevToolsApp/MyDevTools.Site/Components/Tools/ImageResizer.razor` | `ImageResizerPattern.stories.tsx` | `pattern-ready, logic-missing` | Covers file-first media workflow, resize settings, before/after visual comparison. | Actual image processing, aspect-ratio logic, file metadata extraction, download blob handling. |

## App-Level Shell Coverage

These stories represent the layer above tool pages.

| Current Blazor area | Source references | Storybook story | Status | Missing pieces |
| --- | --- | --- | --- | --- |
| Home hero and category catalog | `Home.razor`, `HeroSection.razor`, `ToolsSection.razor` | `AppShellPatterns.stories.tsx` -> `HomeAndCatalog` | `pattern-ready, logic-missing` | Tool/category data source, favorites persistence, navigation wiring, responsive production polish. |
| Search and favorites discovery view | `FavoritesSection.razor`, `MainLayout.razor`, search interactions | `AppShellPatterns.stories.tsx` -> `SearchAndFavoritesView` | `pattern-ready, logic-missing` | Search indexing, filters state, favorites/recent storage, command/search integration. |
| Global command palette and locale-aware header | `MainLayout.razor`, `CommandPalette.razor`, `LanguageSwitcher.razor` | `CommandSearchShellPatterns.stories.tsx` | `pattern-ready, logic-missing` | Actual command palette behavior, keyboard bindings, locale routing implementation, tool data indexing. |
| Footer, trust framing, SEO block placement, route persistence | `MainLayout.razor`, `ToolLayout.razor`, `ToolSeoContent.razor` | `InfrastructureShellPatterns.stories.tsx` | `pattern-ready, logic-missing` | SEO metadata wiring, real footer IA, localized route helpers, shared app-shell composition. |

## Data And Result Pattern Coverage

These stories capture repeated small structures that appear across many tools.

| Current Blazor pattern | Source references | Storybook story | Status | Missing pieces |
| --- | --- | --- | --- | --- |
| Generated history rows with copy/download actions | `UuidGenerator.razor`, hash/generator result lists | `DataResultPatterns.stories.tsx` -> `HistoryAndResultRows` | `ready for page assembly` | Needs only real data and event wiring when used in pages. |
| Compact saved-pattern tables | `RegexTester.razor` and similar structured lists | `DataResultPatterns.stories.tsx` -> `HistoryAndResultRows` | `ready for page assembly` | Could later become its own reusable table component if repeated heavily. |
| Regex flag chips and compact match cards | `RegexTester.razor` | `DataResultPatterns.stories.tsx` -> `MatchExplorerAndChips` | `ready for page assembly` | Still needs real parsing/group metadata and filtering logic. |

## What The Migration Map Covers Well Now

- tool-page layout shells
- action hierarchy and dense developer-tool UI language
- text, file, editor, encode/decode, preview, and result-heavy workflows
- app discovery shell with home, search, favorites, and category surfaces
- infrastructure shell with locale-aware routing and SEO/trust placement
- repeated result structures like rows, chips, metric cards, and compact tables

## What Is Still Missing

These are the biggest gaps between the current Storybook map and a real React frontend.

### React application concerns

- routing and nested layouts
- locale-aware route generation helpers
- metadata and head management
- command palette state and keyboard handling
- persistent favorites/recent/search history state

### Tool logic concerns

- WASM integration boundaries
- file processing adapters
- clipboard/download/toast behavior
- async and long-running processing states
- validation and parsing error models

### Possible future reusable UI extractions

- result table primitive if compact tables repeat widely
- filter chip group primitive if chip bars appear across app shell and tools
- stats/metric card primitive if repeated enough across pilot pages
- toolbar/action-strip primitive for editor-heavy tools

## Recommended Next Phase

The next phase should not create more Storybook pattern files by default.

Recommended order:

1. Pick the first real React pilot page.
2. Assemble it only from the current `ui-kit` components and validated Storybook patterns.
3. Introduce new reusable components only when a real page exposes a genuine repeated gap.
4. Keep this map updated when a Storybook pattern graduates into a real React route.

## Recommended First React Pilots

Best candidates based on current pattern readiness:

1. `HashCalculator`
2. `JsonBeautifier`
3. `Base64Encoder`

Why these first:

- they already have focused Storybook pilot references
- they exercise text/file/result workflows without needing the most complex custom visual widgets
- together they pressure-test most of the current `ui-kit` surface area
