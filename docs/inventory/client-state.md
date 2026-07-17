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
