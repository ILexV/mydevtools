# Catalog & SEO Inventory (Stage 1)

> Source: locale JSON + Razor > docs. Catalog hardcoded in `Home.razor`;
> all SEO via one component `Components/Seo/MetaTags.razor`.

## 1. Tool Catalog & Categories

Catalog hardcoded in `Home.razor`: `GetTools()` = 38 tools; `GetToolsByCategoryForSections()` = 12 categories. Renderer `ToolsSection.razor` iterates categories → `#category-<slug>` sections + tool cards linking `/{lang}/{slug}`. Category labels = i18n keys from `home.json`; slugs hardcoded.

### Definitive category list

| slug | i18n key | en label | members |
|---|---|---|---|
| images | Category_Images | Images | image-converter, image-compressor, image-resizer |
| design | Category_ColorsAndDesign | Colors & Design | color-converter, markdown-preview |
| hashing | Category_HashingAndSecurity | Hashing & Security | hash-calculator, password-generator |
| encoding | Category_Encoding | Encoding | base64-encoder, base32-encoder, base58-encoder, hex-encoder, url-encoder, html-entity-encoder |
| structured-data | Category_StructuredData | Structured Data | json-beautifier, json-to-typescript, xml-beautifier, yaml-beautifier-validator, cron-parser, cron-generator |
| text | Category_TextTools | Text Tools | text-case-converter, text-diff-viewer, word-counter |
| cryptography | Category_Cryptography | Cryptography | hmac-calculator, aead-file, openssh-keys, x509 |
| jwt | Category_JwtAndTokens | JWT & Tokens | jwt-decoder, jwt-encoder |
| regex | Category_Regex | Regular Expressions | regex-tester |
| qrcode | Category_QrCodes | QR Codes | qr-code-generator, qr-scanner |
| pdf | Category_PdfTools | PDF Tools | pdf-merger, pdf-compressor |
| converters | Category_Converters | Converters | unit-converter, ip-subnet-calculator |

### Orphaned tools (in `GetTools()`, assigned to NO category, hidden on home)

- `uuid-generator`, `lorem-ipsum-generator`, `date-converter`

### Unused category keys in `home.json` (imply intended categories)

- `Category_Generators` = Generators → intended for uuid-generator / lorem-ipsum-generator
- `Category_DateTime` = Date & Time → intended for date-converter
- `Category_All` = All (client-side filter, not a real category)

**New IA decision:** the new registry surfaces `generators` (uuid + lorem), folds `date-converter` → converters, `pdf-to-text` → pdf. `Category_DateTime` is dropped (date-converter fits converters). This resolves all 4 ungrouped tools. See `src/registry/categories.ts` + `tools.ts`.

### Discrepancy / phantom

`Middleware/CultureRedirectMiddleware.cs` `ToolSlugs` whitelist contains `pdf-to-text` with no entry in `Home.razor GetTools()` and no `@page` tool component (stale slug — a route DOES exist as `PdfToText.razor`, it's just absent from the home catalog). The whitelist is a manual mirror of the catalog → any catalog change needs a parallel edit. **New build eliminates this: the registry IS the single source.**

## 2. SEO Field Set Per Page

All head SEO emitted by `MetaTags.razor` (used by Home + every tool), once per page in `HeadContent`.

### MetaTags parameter contract

| Parameter | tool source | home source |
|---|---|---|
| Title | T(Title) | T(Title) |
| Description | T(Description) | T(Subtitle) |
| Keywords | T(Keywords), default "developer tools, privacy, browser tools, web tools" | default |
| ToolPath | slug | unset |
| Category | e.g. Hashing | unset |
| HowToSteps | T(Seo_HowToSteps) markdown `### Step N: Title\nBody` | unset |
| SupportedAlgorithms | hash/hmac tools only | unset |
| ImageUrl | rarely set | unset |
| IsHomePage | false | true |

### Tags emitted (every page)

`<title>`, meta description, meta keywords, og:title/description/image/type=website/url/locale + og:locale:alternate ×9, twitter:card=summary_large_image + title/description/image, meta robots=index,follow, canonical, hreflang ×10 + x-default, JSON-LD.

Default og:image = `https://mydevtools.app/hero_logo.webp` (hardcoded).

### JSON-LD (GenerateJsonLd)

- **Home**: WebSite (potentialAction = SearchAction, target `EntryPoint urlTemplate = https://{host}/en/{search_term_string}`), Organization (logo), BreadcrumbList (Home).
- **Tool**: SoftwareApplication (applicationCategory=DeveloperApplication, operatingSystem=Web Browser, isAccessibleForFree=true, offers=Offer price 0 USD; if SupportedAlgorithms → additionalProperty[] PropertyValue), BreadcrumbList (Home → [Category →] Tool), optional HowTo (parsed from `### Step N:`).
- **Known bug**: BreadcrumbList category item URL points to homeUrl, not a category page → **fix in rebuild**.
- Serializer: System.Text.Json, WriteIndented, UnsafeRelaxedJsonEscaping.

## 3. Canonical & Hreflang Patterns

Base = `https://{host}`.

| Link | Pattern |
|---|---|
| canonical | `https://{CurrentUrl}` — per-lang self-canonical |
| hreflang alternate | `https://{host}/{culture}/` (home) or `https://{host}/{culture}/{ToolPath}` (tool); trailing slash only on lang-root |
| hreflang x-default | home → `https://{host}/`; tool → `https://{host}/en/{ToolPath}` |
| hreflang code | `zh → zh-Hans`; others identity |

> **New build note:** the current `BaseLayout.astro` emits canonical/hreflang from the registry. x-default for tools currently points to the same-locale pattern; TODO Stage 10 should pin tool x-default → `/en/{slug}` to match legacy.

### Canonicalization redirects (CultureRedirectMiddleware)

- `/` (no culture): bots → rewrite to `/{default}/` (Vary: Accept-Language + Content-Language); users → 302 to `/{browserLang}/`.
- `/{lang}` (no trailing slash) → 301 to `/{lang}/`.
- Unknown slug without culture → 404.
- **GitHub Pages has no server** → the new build handles `/` and 404 client-side (see `src/pages/index.astro`, `404.astro`); no 301 for missing trailing slash (Astro `trailingSlash: 'always'` emits `/dir/` natively).

## 4. Sitemap (SitemapMiddleware)

- `GET /sitemap.xml`, `application/xml`. Registered early in pipeline. `IMemoryCache` key `sitemap_xml`, 24h expiry.
- `baseUrl = https://{Request.Host}`. lastmod = today UTC.
- **Discovery via reflection**: scans assembly for IComponent with `[Route]` containing `{lang}` (excludes not-found/error). One `<url>` per culture (×10).

| Entry | loc | priority | changefreq |
|---|---|---|---|
| Site root | `{baseUrl}/` | 1.0 | daily |
| Lang home | `{baseUrl}/{lang}/` | 0.9 | daily |
| Tool page | `{baseUrl}/{lang}/{slug}` | 0.7 | weekly |

Orphaned tools still in sitemap (they have routes). **New build:** replace reflection with a build-time sitemap generator over the Astro route list × registry (Stage 10). No sitemap-index, no image-sitemap, no robots.txt generation in legacy.

## 5. Astro rebuild notes

- Catalog = data: extract to the typed `tools.ts` / `categories.ts` registry (done).
- Resolve 3 orphans + 2 unused keys → generators category + fold date-converter/pdf-to-text (done in registry).
- Replicate `MetaTags` as one Astro SEO component with the same contract; fix the BreadcrumbList category-URL bug (Stage 10).
- Build-time sitemap from registry ×10 cultures with the priority/changefreq table + trailing-slash for lang-root (Stage 10).
- Port canonical/hreflang/x-default/og:locale/zh-Hans verbatim (Stage 10).
