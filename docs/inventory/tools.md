# Tool Inventory (Stage 1 parity source)

> Source of truth priority: Razor pages > browser JS > locale JSON > docs.
> WASM domains verified from each JS controller's `import('/wasm/<domain>/...')`.
> Categories from `Home.razor → GetToolsByCategoryForSections()`; 4 tools absent
> from the catalog are marked **[INFERRED]** and sourced from `MetaTags Category`.

## Registry roll-up

- **39 tools**, **13 categories** (12 legacy + `generators` for the ungrouped pair).
- **25 WASM-backed**, **14 pure-JS**.
- WASM domain counts: encoding 6, cryptography 6, image_tools 3, pdf 3, qrcode 2, hash 1, password 1, text_tools 1, structured_data 1, regex_tool 1, ipcalc 1.

## Table

| slug | category | namespace | inputs | settings | actions | results | js | wasm |
|---|---|---|---|---|---|---|---|---|
| base64-encoder | encoding | tools/base64-encoder | text; OR file | charset; alphabet; padding; line wrap; output mode; allow-whitespace | Encode; Decode; Clear; Swap; Copy; Download | textarea; image preview / binary info on decode | tools/base64-encoder.js | encoding |
| base32-encoder | encoding | tools/base32-encoder | text; OR file | charset; alphabet (RFC4648/Crockford/zbase32); padding; case; output mode; allow-whitespace | Encode; Decode; Clear; Swap; Copy; Download | textarea | tools/base32-encoder.js | encoding |
| base58-encoder | encoding | tools/base58-encoder | text; OR file | alphabet (Bitcoin/Flickr/Ripple); output mode; allow-whitespace | Encode; Decode; Clear; Swap; Copy; Download | textarea | tools/base58-encoder.js | encoding |
| hex-encoder | encoding | tools/hex-encoder | text; OR file | charset; case; output mode; ignore-whitespace; allow-separators; allow-0x | Encode; Decode; Clear; Swap; Copy; Download | textarea | tools/hex-encoder.js | encoding |
| url-encoder | encoding | tools/url-encoder | text | mode (component/uri/form); charset | Encode; Decode; Clear; Swap; Copy | textarea | tools/url-encoder.js | encoding |
| html-entity-encoder | encoding | tools/html-entity-encoder | text | mode (all/specialchars/nonascii); format (named/decimal/hex) | Encode; Decode; Clear; Swap; Copy | textarea | tools/html-entity-encoder.js | none |
| json-beautifier | structured-data | tools/json-beautifier | CodeMirror; Open .json | indent; sort keys; compact | Format; Open; Save; Copy; Clear | CodeMirror | tools/json-beautifier.js | none |
| json-to-typescript | structured-data | tools/json-to-typescript | CodeMirror input | root name; export; optional; type alias | Convert; Copy; Download; Clear | CodeMirror (readonly) | tools/json-to-typescript.js | none |
| xml-beautifier | structured-data | tools/xml-beautifier | CodeMirror; Open .xml | indent; compact | Format; Open; Save; Copy; Clear | CodeMirror | tools/xml-beautifier.js | none |
| yaml-beautifier-validator | structured-data | tools/yaml-beautifier-validator | CodeMirror input | (none) | Format; Validate; Clear; Paste; Copy | CodeMirror (readonly); valid/invalid badge | tools/yaml-beautifier-validator.js | structured_data |
| cron-generator | structured-data | tools/cron-generator | m/h/d/mo/wd fields | date-format | Generate; Copy | expr; human; next runs | tools/cron-generator.js | none |
| cron-parser | structured-data | tools/cron-parser | cron expr | date-format; presets | Parse; Clear | human; next runs; field breakdown | tools/cron-parser.js | none |
| word-counter | text | tools/word-counter | text | (none) | Clear; Copy; Paste | words/chars/lines/paras/sentences/reading&speaking time | tools/word-counter.js | none |
| text-case-converter | text | tools/text-case-converter | text | (none) | case buttons; Clear; Copy | same textarea (in-place) | tools/text-case-converter.js | text_tools |
| text-diff-viewer | text | tools/text-diff-viewer | original; modified (both +file) | view (line/side) | Compare; Clear | diff2html | tools/text-diff-viewer.js (+ jsdiff & diff2html CDN) | none |
| jwt-decoder | jwt | tools/jwt-decoder | JWT; secret | (algo read-only) | auto-decode; Verify; Copy | header; payload; signature status | tools/jwt-decoder.js | cryptography |
| jwt-encoder | jwt | tools/jwt-encoder | header JSON; payload JSON; secret | algorithm (HS256/384/512) | Encode; Copy | encoded JWT | tools/jwt-encoder.js | cryptography |
| regex-tester | regex | tools/regex-tester | pattern; test text | flags (g/i/m/s/u) | live match; Save; cheat sheet | count + detail; backdrop highlight; saved table | tools/regex-tester.js (ESM) | regex_tool |
| hash-calculator | hashing | tools/hash-calculator | text; OR file | multi-select algos (39) w/ search | Calculate; Clear | per-algo digest list | tools/hash-calculator.js | hash |
| password-generator | hashing | tools/password-generator | (none) | length; toggles; custom special | Generate; Copy; Clear history | result; history table | tools/password-generator.js | password |
| hmac-calculator | cryptography | tools/hmac-calculator | key; message | algorithm (SHA-256/512) | Calculate; Clear | HMAC digest | tools/hmac-calculator.js | cryptography |
| aead-file | cryptography | tools/aead-file | encrypt/decrypt file; password | algorithm (AES-256-GCM/ChaCha20-Poly1305/XChaCha20) | Encrypt; Decrypt | hex header; result file; warnings | tools/aead-file.js | cryptography |
| openssh-keys | cryptography | tools/openssh-keys | import textarea/file; passphrase | algorithm (Ed25519/ECDSA/RSA); key size | Generate; Import; Convert | public/private key (copy/download); warnings | tools/openssh-keys.js | cryptography |
| x509 | cryptography | tools/x509 | subject; validity days; parse | (none) | Generate CSR; Self-signed; Parse | output (copy/download); warnings | tools/x509-tool.js | cryptography |
| uuid-generator | generators [INFERRED] | tools/uuid-generator | (none) | version (v4/v7); format; case; count | Generate; Copy each/all; Download; Clear | UUID table | inline Razor | none |
| lorem-ipsum-generator | generators [INFERRED] | tools/lorem-ipsum-generator | (none) | count+type; format; start-classic; rich options | Generate; Copy; Download | textarea; stats | tools/lorem-ipsum-generator.js | none |
| unit-converter | converters | tools/unit-converter | from-value | category; from-unit; to-unit | Swap; Copy | to-value (live) | inline Razor | none |
| date-converter | converters [INFERRED] | tools/date-converter | input | input type; output format; custom | Current time; Convert; Copy | textarea | tools/date-converter.js | none |
| ip-subnet-calculator | converters | tools/ip-subnet-calculator | CIDR / addr+mask | examples | Calculate | addr/mask/wildcard/network/broadcast/hosts/class; binary; private badge | tools/ip-subnet-calculator.js | ipcalc |
| color-converter | design | tools/color-converter | picker; manual (hex/rgb/hsl/cmyk) | input format | Convert; Clear; per-format Copy | HEX/RGB/HSL/CMYK; shades; WCAG contrast | inline Razor | none |
| markdown-preview | design | tools/markdown-preview | markdown | sync-scroll | toolbar; Clear; Copy HTML/MD; Download | live HTML (marked.js GFM) | js/markdown-preview.js (+ marked.min.js) | none |
| image-compressor | images | tools/image-compressor | images (multi; png/jpeg/webp) | quality; output format | Compress; Download each; Download All (ZIP) | file list table | tools/image-compressor.js | image_tools |
| image-converter | images | tools/image-converter | image (any) | target format (8); quality (lossy) | Convert; Download | preview; output size | tools/image-converter.js | image_tools |
| image-resizer | images | tools/image-resizer | image (any) | w/h; lock aspect; format | Resize; Download | preview; result info | tools/image-resizer.js | image_tools |
| pdf-compressor | pdf | tools/pdf-compressor | PDFs (multi) | (none) | Compress | file list (orig/result/status/per-file dl) | tools/pdf-compressor.js | pdf |
| pdf-merger | pdf | tools/pdf-merger | PDFs (multi) | (none) | Merge | merged.pdf download | tools/pdf-merger.js | pdf |
| pdf-to-text | pdf [INFERRED] | tools/pdf-to-text | PDFs (multi) | (none) | Extract | file list (per-file .txt dl) | tools/pdf-to-text.js | pdf |
| qr-code-generator | qrcode | tools/qr-code-generator | content; logo (opt) | fg/bg; style; error correction; size | Generate; Download PNG/SVG | QR preview | tools/qr-code-generator.js | qrcode |
| qr-scanner | qrcode | tools/qr-scanner | image file | (none) | auto-decode on upload | decoded text (copy); Open Link if URL | tools/qr-scanner.js | qrcode |

## Notes (non-obvious behavior)

**Catalog source.** Categories above come from `Home.razor → GetToolsByCategoryForSections()` (35 of 39 tools). Four are not in the catalog — `uuid-generator`, `lorem-ipsum-generator`, `date-converter`, `pdf-to-text` — marked **[INFERRED]** (from `MetaTags Category`). `MetaTags Category` frequently disagrees with the catalog; catalog wins where present. New IA folds the 2 generators into a new `generators` category, `date-converter` → converters, `pdf-to-text` → pdf.

**File encoding tools (base32/58/64/hex).** Text OR dropped file (any type). 1 MiB chunks + progress + `AbortController` cancel. "preview" output mode truncates large output. All four: Copy + Download (decoded bytes) + Swap.
- *base58*: O(n²) math — **cannot chunk**; reads whole file, synthesizes 33/50/66/100 % milestones.
- *base64*: on **Decode** sniffs magic bytes; renders **image preview** (PNG/JPEG/GIF/WebP) or binary-info (ZIP/GZIP/ELF detection) + download.

**hash-calculator.** 39 algos via search-backed multi-list (MD5; SHA-1/2/3; Streebog; Keccak; SHAKE; BLAKE2/3; RIPEMD; CRC32; Adler-32; xxh; SipHash; HighwayHash; MetroHash; FxHash; FNV-1a; SeaHash). File hashing 1 MiB chunks + progress + cancel; per-row copy.

**aead-file.** Streaming AEAD 1 MiB chunks (encrypt) / chunk-from-header (decrypt). KDF = **Argon2id** (m=64 KiB, t=3, p=1), random 16-byte salt + nonce prefix. Encrypt → hex header preview; Decrypt reads header from first 128 bytes. Password shared between panels. Progress + cancel.

**Cryptography-WASM group (hmac/jwt-decoder/jwt-encoder/openssh-keys/x509).** Lazy-load `/wasm/cryptography/`. jwt-decoder verifies live when secret supplied. x509 controller is **`x509-tool.js`** (not `x509.js`).

**CodeMirror tools (json/json-to-ts/xml/yaml).** CodeMirror 5 + closebrackets/matchbrackets/fold. xml defines custom `simplexml` mode. json-to-ts uses two editors. json & xml add Open/Save via hidden `<input type=file>`.

**markdown-preview.** Controller at **`wwwroot/js/markdown-preview.js`** (not /tools/); local **`marked.min.js`** (GFM, headerIds).

**regex-tester.** ES module; WASM `test_regex`. Live highlight via transparent backdrop `<div>` under textarea. Saved patterns table; native `<dialog>`.

**text-case-converter.** `text_tools` WASM; transforms **in place**.

**text-diff-viewer.** Pure-JS but **external CDN** — jsdiff 5.1.0 + diff2html. File load per side; line/side view.

**password-generator.** `password` WASM (CSPRNG); session history table.

**uuid-generator.** Pure inline JS (Web Crypto); no JS file, no WASM. v4/v7; batch ≤100; download .txt.

**color-converter / unit-converter.** Pure inline JS. unit-converter **auto-converts live** (no Convert button). color-converter: shades palette + WCAG AA/AAA contrast.

**date-converter.** Pure JS file, no WASM. Custom output format (`yyyy MM dd HH mm ss SSS`).

**image-compressor.** Multi-file batch. "Download All" lazily loads **JSZip** from CDN, timestamped ZIP.

**image-converter / image-resizer.** Single-file; converter 8 formats + quality (lossy); resizer w/h + aspect lock + live size/dim readout.

**PDF tools.** All multi-file, all `pdf` WASM. merger → single `merged.pdf`. pdf-to-text cache-busts WASM URL + WinAnsi text-extraction fallback. compressor: before/after sizes.

**ip-subnet-calculator.** `ipcalc` WASM via **relative** path (`../wasm/ipcalc/ipcalc.js`). `a.b.c.d/n` or addr+netmask; results table + binary view + Private/Public badge.

**qr-code-generator.** `qrcode` WASM. Optional **logo overlay**, 4 dot styles, PNG + SVG.

**qr-scanner.** `qrcode` WASM. Decodes **uploaded image only** — no `getUserMedia` (no live camera despite camera icon). "Open Link" if payload is URL.

## Privacy / external-deps flags (Stage 7 must vendor or replace)

- `text-diff-viewer`: CDN jsdiff + diff2html.
- `markdown-preview`: local marked.min.js (self-hosted, OK).
- `image-compressor`: CDN JSZip.
- All other libs are local (CodeMirror, wasm-bindgen).

## Astro catalog additions (2026-10-08)

The Stage 1 table above records the legacy 39-tool baseline. The current Astro registry has **45 tools: 24 Rust/WASM-backed and 21 browser-only or npm-WASM-backed**, in the same 13 categories. `json-explorer`, `csv-explorer`, `parquet-explorer`, `local-data-playground` and `data-format-converter` belong to `structured-data`. `hex-viewer` belongs to `encoding`. All six run locally and have UI/error/SEO strings in all 10 locales.

| Slug | Input and execution | View and export | Explicit boundaries |
|---|---|---|---|
| `json-explorer` | Chunked UTF-8 JSONL; lossless ordinary JSON with a user-selected size/depth limit. Numeric spelling is preserved. | Virtualized records, lazy JSON tree, key/value search, JSON Pointer filters and field projection; full filtered JSONL/CSV export streamed to the chosen local file when the File System Access API is available. | Ordinary JSON: 8/16/32/64 MiB; JSONL record: 1–8 MiB; depth ≤256; automatic fields: first 10,000 records, ≤100 pointers. Browsers without a native save picker use an explicitly bounded 256 MiB Blob fallback. Explicit field selection can project fields outside the automatic sample. |
| `csv-explorer` | Chunked CSV/TSV; automatic or explicit comma/semicolon/tab/pipe delimiter; UTF-8, UTF-16 and selected legacy encodings. | Virtualized table, exact numeric comparisons, selected columns, full filtered CSV/JSONL export with destination backpressure. | Field ≤2 MiB, record ≤8 MiB, ≤512 columns, ≤100,000,000 records. Browsers without a native save picker use an explicitly bounded 512 MiB Blob fallback. Sorting, grouping/aggregates, type conversion and Parquet are not implemented. |
| `parquet-explorer` | Local `.parquet` via hyparquet. Footer, schema and row-group stats are read without decoding every page. Extra codecs (gzip, Brotli, Zstd, LZ4, LZ4_RAW) come from hyparquet-compressors; Snappy is built in. | Virtualized selected columns, schema and row-group tables, cell inspector, streaming CSV/JSONL export of the selected columns. | ≤512 columns and cell ≤1 MiB. Browsers without a native save picker use an explicitly bounded 512 MiB Blob fallback. LZO is unsupported. No SQL, filters, aggregates, sorting or Parquet writing. INT64 keeps its decimal spelling; JSONL stores bigint and byte values as strings. |
| `local-data-playground` | Local CSV/TSV is registered with a lazy, self-hosted DuckDB-WASM worker. Flat JSON and JSONL/NDJSON records are parsed without JavaScript-number coercion in a local worker and transferred through a generated local tabular file; Parquet crosses a separate local `parquet-wasm` worker as Arrow IPC. Each import gets a quoted SQL table name; user SQL is one read-only `SELECT`/`WITH`. DuckDB external access is disabled except for its dedicated `/mdt-local` virtual directory, and extension auto-install/load is disabled. | CodeMirror SQL with generated SELECT/WHERE/GROUP BY/JOIN examples; one materialized result at a time; virtualized pages; streamed CSV/JSON/JSONL and buffered Parquet export. JSON serialization is performed from bounded result pages without DuckDB’s network-installed JSON extension. | Input ≤1 GiB; non-UTF-8 transcode ≤128 MiB; DuckDB memory 512 MiB; playground result ≤100,000 rows; API explicit preview ≤1,000,000 rows; page ≤500 rows. JSON/JSONL parsing is whole-file and in-memory, not chunked. Its records must be flat with a consistent scalar type per column; exact numerics must fit DECIMAL(38). Blob fallback and buffered Parquet ≤512 MiB. Cancel terminates the workers and releases every table. |
| `data-format-converter` | The same DuckDB engine imports CSV as source text (preserving leading-zero identifiers); local JSON parsing distinguishes strings, booleans and numeric lexemes without routing numbers through JavaScript `Number`; the local Parquet worker preserves Parquet types through Arrow IPC. Selected columns use quoted projections and strict `CAST`, so invalid values fail instead of silently becoming NULL. | Bounded 200-row preview; complete CSV/JSON/JSONL export streamed to a destination where supported; Parquet encoded off the main thread from DuckDB's typed Arrow result. JSON/JSONL need no remote extension. | Same input/transcode/working-memory boundaries. JSON/JSONL is whole-file, flat-record only and requires consistent scalar column types; nested values and numerics outside exact DECIMAL(38) are explicitly rejected. Text Blob fallback ≤256 MiB; Parquet output buffering ≤512 MiB. Source data, schema and choices are session-only. |
| `hex-viewer` | Any local file. Visible 16-byte rows are `File.slice` reads on the page. Signature search and Shannon entropy run in a worker. Magic bytes reuse `detectFileType`, then the UTF-8 text probe. | Virtualized hex, ASCII and per-row UTF-8. Decimal or `0x` jump. Text or hex search. 4 KiB entropy bars. Inclusive range download as a blob slice. | Needle ≤256 bytes, ≤200 matches, search chunks of 1 MiB. Entropy is exact up to 1 MiB and 256 samples after that. Export ≤256 MiB. No byte editing or disassembly. |

These tables cap the physical scroll track at 8,000,000 px and retain a bounded visible window rather than one DOM node per input row. Explorer cancellation terminates its worker and releases file/index state. DuckDB cancellation is deliberately hard: the DuckDB worker is terminated, all registered files and materialized tables are released, and a later import starts a fresh worker.

DuckDB uses a single-threaded EH bundle when WebAssembly exception handling is available and the single-threaded MVP bundle otherwise. Neither path requires SharedArrayBuffer, COOP or COEP. Only the selected worker/WASM is fetched; the service worker caches it after use, not during shell installation.

JSON/JSONL export also enforces the flat-scalar contract: nested SQL/Parquet arrays, structs, maps and unions, or non-finite numeric values, produce an explicit unsupported-tabular-JSON error rather than being silently converted into strings.

CSV, JSONL and Parquet-derived text exports use the shared streaming save core. Native-picker writes await every destination write before requesting more worker output; cancellation or storage failure aborts the partial writable. An explicit user cancellation terminates the worker session, while a destination write failure closes only that export stream so the indexed file can be retried. The fallback retains only its documented maximum in memory and refuses larger output instead of claiming an unbounded download will fit.

Hashing, file encoding, image processing, key generation and explorer jobs share the correlated worker runner: aborting or losing one worker rejects every request posted to that exact instance, detaches its listeners and makes the next run spawn a clean worker. Hash, encoding, CSV and JSONL readers also share one configurable `Blob.slice()` async iterator; it keeps one chunk in flight, reports absolute offsets and checks cancellation on both sides of each read.

Worker errors share a small resource taxonomy. Runtime allocation evidence is reported as `memory-exhausted`, terminates the affected worker and uses common localized guidance; it is never relabeled as a bad file. `invalid-format` and `corrupt-input` are emitted only where the parser or decoder provides specific evidence. Existing CSV, JSON, Parquet, PDF, image, QR, encoding and cryptography errors retain their more precise tool-specific messages when that evidence is available.
