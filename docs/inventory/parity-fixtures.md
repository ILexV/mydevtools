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

## 6. JSON/CSV Explorer and PDF/QR/AEAD lifecycle (2026-10-08)

Verification uses the locally built Astro site at `http://127.0.0.1:4345/`, not a new public deployment. Both tools are TypeScript-only: home and Explorer routes made zero WASM requests.

Final `npm run verify -w @mydevtools/site` passed: Astro check (306 files, zero errors), i18n validation (zero errors), **383 unit tests**, **424 built pages** and **8 dist smoke tests**. Existing diagnostics remain: deprecated `document.execCommand` hint and unchanged German UUID title warning.

### Explorer scale and output correctness

Native browser `File`/`Blob` fixtures were imported through the actual file controls. Large inputs repeat a native Blob block and append a unique final record; these are functional scale checks, not standalone disk-I/O benchmarks or peak-RAM measurements.

| Format | Input bytes | Source records | Rendered data rows after indexing |
|---|---:|---:|---:|
| JSONL | 58,000,032 | 2,000,001 | 22 |
| CSV | 20,000,021 | 2,000,001 | 22 |
| JSONL | 5,368,750,051 | 328,385 | 22 |
| CSV | 5,369,556,120 | 328,897 | 22 |

- `End`, `ArrowUp` and `Home` reached the exact last, penultimate and first logical records despite the 8,000,000 px physical scroll-track cap. Last-record inspection displayed the complete source value.
- Both >5 GiB files survived cancel/new-run scenarios and were fully indexed. A filter matching only the final sentinel re-scanned the complete input; both JSONL and CSV exports were compared with exact expected bytes, including CSV BOM/CRLF and BOM-free JSONL.
- JSON checks covered BOM/CRLF/blank physical lines, `9007199254740993`, numeric spelling `1.0`/`1e3`, escaped JSON Pointer keys, whitespace in keys, missing projected fields, full selected-record text, and lazy 100-node pages without duplicates on double activation.
- CSV checks covered quoted multiline fields, exact comparisons above `Number.MAX_SAFE_INTEGER`, formula-safe CSV versus original JSONL values, and embedded U+FEFF. Explicit Tab selection plus a real UTF-16LE/BOM file produced the expected two-column table and byte-exact UTF-8 JSONL export.
- Malformed input followed by valid import was exercised on all 20 Explorer routes at 375 px: localized JSON physical-line/column diagnostics, localized CSV errors, correct `html lang` (`zh-Hans` for `zh`), zero document/body horizontal overflow, zero WASM requests. The recorded successful sweep had zero console/page errors and zero failed tracked requests.
- Actual catalog links, `en → ru` language switching and localized command-palette navigation opened functioning new controllers. Desktop/mobile light and dark surfaces were viewed. A min-content grid-width defect and literal `\t` option defect were reproduced and fixed.
- Only four versioned JSON safety/format settings survived reload. File contents, file selection and search input did not persist; CSV settings remain session-only. Limits are listed in `tools.md` and in each localized UI.

### Firefox and WebKit Explorer coverage

Installed **Firefox 153.0** and **WebKit 26.5** passed against the final rebuilt preview with Playwright 1.62.0. Both Explorer routes were exercised in `en`/`ru`, dark/light themes and at 375 × 812.

- Native file-input imports and native `DataTransfer` drops passed. Each engine/tool imported a separate 1,000,000-row fixture, kept 22 live data rows, and selected exact records 999,999 / 999,998 / 0 with End / ArrowUp / Home.
- Exact JSONL/CSV downloads, >2^53 numeric values, quoted multiline CSV, embedded U+FEFF, semicolon auto-detection and UTF-16BE/BOM decoding passed. Actual-tab TSV imports passed in both locales after the option fix.
- Lazy ordinary-JSON trees paged from 100 to 150 nested children. Cancel → immediate valid import and real startup-worker failure → immediate valid import both recovered on each tool/engine.
- Loaded million-row tables and post-fix JSON pages contained horizontal scrolling inside the 301 px viewport while document/body width remained 375 px. No unexpected console errors or failed network requests were observed; deliberate startup-fault page errors and harness service-worker-block warnings were excluded.
- All probe browser contexts/processes were closed and temporary scripts removed. These checks establish Explorer behavior in those engines, not full-catalog coverage or physical-device behavior.

### Core worker failures, cancellation and recovery

- Real Blob-throw worker startup failures followed by valid runs were exercised for PDF compressor, PDF merger, PDF-to-text, QR upload and AEAD encryption in every locale: **50 localized failure/recovery pairs**. Each infrastructure failure matched `Common_ProcessingFailed`, not an invalid-PDF/no-QR-code/wrong-password message.
- Compressor output (548-byte `%PDF-` file) and merger output (927-byte `%PDF-` file) were fed back through the real PDF WASM extractor. The expected fixture text appeared once and twice respectively; text extraction also matched the original fixture.
- A real 7,436-byte QR PNG was generated and decoded. Camera Stop terminated the pending decode worker, stopped the actual canvas-capture MediaStream track, closed its ImageBitmap and cleared `video.srcObject`; restarting decoded the expected payload. **No physical camera or hardware permission/device-switching behavior was exercised.**
- PDF, QR and AEAD were canceled with a real worker dispatch pending, then rerun successfully. Only dispatch timing was delayed; outputs were never mocked. Shared-helper smoke also proved that aborting one request or explicitly terminating the worker settles all peer pending promises, and a fresh worker computes the real SHA-256 of `abc`.
- A 1,048,613-byte AEAD fixture was encrypted, rejected with the localized wrong-password error, then decrypted successfully. Full byte comparison found no difference; SHA-256 was `03be94f37fb385d978994eecb8f42cf1a3226903acbaef1034cff44445707057`. All three terminal AEAD workers were terminated; the downloaded Blob remained readable.
- Successful core recovery/roundtrip/camera paths had zero unexpected console/page errors and zero failed tracked requests. All five core routes in `en` and `ru` had zero horizontal overflow at 375 px.

## 7. Publication and warm HTTP-cache regression (2026-10-09)

Source `e229054` and Pages `f7eb509` published the 41-tool catalog. All 20 live Explorer routes imported actual JSONL/explicit-TSV fixtures in their own locale, preserved `9007199254740993` and `東京`, used the expected canonical URLs and made zero WASM requests. Compiled site assets matched the verified local build; successful paths had zero console/page errors and failed tracked requests. Live Base64 encoded `hello` as `aGVsbG8=`, the file Hash Calculator matched its MD5/SHA-1/SHA-256 golden digests, and PNG → JPEG produced a real 40,386-byte, 512 × 512 image.

The visible PWA Update button promoted `5662ccd5 → 9a49e8eb` and removed the old cache. Inspecting the **new cache contents** nevertheless exposed an old 39-tool `/en/index.html` response, downloaded before the publication: `cache.addAll(urls)` had reused the browser's still-fresh HTTP cache. A new cache name alone did not prove fresh offline data.

Fix: install with `Request(url, { cache: "reload" })` while retaining atomic `cache.addAll`; derive the cache version from both the manifest and the worker template, so a strategy-only repair does not overwrite the active generation during installation.

A throwaway native-browser regression server served cacheable 39-tool HTML, then switched to 41-tool HTML with both Explorer links. A normal browser fetch still returned the old response; the actual fixed worker installed the new response into precache. Exactly two home network fetches occurred (initial warm-up and forced reload). The probe tab/server were closed. This exercises the real HTTP/ServiceWorker caches rather than a Node cache-option forwarding mock.

## 8. Remaining gaps (not covered by this verification)

- **Full browser matrix** — catalog/core UI sweeps use Chromium; the hash
  benchmark also uses Firefox, and Explorer checks include Firefox/WebKit.
  This does not establish full-catalog Safari/WebKit, branded Chrome or Edge behavior.
- **Real-device mobile touch** — keyboard open, safe-area insets, drag/drop,
  orientation change need a physical device pass; emulated touch verified only.
- **Field CWV (CrUX)** — lab metrics only until real traffic accumulates.

These are flagged in `FRONTEND_REBUILD_TODO.md` Stage 11 §"Визуальная приемка"
as owner-gated / environment-gated.
