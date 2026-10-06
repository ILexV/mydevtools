# SEO-отчёт: группа `encoding` и главная страница

Агент: `seo-encoding`. Дата: 2026-10-06, завершено в 15:07 (UTC+6).
Правила: `docs/qa/seo-guidelines.md`. Факты о поведении инструментов взяты из кода (`src/tools/*`, `wasm/encoding/src/lib.rs`, `registry/tools.ts`) и из `docs/qa/reports/encoding.md`.
Изменено ровно 70 файлов: `locales/<lang>/tools/{base64,base32,base58,hex,url,html-entity}-encoder.json` и `locales/<lang>/home.json` во всех 10 локалях. Новых ключей нет, ни один ключ не удалён.

## Что было не так (общее для всех шести инструментов)

Во всех 10 локалях стоял один и тот же шаблонный текст:
- «comprehensive functionality for base64 encoder operations», «modern web technologies», «improved productivity»;
- три пустых «примера» без единого реального ввода или вывода;
- HowTo из трёх обобщённых шагов, без названий кнопок UI;
- советы, не соответствующие коду:
  - **«Your preferences are saved locally»** — ложь: ни один из шести инструментов не использует localStorage;
  - **«powered by Rust-compiled WebAssembly»** у html-entity-encoder — ложь: там `wasm: null`, чистый TS;
  - **«Large files are supported with progress»** у url- и html-entity-encoder — ложь: у них нет файлового ввода.

## Что сделано по инструментам

Для каждого инструмента во всех 10 локалях переписаны `Seo_Introduction`, `Seo_DetailedDescription`, `Seo_Examples` (4 примера), `Seo_HowToSteps` (4 шага) и `Seo_Tips` (5–6 пунктов), а также `Description`. Названия полей, кнопок и опций в HowTo и советах взяты дословно из JSON этой же локали. Метки, содержащие `& < > "` (опции html-entity), обёрнуты в inline-code, чтобы они экранировались. `Seo_Introduction` рендерится как обычный текст, поэтому в нём нет markdown.

| Инструмент | Что теперь сказано в тексте (по коду) | Дополнительно |
|---|---|---|
| base64-encoder | Кодировки UTF-8, UTF-16LE/BE, ASCII, Latin-1. Алфавиты стандартный и URL-safe. Паддинг required/optional/none, перенос по 76 символов (MIME). Детекция картинок и бинарников при декодировании, скачивание с расширением. Файлы читаются в Worker кусками по 1 МиБ, но целиком хранятся в памяти. Советы: префикс data URI, JWT (URL-safe + Optional), кодировка `é` | В `Keywords` добавлены URL-safe и Base64 → image |
| base32-encoder | RFC 4648, настоящие Crockford (I/L→1, O→0, дефисы) и z-base-32 (после фикса QA). Паддинг, регистр (Auto), регистронезависимое декодирование. Совет про секреты TOTP (Optional, бинарный результат → Скачать) | В `Keywords` добавлены Crockford, z-base-32, TOTP |
| base58-encoder | Алфавиты Bitcoin, Flickr, Ripple. Ведущие нули → `1`. Лимиты 1 МиБ на кодирование и 2 000 000 символов на декодирование (O(n²)). Явно сказано, что **Base58Check не поддерживается** | Из `Keywords` убрано ложное «Base58Check» |
| hex-encoder | Кодировка и регистр. Декодер принимает пробелы, `:`/`-` и `0x` у каждого байта, каждую поблажку можно отключить. Позиция ошибки. Советы про BOM `efbbbf` и NBSP `c2a0` | — |
| url-encoder | Точные наборы незакодированных символов для режимов Component, URI и Form (из `lib.rs`). `+` → пробел только в Form. Строгий `%XX`. Кодировки. Советы про `%2520` и `%E9` | Файлов и скачивания нет — текст это не обещает |
| html-entity-encoder | Три режима, три формата. Именованных сущностей около 30 — остальные символы откатываются в hex даже в формате Named. Эмодзи кодируются одной ссылкой. Декодирование однопроходное (`&amp;lt;` → `&lt;`). Упомянут чистый JS, без WASM | `Title` локализован в ru/es/de/pt/fr/hi (раньше был английским) |

### Проверка примеров

Каждый пример и каждое значение в советах прогнаны в живом инструменте на dev-сервере через Playwright: заполнить поле → выставить опции → нажать кнопку → прочитать вывод или ошибку. Всего около 100 кейсов, все результаты совпали с текстом. Скрипты лежат в `scratchpad/seo-encoding/verify*.mjs`, лог — `verify.log`. Ключевые кейсы:
- **Base64:**
  - `Hello, World!` → `SGVsbG8sIFdvcmxkIQ==`;
  - `<<???>>` → `PDw/Pz8+Pg==` / `PDw_Pz8-Pg`;
  - `SGk` с паддингом Required даёт ошибку, с Optional — `Hi`;
  - PNG 1×1 → превью «PNG», 1×1 px;
  - `data:` URI → ошибка;
  - `eyJhbGciOiJIUzI1NiJ9` → `{"alg":"HS256"}`;
  - `é` → `w6k=` / `6Q==`.
- **Base32:**
  - `hello` → `NBSWY3DP` / `D1JPRV3F` / `pb1sa5dx`;
  - `DIJPRV3F` и `d1jp-rv3f` (Crockford) → `hello`;
  - `JBSWY3DPEHPK3PXP` → 10 B, не текст.
- **Base58:**
  - `Hello World!` → `2NEpo7TZRRrLZSi2U` / `2nePN7syqqRkyrH2t` / `p4NFofTZRRiLZS5p7`;
  - адрес `1A1zP1…` → 25 B, не текст.
- **Hex:**
  - `Привет` → `d09fd180d0b8d0b2d0b5d182`;
  - `A` в UTF-16LE/BE → `4100` / `0041`;
  - `4865zz` → ошибка «позиция 5»;
  - `0x48` с выключенной опцией 0x → ошибка «позиция 2».
- **URL:**
  - Component, URI и Form для двух строк;
  - `café` → `caf%C3%A9` / `caf%E9`;
  - `%2520` → `%20`;
  - `%E9` в UTF-8 → ошибка NotText.
- **HTML entities:**
  - `<a href="x">Tom & Jerry</a>`;
  - `© 2026 — café <b>` → `&copy; 2026 &mdash; caf&#xE9; <b>`;
  - `😀 ©` → `&#128512; &#169;` / `&#x1F600; &#xA9;`;
  - `&hearts;` остаётся как есть.

## Главная страница (Task B)

**Что реально видно на `/[lang]/`:** `Title` (H1), `Subtitle` (он же meta description и описание в manifest), `CTA_*`, `Stat_*`. В футере — `home.NoDataSent`. Ключи `SeoContent_*`, `Feature*`, `WhyChoose*`, `Badge_*` и `SubtitlePrefix` в Astro-сайте **не рендерятся**: это наследие legacy, `grep` по `src` их не находит. По заданию их всё равно исправил.

| Ключ | Было (ложь или преувеличение) | Стало |
|---|---|---|
| `Subtitle` (en) | «All processing happens locally in your browser via WebAssembly» — неверно: у 15 из 39 инструментов `wasm: null` | Конкретный список (JSON, Base64, хеши, JWT, regex, изображения, PDF) и формулировка «всё в браузере, данные не загружаются». Обновлён во всех 10 локалях, проверен в браузере (hero и meta description) |
| `SeoContent_P2` | «processes everything … using WebAssembly», «serverless architecture», «native-like performance» | Статический сайт. WASM из Rust — для хешей, шифрования, изображений, PDF и QR. JSON-форматер и diff — обычный JS |
| `SeoContent_P1` | Общие слова | Реальный перечень категорий инструментов |
| `SeoContent_Bullet_Security` | «No logs» — непроверяемо: хостинг GitHub Pages | «Ввод и файлы обрабатываются на устройстве и не загружаются» |
| `SeoContent_Bullet_Speed` | «Instant» | «Нет загрузки и round-trip, скорость зависит от устройства» |
| `FeatureWasmTitle/Description` | «Powered by WebAssembly» (про всё) | «WebAssembly там, где нужно», плюс уточнение, какие инструменты на JS |
| `FeatureOfflineDescription` | «Install as PWA and use without internet» | «Открытая хотя бы раз страница работает без сети» (SW network-first), PWA — для быстрого доступа |
| `FeatureAlgorithmsTitle/Description` | «Select algorithms and save your set» (про hash-калькулятор, не про сайт) | Избранное и недавние инструменты в браузере (`localStorage`) |
| `FeatureLanguagesDescription` | «multiple languages» | «10 языков» |
| `Badge_ToolsCount` | «50+ Tools» — ложь, инструментов 39 | «35+» — не устареет при добавлении инструментов |
| `SubtitlePrefix` | «All tools work offline» | «Работают в браузере; тяжёлые вычисления — на …» |
| `FeaturePrivacyDescription` | «Zero data sent to servers» | «Ввод обрабатывается в браузере и не отправляется на сервер» |

**Не трогал:**
- `Title`, `NoDataSent`, `Stat_*`, `WhyChooseDescription` — утверждения в них верны.
- `common.json` — запрещён по заданию. Пилюля в hero использует `common.NoDataSent`.

**Замечание для владельца.** У text-diff-viewer, markdown-preview и image-compressor в registry стоит `externalDeps: true`: они грузят библиотеки с CDN. Пользовательские данные при этом не уходят, так что «данные не загружаются» остаётся правдой. Но «100% Local» в hero формально верно только для данных, не для кода.

## Проверка

- **`flock /tmp/mydevtools-tests.lock npm run validate:i18n -w @mydevtools/site`** → **0 ошибок, 1 предупреждение**: `de/tools/uuid-generator: Title unchanged from English` — чужой инструмент. Предупреждение про `Title` html-entity-encoder ушло.
- **HowTo в JSON-LD** (Playwright, парсинг `script[type="application/ld+json"]`): **4 шага во всех 60 комбинациях** (6 инструментов × 10 локалей). Число совпадает с количеством `h3` в видимом блоке. Префиксы шагов (Step/Шаг/Paso/Schritt/Passo/步骤/Étape/ステップ/단계/चरण) срезаются корректно — названия шагов в JSON-LD чистые. Лог: `seo-check.log`.

  | Локаль | base64 | base32 | base58 | hex | url | html-entity |
  |---|---|---|---|---|---|---|
  | en, ru, es, de, pt, zh, fr, ja, ko, hi | 4 | 4 | 4 | 4 | 4 | 4 |

- **Рендер:**
  - сырых `**` и обратных кавычек в тексте блока нет;
  - inline-code в примерах html-entity отображается дословно (`&lt;a href=&quot;…`);
  - горизонтального переполнения нет;
  - ошибок в консоли 0;
  - ja (CJK) и hi (деванагари) отображаются нормальными глифами, без «тофу».
- **Скриншоты SEO-блока** (шапка скрыта) en/ru/ja/hi для всех 6 инструментов и hero главной: `/tmp/claude-1001/-home-lex-github-mydevtools/3051f920-6aff-44cf-91a3-0734cea3fd9a/scratchpad/seo-encoding/shots/`
  - `<slug>-<lang>.png` — 24 шт.;
  - `home-<lang>.png` — 4 шт.

## Открытые вопросы

1. Ключи `SeoContent_*`, `Feature*`, `WhyChoose*`, `Badge_*` и `SubtitlePrefix` в `home.json` не используются Astro-сайтом. Их стоит либо вывести (SEO-блок на главной), либо удалить из всех 10 локалей — решение за владельцем или `foundation`.
2. В строке статистики base64 выводится «1 bytes» (нет плюрализации `StatsBytes`). Это UI-строка, а не SEO, поэтому не трогал; относится к группе encoding.
