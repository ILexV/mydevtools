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

## 5. Hash Calculator and worker lifecycle (2026-10-08)

### Built-browser behavior

- Hash worker startup failure was reproduced before the fix: calculation stayed
  disabled after 3.5 seconds. With the fix, the failed file shows an error, the
  next file completes, and an immediate rerun produces the expected digests.
- Multiple files run sequentially; duplicate basenames retain distinct digests
  and checksum matches. Picker/drop append to the removable list; files take
  priority over text. Ordinary text drag/drop is not intercepted.
- Cancel terminates the active worker, preserves completed results and marks
  unfinished entries canceled. Clear followed by an immediate new calculation
  cannot repaint old results. Successful hash jobs reuse the bounded-chunk
  worker; encoding workers terminate on success, failure and cancel.
- Actual TXT/CSV/JSON downloads and hash copying were exercised. CSV preserves
  quoted/newline filenames and neutralizes spreadsheet formula prefixes; JSON
  keeps exact filenames, per-source status and digest metadata, not input text.
- Empty text/files and Unicode text were checked. All 39 streaming text digests
  match the original Rust one-shot API. SHA-256 files of 100 MiB + 17 bytes and
  1 GiB + 17 bytes match independent incremental Node.js digests.
- A 2 GiB + 17-byte file completed with MD5, SHA-1, SHA-256, SHA-512, BLAKE3
  and xxHash64 selected, followed by a second file in the same queue. The four
  MD5/SHA digests match independent incremental Node.js references; all six
  digests of the next `abc` file match the Rust one-shot API. Across the large
  UI probes, the maximum observed 50 ms heartbeat gap was 275.1 ms.
- Base64 and Hex binary file encode/decode downloads round-trip
  `00 ff 80 41` after transferring the result buffer. Base64 invalid input,
  100 MiB cancel and immediate `abc` rerun were exercised; all five observed
  encoding workers terminated on their terminal outcomes.
- Runtime failures previously mislabeled a valid `abc` file as invalid Base64.
  `worker-failed`/`init-failed` now use `Common_ProcessingFailed`, translated
  in all ten languages. All 40 Base32/Base58/Base64/Hex locale routes were
  fault-injected at worker startup and recovered to the canonical encoding,
  with no invalid-input flag or horizontal overflow. Constructor failure and
  failed WASM initialization also recovered; genuine invalid text still shows
  its localized character error and marks the input invalid.
- All ten Hash Calculator routes (`en`, `ru`, `es`, `de`, `pt`, `zh`, `fr`,
  `ja`, `ko`, `hi`) calculated a two-file batch at 375 px with zero horizontal
  overflow and no console/network errors. The 13 new UI messages and meta
  descriptions match their locale JSON; en/ru light/dark surfaces and the
  language switch were exercised.
- `npm run verify -w @mydevtools/site`: 355 unit tests, 404 built pages and all
  eight dist smoke checks passed. Existing diagnostics: deprecated
  `document.execCommand` hint and the German UUID title translation warning.

### SHA-256 backend benchmark

Reproduce after `npm run build:site`:

```bash
npm run bench:hash -- --browser chromium --sizes 10,100,1024 --iterations 3 --output /tmp/mydevtools-hash-chromium.json
npm run bench:hash -- --browser firefox --sizes 10,100,1024 --iterations 3 --output /tmp/mydevtools-hash-firefox.json
```

Observed on 2026-10-08: Linux x64, Intel Xeon Gold 6132 @ 2.60 GHz, 28 logical
processors, Node 25.9.0, Playwright 1.62.0, Chromium 151.0.7922.34 and Firefox
153.0. Engines and trials run sequentially; three warmed trials per backend,
alternating backend order. Cold initialization and a separate 1 MiB warm-up
are excluded from the medians.

| Engine | File size (MiB) | Rust/WASM worker (MiB/s) | Web Crypto (MiB/s) |
|---|---:|---:|---:|
| Chromium | 10 | 108.696 | 180.832 |
| Chromium | 100 | 93.729 | 148.302 |
| Chromium | 1024 | 107.963 | 168.059 |
| Firefox | 10 | 23.585 | 103.093 |
| Firefox | 100 | 22.936 | 105.820 |
| Firefox | 1024 | 23.254 | 102.646 |

These are browser wall-time measurements, not isolated hash-kernel timings:
WASM includes worker dispatch, 1 MiB File reads and hashing; Web Crypto
includes a whole-file `arrayBuffer()` and `subtle.digest()`. Fixtures repeat
one deterministic 1 MiB Blob; this is not a cold physical-disk benchmark.
Every cold, warm-up and measured digest matches independently generated,
incremental Node.js SHA-256 references.

Memory observations sum `/proc` RSS across the browser process tree, including
children spawned by non-leader threads (required for Firefox). Samples are
taken every 50 ms; the following peaks cover the **combined** benchmark,
not isolated per-backend memory:

| Engine | Peak RSS (MiB) | After operations (MiB) | After worker termination (MiB) |
|---|---:|---:|---:|
| Chromium | 3815.633 | 1458.648 | 1428.941 |
| Firefox | 3545.391 | 1366.191 | 1365.980 |

Both peaks occurred during the second 1 GiB Web Crypto trial. Shared physical
pages can be counted more than once; RSS is neither unique RAM nor JS heap.
No forced GC was requested, so the post-operation values do not prove an
absence of leaks or immediate reclamation of all buffers.

Decision: retain the streaming worker for File Hash Calculator. Web Crypto
was faster on this host, but its measured path buffers the entire input and
does not provide the tool's selected multi-algorithm, chunked-file contract.
The runner closes its browser/server and reports failures rather than
substituting another digest or backend. Edge, Safari/WebKit and 5 GiB files
were not exercised in this pass.

## 6. Remaining gaps (not covered by this verification)

- **Full browser matrix** — the built UI sweep above uses Chromium. The hash
  benchmark also exercises Firefox; this does not establish full-catalog
  Safari/WebKit, branded Chrome or Edge behavior.
- **Real-device mobile touch** — keyboard open, safe-area insets, drag/drop,
  orientation change need a physical device pass; emulated touch verified only.
- **Field CWV (CrUX)** — lab metrics only until real traffic accumulates.

These are flagged in `FRONTEND_REBUILD_TODO.md` Stage 11 §"Визуальная приемка"
as owner-gated / environment-gated.
