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

Files, record contents, search/filter values, discovered schema and projected fields are **not persisted**. `csv-explorer` settings, column types, sort and group results are session-only; importing either format does not write its contents to browser storage. `parquet-explorer` persists nothing: the open file, column selection, filter conditions, group results and export options live only for the page session. `hex-viewer` persists nothing either: the open file, offset, search needle and export range live only for the page session. `sqlite-explorer` stores only its export format; the database copy, SQL and results live in its worker for the page session and are dropped on cancel. `local-data-playground` and `data-format-converter` also persist nothing: DuckDB tables, SQL, file handles, column casts, previews and exports exist only in the active worker/page session, and cancellation terminates that worker.

Explorer exports do not persist file handles. Where supported, the save picker opens a temporary writable and CSV/JSONL bytes are streamed with backpressure; cancel or failure aborts the partial destination. Browsers without that API use bounded in-memory Blob downloads (256 MiB for JSON Explorer, 512 MiB for CSV and Parquet Explorer) and report a localized limit error rather than growing without a bound.

`log-analyzer` persists nothing: file handles, parser preset, filters, source/filter checkpoints, aggregate counts and inspected lines remain in the current page/worker session. Cancellation terminates the worker and clears the result; the user selects the file again to restart. Full filtered UTF-8 exports use the shared streaming save core, with a 512 MiB Blob fallback and no saved destination handle.

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

Several desktop tabs share `mdt.desktop.prefs.v1` and `mdt.desktop.window-bounds.v1`: a tab adopts the other tab's save from the `storage` event (shortcut undo history is dropped then) and writes a key only when its own value changed. `mdt.desktop.layout.v1` (open windows) is per tab in spirit: the last tab that changed its windows wins on the next load.

After a reload, minimized windows and background tabs of a group keep an empty iframe until first shown; nothing about them is stored beyond the layout above.

`theme` stays the existing light/dark key. Favorites and recent stay `mdt.favorites.v1` and `mdt.recent.v1`. An embedded tool page (`?embed=1`) does not record a second recent visit.

Desktop multi-selection, the selection rectangle and drag/drop previews are transient DOM/controller state. Shortcut undo keeps at most 20 in-memory snapshots of `shortcuts`, `positions`, `pinned` and custom-folder definitions for the current page session. Reloading clears undo and selection, not committed preferences.

“Restore window” keeps only the most recently closed window or tab group in controller memory for seven seconds. It recreates each tool and its geometry only; it deliberately cannot restore grouping, text, files, results or other iframe state. The notification says that input was not saved. It is not written to storage.

Initial window width profiles apply only when opening a new tool window. Without remembered geometry, height fits the initial embedded `.tool` after fonts load, once, within the stage with vertical margins. Tool interaction, manual geometry changes or a workspace override cancel pending fitting; it never steals focus or continually resizes as results grow. Existing windows and saved workspaces keep their geometry.

Explicit moves/resizes (including keyboard actions, half/quarter snapping and tiling) remember the latest bounds per tool, across closing and reloading. Reopening preserves exact CSS pixels while they fit; otherwise `clampBounds` moves/shrinks the frame into the current stage. Automatic viewport clamping never overwrites the remembered preference, so reopening on a larger stage restores it. Multiple copies share the last explicitly changed tool geometry. “Reset window layout” clears both open windows and remembered bounds only after any discard confirmation is accepted.

Taskbar previews and tab/group close actions read the same dirty-input check and share one confirmation flow. Desktop result transfers remain in `postMessage`/controller memory only, target one mounted iframe by request id, and are never copied to layout, preferences or bounds storage. The transfer target marks its pre-transfer input baseline before applying text, so transferred content receives the same close protection as trusted user edits.

Desktop discard checks compare editable input against an in-memory baseline captured before the first user interaction, after tool initialization/restored preferences. Untouched defaults (including QR color fields), unchanged values, cleared input and readonly output do not prompt. Selected files and occupied FileDrop zones do. CodeMirror supplies its immutable full document through `mdt:input-snapshot`, avoiding viewport-dependent checks and full-document string copies. These snapshots are released with the iframe and are never persisted or transmitted.

## HTTP client and Local Agent

`http-client` automatically saves request drafts locally, including URLs, names,
methods, enabled/disabled repeated parameters and headers (including secrets),
body text/format, timeout and redirect settings. The selected request is restored
on reopen. Responses and one-time pairing codes are never stored.
The request list is independent of the shorter-lived connection token.

| Key | Storage | Shape | Lifetime |
|---|---|---|---|
| `mdt.local-agent.session.v1` | localStorage | `{ v: 1, token, expiresAt, capabilities[] }` | Until the agent's eight-hour expiry, explicit Disconnect/clear, or an unauthorized response. A record saved before path tracing has no `capabilities` field and is treated as `http.request` only. A present array is filtered to known ids and may be only `icmp.trace`, only `dns.lookup`, only `tcp.connect`, only `tls.inspect`, only `whois.lookup`, only `asn.lookup`, or empty. A 403 does not remove the record. |
| `mdt.http-workspace.v1` | localStorage | `{ v: 1, selectedId, requests[], folders[], selectedFolderId, sidebarWidth, environments?[], activeEnvironmentId?, globals?[], openIds?[], proxy? }`; requests and folders may carry `auth`, folders `variables[]`; requests may carry `bodyMode`, `urlencoded[]`, `formdata[]`, `binary`, `graphql`; requests may carry `examples[]` (saved text responses: `{ id, name, savedAt, status, statusText, headers[], body }`, up to 20 per request and 256 KiB each); requests and folders may carry `scripts: { pre, test }` (JavaScript source; variable changes made by scripts are written to the same workspace); requests may carry `verifyTls: false` and `httpVersion: "http1" | "http2"` (absent = verify, auto) and `useCookies: false` (absent = the request sends and updates the cookie jar); the workspace may carry `proxy: { enabled, url, username, password, bypass }` (the proxy password is stored with the workspace like other auth fields). Client certificates (mTLS) are never kept by the page: certificate and key live in the agent vault (`certificates.mdtv`), the page holds only their names and hosts in memory and sends a name per request. WebSocket messages and event-stream events are never stored: the last 1000 of each live in page memory until the next send. Picked files are saved as `{id, name, size, type}` only, their bytes stay in page memory. OAuth tokens are never stored | Until explicit deletion or browser site-data removal; no automatic eviction. Removed after the agent vault confirms its copy |
| `mdt.http-workspace.location.v1` | localStorage | `"agent"` or absent | Setting only: the workspace lives in the agent vault (`vault.data`, document `http-workspace`, AES-256-GCM under a DPAPI-wrapped key); the browser keeps no request data |
| `mdt.http-cookies.persist.v1` | localStorage | `"1"` or absent | Setting only: the HTTP client keeps its cookie jar between visits (off by default; without it the jar lives in page memory until the page closes) |
| `mdt.http-cookies.v1` | localStorage | `{ v: 1, cookies[] }`; a cookie is `{ name, value, domain, path, hostOnly?, secure?, httpOnly?, sameSite?, expires? }` (`expires` in Unix seconds, absent for a session cookie), taken from response `Set-Cookie` headers and edits in the Cookies window | Only while «Keep cookies» is on; at most 300 cookies and 256 KiB, expired ones dropped on change. Turning the switch off or «Delete all» removes it. With the workspace in the agent it lives in the vault document `http-cookies` instead, and the browser copy is moved there and removed |
| `mdt.http-history.enabled.v1` | localStorage | `"1"` or absent | Setting only: the HTTP client records sent requests (off by default) |
| `mdt.http-history.v1` | localStorage | `{ v: 1, entries[] }`, newest first; an entry is `{ id, at, request, status, error?, elapsedMs?, sizeBytes?, bodyDropped? }` where `request` is the request as written (variables and `{{secret:…}}` unresolved, no response body, request bodies over 64 KiB dropped) | Opt-in; at most 100 entries and 1 MiB, the oldest are evicted. Cleared by the user from the History panel. With the workspace in the agent it lives in the vault document `http-history` instead, and the browser copy is moved there and removed |
| `mdt.http-code-language.v1` | localStorage | `"curl"`, `"fetch"`, `"python"` or `"httpie"` | Setting only: the last language chosen in the HTTP client «Code» window; snippets themselves are never stored |
| `mdt.path-trace.v1` | localStorage | `{ v: 1, targets[] (≤20), intervalMs, payloadBytes, maxHops, timeoutMs, resolveNames, sourceAddress, sourceInterface }` | Until the user clears site data. Recent targets are added only after the agent accepts a trace or a path MTU search. An empty source pair means automatic. A pair that later disappears from the interface list stays saved and the control falls back to automatic until a refresh lists it again. Hop results, path MTU results, pairing codes and session tokens are not stored here. |
| `mdt.dns-lookup.v1` | localStorage | `{ v: 1, recordType }` | Until the user clears site data. Only the selected record type is stored. The query name and the answer are not stored. An unknown type is read back as `A`. |
| `mdt.tcp-connect.v1` | localStorage | `{ v: 1, timeoutMs }` | Until the user clears site data. Only the timeout is stored, from 200 to 10000 ms. An unknown or out-of-range value is read back as 3000. The host, the port, and the result are not stored. |
| `mdt.tls-inspect.v1` | localStorage | `{ v: 1, timeoutMs }` | Until the user clears site data. Only the timeout is stored, from 200 to 10000 ms. An unknown or out-of-range value is read back as 5000. The host, the port, and the chain are not stored. |
| `mdt.whois-lookup.v1` | localStorage | `{ v: 1, timeoutMs }` | Until the user clears site data. Only the timeout is stored, from 200 to 10000 ms. An unknown or out-of-range value is read back as 5000. The query, the server, and the reply are not stored. |
| `mdt.sqlite-explorer.v1` | localStorage | `{ v: 1, exportFormat: "csv"\|"json"\|"jsonl"\|"sql" }` | Until the user clears site data. Saved when the export format changes; an unknown value is read back as `csv`. The database, its file name, SQL text, results and the writable switch are never stored. |
| `mdt.port-scanner.v1` | localStorage | `{ v: 1, preset: "common"\|"well-known"\|"all"\|"custom", custom, timeoutMs, parallel }` | Until the user clears site data. Saved when a scan starts. The timeout is 200 to 5000 ms (default 1000) and the parallel count 1 to 64 (default 64); an unknown preset or an out-of-range number is read back as the default. The host and the results are not stored. |
| `mdt.network-scanner.v1` | localStorage | `{ v: 1, timeoutMs, ports, resolveNames }` | Until the user clears site data. Saved when a scan starts. The timeout is 200 to 5000 ms (default 1000); `ports` is the probe-port text, up to 16 single ports (default `22, 80, 443, 445, 3389`); a list that does not parse is read back as the default. The network and the hosts found are not stored. |

Draft edits are debounced by 250 ms and flushed on switch, send, pagehide and
hidden visibility. New/rename/delete and selected request changes are persisted.
Malformed workspace data is left intact on initial load with a visible error;
blocked storage or quota failure reports an error and preserves the previous
saved value. Responses stay transient. These drafts are not encrypted or synced:
avoid shared browser profiles for secrets, and clearing site data removes them.

Each request has a nullable `folderId`; folders contain `{ id, name, parentId,
expanded }`. Parent links must exist and form an acyclic tree. The previous flat
workspace is upgraded in memory to root-level requests and a 240px sidebar,
without rewriting storage during load. Folder creation, renaming, reparenting,
request moves and expansion are saved. Deleting a folder promotes its direct
subfolders and requests to its parent; it never recursively deletes requests.
Ancestors of a selected request expand when restoring/selecting it.
Desktop sidebar width is persisted between 192 and 480px after pointer release
or keyboard adjustment. Stacked/mobile layout ignores the width and hides the
separator without overwriting the desktop preference.

Explorer context menus, move-dialog state and native drag state are transient.
Moves reuse the same validated parent-link contract and persist only on success;
a failed storage write rolls back structural changes. Context-menu targeting
does not change the active request. Hover expansion changes only destination
DOM in place so dragging is not canceled by replacing the source element.

On page load, an unexpired record is restored only after `/v1/info` confirms a
reachable agent with the expected protocol. The record stores the capabilities
granted at pairing. A record written before path tracing has no capabilities
field and is read as HTTP-only. A 403 from a missing capability leaves the
saved token in place. On the path-trace, dns-lookup, tcp-connect, tls-inspect, whois-lookup, asn-lookup, port-scanner, and network-scanner pages, a rejected pairing code restores the previous saved record so an earlier grant is not dropped. A temporarily unavailable agent
leaves the record intact so a later retry can reconnect. Expired, malformed and
unauthorized records are removed. If localStorage is blocked or rejects a
write, pairing still works for the current page in memory and the client exposes
that the token was not persisted.

The agent keeps sessions in memory with an eight-hour expiry and invalidates
them on exit/restart. Protocol v1 has no non-destructive authenticated session
inspection route: `/v1/info` verifies the agent and protocol, not the saved
bearer. After an agent restart, the next protected request receives
`unauthorized` and removes the stale browser record.

The Windows agent has one opt-in OS setting: the current user's
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\MyDevToolsLocalAgent` value.
It contains the quoted executable path and `--autostart`, not tokens or request
data. Unchecking autostart removes only this value. Advanced CLI settings
(`--origin`, `--allow-private`, `--port`) are not persisted by the checkbox.
HTTP responses and explicit downloads may contain secrets; they are never
rendered as HTML or copied into localStorage, desktop state or analytics.

The generated release manifest is public software metadata, not client state.
The service worker never serves `/downloads/` from its runtime cache.

