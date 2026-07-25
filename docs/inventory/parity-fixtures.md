# Parity fixtures & QA verification

> Single source of truth for the functional parity of the new Astro frontend
> vs. the legacy Blazor site, plus the cross-cutting QA results collected
> during the rebuild. Supersedes the scattered per-tool notes — the per-tool
> migration matrix in [`FRONTEND_REBUILD_TODO.md`](../../FRONTEND_REBUILD_TODO.md)
> Stage 9 remains the authoritative "done/not-done" record; this file records
> the **vectors** behind those checks.

## 1. Differential parity (new vs. legacy computation)

Tools whose output was verified byte-for-byte against an independent reference:

| Tool | Fixture | Result |
|---|---|---|
| `text-case-converter` | 927 cases × 9 transforms vs. legacy WASM | **0 divergences** |
| `html-entity-encoder` | 36 encode↔decode round-trips, 3 modes × 3 formats | all round-trip |
| `base58-encoder` | Bitcoin / Flickr / Ripple alphabets | all correct (Flickr/Ripple bug fixed) |
| `hmac-calculator` | RFC 4231 reference vector | matches (key-length bug fixed) |
| `hash-calculator` | `"hello"` → MD5 / SHA-1 / SHA-256 | canonical digests |
| `aead-file` | encrypt → decrypt round-trip, Argon2id 64MiB/3/1 | round-trips, header hex |
| `qr-code-generator` → `qr-scanner` | generate PNG/SVG → decode | round-trip |
| `image-converter` | PNG → WebP | 164 B output |
| `pdf-compressor` | sample PDF | 649 → 588 B (9 %) |
| `pdf-merger` | 4 PDFs | 1997 B, 4 pages |
| `uuid-generator` | Web Crypto v4/v7, ≤100 batch | format + uniqueness |
| `openssh-keys` | ed25519/p256/p384/rsa generate + import + convert | passphrase→comment bug fixed |

## 2. Known, accepted deviations

- **`image-compressor`** — single-file only. Legacy multi-file batch + ZIP
  download (JSZip CDN) was **not** migrated (no external CDN policy).
- **`json-beautifier` / `xml-beautifier`** — input persistence **not** migrated
  (privacy: editor content is never stored).

These are deliberate and documented in Stage 9.

## 3. Cross-cutting QA (Chromium, built `dist` via `astro preview`)

### Performance / CWV (Lighthouse 12, mobile profile unless noted)

| Page | Perf | A11y | Best-practices | SEO | FCP | LCP | CLS | TBT |
|---|---|---|---|---|---|---|---|---|
| home (desktop) | 99 | 100 | 100† | 100 | 0.8 s | 0.8 s | 0 | 0 |
| home (mobile)  | 79 | 100 | 100† | 100 | 3.8 s | 3.9 s | 0 | 0 |

† Best-practices is 64 **only** on the local HTTP preview (`is-on-https` +
a Kaspersky extension injecting a deprecated `unload` listener). On the HTTPS
GitHub Pages deployment both vanish → 100. Initial payload: **30 KB CSS,
8.8 KB JS, 117 KB fonts** (4 woff2 subsets, all `font-display: swap`).

### Cold-load (clean profile, cache disabled)

- **CLS = 0** (0 layout-shift entries), **FCP 76 ms**.
- **No theme flash** — the inline head script sets `data-theme` from
  `localStorage`/`prefers-color-scheme` before first paint (verified dark +
  light + system).
- **Font swap** — Inter Variable loads via `font-display: swap`; FCP is not
  blocked by font download.
- **Service worker** — registered + active on the Pages scope `/mydevtools/`;
  update flow (waiting → toast → `SKIP_WAITING` → purge stale → reload) verified
  across deploys.

### Mobile layout (375 px, `scrollWidth` audit)

All 39 tool routes + 10 home routes audited for horizontal overflow. Two real
bugs found and fixed: `cron-parser` (+34 px) and `cron-generator` (+55 px) —
grid cards with default `min-width: auto` couldn't shrink past long `<select>`
options / ISO timestamps. Fixed with `min-width: 0` + `overflow-wrap: anywhere`.
Re-verified: `scrollWidth == clientWidth` on both. Remaining routes clean.

### Accessibility / robustness (from Stage 11)

- Keyboard-only Tab trace: visible `:focus-visible` ring on every interactive;
  0 unnamed buttons; single `h1`; landmarks header/nav/main/footer.
- Theme contrast (text/bg) = **8.39 ≥ WCAG AAA 7.0**.
- Corrupted `localStorage` (favorites/recent/theme/locale) → 0 page errors,
  silent fallback to defaults.
- Large file (hash, 150 MB): chunked progress, responsive UI, clean cancel.

## 4. Reference screenshots

Collected under `docs/design/concepts/shots/stage6/` during the QA sweeps:

- `live-uuid-fixed.png`, `fix-*.png` — DS class-collision regression + fix.
- `sweep-{image,regex,cron,jwt,pdf,aead}.png` — post-fix tool sweep (desktop).
- `mobile-{home,uuid,image,cron,json}.png` — 375 px mobile sweep.
- `ux-home-{ambient,scrolled}.png` — home ambient + sticky header.
- `ambient-prism.png` — prism spectrum + grain after anti-banding.

## 5. Remaining gaps (not automatable in this environment)

- **Browser matrix** — verified on **Chromium** only. Firefox and Safari/WebKit
  require either manual verification or a CI multi-browser setup
  (Playwright `firefox`/`webkit` channels), which is not yet configured.
- **Real-device mobile touch** — keyboard open, safe-area insets, drag/drop,
  orientation change need a physical device pass; emulated touch verified only.
- **Field CWV (CrUX)** — lab metrics only until real traffic accumulates.

These are flagged in `FRONTEND_REBUILD_TODO.md` Stage 11 §"Визуальная приемка"
as owner-gated / environment-gated.
