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
