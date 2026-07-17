# Locale Structure Inventory (Stage 1)

> Architecture: **flat-file, flat-key** i18n. Directory
> `wwwroot/i18n/<lang>/{common,home,categories}.json` + `tools/<slug>.json`.
> Loader: `IJsonLocalizationService.Get(lang, ns, key)` → flat
> `Dictionary<string,string>`, falls back to **key on miss**. No nested keys,
> no interpolation. Namespace values: `common`, `home`, `categories`, `tools/<slug>`.

## Shape

10 langs × (3 shared + 39 tool) = **420 JSON files**, structurally identical across all langs. Zero empty-string values; spot-checked ru/ja are genuinely translated (native script). Only systematically-English field is `Keywords` (deliberate SEO).

### Shared namespaces (per `<lang>/`)

| file | purpose | ~keys |
|---|---|---|
| `common.json` | Shared chrome: app name, generic UI verbs (`Common_*`), nav (`Nav_*`), search (`Search_*`), command palette (`CommandPalette_*`), badges (`Badge_*`), PWA install/update (`PWA_*`), SEO section headings (`Seo_*`), theme toggle. Flat keys. | ~50 |
| `home.json` | Landing: app/page meta, 15 `Category_*` chips (**duplicate of categories.json**), badges, features grid, CTAs, favorites/recent, stats, `SeoContent_*` blocks, FerrisClickHint. Flat keys. | ~73 |
| `categories.json` | Flat 14-key PascalCase map of category display names. Same 14 strings also exist as `Category_*` in home.json — **duplication to de-duplicate in rebuild**. | 14 |

### Per-tool namespaces

`<lang>/tools/<slug>.json` — 39 per tool, identical slug set in all 10 langs.
Shape: `Title`, `Description`, `Keywords` (English everywhere for SEO), 5–30
tool-specific UI keys, then a repeating 5-key `Seo_*` block. Key counts range
11 (`pdf-to-text`) to ~45 (`cron-parser`); ~1000 total across en.

## Language metadata (consolidated into `src/registry/locales.ts`)

Native names are **NOT stored** in the legacy repo — `LanguageSwitcher.razor`
just uppercases ISO codes (EN, RU…). The new registry adds proper native names.
`og:locale` and hreflang come from `MetaTags.razor`.

| code | native | english | hreflang | og:locale |
|---|---|---|---|---|
| en | English | English | en | en_US |
| ru | Русский | Russian | ru | ru_RU |
| es | Español | Spanish | es | es_ES |
| de | Deutsch | German | de | de_DE |
| pt | Português | Portuguese | pt | pt_BR |
| zh | 中文 | Chinese | zh-Hans | zh_CN |
| fr | Français | French | fr | fr_FR |
| ja | 日本語 | Japanese | ja | ja_JP |
| ko | 한국어 | Korean | ko | ko_KR |
| hi | हिन्दी | Hindi | hi | hi_IN |

## Flags for the rebuild

- **No `errors.json` namespace** — tool errors are inline keys within each tool namespace. Decide: keep inline or introduce a shared `errors` namespace (TODO Stage 5 lists `errors`).
- **Category labels duplicated** across `categories.json` AND `home.json` `Category_*` keys → keep ONE source in the rebuild.
- **Hard-coded 10-code list replicated in 7 files** (Program.cs, 3 middlewares, LanguageSwitcher, MetaTags ×2) → the new `locales.ts` registry replaces all of these.
- **No interpolation/pluralization** in legacy loader → the new `t()` adds `{param}` interpolation (TODO Stage 5).
