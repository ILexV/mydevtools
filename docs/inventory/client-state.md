# Client-State Inventory (Stage 1)

> Scope: legacy `wwwroot/**` browser JS only. Mechanism: **localStorage + one cookie**. No `sessionStorage`, no `IndexedDB`. Language is URL-only (never stored).

## localStorage keys (15)

| Key | Owner | Shape / Example | Notes |
|---|---|---|---|
| `mydevtools_favorites` | favorites.js | JSON array `["json-beautifier",…]` | tool slugs |
| `mydevtools_recent` | favorites.js | JSON array (≤10) `[{slug,icon,timestamp}]` | LIFO, dedup, cap 10 |
| `theme` | theme.js | `"dark" \| "light"` | falls back to cookie |
| `pwa-install-dismissed` | pwa.js | `"true"` (only when dismissed) | hides install banner |
| `cron-date-format` | cron-generator.js + cron-parser.js (**shared**) | enum `"locale" \| "iso" \| "compact" \| "american" \| "full-month" \| "verbose" \| "locale-12h"` | shared key, default `locale` |
| `mydevtools.tools.hash-calculator.selectedAlgorithms.v1` | hash-calculator.js | JSON array `["md5","sha1","sha256"]` | default those 3; validated vs DOM list |
| `mydevtools.tools.password-generator.settings.v1` | password-generator.js | `{length,uppercase,lowercase,numbers,special,specialChars}` | settings only — **passwords NOT persisted** (history DOM-only ≤10) |
| `mydevtools_regex_saved` | regex-tester.js | `[{name,pattern,sample,flags}]` | ⚠ `sample` is user text |
| `json-beautifier-input` ⚠ | json-beautifier.js | raw string | ⚠ persists user JSON doc on every keystroke |
| `json-beautifier-indent` | json-beautifier.js | `"2" \| "tab"` | |
| `json-beautifier-sort-keys` | json-beautifier.js | `"true" \| "false"` | |
| `json-beautifier-compact-mode` | json-beautifier.js | `"true" \| "false"` | |
| `xml-beautifier-input` ⚠ | xml-beautifier.js | raw string | ⚠ persists user XML doc |
| `xml-beautifier-indent` | xml-beautifier.js | `"2" \| "tab"` | |
| `xml-beautifier-compact-mode` | xml-beautifier.js | `"true" \| "false"` | |

## Cookies (1)

| Name | Value | Attributes | Purpose |
|---|---|---|---|
| `theme` | `"dark" \| "light"` | `path=/; max-age=31536000; samesite=lax` | mirror of `localStorage.theme` so SSR emits correct theme before client JS. No Secure/HttpOnly. |

## Features with NO persistence

Command palette (in-memory; reads favorites/recent via window APIs; popular list hardcoded `[hash-calculator,base64-encoder,json-beautifier,password-generator,qr-code-generator]`); language preference (URL only); markdown preview; file drop; hero animation; password history (DOM-only); cron expression (only format persists); hash input text/file (only algo list persists).

## ⚠ Privacy flags — drop or make opt-in in the new build

1. **json-beautifier** → `json-beautifier-input`: stores entire JSON doc, every keystroke, across sessions.
2. **xml-beautifier** → `xml-beautifier-input`: same for XML.
3. **regex-tester** → `mydevtools_regex_saved[].sample`: each saved pattern stores its sample test text.

All other persisted state is settings/preferences only — safe to keep. The new build's TODO Stage 8 explicitly says: "Не сохранять пользовательские тексты, файлы, ключи, пароли или результаты без явного действия пользователя."

## Architecture notes

- Every `localStorage` access is `try/catch` → silent degradation to defaults.
- Event bus: `favorites.js` dispatches window `CustomEvent`s `favoritesChanged` / `recentChanged`; consumed by commandPalette + favorite/recent badge renderer.
- Global `window` APIs: `MyDevToolsFavorites`, `MyDevToolsRecent`, `commandPalette`, `PWA`.
- Recent auto-populated on tool-page visit (`autoAddToRecent`).
- **Key naming is inconsistent** (namespaced-versioned vs flat legacy). New build: pick one scheme (recommend namespaced `mdt.<feature>.<field>.v1`).
- `cron-date-format` shared by generator + parser via one key — preserve coupling.
- `favorites.js` ships an inline `TOOLS_REGISTRY` (~38 tools × 10 names + icon + popular) duplicating the catalog → in the new build this comes from the single `tools.ts` registry, not duplicated.

## Current Astro Explorer state (2026-10-08)

The inventory above describes the legacy baseline. `json-explorer` persists only these explicit settings through the existing versioned storage helper:

| Key | Stored setting |
|---|---|
| `mdt.tools.json-explorer.format.v1` | `auto`, `json` or `jsonl` |
| `mdt.tools.json-explorer.ordinary-limit.v1` | Ordinary JSON size limit |
| `mdt.tools.json-explorer.record-limit.v1` | JSONL record size limit |
| `mdt.tools.json-explorer.depth-limit.v1` | JSON depth limit |

Files, record contents, search/filter values, discovered schema and projected fields are **not persisted**. `csv-explorer` settings and data are session-only; importing either format does not write its contents to browser storage. `parquet-explorer` persists nothing: the open file, column selection and export options live only for the page session. `hex-viewer` persists nothing either: the open file, offset, search needle and export range live only for the page session.

## Desktop shell (2026-10-16)

The computer workspace at `/{lang}/desktop/` stores layout and appearance only. Tool text, files, keys and results stay out of these keys. A broken payload or an unknown `v` opens an empty desk; the catalog still works.

| Key | Storage | Shape |
|---|---|---|
| `mdt.desktop.layout.v1` | localStorage | `{ v: 1, activeId, windows[] }` — id, kind (`tool` or legacy `folder`), slug, instance, optional `groupId`/`tabActive`, bounds, previousBounds, mode, modeBeforeMinimize, dock, z. Equal `groupId` values restore tools as tabs in one frame; `tabActive` remembers each background group’s selected tab and inactive tab iframes stay mounted while the page remains open. Dock accepts halves and the four corner quarters. Not `concealed`, transfer payloads or tool contents. |
| `mdt.desktop.window-bounds.v1` | localStorage | `{ v: 1, bounds: { [toolSlug]: { x, y, width, height } } }` — last explicitly moved/resized/snapped geometry in stage CSS pixels, independent of the open-window list. Known tools and finite positive sizes only. No tool contents. |
| `mdt.desktop.prefs.v1` | localStorage | `{ v: 1, preset, fit, dim, hasImage, shortcuts, positions, pinned, iconSize, density, locked, hintDismissed, workspaces, widgets, widgetsCollapsed, folders, focusMode }`. Shortcuts are `cat:<id>`, `tool:<slug>` or `folder:<id>`. Custom `folders` store only a user-visible name and known tool shortcut ids; nested folders and tool data are rejected. `focusMode` hides icons/widgets but keeps a visible exit. `workspaces` stores a name plus tool slugs, optional group ids and stage shares (`x`, `y`, `width`, `height` in 0–1, `mode`), never field text. A missing `widgets` list shows Favorites then Recent; `[]` hides the column. |
| `mdt.desktop.entry.v1` | localStorage | `"1"` opens the desktop from the home page. Any other value leaves the catalog. |
| `mdt.desktop.skip` | sessionStorage | `"1"` while this tab asked to see the catalog. Stops the home-page redirect from bouncing straight back. |
| IndexedDB `mdt.desktop` / store `files` / key `wallpaper` | blob | Custom JPG, PNG or WebP after an in-browser re-encode. `hasImage` in prefs is only a flag. |

`theme` stays the existing light/dark key. Favorites and recent stay `mdt.favorites.v1` and `mdt.recent.v1`. An embedded tool page (`?embed=1`) does not record a second recent visit.

Desktop multi-selection, the selection rectangle and drag/drop previews are transient DOM/controller state. Shortcut undo keeps at most 20 in-memory snapshots of `shortcuts`, `positions`, `pinned` and custom-folder definitions for the current page session. Reloading clears undo and selection, not committed preferences.

“Restore window” keeps only the most recently closed window or tab group in controller memory for seven seconds. It recreates each tool and its geometry only; it deliberately cannot restore grouping, text, files, results or other iframe state. The notification says that input was not saved. It is not written to storage.

Initial window width profiles apply only when opening a new tool window. Without remembered geometry, height fits the initial embedded `.tool` after fonts load, once, within the stage with vertical margins. Tool interaction, manual geometry changes or a workspace override cancel pending fitting; it never steals focus or continually resizes as results grow. Existing windows and saved workspaces keep their geometry.

Explicit moves/resizes (including keyboard actions, half/quarter snapping and tiling) remember the latest bounds per tool, across closing and reloading. Reopening preserves exact CSS pixels while they fit; otherwise `clampBounds` moves/shrinks the frame into the current stage. Automatic viewport clamping never overwrites the remembered preference, so reopening on a larger stage restores it. Multiple copies share the last explicitly changed tool geometry. “Reset window layout” clears both open windows and remembered bounds only after any discard confirmation is accepted.

Taskbar previews and tab/group close actions read the same dirty-input check and share one confirmation flow. Desktop result transfers remain in `postMessage`/controller memory only, target one mounted iframe by request id, and are never copied to layout, preferences or bounds storage. The transfer target marks its pre-transfer input baseline before applying text, so transferred content receives the same close protection as trusted user edits.

Desktop discard checks compare editable input against an in-memory baseline captured before the first user interaction, after tool initialization/restored preferences. Untouched defaults (including QR color fields), unchanged values, cleared input and readonly output do not prompt. Selected files and occupied FileDrop zones do. CodeMirror supplies its immutable full document through `mdt:input-snapshot`, avoiding viewport-dependent checks and full-document string copies. These snapshots are released with the iframe and are never persisted or transmitted.
