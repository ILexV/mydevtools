# QA-отчёт: группа `text` (агент `qa-text`)

Дата: 2026-10-06, завершено 12:45 (UTC+6). Dev-сервер `http://localhost:3312/mydevtools/` (общий, HMR), Chromium (Playwright).
Инструменты: word-counter, text-case-converter, text-diff-viewer, regex-tester, jwt-decoder, jwt-encoder, markdown-preview.

## Сводка по чек-листу

| Инструмент | 1 Консист. | 2 Функционал | 3 Граничные | 4 Визуал | 5 Локализация | 6 Консоль/сеть | 7 Тесты | 8 Доступность |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| word-counter | ✅ ds-card/ds-btn/Field/StatusMessage, локальных кнопок/полей нет | ✅ paste/copy/clear, live-статистика | ✅ пусто, 1 МБ (≈1 с), эмодзи/ZWJ, CJK, RTL, CRLF | ✅ light/dark × 1440/375, без h-scroll | ✅ en/ru/de/ja | ✅ 0 ошибок, без WASM, без внешних | ✅ `word-stats.test.ts` (9) | ✅ label, ошибки clipboard в `role=alert` |
| text-case-converter | ✅ ds-btn-сетка, ds-field-textarea | ✅ 9 преобразований in-place, copy/clear | ✅ пусто, кириллица, ß, эмодзи, CJK, \n/\t | ✅ | ✅ (de «CamelCase» — термин) | ✅ без WASM (чистый TS) | ✅ `text-case.test.ts` (18, вкл. закреплённую legacy-причуду) | ✅ label, группа кнопок с `aria-label` |
| text-diff-viewer | ✅ ds-card/ds-btn/ds-radio, статусы — StatusMessage | ✅ compare/clear/file/line↔side/auto-diff | ✅ пусто, идентичные, HTML в тексте экранирован, 5000 строк | ✅ diff читается в обеих темах | ✅ | ✅ jsdiff/diff2html только с `/lib`, без внешних | ⚠️ логика в вендорных либах; покрыто браузером | ✅ label `for`, legend, кнопки файлов с клавиатуры |
| regex-tester | ✅ ds-card/ds-btn/ds-icon-btn/ds-check/ds-dialog/ds-alert/ds-empty | ✅ live, флаги, группы, примеры, save/load/delete | ✅ невалидный, `(a+)+$` на 100k, кап 10 000, Unicode-подсветка, битый localStorage | ✅ | ✅ | ✅ WASM только `regex_tool` | ✅ Rust 11 + TS 8 | ✅ aria-invalid, `role=alert`, aria-live на счётчике, dialog с label |
| jwt-decoder | ✅ ds-card/Field-классы/ds-badge/ds-alert | ✅ decode, verify HS*/RS*, exp/nbf/iat | ✅ мусор, 2 части, `alg:none`, ES256, истёкший, `Bearer`+переносы | ✅ | ✅ | ✅ WASM только `cryptography` | ✅ Rust 6 (jwt) + TS 8 | ✅ labels, aria-invalid, статус `role=status` |
| jwt-encoder | ✅ ds-field-select/ds-hint-error/ds-output | ✅ live-подпись HS256/384/512, copy | ✅ `null`/`[]`/`123`/битый JSON, Unicode | ✅ | ✅ | ✅ WASM только `cryptography` | ✅ вектор jwt.io (TS+Rust) | ✅ labels, aria-invalid + aria-describedby |
| markdown-preview | ✅ ds-icon-btn тулбар, ds-check, ds-btn, StatusMessage | ✅ рендер, тулбар, sync-scroll, copy HTML/MD, download | ✅ **XSS санитизирован** (12 векторов), длинный code переносится | ✅ | ✅ | ✅ marked только с `/lib`, без WASM | ✅ `markdown-sanitize.test.ts` (5) + браузер | ✅ toolbar group с именем, preview `role=region` |

Браузер: функциональный прогон — **104/104** проверок ✅ (`func.json`); визуал 7×2 темы×2 ширины — 0 переполнений, 0 ошибок консоли, 0 внешних запросов, фокус-кольцо есть (`visual.json`); локализация 7×ru/de/ja×1440/375 — 0 переполнений, непереведённых ключей нет (`i18n.json`); a11y — 0 кнопок без имени, 0 полей без label, Tab-обход: кольцо фокуса на каждом элементе (у поля паттерна regex кольцо на обёртке `:focus-within`).

## Найденные и исправленные баги

1. **markdown-preview: XSS.** Вывод marked вставлялся `innerHTML` без санитизации — `<img onerror>`, `<script>`, `javascript:`-ссылки, `<iframe>`, `<svg>`, `style`/`class` (UI-redress классами `ds-*`) исполнялись/применялись. Добавлен allowlist-санитайзер `src/tools/markdown-sanitize.ts` (inert `<template>`, drop/unwrap, фильтр атрибутов, схемы URL, ссылки → `target=_blank rel=noopener noreferrer nofollow`). Copy HTML и Download отдают уже очищенный HTML. Осознанное отличие от legacy.
2. **regex-tester: подсветка «уезжала» на не-ASCII.** Rust отдавал байтовые смещения UTF-8, JS резал строку по UTF-16 → на кириллице/эмодзи/CJK подсвечивались не те символы, позиции `[start-end]` неверны. В `wasm/regex_tool` смещения переводятся в UTF-16 (линейно), байндинги пересобраны.
3. **regex-tester: зависание на огромном числе совпадений.** `.`/`a` по большому тексту сериализовал миллионы объектов. Кап 10 000 совпадений + флаг `truncated` (счётчик «10000+»).
4. **regex-tester: стили runtime-DOM не применялись.** Кнопки load/delete (`.rx-icon-btn`), иконки, `.rx-empty`/`.rx-error` создавались контроллером, а scoped-стили на них не действуют — кнопки были без оформления. Переведено на `ds-icon-btn`/`ds-empty`/`ds-alert`, SVG с явным размером, у кнопок имя «Загрузить: <имя>».
5. **regex-tester:** `localStorage.setItem` без try/catch (падение в приватном режиме) → локализованная ошибка; «WASM Error:» не локализовано → ключ `EngineError`; диалог сохранения — `<form method=dialog>`, label, `required`, пустой паттерн не сохраняется.
6. **jwt-encoder: терялись поля заголовка и порядок claims.** WASM `jwt_sign` десериализует header в `{typ, alg}` — `kid`/`cty` пропадали, при отсутствии `typ` писалось `"typ":null`, payload пересортировывался. Теперь сегменты строит `src/tools/jwt.ts` (порядок и поля сохраняются, `alg` подменяется на месте), подпись — новая WASM-функция `jwt_sign_input` (добавление в крейт `cryptography`). Выход совпадает с эталоном jwt.io.
7. **jwt-encoder: падение на `null`.** Header `null` → `TypeError` (необработанный reject); массив/число давали англоязычную ошибку WASM. Теперь header и payload обязаны быть JSON-объектами, ошибки по каждому полю независимо (`aria-invalid`), ключ `MustBeObject`.
8. **jwt-encoder:** захардкоженный английский заголовок «Signature» → ключ `SignatureLabel`; у textarea не было label.
9. **jwt-decoder: ссылка на энкодер без base-пути** (`/${lang}/jwt-encoder` → 404 на Pages) → `localizedPath()`.
10. **jwt-decoder: статус.** `alg: none` и неподдерживаемые алгоритмы показывались просто «Invalid»; пустой секрет — тоже «Invalid». Теперь: unsigned-предупреждение для `none` (никогда «verified»), «{alg} не поддерживается» для ES*/PS*/EdDSA, нейтральная подсказка при пустом секрете. Ошибки декодирования локализованы (`InvalidToken`). Токен нормализуется (`Bearer `, пробелы/переносы). Показ `exp/nbf/iat` с пометкой «Истёк»/«Ещё не действует». Иконка статуса (runtime SVG) раньше не получала размер.
11. **jwt-decoder:** подпись поля ввода была «Generated JWT» → новый ключ `TokenLabel` («Закодированный JWT»).
12. **text-diff-viewer: заморозка вкладки.** 5000 строк с 1667 правками — jsdiff 13 с на главном потоке, после чего diff2html всё равно писал «Diff too big». Введён `maxEditLength = 1000` (= `diffMaxChanges`) → ~0,5 с и локализованное сообщение `DiffTooBig`.
13. **text-diff-viewer:** идентичные тексты → пустой diff с англ. «File without changes» → локализованное `NoDifferences`; скрыт вводящий в заблуждение тег diff2html «RENAMED» и англоязычный «Viewed»; ошибка чтения файла (`FileReadError`); повторный выбор того же файла снова срабатывает; алерты вынесены из области diff в `StatusMessage`.
14. **text-diff-viewer, markdown-preview: вечное ожидание после сбоя загрузки скрипта** — неудачный `<script>` оставался в DOM, повтор ждал `load`, которого не будет. Тег удаляется при ошибке; markdown повторяет загрузку marked при следующем вводе.
15. **word-counter:** символы считались в UTF-16 (👍 = 2, 👨‍👩‍👧‍👦 = 11) → графемы через `Intl.Segmenter`; японский/китайский текст без пробелов считался одним словом → сегментация слов; `。！？…` завершают предложения; строки из одной пунктуации («...») не считаются предложениями; числа форматируются по локали. Ошибки clipboard (copy/paste) теперь видны (`CopyFailed`/`PasteFailed`), раньше глотались.
16. **text-case-converter:** ошибка clipboard глоталась → `CopyFailed`; у textarea не было label.

## Изменённые / новые файлы

- Разметка + контроллеры: `apps/site/src/tools/{WordCounter,TextCaseConverter,TextDiffViewer,RegexTester,JwtDecoder,JwtEncoder,MarkdownPreview}.astro`, `…/{word-counter,text-case-converter,text-diff-viewer,regex-tester,jwt-decoder,jwt-encoder,markdown-preview}.client.ts`.
- Новые чистые модули: `src/tools/word-stats.ts`, `src/tools/regex-tester-core.ts`, `src/tools/jwt.ts`, `src/tools/markdown-sanitize.ts`.
- WASM: `wasm/regex_tool/src/lib.rs` (чистая `run_regex`, UTF-16, кап, тесты; байндинги пересобраны); `wasm/cryptography/src/jwt.rs` — **только добавления**: `jwt_sign_input` + `#[cfg(test)]`; байндинги `cryptography` пересобраны (включили и текущие правки qa-crypto в `openssh.rs` — сборка прошла); `src/scripts/wasm/crypto-client.ts` — добавлена `jwtSignInput()`.
- Локали (все 10 языков): word-counter (`InputLabel`, `CopyFailed`, `PasteFailed`), text-case-converter (`InputLabel`, `ConvertLabel`, `CopyFailed`), text-diff-viewer (`ViewModeLabel`, `NoDifferences`, `FileReadError`, `DiffTooBig`), regex-tester (`EngineError`, `StorageError`), jwt-decoder (`TokenLabel`, `InvalidToken`, `EnterSecret`, `UnsignedToken`, `UnsupportedAlgorithm`, `ClaimExpired`, `ClaimExpiresAt`, `ClaimNotBefore`, `ClaimValidFrom`, `ClaimIssuedAt`), jwt-encoder (`SignatureLabel`, `MustBeObject`, `CopyFailed`), markdown-preview (`ToolbarLabel`). `validate:i18n`: 0 ошибок (7 чужих предупреждений).

## Тесты

| Файл | Тестов | Что покрыто |
| --- | --- | --- |
| `apps/site/test/word-stats.test.ts` (новый) | 9 | пусто/пробелы, предложения/абзацы/строки, CRLF, многоточия, графемы (эмодзи, ZWJ, комбинируемые), кириллица/арабский/корейский/японский/китайский, время чтения, 1 МБ < 3 с |
| `apps/site/test/text-case.test.ts` (новый) | 18 | векторы 9 преобразований (паритет с legacy WASM, вкл. причуду `wORLD → W Orld`), пусто, Unicode/ß/эмодзи, \n/\t, CJK |
| `apps/site/test/regex-tester.test.ts` (новый) | 8 | флаги → inline, экранирование, подсветка UTF-16 (кириллица/эмодзи), перекрытия/пустые/за пределами, сохранённые паттерны (legacy-формат, битые данные), усечение по code points |
| `apps/site/test/jwt.test.ts` (новый) | 8 | вектор jwt.io (signing input + HMAC через `node:crypto`), сохранение `kid`/порядка, подстановка `alg`, `null`/`[]`/`123`/битый JSON, base64url UTF-8, `Bearer`, classifyAlg, exp/nbf/iat |
| `apps/site/test/markdown-sanitize.test.ts` (новый) | 5 | обфусцированные `javascript:` (таб/перевод строки/управляющие), `data:` SVG/HTML, on*/style/id/name/class, атрибуты GFM, drop/unwrap/keep |
| `wasm/regex_tool` (новые) | 11 | позиции ASCII/UTF-16 (кириллица, CJK, эмодзи), именованные/вложенные/неучаствующие группы, флаги i/m/s, ошибки, look-around/backref отклоняются, `^(a+)+$` на 50k линейно, пустые совпадения, кап |
| `wasm/cryptography` jwt (новые) | 6 | `jwt_sign_input` = jwt.io, длины HS384/512, пустой ключ, verify (верный/неверный секрет, подмена payload, неверное число частей), round-trip HS256/384/512, decode jwt.io, `alg:none` |

Прогоны (под `flock`): `node --test` 6 файлов — **55/55 ✅** (48 новых + 7 существующих `markdown.test.ts`); `cargo test -p regex_tool` — **11/11 ✅**; `cargo test -p mydevtools_cryptography --lib jwt` — **6/6 ✅**; `astro check` — 0 ошибок в моих файлах (7 чужих: `json-format.ts`, `pdf-compressor`, `pdf-to-text`).

Оценка существующих тестов: до аудита у логики группы тестов не было вовсе (только `markdown.test.ts` для SEO-конвертера, к инструменту markdown-preview не относится); в крейтах `regex_tool` и `cryptography/jwt` тестов не было.

## Скриншоты и скрипты

`/tmp/claude-1001/-home-lex-github-mydevtools/3051f920-6aff-44cf-91a3-0734cea3fd9a/scratchpad/qa-text/`:
- `<slug>-en-{light,dark}-{1440,375}.png` — 28 шт.; `<slug>-{ru,de,ja}-375.png`, `<slug>-ru-1440.png` — локализация (ja — тёмная тема); `jwt-decoder-ru-light-1440-final.png`.
- `check.mjs` (режимы `func` / `visual` / `i18n`), `a11y.mjs`; результаты `func.json`, `visual.json`, `i18n.json`.
- В headless Chromium нет CJK-шрифтов — японские глифы на скриншотах «тофу» (окружение, не сайт).

## Открытые вопросы и запросы к общему слою (`foundation`)

1. **Нейтральный алерт.** `ds-alert-info` красится в `--mdt-accent` (= цвет категории): на красно-оранжевой категории JWT он выглядит как ошибка, на янтарной Text — как предупреждение. Нужен `ds-alert-neutral` (muted текст, `--mdt-border`, `surface-inset`). Пока — локальный `.jwtd-status.is-neutral` в `JwtDecoder.astro`; ссылки «Нужно создать/декодировать JWT?» сделаны `ds-hint`.
2. **Общий scrim для `<dialog>::backdrop`.** `.ds-scrim` нельзя повесить на `::backdrop`; в `RegexTester.astro` продублирован цвет `rgb(4 6 10 / 0.55)`. Предложение: токен `--mdt-scrim` или правило `.ds-dialog::backdrop` в общем слое.
3. **`registry/tools.ts`:** у `text-case-converter` указано `wasm: "text_tools"`, но инструмент давно чистый TS и WASM не грузит. Поправить на `null` (файл общий, я не трогал).
4. **Предупреждение для координатора/foundation:** в ходе прогона dev-сервер один раз отдал **устаревший scoped CSS** (Vite-модуль стиля `JwtDecoder.astro` не инвалидировался после правки) — лечится `touch` файла. Скриншоты и проверки финального прогона сделаны после инвалидации; в `check.mjs` добавлен детектор устаревших стилей.
5. **jwt-decoder:** WASM `jwt_decode` пересортировывает ключи header/payload по алфавиту (serde `BTreeMap`) — так было и в legacy. Можно декодировать в TS с сохранением порядка; не сделано, чтобы не менять поведение крейта.
6. **regex-tester:** в режиме `forced-colors` фон textarea становится непрозрачным и скрывает подложку подсветки — совпадения видны только в списке. Мелочь, не исправлялось.
7. **markdown-preview:** заголовки из пользовательского markdown (`# …`) попадают в outline страницы (второй `h1`) — как в legacy. Относительные `<img src>` из markdown дают запрос к сайту (404) — допустимо (внешние картинки грузятся только по желанию пользователя).
8. Не коммитил (по правилам).
