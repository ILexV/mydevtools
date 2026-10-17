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

## 8. Streaming save, local SQL and data conversion (2026-10-17)

Verified the built Astro site in Chromium, including an independently launched Chrome 151 for actual DuckDB workers. The managed browser's Worker interception caused startup stalls that did not occur in the independent browser; no application retry or timeout workaround was added.

- Final gates: 459 unit tests, 9 distribution smoke tests, successful static build (475 pages), and Astro check with zero errors/warnings (two existing deprecation hints). Locale validation had zero errors and the existing German UUID title warning.
- Existing CSV, JSON and Parquet Explorer exports exercised the new shared saving path. JSONL retained the numeric token `9007199254740993`; CSV and Parquet-derived JSONL downloads contained the expected source records.
- Real `FileSystemWritableFileStream` writes used OPFS handles in place of the native picker UI. A deliberate second-write quota failure left the original destination text unchanged; retry without reindexing exported all 100,005 records. This proves destination rollback and session preservation, not OS save-dialog interaction.
- Hash `abc` matched MD5/SHA-1/SHA-256 reference values. Canceling a 256 MiB file operation settled, and a subsequent text run produced the correct digest.
- Actual SQL editor actions exercised CSV and JSONL imports, WHERE, GROUP BY and JOIN. Group totals were Ada = 15.5 and Bob = 7.25; the join preserved BIGINT `9007199254740993`. A long cross join was canceled, all imported tables cleared, and reimport succeeded.
- An ordinary SQL URL string literal remained valid. External `read_csv('https://…')` was rejected. Successful SQL-page resource requests were same-origin. A downloaded SQL JSON result retained the exact BIGINT token.
- Converter tests covered CSV/TSV, UTF-16, Windows-1251 CSV and JSON, JSON/JSONL and typed Parquet round-trips. Explicit invalid BIGINT casts surfaced errors. JSON export preserved `12345678901234567890.123456789012345678`, `0.000000000000000001`, and string `"00123"`.
- Nested JSON values and `1e400` produced the localized unsupported-tabular-JSON error, not silent stringification or rounding. Supported JSON is flat object records with consistent scalar column types; JSON/JSONL input is materialized in a worker, not a bounded-memory stream.
- A final SQL-export regression reproduced an array becoming the JSON string `"[1, 2]"`. After correction, arrays and non-finite DOUBLE values both produced the visible localized JSON-contract error without a download; a subsequent valid export in the same session preserved BIGINT `9007199254740993`, boolean `true` and string `"00123"`. The SQL JSON error was also added to its client message island.
- Converter preview was bounded to 200 rows while the actual JSONL download contained all 10,005 source rows.
- All 20 new locale routes rendered localized titles at 375 px without document horizontal overflow or initial WASM requests. English/Russian surfaces, light/dark themes and actual language switching were viewed; the SQL table-name field uses the shared styled input.
- After one online load, the actual service-worker cache contained DuckDB, JSON worker and Parquet worker/WASM assets. Offline reload followed by Parquet and JSON processing succeeded with `navigator.onLine === false`.
- Both non-isolated runtime paths were exercised: ordinary EH, then actual MVP worker/WASM after hiding only the `WebAssembly.Exception` feature for selection. `crossOriginIsolated` was false, and neither path required threads or shared memory.

Limits are not performance guarantees: 1 GiB source cap, 128 MiB non-UTF-8 transcoding, 512 MiB DuckDB memory setting, 100,000-row Playground result bound, buffered Parquet output up to 512 MiB, and bounded Blob fallbacks (converter 256 MiB; Playground 512 MiB). Cross-browser peak-memory/throughput benchmarks, native OS picker dialogs and multi-gigabyte DuckDB imports were not exercised.

## 9. Remaining gaps (not covered by this verification)

- **Full browser matrix** — catalog/core UI sweeps use Chromium; the hash
  benchmark also uses Firefox, and Explorer checks include Firefox/WebKit.
  This does not establish full-catalog Safari/WebKit, branded Chrome or Edge behavior.
- **Real-device mobile touch** — keyboard open, safe-area insets, drag/drop,
  orientation change need a physical device pass; emulated touch verified only.
- **Field CWV (CrUX)** — lab metrics only until real traffic accumulates.

These are flagged in `FRONTEND_REBUILD_TODO.md` Stage 11 §"Визуальная приемка"
as owner-gated / environment-gated.

## 10. Processing-core browser matrix (2026-10-17)

Reproducible runner: `apps/site/scripts/validate-processing-core.mjs`. Build the site first, then run:

```bash
node apps/site/scripts/validate-processing-core.mjs --browser firefox --hash-sizes 10,100,1024,5120 --repetitions 3 --output /tmp/processing-firefox.json
node apps/site/scripts/validate-processing-core.mjs --browser chrome --hash-sizes 10,100,1024,5120 --repetitions 3 --output /tmp/processing-chrome.json
node apps/site/scripts/validate-processing-core.mjs --browser msedge --hash-sizes 10,100,1024,5120 --repetitions 3 --output /tmp/processing-edge.json
```

The runner serves the built assets on loopback and imports the actual common `createJobWorker` module and hash/CSV/JSON workers. `--executable-path` supports portable browser installations. Actual branded Chrome/Edge runs used official packages extracted without root; temporary packages and browser trees were removed afterward. Platform: Linux x64 7.0.0-38-generic, Node 25.9.0, QEMU virtual CPU, 28 logical processors. All three full reports passed.

### Fixtures and behavior

- Empty and exact 1 KiB binary files; SHA-256 at 10/100 MiB and 1/5 GiB. Every digest matched independently streamed Node crypto.
- Empty and exact 1 KiB CSV/JSONL; complete 100 MiB CSV (1,436,401 rows) and JSONL (1,361,700 rows) scans.
- Empty CSV returns `malformed-csv`; empty JSONL is a valid zero-row result. Invalid UTF-8 returns `invalid-utf8`; a 1 GiB + 1 byte ordinary JSON input hits the 32 MiB configured limit before a complete read. CSV fields above 2 MiB and JSONL records above the configured 64 KiB test limit fail explicitly.
- Three cancellation/restart cycles each for hash and CSV, aborted at the first 1 MiB progress event. Every fresh worker returned the correct 1 KiB result.
- Export of 114,913 CSV rows produced 41 chunks / 8,503,528 bytes. A receiver delaying acknowledgements by 75 ms kept exactly one unacknowledged chunk. Receiver abort propagated `aborted`; another export on the same indexed session succeeded.
- Fixtures use a deterministic block of at most 1 MiB repeated as Blob/File parts, with a bounded final slice. No multi-gigabyte source buffer or fixture file is created. This exercises browser File/Blob chunking, not physical-disk throughput.

### Measured SHA-256 throughput

Values are MiB/s for the complete operation, including worker startup. One observed run per browser/size, not a statistical performance guarantee.

| Browser | Version | 10 MiB | 100 MiB | 1 GiB | 5 GiB |
|---|---|---:|---:|---:|---:|
| Google Chrome | 155.0.8059.84 | 56.850 | 91.583 | 95.052 | 93.356 |
| Microsoft Edge | 155.0.4283.60 | 50.942 | 90.514 | 99.802 | 94.983 |
| Firefox | 153.0 | 15.699 | 19.117 | 18.470 | 18.242 |

### Memory and responsiveness

RSS is sampled every 100 ms and summed over the browser process tree. Shared pages may be counted more than once; these values are neither unique physical memory nor worker/WASM heap measurements. No forced GC was used. A post-termination RSS observation does not prove absence of leaks.

| Browser | Peak process-tree RSS, MiB | Post-worker-termination RSS, MiB | CSV 100 MiB, ms | JSONL 100 MiB, ms | 5 GiB hash heartbeat maximum / p95 gap, ms |
|---|---:|---:|---:|---:|---|
| Chrome | 1540.293 | 1049.723 | 6487.5 | 6465.1 | 47.3 / 16.3 |
| Edge | 1407.023 | 932.699 | 6808.1 | 6583.0 | 36.3 / 16.3 |
| Firefox | 781.898 | 702.879 | 9555.0 | 26651.0 | 157.0 / 17.0 |

The main-page heartbeat uses a 16 ms timer during worker operations: it measures scheduling responsiveness, not rendered FPS or paint latency. Chrome/Edge expose non-standard `performance.memory` for the page only; it excludes worker/WASM allocations. Firefox exposed neither that API nor `measureUserAgentSpecificMemory`. The report records these support differences rather than inventing comparable heap numbers.

### Lazy loading and limits of the check

On Chrome, importing the common runner fetched 2,494 B runner JS + 759 B protocol JS. The first hash call fetched 5,446 B worker JS + 218,312 B WASM; the cold empty operation took 52.3 ms. Worker/WASM request-to-response-start times were 30.180/15.631 ms (Chrome), 29.316/11.101 ms (Edge), and 25.271/13.549 ms (Firefox). These are loopback HTTP Content-Length/response-start observations, not internet download budgets or compilation timings.

Safari/WebKit, inputs larger than 5 GiB, rendered-frame profiling, per-worker heap accounting, genuine full-disk/native-picker faults, and >512 MiB Blob fallback exports were not exercised by this matrix. The worker transport backpressure/abort/recovery paths were exercised; native writable rollback has separate prior OPFS evidence in §8. Broad cross-tool leak/resource-exhaustion acceptance remains open.

## 11. Log Analyzer acceptance (2026-10-17)

Implemented `/{lang}/log-analyzer/` for all ten locales using shared chunk reads, worker lifecycle, virtual tables and streaming saves. No input/filter persistence or server-side processing.

Actual built-site Chromium checks:

- Seven-line Serilog/CLEF fixture: six valid records, one malformed line, two error events and one fatal event. `System.TimeoutException` counted twice, `System.InvalidOperationException` once; changing order IDs grouped under the same `@mt` template while `@m` stayed readable.
- Combined source/request-ID/raw-text filters selected the exact expected record. Inclusive time bounds plus Error severity selected exactly two records. Selecting no severity produced zero matches (regression fixed after browser reproduction).
- One million NDJSON records / 114,000,000 bytes imported with exact error counts. Canceling and selecting the same file again succeeded.
- Full export of 10,005 records / 1,140,570 bytes matched the input byte-for-byte, beyond the virtual preview. A filtered single-record export matched its original source line. UTF-8 BOM, LF, CRLF, CR and an unterminated final line also round-tripped byte-for-byte.
- Nginx access/error presets parsed their matching source lines and counted mismatched lines explicitly. Empty input, invalid UTF-8 and a line beyond 2 MiB produced localized errors; a valid import succeeded afterward.
- HTML/script-like log content remained text. No fixture data appeared in localStorage. All ten localized routes had named tool buttons and no horizontal page overflow at 375 px; loaded Russian/English screens were visually inspected in light/dark themes.

Limits: 2 MiB per physical line, 100 million records, 512 characters per filter/aggregate label, 2,000 aggregate keys and 4,096 distinct minutes. Aggregate truncation is disclosed; total counts, matching and export remain exact. Multiline stack traces are separate physical records, not reconstructed events. Native operating-system save dialogs were not exercised in this Log Analyzer pass; downloads used the Blob fallback. Preview analytics requests can return 404 because the local static preview has no analytics API; no script/resource failures affected log processing.

Final integration gate: `ANALYTICS_ENABLED=true npm run verify -w @mydevtools/site` passed **466 unit tests and 9 dist smoke checks**, building 485 pages. Astro reported zero errors/warnings and three hints; i18n reported zero errors and the pre-existing German UUID-title warning. The final built browser also confirmed CLEF's omitted `@l` means Information and `@tr` is available as a correlation ID, following the [Serilog compact-format specification](https://github.com/serilog/serilog-formatting-compact#reified-properties). English → Russian language switching retained the Log Analyzer route. All ten localized CLEF examples are valid JSON.
