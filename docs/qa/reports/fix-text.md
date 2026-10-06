# Отчёт агента `fix-text` — группа text: исправления открытых пунктов + SEO-тексты

Дата: 2026-10-06 (UTC+6). Dev-сервер `http://localhost:3312/mydevtools/`, Chromium (Playwright). Ничего не коммитил.
Инструменты: word-counter, text-case-converter, text-diff-viewer, regex-tester, jwt-decoder, jwt-encoder, markdown-preview.

## A. Исправления

| # | Инструмент | Проблема | Исправление | Доказательство |
| --- | --- | --- | --- | --- |
| 1 | regex-tester | В `forced-colors` UA красил textarea непрозрачным Canvas → подсветка совпадений не видна | В `@media (forced-colors: active)` слои textarea/backdrop выведены из forced colors (`forced-color-adjust: none`) только на системных цветах (Canvas/CanvasText/GrayText/Highlight); совпадение = `outline 2px Highlight` + подчёркивание 3px Highlight без заливки (текст CanvasText остаётся читаемым); фокус — граница + inset-тень Highlight (метрики слоёв не меняются) | Playwright `forcedColors: "active"`, light+dark: фон textarea `transparent`, 4 `mark` с outline/underline Highlight; скриншоты `regex-forced-{light,dark}.png`; обычный режим без изменений |
| 2 | markdown-preview | `# h1` пользователя/примера → второй `h1` в outline страницы | Новый `demoteHeadings()` (`markdown-sanitize.ts`): в превью h1→h2 … h5→h6, h6→`div role=heading aria-level=7`, класс `md-hN` сохраняет визуальный размер исходного уровня (CSS переписан на `.md-hN`). **Copy HTML / Download HTML отдают исходные уровни** (`exportHtml` — санитизированный HTML до понижения) | На странице 1 `h1` (en 1440 light, ru 375 dark); превью `H2.md-h1 … div[aria-level=7].md-h6`; буфер Copy HTML = `<h1>A</h1><h2>B</h2><h6>F</h6>`; тест `previewHeadingLevel` |
| 3 | jwt-decoder | Ключи header/payload сортировались по алфавиту (serde `BTreeMap` в WASM `jwt_decode`) | Декодирование перенесено в TS: `decodeJwt()` в `jwt.ts` (base64url без padding строго, UTF-8 fatal, не-JSON → JSON-строка — контракт legacy WASM) + `reindentJson()` — переотступ токенов без parse→stringify: сохраняются порядок ключей (в т.ч. целочисленных `"2"`,`"1"`), дубликаты, запись чисел (`12345678901234567890`, `1.10` без потери точности). WASM остаётся только для проверки подписи. Крейт `cryptography` не трогал | Браузер: `{"typ","alg","kid"}` и `{"sub","name","iat","admin"}` в исходном порядке; 2 новых теста в `jwt.test.ts` |
| 4 | regex-tester | Флажок **Global** ничего не делал (движок всегда отдаёт все совпадения) | `applyGlobalFlag()` в `regex-tester-core.ts`: без `g` показывается/подсвечивается только первое совпадение | `\d+` на `order 42, room 7` без g → счётчик `1`, 1 mark; тест |
| 5 | text-diff-viewer | Автосравнение после загрузки файлов брало сырой текст (CRLF), а ручное «Сравнить» — значение textarea (LF) → CRLF-файл vs LF-файл давал «все строки изменены» только при автосравнении | После `area.value = text` берётся `area.value` (нормализовано) | `setInputFiles` CRLF+LF → «The texts are identical» |
| 6 | jwt-decoder | Подпись поля «Secret / **Private Key**» во всех 10 локалях — неверно: для RS* нужен **открытый** ключ; плейсхолдер про «секретный ключ» | `SecretLabel` → «Secret / RSA public key» (×10), `SecretPlaceholder` → «HS*: shared secret · RS*: PEM public key» (×10) | — |
| 7 | i18n | Мелкие дефекты UI-строк | ru/es `DecodedHeaderLabel/PayloadLabel` «(Decoded)» → «(Header)/(Payload)»; ru/es `SyncScroll` не переведён → «Синхронная прокрутка»/«Sincronizar desplazamiento»; es `SignatureLabel` опечатка «Veriricar» → «Verificar Firma» | validate:i18n 0 ошибок |
| 8 | markdown-preview | Пример-документ обещал «Code syntax highlighting», которой нет | Строка → «Fenced code blocks (no syntax highlighting)»; обновлены doc-комментарии (старый говорил «No sanitization») | скриншот `md-preview-en-1440-light.png` |

### Осознанно оставлено
- **regex-tester, флажок `u`:** в Rust Unicode включён всегда; снятие `u` ничего не меняет. Маппинг на `(?-u)` ломает `.` (ошибка «pattern can match invalid UTF-8», проверено), поэтому не делал; честно описано в SEO. Варианты для владельца: убрать флажок `u` из UI или сделать его disabled+checked с подсказкой.
- **Нейтральный алерт** (`ds-alert-neutral`) и **scrim для `<dialog>::backdrop`** — общий слой (`tool-ui.css`/`global.css`), вне моей зоны; остаются локальные обходы (`.jwtd-status.is-neutral`, цвет в `RegexTester.astro`).
- `registry/tools.ts` для text-case-converter уже `wasm: null` — пункт закрыт кем-то ранее.
- markdown-preview: относительные `<img src>` дают 404 к сайту — допустимо, упомянуто в SEO-советах.

## B. SEO-тексты (7 инструментов × 10 локалей)

Переписаны `Description`, `Keywords`, `Seo_Introduction`, `Seo_DetailedDescription`, `Seo_Examples`, `Seo_HowToSteps`, `Seo_Tips` (Title не менялись). Сначала en, затем естественные переводы ru/es/de/pt/zh/fr/ja/ko/hi; код-спаны побайтно как в en, названия кнопок/полей — точно из UI каждой локали, формат шагов по локали (`Шаг N:`, `步骤1：`, `1단계:`, `Étape N :`, `चरण N:` …).

Что по существу (вода «comprehensive/modern web technologies/файлы/настройки сохраняются» удалена; раньше 5 из 7 текстов были шаблонными и ложно обещали WASM, загрузку файлов, сохранение настроек и прогресс):
- **word-counter** — графемы (эмодзи = 1), `Intl.Segmenter` для китайского/японского, правила строк/абзацев/предложений, 200/130 слов в минуту; подводные камни: `2.0`/`e.g.` дробят предложения, тайский не сегментируется. Без WASM.
- **text-case-converter** — 9 регистров, правила границ слов (акронимы, цифры), сохранение переводов строк; честно: UPPER/lower/Title заменяют `_`/`-` пробелами (`user_id` → `USER ID`), `iPhone` → `i_phone`, Title Case без исключений. Чистый TS.
- **text-diff-viewer** — построчный jsdiff + diff2html, 4 строки контекста, подсветка слов, файлы UTF-8, нормализация CRLF, лимит 1000 изменённых строк. Без WASM.
- **regex-tester** — Rust `regex` в WASM: нет look-around и обратных ссылок (точный текст ошибки), линейное время, Unicode всегда включён, позиции UTF-16, 50 в списке / 10 000 максимум, localStorage только по «Сохранить шаблон».
- **jwt-decoder** — порядок claims, `Bearer`, exp/nbf/iat в локальном поясе, HS*/RS* (PEM SPKI/PKCS#1), ES*/PS*/EdDSA не проверяются, `alg: none` никогда не «валиден».
- **jwt-encoder** — только HS256/384/512, секрет как UTF-8, порядок и `kid` сохраняются, `alg` подменяется, пустой секрет всё равно подписывает, `exp` в секундах.
- **markdown-preview** — marked + GFM (таблицы, task list, `~~`, автоссылки), `breaks` → `<br>`, без подсветки синтаксиса, санитизация, понижение заголовков в превью, экспорт.

Все примеры прогнаны в инструментах (Playwright), напр.: jwt.io-вектор → `…SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c` и «Signature Verified»; `(?<year>\d{4})-…` → 2 совпадения, `[9-19]`; `foo(?=bar)` → ошибка look-around; `getHTTPResponse code` → `get_http_response_code`; `👍 café` → 2 слова / 6 символов; 20 строк с одной правкой → hunk `@@ -7,9 +7,9 @@`; `<script>…<b onclick=x>hi</b>` → `<b>hi</b>`.

Попутно: `Seo_Introduction` рендерится как простой текст (не markdown) — убраны backticks из интро regex во всех локалях.

## Проверка

- `node --test` (под `flock`): jwt, markdown-sanitize, regex-tester, word-stats, text-case — **52/52 ✅** (новые: 2 decodeJwt, 1 previewHeadingLevel, 1 applyGlobalFlag).
- `astro check` (под `flock`): **0 ошибок** (245 файлов).
- `validate:i18n` (под `flock`): **0 ошибок**, 1 чужое предупреждение (de uuid-generator Title).
- Браузерный прогон: 7 инструментов × en/ru/ja/hi × light/dark × 1440/375 = 112 страниц: ровно 1 `h1`, без горизонтального скролла, SEO-блок есть, число `h3` в HowTo = числу шагов HowTo JSON-LD, 0 ошибок/предупреждений консоли; сырые `**`/`` ` `` в тексте — 0 (после правки интро). Шрифты ja/hi отображаются (скриншоты `*-ja-dark-375-seo.png`, `*-hi-dark-375-seo.png`).
- Forced colors (item 1): эмуляция `forcedColors: "active"` light+dark.
- Cargo не запускал: Rust-код не менялся.

Скриншоты/скрипты: `/tmp/claude-1001/-home-lex-github-mydevtools/3051f920-6aff-44cf-91a3-0734cea3fd9a/scratchpad/fix-text/` (`fixes.mjs`, `examples.mjs`, `sweep.mjs`, `sweep.json`, `shots/`, `seo-<lang>.json`, `apply.py`).

## Изменённые файлы

- `apps/site/src/tools/RegexTester.astro`, `regex-tester.client.ts`, `regex-tester-core.ts`
- `apps/site/src/tools/MarkdownPreview.astro`, `markdown-preview.client.ts`, `markdown-sanitize.ts`
- `apps/site/src/tools/JwtDecoder.astro`, `jwt-decoder.client.ts`, `jwt.ts`
- `apps/site/src/tools/text-diff-viewer.client.ts`
- `apps/site/test/{jwt,markdown-sanitize,regex-tester}.test.ts`
- `apps/site/src/i18n/locales/*/tools/{word-counter,text-case-converter,text-diff-viewer,regex-tester,jwt-decoder,jwt-encoder,markdown-preview}.json` (70 файлов)

## Открытые вопросы

1. Флажок `u` в regex-tester ничего не делает (см. выше) — нужно решение владельца по UI.
2. Общий слой: `ds-alert-neutral`, правило `.ds-dialog::backdrop` / токен `--mdt-scrim` (запросы из прошлого отчёта остаются).
3. WASM `jwt_decode` в `cryptography` больше не используется jwt-декодером; удалять экспорт не стал (крейт меняет `fix-crypto`).
4. Description для ja/ko местами 100–108 символов (длиннее типичных для CJK ≈60–90, но < 160).
