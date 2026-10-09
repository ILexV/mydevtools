# Anonymous tool-operation analytics

## Release state

Implemented in the active Astro site and the separate Cloudflare ingestion Worker. Analytics is **off by default**. Neither the Worker nor GitHub Pages has been deployed for this change. Local HTTP/browser checks do not prove a real Analytics Engine write: Wrangler's local Analytics Engine binding is a no-op simulator.

**External release gate:** authenticate to the owner's Cloudflare account, obtain explicit staging/production deployment approval, record a staging event, and read it back through the private SQL API. Live zone routing, WAF/cache/CSP settings, account plan and billing are not inspectable without that access. Do not call the rollout complete before those checks.

## Architecture and contract

- `apps/site/src/registry/tools.ts` supplies stable slug-based `ToolId` types and the Worker allowlist. No translated labels, URLs, or independently maintained ID catalog.
- `apps/site/src/scripts/analytics/trackToolEvent.ts` is the central typed API. `instrumentation.ts` supplies an operation handle with at most one terminal event; the handle is in-memory operation state, **not** a visitor/session identifier.
- Controllers start a handle only for existing explicit processing after their local preflight. They complete/fail it after actual processing. No pageview, automatic typing/settings/init, clipboard, download, history, or per-chunk events.
- The browser POSTs exactly `{ "tool": "hash-calculator", "event": "tool_completed" }` to `/api/analytics/event`, at the origin root independently of Astro's deployment base. Fetch uses `credentials: omit`, `cache: no-store`, `referrerPolicy: no-referrer`, `redirect: error`, and a 3-second AbortController timeout. Nothing awaits telemetry; no retries, keepalive requirement, offline queue, background sync or persistent analytics state.
- `navigator.onLine === false`, Do Not Track (`"1"`) and Global Privacy Control (`true`) suppress requests without changing tool processing.
- `cloudflare/analytics-worker` owns only ingestion. Its production route is **only** `mydevtools.app/api/analytics/*`; no apex-wide route, `www` route, DNS/SSL change, processing service, public reporting/SQL endpoint or admin UI.
- Exact endpoint path, no query string, POST, JSON media type, unencoded UTF-8 body ≤512 bytes, exactly two string fields, no duplicate keys, and allowlisted IDs/events are required. Chunked requests are bounded too. Responses are empty and `Cache-Control: no-store`: 204 accepted; 400 invalid; 413 too large; 405 method with `Allow: POST`; 404 other path/query; 403 foreign browser source; 500 binding error.
- Production pins browser Origin to `https://mydevtools.app`; staging allows only its concrete request origin (`self`). `Sec-Fetch-Site`, if present, must be `same-origin`. CLI clients may omit both headers. These checks are defense-in-depth, **not authentication**; a sender can spoof/omit them.

### Metrics and cancellation

These are **operation counters**, not people, unique users or pageviews. An explicit rerun is another operation. One file/generator/hash/PDF batch is one launch, not one launch per item. A mixed-success hash/PDF batch fails if any attempted item fails; no per-item events.

Cancellation, AbortError/expected worker abort, camera permission denial/interruption, and superseded stale work do not emit failed. They may leave started without a terminal. Completed/failed requests can arrive out of order or be lost independently. Never treat their ratio as exact conversion or a transactional count. Camera scanning counts one user-started session and its first successful decode, not frames or normal no-result retries.

## Privacy data inventory

| Stored Analytics Engine dimension | Meaning |
| --- | --- |
| `blob1` | Allowlisted tool ID |
| `blob2` | `tool_started`, `tool_completed`, or `tool_failed` |
| `double1` | Constant `1` |
| `index1` | Same tool ID, for per-tool sampling locality |
| `timestamp` | Cloudflare server-side event timestamp |

No input text, file bytes/name/size, analyzed URL, token/key/password, error/stack, operation parameters, referrer/path, user metadata, cookies, IP, UA, geography, fingerprint, UUID, session or visitor ID enters the application dataset. The Worker does not read cookies or save network headers. It never logs request bodies, headers, validation errors or binding exceptions. Observability logs/invocation logs, traces, issues, Logpush and dependency instrumentation are disabled in Wrangler config; recheck dashboard overrides, Tail Workers and account-wide log exports before release.

Cloudflare necessarily processes network information to deliver/protect HTTP requests. An edge IP rate-limit counter is platform security state, not application analytics identity. Do not add fingerprint/cookie characteristics, or export endpoint request logs. If the privacy policy requires no network-metadata storage anywhere at the platform level, that is a separate Cloudflare account/log-retention review, not a claim this implementation can guarantee.

No analytics-specific notice was added to the UI while analytics remains off. Existing privacy labels in `common.json` and `home.json` were clarified in all ten languages: inputs and files stay in the browser, rather than promising that no HTTP data of any kind is sent. A truthful notice when enabling counters is: “The site collects anonymous counters of tool actions. File contents and entered data are not sent.” It must describe started/failed actions too, not promise that only successes are observed.

## Tool coverage matrix

`S/C/F` means started/completed/failed are supported **for the listed explicit action only**. All seven excluded tools keep their existing automatic UX; no artificial Run button was introduced. Success generally means the actual output/status is committed; failed means a launched processing exception, not a rejected preflight.

| Tool ID | Explicit action | S/C/F | Success / processing failure | Preflight and exclusions |
| --- | --- | --- | --- | --- |
| `base64-encoder` | Encode / Decode text or file | yes | Output/statistics/download result committed / non-abort processing error | No separate input preflight; file pick, typing, settings and swap excluded |
| `base32-encoder` | Encode / Decode text or file | yes | Output/statistics/result committed / non-abort processing error | Charset conversion and size caps before start; cancellation has no terminal |
| `base58-encoder` | Encode / Decode text or file | yes | Output/statistics/result committed / non-abort processing error | Charset and 1 MiB encode / 2,000,000-character decode caps before start |
| `hex-encoder` | Encode / Decode text or file | yes | Output/statistics/result committed / non-abort processing error | Charset conversion and configured caps before start |
| `url-encoder` | Encode / Decode | yes | Output/statistics committed / non-abort processing error | No separate validator; typing, example and swap excluded |
| `html-entity-encoder` | Encode / Decode | yes | Transform/output committed / transform or render exception | Mode/format read before start; typing/settings excluded |
| `json-beautifier` | Format; Ctrl/Cmd-Enter | yes | Formatted editor committed / malformed nonempty JSON | Empty input excluded; settings auto-format and file load excluded |
| `json-to-typescript` | Convert; Ctrl/Cmd-Enter | yes | Generated types committed / malformed nonempty JSON | Empty excluded; debounced input/name/options conversion excluded |
| `json-explorer` | File pick/drop; Process | yes | Worker session/table committed / malformed JSON/JSONL or open error | Missing/empty/oversized forced-JSON preflight excluded; cancel/stale has no terminal; filter/read/export excluded |
| `csv-explorer` | File pick/drop | yes | Parsed session/summary/table committed / parse/open error | Empty file excluded; delimiter/encoding/header reparses, filter/read/export excluded |
| `xml-beautifier` | Format; Ctrl/Cmd-Enter | yes | Formatted editor committed / malformed nonempty XML | Empty input excluded; settings auto-format and file load excluded |
| `yaml-beautifier-validator` | Format / Validate; Ctrl/Cmd-Enter | yes | Output/status committed / YAML or WASM error | Empty excluded; changed in-flight input has no terminal |
| `cron-generator` | Generate; Enter in fields | yes | Description/capsules/timeline committed / post-validation processing/render exception | `parseCron` validation before start; init/date-format changes excluded |
| `cron-parser` | Parse; Enter; preset that launches parsing | yes | Description/expanded fields/timeline committed / post-validation processing/render exception | Nonempty valid expression required; debounced typing/init/date-format changes excluded |
| `word-counter` | None | no | — | Automatic input/init counting only |
| `text-case-converter` | Case-transform button | yes | Transformed textarea committed / conversion/render exception | Existing trusted case choice; no separate input validator; example/clear excluded |
| `text-diff-viewer` | Compare | yes | Equal-input state or rendered diff committed / processing/library/render error | Both inputs empty excluded; file auto-compare/view rerender excluded; stale has no terminal |
| `jwt-decoder` | None | no | — | Decode and signature verification are live on token/secret input; no existing Verify button |
| `jwt-encoder` | None | no | — | Automatic signing on input/algorithm/init only |
| `regex-tester` | None | no | — | Debounced pattern/text/flags and example/saved-pattern computations only |
| `hash-calculator` | Calculate text or selected-file batch | yes | Every group succeeded / any group processing failure | At least one algorithm; reentrant launch excluded; compare/history/export excluded; cancellation has no terminal |
| `password-generator` | Generate | yes | Password/meter/history result committed / generation error | Enabled nonempty charset required; init/settings generation and history reads excluded |
| `hmac-calculator` | Calculate | yes | HMAC committed / active processing error | Nonempty key required; live key/message/algorithm work and example excluded; stale has no terminal |
| `aead-file` | Encrypt / Decrypt | yes | Blob/result committed / crypto/worker error, wrong password or corrupt container | File and password required; file pick/download excluded; cancel/stale has no terminal |
| `openssh-keys` | Generate / Import / Convert | yes | Generated/imported/converted key committed / launched key-processing error | Import/Convert require recognized nonempty format; file load only populates input; passphrase fallback counts once; cancel has no terminal |
| `x509` | Generate certificate / CSR; Parse | yes | Generated/parsed result committed / processing error or explicitly false CSR self-signature | Validity/SAN and nonempty parse preflight; example generation excluded; unsupported signature status is not failure; stale has no terminal |
| `uuid-generator` | Generate | yes | Whole UUID batch rendered / generation/render exception | Existing count normalization 1–100; one event pair per batch; count/settings/download excluded |
| `lorem-ipsum-generator` | Generate | yes | Output/statistics committed / generation/render exception | Existing normalized inputs; live settings/count/init recomputation excluded |
| `unit-converter` | None | no | — | Input/category/unit/swap/quick-choice automatic conversion only |
| `date-converter` | Convert / Now | yes | Formatted date/instant details committed / formatting/render exception | Nonempty valid parsed date required; typing/select/example/relative-time refresh excluded |
| `ip-subnet-calculator` | Calculate / Enter / calculating example; Split / Enter | yes | Network or subnet tables/diagram committed / real WASM processing error | Empty input, dependency-readiness failure and invalid split prefix excluded; malformed nonempty CIDR rejected by WASM counts failed |
| `color-converter` | Convert / Enter | yes | Formats/shades/swatch committed / render exception | `parseColor` succeeds before start; live picker/typing/contrast settings excluded |
| `markdown-preview` | None | no | — | Automatic input/toolbar/sample/init rendering only |
| `image-compressor` | Compress | yes | Compressed image/comparison committed / read/WASM/decode/output error | Selected image and idle state required; selection/quality/format excluded; cancel/stale has no terminal |
| `image-converter` | Convert | yes | Converted image/comparison committed / read/WASM/decode/output error | Selected image and idle state required; selection/settings excluded; cancel/stale has no terminal |
| `image-resizer` | Resize | yes | Resized image/comparison committed / read/WASM/decode/output error | Image dimensions and valid target size required; selection/ratio/automatic preview fallback excluded |
| `pdf-compressor` | Compress PDFs | yes | All attempted pending PDFs succeed / any attempted processing error | Nonempty pending queue and idle state; one lifecycle per batch; cancellation has no terminal |
| `pdf-merger` | Merge | yes | Merged PDF blob committed / file-read or merge error | At least two accepted PDFs and idle state; selection/order/download excluded |
| `pdf-to-text` | Extract Text | yes | All attempted pending PDFs succeed / any attempted extraction error | Nonempty pending queue and idle state; one lifecycle per batch; preview/copy/download excluded; cancel has no terminal |
| `qr-code-generator` | None | no | — | Live input/settings/style/color/logo/init generation only |
| `qr-scanner` | Image pick/drop; start camera | yes | Decoded file result or first successful camera decode / file decode failure or real frame-processing error | Image MIME or secure-context/camera-support preflight; no-result frames are not failures; permission denial, stop, interruption and supersession have no failure terminal |

## Local verification commands

From repository root, with generated WASM already available:

```sh
npm ci
npm run check:analytics
npm run test:analytics
npm run build:analytics             # Wrangler dry run; no infrastructure changes
npm run dev -w @mydevtools/analytics-worker -- --ip 127.0.0.1 --port 8787
```

Local HTTP smoke (a 204 validates ingestion, **not real dataset storage**):

```sh
curl -i http://127.0.0.1:8787/api/analytics/event \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://127.0.0.1:8787' \
  -H 'Sec-Fetch-Site: same-origin' \
  --data '{"tool":"hash-calculator","event":"tool_completed"}'
```

Test both compiled feature-flag states; the browser command must match its preceding build:

```sh
ANALYTICS_ENABLED=true npm run verify -w @mydevtools/site
ANALYTICS_ENABLED=true npm exec -- playwright test -c e2e/playwright.config.ts analytics.spec.ts --project chromium
ANALYTICS_ENABLED=false npm run build:site
ANALYTICS_ENABLED=false npm exec -- playwright test -c e2e/playwright.config.ts analytics.spec.ts --project chromium
```

Use `$env:ANALYTICS_ENABLED = 'true'` / `'false'` before the same commands in PowerShell. Browser regressions cover no pageview/input/settings/empty-preflight events, exact private payload/no cookies or referrer, explicit repeat success/error outcomes, 429/500, timeout, offline, DNT/GPC and disabled builds. Enabled-only cases are deliberately skipped for a disabled build.

## Owner-controlled Cloudflare setup

There is no existing GitHub Actions deploy pipeline in this repository; the Pages release remains local. New npm workspace scripts provide local check/test/dry-run/staging/production deploy commands. Do not add an automatic production-on-push workflow. If CI is later enabled, require a protected manually approved environment and scope its token to this account/zone; never reuse its deploy token for reporting.

1. Confirm account access, Analytics Engine availability/usage plan, a staging `workers.dev` subdomain, and that the canonical `mydevtools.app` DNS record is already proxied. **Do not edit A/CNAME, TLS/SSL, canonical redirects or proxy status.**

   Enable Analytics Engine for this account before deploying a dataset binding. Error `10089` means activation is missing; use the account-scoped dashboard URL in Wrangler's error. If the activation UI asks for a blank staging dataset, use dataset name `mydevtools_tool_usage_staging` and binding `TOOL_ANALYTICS`. A dataset does not appear in the dashboard until a bound Worker writes its first point.
2. Authenticate locally with `npm exec -w @mydevtools/analytics-worker -- wrangler login`, or supply `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from a password manager/protected environment. Do not put tokens in source, Astro `PUBLIC_*` variables, public assets, shell history or command output. Do not run with shell tracing.

   For remote SSH sessions, use `npm exec -w @mydevtools/analytics-worker -- wrangler login --device --browser=false`, or forward local port `8976` to the remote callback listener during the standard login. The port forward is not needed after login completes.
3. Scope deployment permissions to the selected account and `mydevtools.app` zone: Workers Scripts Edit for code/bindings; Workers Routes Edit and Zone Read for the production route. Staging has no zone route and does not need production route-edit rights. Use the official Edit Cloudflare Workers token template as a starting point, remove unused storage/service permissions, and review any permissions Wrangler requests for the selected account. The Worker itself has **no secret bindings or API token**.
4. Obtain owner approval, then deploy staging only:

   ```sh
   npm run deploy:staging -w @mydevtools/analytics-worker
   ```

   Record its returned HTTPS workers.dev origin in a local `STAGING_ORIGIN` variable. The staging binding is `mydevtools_tool_usage_staging`; its `routes: []` cannot capture production Pages traffic. Production dataset remains `mydevtools_tool_usage`.
5. Create a **separate read-only** token scoped to the selected account with `Account Analytics Read`, saved as local `ANALYTICS_READ_TOKEN` or in a reporting-only secret store, not in Wrangler/site config. Use `CLOUDFLARE_ACCOUNT_ID` only in the private operator shell. Read the staging SQL below, record a baseline if it already has data, then send one started and one completed request:

   A private env file may live at `$HOME/.config/mydevtools/analytics.env`, outside the repository, with directory mode `700` and file mode `600`. Store only `ANALYTICS_READ_TOKEN` there and load it explicitly in the private reporting process, for example with Node's `--env-file` option. It must not become a site/build variable or Worker binding; never print its contents.

   ```sh
   curl --fail-with-body -i "$STAGING_ORIGIN/api/analytics/event" \
     -H 'Content-Type: application/json' \
     --data '{"tool":"hash-calculator","event":"tool_started"}'
   curl --fail-with-body -i "$STAGING_ORIGIN/api/analytics/event" \
     -H 'Content-Type: application/json' \
     --data '{"tool":"hash-calculator","event":"tool_completed"}'
   ```

   Copy a single SQL statement below into a private local `query.sql`, then query it with:

   ```sh
   curl --fail-with-body \
     "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/analytics_engine/sql" \
     -H "Authorization: Bearer $ANALYTICS_READ_TOKEN" \
     --data-binary @query.sql
   ```

   Allow for ingestion visibility delay; confirm the same tool and **+1 per event versus baseline**, not merely a 204 or nonempty table. Check `_sample_interval`; this small smoke should be unsampled. Live staging was verified on 2026-10-09: `hash-calculator` started increased from 1 to 2 and completed from 0 to 1, with `_sample_interval = 1`. Both writes returned 204 with `Cache-Control: no-store`; their stored points were visible about two minutes after submission, not within the initial 36-second readback window. Eight malformed/disallowed requests returned the expected 400/403/404/405/413 responses.
6. Before production, review **Security → Security rules → Rate limiting rules**. On Free, the supported filter is the exact path (`http.request.uri.path eq "/api/analytics/event"`); on plans supporting hostname add `http.host eq "mydevtools.app"`. Start with **30 requests / 10 seconds**, **10-second block**, edge IP counting only. A normal operation uses two requests. Prefer a 429 response when the plan supports custom responses. Reassess legitimate shared-NAT/batch usage from aggregate metrics; blocked telemetry must never block tool processing. Do not use cookies, fingerprint fields, application IDs or request-body logging. Free has one rule and a 10-second period; verify current entitlements and whether that rule is already used before changing anything. WAF rollout is an explicit owner action, not performed by these scripts.
7. In **Caching → Cache Rules**, add/review an exact canonical-host `/api/analytics/*` **Bypass cache** exception with effective precedence over broader cache rules. POST is not cached by the app/Worker, but account overrides must still be checked. Review Workers Observability/Logpush/Tail/export settings for this Worker and any endpoint logs. Confirm a deployed CSP, if present, permits `connect-src 'self'`; no external analytics script or origin is needed.
8. Obtain owner approval, then deploy production:

   ```sh
   npm run deploy -w @mydevtools/analytics-worker
   ```

   In **Workers & Pages → mydevtools-analytics → Settings → Domains & Routes**, verify exactly `mydevtools.app/api/analytics/*`, no `mydevtools.app/*`, no `www`/custom domain or production workers.dev/preview URL. Test valid/invalid ingest and a private production readback, then verify `/`, `/en/`, `/ru/hash-calculator/`, `/_astro/...`, `/sw.js`, HTTPS and canonical redirects still reach the normal Pages site.
9. Only after successful live Worker write/read, opt into the static client build and separately approve Pages publication:

   ```sh
   ANALYTICS_ENABLED=true npm run build:pages
   npm run preview:site
   npm run deploy:pages             # dry run
   npm run deploy:pages -- --push   # only with owner approval
   ```

   Fresh-browser live smoke: no requests for pageview/typing; one started and terminal for a real action; read back the corresponding increments; verify a locally computed result with telemetry blocked. Test en/ru, both themes, language switcher and 375px without horizontal overflow.

### Production rollout verification — 2026-10-09

- The owner confirmed the edge rate-limit and cache-bypass rules were configured and explicitly approved both production deployments. The available Wrangler OAuth credential could not read DNS/WAF/cache-rule settings, so those owner-controlled rules were not independently audited. DNS, TLS/SSL and canonical redirects were not changed.
- Production Worker `mydevtools-analytics`, version `52bebdb4-fd0c-47de-9e70-64e57c126739`, was deployed with the sole route `mydevtools.app/api/analytics/*` and `TOOL_ANALYTICS` bound to `mydevtools_tool_usage`. The deployed metadata confirmed no production workers.dev/preview URL, no tail consumers and `logpush: false`; the source configuration disables observability and contains no secret binding.
- Pages was built with `ANALYTICS_ENABLED=true` and published as gh-pages commit `12a3b1c`. All 11 WASM domains were rebuilt; Worker checks and 14 tests passed, and site verification passed with 383 unit tests, 424 built pages and 8 dist smoke tests. Astro reported no errors/warnings, with one existing `execCommand` deprecation hint; i18n retained one existing German UUID-title warning.
- Live browser checks covered JSON formatting and an intentional malformed-JSON failure, SHA-256 of the three-byte file `abc`, and repeated image compression. The image smoke produced a real 96×64 JPEG of 4,913 bytes from a 96×64 PNG of 18,614 bytes. English/Russian routes, the language switcher, both themes and 375px layout were exercised. Computation also succeeded on the local built site when its analytics endpoint returned 404.
- Pageviews, typing and settings changes sent no events. Actual DNT `1` and GPC `true` browser contexts suppressed telemetry while formatting still worked. Accepted requests contained only `tool` and `event`, with no cookies, referrer or tool input. Private production SQL matched every expected increment with `_sample_interval = 1`; the rollout deliberately left **18 synthetic events: 9 started, 8 completed and 1 failed**. These calibration operations, including the intentional parse failure, are included in reports.
- Every production report below returned HTTP 200. Public Pages routes, the WASM asset, manifest, sitemap, offline page, 404 and trailing-slash canonical redirect remained functional. The PWA's real **Update Now** action activated service-worker release `5fba5f2b`, removed the old precache and generated no analytics requests.

Chromium diagnostics sometimes marked the sender's discarded empty 204 responses as `requestfailed` / `net::ERR_ABORTED` after the actual `fetch` promises had fulfilled successfully with status 204. Instrumentation confirmed a non-null response stream; diagnostic requests that consumed the empty body completed without that marker. There were no page/console exceptions, and private SQL confirmed the exact counters. Do not treat this marker alone as lost telemetry; [MDN documents the non-null body behavior for no-body responses](https://developer.mozilla.org/en-US/docs/Web/API/Response/body#value). No transport change was made merely to suppress the diagnostic.

Future releases must still opt in with `ANALYTICS_ENABLED=true`; an unflagged build deliberately disables the client again.


### Retention, sampling, limits and monitoring

Analytics Engine retains events for **three months**, not necessarily 90 complete days. No D1/long-term archive is included. `index1 = toolId` localizes platform sampling to a busy tool; do not change dimension order or index semantics after release without a dataset migration.

There is no application sampling. Cloudflare can sample on write/read at high volume: use `SUM(_sample_interval * double1)` and mark estimates when `_sample_interval > 1`; do not promise exact global counts or conceal platform sampling. Started+terminal means roughly two Worker requests/data points per normal operation, plus rejected/spoofed ingestion traffic.

Official docs checked 2026-10-09 list Workers Free 100,000 requests/day and 10 ms CPU/request; Paid starts at $5/month, with 10 million requests/month then $0.30/million. Analytics Engine lists Free 100,000 data points and 10,000 read queries/day; Paid 10 million writes/month then $0.25/million, 1 million read queries/month then $1/million. Its pricing page currently says billing is not yet enabled: **recheck actual plan/billing before release**, not a guarantee of free usage. Engine API limits are 20 blobs, 20 doubles, one ≤96-byte index, 16 KB total blobs, and 250 points/invocation; this Worker writes one tiny point.

Monitor Workers request/error/CPU totals and Analytics Engine writes/queries in the private account dashboard. Set account spending/usage alerts where supported; review budget before raising edge thresholds. Do not enable raw request logs to debug counters. Without visitor identification, authenticated ingestion or absolute rate enforcement, bots can inflate counts; Origin checks and edge limiting do not make them fraud-proof.

## Private SQL reports

These use the **Workers Analytics Engine SQL API** (`.../analytics_engine/sql`), not the newer Analytics SQL API/binding and its `events.analyticsEngine.*` table namespace. No reporting Worker/binding/token is shipped to the browser. Syntax and column names below match the official SQL reference; **live staging and production write/readback, plus all production report queries, were verified on 2026-10-09**. Submit one statement at a time. The 90-day query can only return retained data, bounded by three calendar months.

### Staging write/read verification

```sql
SELECT blob1 AS tool, blob2 AS event,
       SUM(_sample_interval * double1) AS operations,
       MAX(_sample_interval) AS maximum_sample_interval
FROM mydevtools_tool_usage_staging
WHERE timestamp >= NOW() - INTERVAL '1' DAY
  AND blob1 = 'hash-calculator'
GROUP BY blob1, blob2
ORDER BY event
```

### Top successfully completed tools: 7 days

```sql
SELECT blob1 AS tool, SUM(_sample_interval * double1) AS completed_operations,
       MAX(_sample_interval) AS maximum_sample_interval
FROM mydevtools_tool_usage
WHERE timestamp >= NOW() - INTERVAL '7' DAY AND blob2 = 'tool_completed'
GROUP BY blob1
ORDER BY completed_operations DESC
LIMIT 41
```

### Top successfully completed tools: 30 days

```sql
SELECT blob1 AS tool, SUM(_sample_interval * double1) AS completed_operations,
       MAX(_sample_interval) AS maximum_sample_interval
FROM mydevtools_tool_usage
WHERE timestamp >= NOW() - INTERVAL '30' DAY AND blob2 = 'tool_completed'
GROUP BY blob1
ORDER BY completed_operations DESC
LIMIT 41
```

### Top successfully completed tools: 90 days, within retention

```sql
SELECT blob1 AS tool, SUM(_sample_interval * double1) AS completed_operations,
       MAX(_sample_interval) AS maximum_sample_interval
FROM mydevtools_tool_usage
WHERE timestamp >= NOW() - INTERVAL '90' DAY AND blob2 = 'tool_completed'
GROUP BY blob1
ORDER BY completed_operations DESC
LIMIT 41
```

### Started/completed/failed by tool: 30 days

```sql
SELECT blob1 AS tool, blob2 AS event,
       SUM(_sample_interval * double1) AS operations,
       MAX(_sample_interval) AS maximum_sample_interval
FROM mydevtools_tool_usage
WHERE timestamp >= NOW() - INTERVAL '30' DAY
GROUP BY blob1, blob2
ORDER BY tool, event
```

### Daily operations by event, UTC: 90 days

```sql
SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day,
       blob2 AS event, SUM(_sample_interval * double1) AS operations,
       MAX(_sample_interval) AS maximum_sample_interval
FROM mydevtools_tool_usage
WHERE timestamp >= NOW() - INTERVAL '90' DAY
GROUP BY day, blob2
ORDER BY day, event
```

Keep events separated: summing started and completed together double-counts successful launches, not useful “total operations”.

### Processing errors by tool: 30 days

```sql
SELECT blob1 AS tool, SUM(_sample_interval * double1) AS failed_operations,
       MAX(_sample_interval) AS maximum_sample_interval
FROM mydevtools_tool_usage
WHERE timestamp >= NOW() - INTERVAL '30' DAY AND blob2 = 'tool_failed'
GROUP BY blob1
ORDER BY failed_operations DESC
LIMIT 41
```

## Rollback

1. Immediate ingest stop: remove/disable **only** `mydevtools.app/api/analytics/*` in the Worker Domains & Routes dashboard. Keep all DNS/HTTPS/Pages configuration unchanged. Already enabled clients may lose telemetry/receive 404, but tools still compute locally.
2. Client stop: rebuild with `ANALYTICS_ENABLED=false` and publish the static site with owner approval. Accept the normal service-worker update/hard refresh so older clients are replaced. No telemetry queue exists to replay later.
3. Keep the previous Wrangler deployment/config for a code rollback if needed; do not mutate event dimensions or delete datasets to “fix” a failed release. Staging and production datasets are separate. Remove only the analytics-specific WAF/cache rules if reverting their setup is approved.

## Official references

- [Analytics Engine setup and private read token](https://developers.cloudflare.com/analytics/analytics-engine/get-started/)
- [SQL API columns and platform sampling](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)
- [SQL reference](https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/), [date/time functions](https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/date-time-functions/)
- [Retention and limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/), [Analytics Engine pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Worker routes](https://developers.cloudflare.com/workers/configuration/routing/routes/), [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Observability/invocation logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/), [rate-limit plan availability](https://developers.cloudflare.com/waf/rate-limiting-rules/), [cache-rule setup](https://developers.cloudflare.com/cache/how-to/cache-rules/create-dashboard/)
- [Scoped deploy tokens and protected CI secrets](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Remote SSH login without a localhost callback](https://developers.cloudflare.com/changelog/post/2026-08-04-wrangler-login-device-flow/)
