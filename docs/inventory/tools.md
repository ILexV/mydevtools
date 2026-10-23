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

The Stage 1 table above records the legacy 39-tool baseline. The current Astro registry has **57 tools: 24 Rust/WASM-backed and 33 browser-only or npm-WASM-backed**, in the same 13 categories. `json-explorer`, `csv-explorer`, `parquet-explorer`, `local-data-playground`, `sqlite-explorer`, `data-format-converter` and `log-analyzer` belong to `structured-data`. `hex-viewer` belongs to `encoding`; `large-file-diff` belongs to `text`. All nine run locally and have UI/error/SEO strings in all 10 locales.

| Slug | Input and execution | View and export | Explicit boundaries |
|---|---|---|---|
| `json-explorer` | Chunked UTF-8 JSONL; lossless ordinary JSON with a user-selected size/depth limit. Numeric spelling is preserved. | Virtualized records, lazy JSON tree, key/value search, JSON Pointer filters and field projection; full filtered JSONL/CSV export streamed to the chosen local file when the File System Access API is available. | Ordinary JSON: 8/16/32/64 MiB; JSONL record: 1–8 MiB; depth ≤256; automatic fields: first 10,000 records, ≤100 pointers. Browsers without a native save picker use an explicitly bounded 256 MiB Blob fallback. Explicit field selection can project fields outside the automatic sample. |
| `csv-explorer` | Chunked CSV/TSV; automatic or explicit comma/semicolon/tab/pipe delimiter; UTF-8, UTF-16 and selected legacy encodings. | Virtualized table, exact numeric comparisons, selected columns; column types (text, int64, double, boolean; manual or detected from 1,000 rows; invalid → error or null); sort of the filtered result by one column; group by one column with count, non-null count, exact sum, average, min, max; full CSV/JSONL/Parquet export (Snappy, 64Ki-row groups) of rows or the group summary with destination backpressure. | Field ≤2 MiB, record ≤8 MiB, ≤512 columns, ≤100,000,000 records. Sort ≤5,000,000 rows and ≤32M chars of text keys; ≤100,000 groups; an integer sum beyond int64 cannot go to Parquet. Browsers without a native save picker use an explicitly bounded 512 MiB Blob fallback. |
| `parquet-explorer` | Local `.parquet` via hyparquet. Footer, schema and row-group stats are read without decoding every page. Extra codecs (gzip, Brotli, Zstd, LZ4, LZ4_RAW) come from hyparquet-compressors; Snappy is built in. | Virtualized selected columns, schema and row-group tables, cell inspector; up to 8 AND conditions (exact int64/decimal comparisons, timestamps by instant, case-folded text) kept as a one-bit-per-row selection; group by one column with count, non-null count, exact sum, average, min, max; streaming CSV/JSONL export of the filtered rows or the group summary. Scans read 65,536-row windows where columns have an offset index, otherwise each row group once. | ≤512 columns and cell ≤1 MiB; ≤8 conditions; ≤100,000 groups. Browsers without a native save picker use an explicitly bounded 512 MiB Blob fallback. LZO is unsupported. No SQL, sorting or Parquet writing. INT64 keeps its decimal spelling; JSONL stores bigint and byte values as strings. Cancel reopens the file without the filter. |
| `local-data-playground` | Local CSV/TSV is registered with a lazy, self-hosted DuckDB-WASM worker. Flat JSON and JSONL/NDJSON records are parsed without JavaScript-number coercion in a local worker and transferred through a generated local tabular file; Parquet crosses a separate local `parquet-wasm` worker as Arrow IPC. Each import gets a quoted SQL table name; user SQL is one read-only `SELECT`/`WITH`. DuckDB external access is disabled except for its dedicated `/mdt-local` virtual directory, and extension auto-install/load is disabled. | CodeMirror SQL with generated SELECT/WHERE/GROUP BY/JOIN examples; one materialized result at a time; virtualized pages; streamed CSV/JSON/JSONL and buffered Parquet export. JSON serialization is performed from bounded result pages without DuckDB’s network-installed JSON extension. | Input ≤1 GiB; non-UTF-8 transcode ≤128 MiB; DuckDB memory 512 MiB; playground result ≤100,000 rows; API explicit preview ≤1,000,000 rows; page ≤500 rows. JSON/JSONL parsing is whole-file and in-memory, not chunked. Its records must be flat with a consistent scalar type per column; exact numerics must fit DECIMAL(38). Blob fallback and buffered Parquet ≤512 MiB. Cancel terminates the workers and releases every table. |
| `sqlite-explorer` | Local SQLite 3 file (`.sqlite`, `.db`, …) copied into the official `@sqlite.org/sqlite-wasm` build in a dedicated worker with `sqlite3_deserialize`. Read-only by default (`SQLITE_DESERIALIZE_READONLY`); an explicit switch reopens it as a resizable in-memory copy. The original file is never written. WAL-mode files are opened by switching header bytes 18/19 in the copy; a separate `-wal` file is not read. OPFS/kvvfs VFS probes are disabled. | Schema list (tables, views, indexes, triggers), structure with columns, indexes, foreign keys and the CREATE statement; table browsing with LIMIT/OFFSET pages; CodeMirror SQL scripts run statement by statement, the last row-returning statement is the result (SELECT/WITH/VALUES materialized into `temp._mdt_result`, PRAGMA/EXPLAIN/RETURNING captured). Streamed CSV/JSON/JSONL/SQL INSERT export; download of the changed copy via `sqlite3_js_db_export`. | File ≤512 MiB; SQL ≤1 MiB; materialized result ≤1,000,000 rows; captured rows ≤10,000; page ≤500 rows; preview cell ≤512 characters, BLOB preview 32 bytes. Encrypted databases are refused as not SQLite. Cancel terminates the worker and reopens the file, discarding changes. 64-bit integers stay exact (BigInt, JSON string above 2^53). |
| `data-format-converter` | The same DuckDB engine imports CSV as source text (preserving leading-zero identifiers); local JSON parsing distinguishes strings, booleans and numeric lexemes without routing numbers through JavaScript `Number`; the local Parquet worker preserves Parquet types through Arrow IPC. Selected columns use quoted projections and strict `CAST`, so invalid values fail instead of silently becoming NULL. | Bounded 200-row preview; complete CSV/JSON/JSONL export streamed to a destination where supported; Parquet encoded off the main thread from DuckDB's typed Arrow result. JSON/JSONL need no remote extension. | Same input/transcode/working-memory boundaries. JSON/JSONL is whole-file, flat-record only and requires consistent scalar column types; nested values and numerics outside exact DECIMAL(38) are explicitly rejected. Text Blob fallback ≤256 MiB; Parquet output buffering ≤512 MiB. Source data, schema and choices are session-only. |
| `hex-viewer` | Any local file. Visible 16-byte rows are `File.slice` reads on the page. Signature search and Shannon entropy run in a worker. Magic bytes reuse `detectFileType`, then the UTF-8 text probe. | Virtualized hex, ASCII and per-row UTF-8. Decimal or `0x` jump. Text or hex search. 4 KiB entropy bars. Inclusive range download as a blob slice. | Needle ≤256 bytes, ≤200 matches, search chunks of 1 MiB. Entropy is exact up to 1 MiB and 256 samples after that. Export ≤256 MiB. No byte editing or disassembly. |
| `large-file-diff` | Two local files read in 1 MiB blocks in a worker. Text lines become 64-bit hashes after the whitespace (exact, trailing, amount, all) and line-ending rules; UTF-8/UTF-16 hash as code points, legacy encodings as bytes. Diff: common head/tail, unique-line anchors (patience), capped linear-space Myers in the gaps. Binary mode compares 1 MiB blocks. | Virtualized unified view with both line numbers, previous/next change, adjustable context; byte-range table with 16-byte previews per side. Streamed unified diff (.diff) or CSV of ranges. | ≤10,000,000 lines per file; ~8 B/line plus ≤9 B/line while matching. Gaps over the Myers work cap are shown as replace blocks (flagged). Table clips lines at 2,000 chars; report lines ≤16 MiB. ≤100,000 kept binary ranges. Blob fallback ≤512 MiB. |
| `log-analyzer` | UTF-8 `.log`, text and NDJSON read in 1 MiB worker chunks. Auto/explicit Serilog (.NET JSON/CLEF/plaintext), Nginx access/error, generic JSONL and text presets. Sparse source/filter checkpoints; no whole-file materialization. | Virtualized rows, raw-line inspector, combined inclusive time/severity/source/request-ID/raw-text filters; severity counts, time histogram, error types and message-template rankings. Full filtered export streams original UTF-8 lines, preserving BOM and line endings. | Line ≤2 MiB; ≤100 million physical lines; page ≤250 rows; filters ≤512 characters; aggregate labels ≤512 characters, ≤2,000 distinct keys and ≤4,096 distinct minutes, with a visible truncation warning. Inspector ≤64 KiB; Blob export fallback ≤512 MiB. Multiline stack traces remain separate physical records. Nginx error timestamps without an offset are interpreted as UTC; unzoned ISO date-times and filter inputs use browser-local time. |

These tables cap the physical scroll track at 8,000,000 px and retain a bounded visible window rather than one DOM node per input row. Explorer cancellation terminates its worker and releases file/index state. DuckDB cancellation is deliberately hard: the DuckDB worker is terminated, all registered files and materialized tables are released, and a later import starts a fresh worker.

DuckDB uses a single-threaded EH bundle when WebAssembly exception handling is available and the single-threaded MVP bundle otherwise. Neither path requires SharedArrayBuffer, COOP or COEP. Only the selected worker/WASM is fetched; the service worker caches it after use, not during shell installation.

JSON/JSONL export also enforces the flat-scalar contract: nested SQL/Parquet arrays, structs, maps and unions, or non-finite numeric values, produce an explicit unsupported-tabular-JSON error rather than being silently converted into strings.

CSV, JSONL and Parquet-derived text exports use the shared streaming save core. Native-picker writes await every destination write before requesting more worker output; cancellation or storage failure aborts the partial writable. An explicit user cancellation terminates the worker session, while a destination write failure closes only that export stream so the indexed file can be retried. The fallback retains only its documented maximum in memory and refuses larger output instead of claiming an unbounded download will fit.

Hashing, file encoding, image processing, key generation and explorer jobs share the correlated worker runner: aborting or losing one worker rejects every request posted to that exact instance, detaches its listeners and makes the next run spawn a clean worker. Hash, encoding, CSV and JSONL readers also share one configurable `Blob.slice()` async iterator; it keeps one chunk in flight, reports absolute offsets and checks cancellation on both sides of each read.

Worker errors share a small resource taxonomy. Runtime allocation evidence is reported as `memory-exhausted`, terminates the affected worker and uses common localized guidance; it is never relabeled as a bad file. `invalid-format` and `corrupt-input` are emitted only where the parser or decoder provides specific evidence. Existing CSV, JSON, Parquet, PDF, image, QR, encoding and cryptography errors retain their more precise tool-specific messages when that evidence is available.

## Current Astro HTTP client and Windows companion

`http-client` uses the shared `src/scripts/local-agent.ts` browser client and
the independent Rust application in `apps/local-agent`; it does not use WASM
or a MyDevTools cloud proxy. `/{lang}/local-agent/` is a localized software
download page, not another tool registry entry.

The tool supports explicit pairing, HTTP methods, user-entered headers and
UTF-8 bodies, request timeout, optional redirects, cancellation, status/timing,
duplicate response headers, safe text preview and byte-exact body download.
Bounds are 1 MiB request body, 16 MiB response and 120 seconds. Text preview
shows at most 1 MiB; downloaded bytes are complete within the response limit.
No cookie jar, client-certificate UI, arbitrary process execution, filesystem
API or port/network scanner is provided.

Protocol `/v1`: `GET /info`, `POST /pair`, `DELETE /session`,
`POST /http/request`, `POST /http/cancel`, `POST /icmp/trace`,
`POST /icmp/snapshot`, `POST /icmp/cancel`, `POST /icmp/mtu`,
`GET /icmp/interfaces`, `POST /dns/lookup`, `POST /tcp/connect`, `POST /tls/inspect`, `POST /whois/lookup`. Pairing requests an explicit
non-empty subset of advertised capabilities. `http.request`, `icmp.trace`,
`dns.lookup`, `tcp.connect`, `tls.inspect` and `whois.lookup` are checked separately; a trace does not inherit HTTP permission,
and an HTTP session cannot start a trace, a DNS lookup, a TCP connect, a TLS inspect, or a WHOIS lookup. The browser asks for
the capability the open tool needs and keeps grants this browser already holds when the running agent
still advertises them. Session tokens are scoped to the pairing origin.
Future tools must introduce independently checked capabilities and routes
without inheriting HTTP or ICMP permissions. Host/Origin checks, one-time
pairing, session expiry and cancellation live in `server.rs`/`state.rs`;
outgoing HTTP and DNS pinning live in `http_client.rs`/`policy.rs`; ICMP
probes live in `icmp.rs`. The DNS lookup lives in `dns.rs` and asks the
operating-system resolver. The TCP connect lives in `tcp.rs`. The TLS inspect lives in `tls.rs`. The WHOIS lookup lives in `whois.rs`. The Windows tray/autostart shell stays separate.

`path-trace` is the ICMP page. One host or IP is resolved to the first
address and probed continuously until Stop. The user target follows
`--allow-private`; metadata, link-local and multicast targets stay denied.
Intermediate hop addresses, including a home gateway or CGNAT `100.64.0.0/10`,
are shown as path observations. The page stores recent targets and probe
settings in `mdt.path-trace.v1`. Hop results stay in memory. Each hop also
shows the sample standard deviation and the average jitter of reply
round-trip times, in tenths of a millisecond. A timeout is not a sample, and
both stay blank until a second reply. Find path MTU on the same page sends
Don't Fragment echoes and keeps the largest size that earns a reply, up to
1500 bytes. A lost probe is inconclusive. That result stays on the page and
is not stored. The search uses `icmp.trace` and takes one of the two ICMP
slots. A chosen source also reuses `icmp.trace`. `GET /icmp/interfaces`
lists this computer's own unicast addresses and does not take a slot. The
list is not a scan and not an ARP table. The saved address and interface
stay in `mdt.path-trace.v1`; hop rows and the MTU sentence do not. The
agent runs at most two of those operations at once, across every paired
session, and answers 429 `busy` past that cap. Each desktop window is its
own iframe and its own trace id; those windows share one paired session, so
disconnecting it stops every
trace on that session. The published Windows download is still the HTTP-only
build until a new agent binary is shipped; an older agent answers
`unsupported_capability`.

`dns-lookup` asks this computer's resolver for one name and one of A, AAAA,
CNAME, MX, NS, TXT, SOA or PTR. `POST /dns/lookup` requires `dns.lookup` and
does not take an ICMP slot. The agent runs at most four lookups at once. The
page stores the selected record type in `mdt.dns-lookup.v1`. The query name
and the answer stay on the page. Linux calls `res_query`. Windows `DnsQuery_A`
is written and was not compiled or run here. The published Windows download
is still the HTTP-only build.

`tcp-connect` opens one TCP connection to one host and one port, then closes
it without sending data. `POST /tcp/connect` requires `tcp.connect` and does
not take an ICMP slot or a DNS slot. The agent runs at most two connects at
once. A port range, a host list, and an extra `ports` field are rejected.
The page stores the timeout in `mdt.tcp-connect.v1`. The host, the port, and
the result stay on the page. The same connect path runs on every OS. It was
checked on Linux and was not run on Windows. The published Windows download
is still the HTTP-only build.

`tls-inspect` opens one TLS handshake to one host and one port, then closes
it without sending application data. `POST /tls/inspect` requires `tls.inspect`
and does not take an ICMP slot, a DNS slot, or a TCP slot. The agent runs at
most two inspections at once. A port range, a host list, and a pasted PEM are
rejected. Trust is a separate report: an untrusted chain is still shown. The
page stores the timeout in `mdt.tls-inspect.v1`. The host, the port, and the
chain stay on the page. The same handshake path runs on every OS. It was
checked on Linux and was not run on Windows. The published Windows download
is still the HTTP-only build. Pasted PEM parsing stays in `x509`.

`whois-lookup` sends one query line to one WHOIS server on TCP port 43, then
reads the reply and closes. `POST /whois/lookup` requires `whois.lookup` and
does not take an ICMP slot, a DNS slot, a TCP slot, or a TLS slot. The agent
runs at most two queries at once. A second line, a URL, a numeric range, and
a client-chosen port are rejected. A referral named inside the reply is shown
and is not opened. The reply is kept up to 64 KiB. The page stores the timeout
in `mdt.whois-lookup.v1`. The query, the server, and the reply stay on the page.
The same path runs on every OS. It was checked on Linux and was not run on
Windows. The published Windows download is still the HTTP-only build.

`asn-lookup` matches one address or one CIDR against a prefix snapshot stored
on this computer. `POST /asn/lookup` requires `asn.lookup` and does not take
an ICMP slot, a DNS slot, a TCP slot, a TLS slot, or a WHOIS slot. The agent
runs at most two lookups at once. The snapshot was taken from iptoasn.com on
2026-10-21 and is derived from RouteViews. The country column is not stored,
and ASN 0 rows are omitted. The lookup does not call a network API. A reserved
address and an unknown public prefix are results. More-specific prefixes inside
a short query are not listed, and the answer is not a path-trace column. There
is no settings key. The address and the result stay on the page. The same path
runs on every OS. It was checked on Linux and was not run on Windows. The
published Windows download is still the HTTP-only build.

`port-scanner` connects to many TCP ports of one host. `POST /v1/scan/ports`
requires `port.scan` and streams NDJSON lines: start, one line per port,
progress every 250 ms, then end or error. The request carries up to 1024 port
ranges, a timeout of 200 to 5000 ms per port and up to 64 connections at once.
Refused is closed, a timeout is filtered, no route is unreachable, and the
agent's own port is reported as denied without a connection. For up to 1024
ports every result is listed; above that only open ports are, with counts for
the rest. No data is sent and no banner is read. The host goes through the
same destination policy as the other tools. Stop calls `/v1/http/cancel`. The
page stores the preset, the custom list, the timeout and the parallel count in
`mdt.port-scanner.v1`. The host and the results stay on the page.

`network-scanner` finds hosts in one of this computer's own IPv4 networks.
`GET /v1/scan/networks` lists those networks (link-local dropped, wider than /22
narrowed to the /22 around the address) and `POST /v1/scan/network` scans a
CIDR from /22 to /32 that lies inside one of them; anything else is
`network_not_local` or `network_too_large`. Both require `network.scan`. The
network and broadcast addresses are skipped up to /30. Up to 32 addresses are
probed at once with one ICMP echo, TCP connects to up to 16 probe ports
(refused counts as alive) and an ARP lookup (Windows `SendARP`, Linux
`/proc/net/arp`), plus optional reverse DNS. Local networks are private, so the
scan needs local-network access turned on in the agent window. This
computer's own addresses are marked. The page stores the probe ports, the
timeout and the name-lookup setting in `mdt.network-scanner.v1`. The network
and the hosts stay on the page.

Both scanners share a limit of two scans per agent process. A scanner page
asks only for its own capability on top of what the session already holds, and
other tool pages do not request a scanner capability.

The browser persists the origin-bound bearer and its server-issued expiry in
versioned localStorage so navigation, reload and browser reopen do not require
another one-time pairing code. The code itself and responses are not stored.
Request drafts, including credentials explicitly entered in headers, are stored
separately in `mdt.http-workspace.v1` for the saved-request sidebar and restoration
of the selected request. Restore checks the local expiry and calls `/v1/info` to inspect the
agent and protocol; a transiently unavailable agent leaves the saved bearer
for a later retry. Blocked storage degrades to an in-memory session. Disconnect,
local expiry and an unauthorized protected response remove the saved record.
The native agent still owns the eight-hour session lifetime and keeps sessions
only in process memory, so an agent restart invalidates the bearer. Protocol v1
has no non-destructive authenticated validation route; after a restart the
first protected request detects the stale bearer and clears it.

Public destinations are allowed by default. `--allow-private` explicitly opts
into private/LAN/loopback targets but never cloud metadata, link-local addresses
or the agent itself. Redirects are revalidated, credential headers are removed
across origins, TLS verification stays enabled and HTTPS downgrades are rejected.
Network-specific NAT64 `/48` destinations are rejected because the translated
IPv4 address cannot be safely inferred from a suffix alone.

