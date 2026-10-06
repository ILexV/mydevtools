# QA-отчёт группы `convert` (агент `qa-convert`)

Дата: 2026-10-06, завершено 12:33 (UTC+6). Объект: `apps/site`, dev-сервер `http://localhost:3312/mydevtools/` (Chromium через Playwright).
Инструменты: color-converter, unit-converter, date-converter, ip-subnet-calculator, uuid-generator, lorem-ipsum-generator.

## Сводная таблица (пункты чек-листа 1–8)

| Инструмент | 1 Консистентность | 2 Функционал | 3 Граничные случаи | 4 Визуал | 5 Локализация | 6 Консоль/сеть | 7 Тесты | 8 Доступность |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| color-converter | ✅ `ds-card`/`ds-result-row`/`ds-badge`/`StatusMessage`; локальный CSS — только раскладка, цветовые поля и плитки оттенков | ✅ ручной ввод HEX/rgb()/hsl()/cmyk() с автоопределением формата (паритет с legacy), Convert/Enter, Clear, копирование каждого формата, оттенки, WCAG | ✅ неверный или пустой ввод: `aria-invalid` + локализованная ошибка; значения вне диапазона, rgba / `/ alpha` / deg / проценты | ✅ light/dark, 1440/375, нет горизонтального скролла | ✅ en/ru/de/ja (+6 языков) | ✅ 0 ошибок, 0 внешних запросов, без WASM | ✅ новый `color.test.ts` (12) | ✅ подписи, `aria-pressed` и `aria-label` у плиток оттенков, error → `role=alert` |
| unit-converter | ✅ `ds-field-select`/`ds-field`/`ds-icon-btn`/`ds-chip-btn`/`ds-code-block`/`ds-card` | ✅ live-конвертация, swap, copy, быстрые и частые конверсии | ✅ 0 (раньше выводилось `0.000000e+0`), пустой ввод, 1e12, ниже абсолютного нуля → предупреждение | ✅ | ✅ названия единиц локализованы (31 × 10 языков); числа в формате локали | ✅ 0 ошибок, без WASM | ✅ новый `units.test.ts` (10) | ✅ у полей значений есть `aria-label`; у кнопки копирования правильное имя (было «Copied!»); формула — `aria-live` |
| date-converter | ✅ `Field`/`ds-settings`/`OutputPanel`/`StatusMessage` | ✅ auto/sec/ms/ISO → 8 форматов, свой формат, «Сейчас», копирование | ✅ отрицательные и дробные epoch, hex/exp отклоняются, выход за ±8.64e15 → ошибка, DST, все вхождения токенов | ✅ | ✅ «Local» = Intl в языке страницы (ru «вторник, 14 ноября 2023 г. …») | ✅ | ✅ новый `dates.test.ts` (11) | ✅ `aria-invalid`, `role=alert`, у полей есть label |
| ip-subnet-calculator | ✅ `Field`/`ds-chip-btn`/`ds-icon-btn`/`ds-badge`/`StatusMessage` | ✅ CIDR, «IP маска», голый IP, примеры, Enter, копирование сети и broadcast | ✅ /0 (**баг в Rust исправлен**), /31, /32, IPv6 → локализованная ошибка, /33; ошибка загрузки WASM показывается отдельным сообщением с повтором | ✅ | ✅ «Example 1/2/3», «IP:», «Mask:» больше не захардкожены; числа хостов в формате локали (`1.048.574` de) | ✅ WASM `ipcalc` грузится только здесь и только при первом расчёте | ✅ Rust: 6 → 16 тестов | ✅ `aria-label` у иконок копирования, `th scope=row`, результаты — `aria-live`, убран `autofocus` |
| uuid-generator | ✅ `ds-radio`/`ds-check-group`/`ds-result-row`/`OutputPanel`/`ds-empty` | ✅ v4/v7, 4 формата, регистр, 1–100, копирование строки и всех, скачивание, очистка | ✅ **v7 теперь монотонный** (раньше внутри 1 мс порядок был случайным), лимиты счётчика | ✅ | ✅ | ✅ | ✅ новый `uuid.test.ts` (9) | ✅ радиокнопки в `fieldset/legend`, `aria-label` «Copy #n», список — `aria-live` |
| lorem-ipsum-generator | ✅ `Field`/`ds-settings`/`ds-check-row`/`OutputPanel`/`ds-status` | ✅ абзацы/предложения/слова, plain/html/md, classic, `<p>`, копирование, скачивание | ✅ **count 1e9 больше не вешает вкладку** (ограничение 1000); 0 → 1 со зеркалированием в поле; NaN → 5 | ✅ | ✅ у селекта формата появились label и опции (были без подписи и на английском), «chars» и «Словам» исправлены | ✅ | ✅ новый `lorem-ipsum.test.ts` (11) | ✅ подписи у всех полей, статистика — `role=status` |

Обозначения: ✅ — проверено в браузере или тестами. Для всех инструментов пройдены en, ru (light + dark) и de, ja (light) при ширине 1440 и 375 — итого 12 комбинаций на инструмент. Во всех комбинациях: overflow = false, ошибок в консоли нет, внешних запросов нет, нет контролов без имени, нет сырых ключей локализации.

## Найденные и исправленные баги

1. **Строки, созданные контроллерами, были без стилей** (color: формат-строки, плитки оттенков, WCAG-бейджи; uuid: строки списка; unit: чипы и строки частых конверсий). Scoped-стили Astro на DOM из `innerHTML` не действуют. Теперь DOM строится через `createElement` с классами `ds-*`, а специфичные элементы стилизуются через `:global(...)` внутри корня инструмента.
2. **color: ручной ввод понимал только HEX**, хотя подсказка обещала rgb/hsl/cmyk (в legacy был паритет). Добавлены `parseColor()` (автоопределение формата, проценты, rgba, `/ alpha`, `deg`) и `cmykToRgb()`. Кнопки Convert и Clear раньше не выводились, хотя строки для них были в локалях. Для невалидного цвета не было ошибки.
3. **unit: `formatNumber(0)` давал `0.000000e+0`.** Быстрые конверсии при значении 0 считались от 1 (`|| 1`). У кнопки копирования accessible name было «Copied!». Названия единиц были захардкожены на английском во всех языках.
4. **date: свой формат заменял только первое вхождение токена** (`dd/MM (dd)`). В режимах Unix принимались `0x10` и `1e3`. В auto не распознавались отрицательные и дробные epoch (`-86400` парсился как строка).
5. **ipcalc (Rust): для /0 `usable_hosts = 0`**, правильно — 4 294 967 294. Пробелы вокруг `/` (`10.0.0.1 / 8`) давали ошибку. Bindings пересобраны (`wasm/build.ps1 -Domains ipcalc`, под lock).
6. **ip: при сбое загрузки WASM показывалось «неверный формат IP»**, и закэшированный rejected promise ломал все последующие попытки. Теперь показывается отдельное сообщение `Error_LoadFailed`, а следующая попытка загружает модуль заново (проверено через `route.abort` на `.wasm`). Хосты форматировались `toLocaleString()` в локали браузера — теперь в языке страницы.
7. **uuid v7 не монотонный внутри одной миллисекунды** (батч из 100 штук не сортировался). Реализован метод RFC 9562 §6.2 (12-битный счётчик в `rand_a`, при переполнении timestamp увеличивается на 1, устойчиво к откату часов). В браузере батч из 100 v7 строго возрастает.
8. **lorem: `count=999999999` вешал вкладку** (атрибут `max=1000` при вводе с клавиатуры не применяется). Добавлен `clampCount` (1..1000). У селекта формата не было label, опции были захардкожены на английском, «chars» тоже был захардкожен. Счётчик слов использовал ключ `Words` («Словам» в ru) — добавлен `WordsStat`.
9. Ошибки clipboard раньше проглатывались молча. Во всех 6 инструментах копирование переведено на `copyWithFeedback`, а при отказе показывается локализованный `CopyFailed`. Скачивание (uuid, lorem) делало `revokeObjectURL` сразу после `click()` — теперь с задержкой, чтобы работало в Firefox/Safari.
10. Во всех контроллерах добавлен guard повторной инициализации `data-initialized`.

## Тесты

Запуск только под `flock /tmp/mydevtools-tests.lock`, точечно:

| Файл | Тестов | Результат |
| --- | --- | --- |
| `apps/site/test/color.test.ts` (новый) | 12 | ✅ pass: векторы legacy-подсказки, round-trip hex↔rgb↔hsl↔cmyk по сетке, `parseColor` (валидный и невалидный ввод), WCAG-пороги, оттенки |
| `apps/site/test/units.test.ts` (новый) | 10 | ✅ pass: таблица эталонов, round-trip всех пар, температура, `formatNumber`/`formatNumberLocale` (en/ru/de/ja), абсолютный ноль |
| `apps/site/test/dates.test.ts` (новый) | 11 | ✅ pass: sec vs ms, отрицательные и дробные epoch, строгий числовой ввод, диапазон, все форматы, DST Europe/Berlin (весна и осень), Intl en/ru/de/ja |
| `apps/site/test/uuid.test.ts` (новый) | 9 | ✅ pass: формат, биты версии и варианта, раскладка 48-битного timestamp, монотонность v7 (5000 подряд + откат часов), уникальность 40 000, лимиты батча |
| `apps/site/test/lorem-ipsum.test.ts` (новый) | 11 | ✅ pass: детерминизм через `rng`, точные количества, диапазоны 5–15 и 3–7, classic, HTML, 0/огромное/NaN |
| `wasm/ipcalc/src/ipv4.rs` (`cargo test -p ipcalc`) | 6 → 16 | ✅ pass: /0…/32 (usable и total для каждого префикса), маска = CIDR, невалидный ввод (включая IPv6), границы классов, RFC 1918, бинарные строки |

Итого TS: 53/53 pass. Rust: 16/16 pass. `npm run validate:i18n`: 0 ошибок (7 чужих и ожидаемых предупреждений; в моих неймспейсах только `de/uuid-generator Title` = «UUID/GUID Generator», это нормальный термин). `npx astro check`: 0 errors, 0 warnings.

Для тестируемости pure-модули получили небольшие расширения: `parseColor`/`cmykToRgb`, `formatNumberLocale`/`isBelowAbsoluteZero`/`allUnitIds`, `format(…, locale)`, `randomUuidBytes(version, now)`/`UUID_RE`/`v7Timestamp`/`MAX_BATCH`, `clampCount`/`MAX_COUNT` и опция `rng`.

## Локализация

Новые ключи добавлены во все 10 языков:
- color — `CopyFailed`, `Error_InvalidColor`;
- unit — `Copy`, `CopyFailed`, `ValueLabel`, `Warning_BelowAbsoluteZero`, `Unit_*` × 31;
- date, uuid — `CopyFailed`;
- ip — `Copy`, `CopyFailed`, `Examples`, `Error_LoadFailed`;
- lorem — `CopyFailed`, `FormatLabel`, `Format_Plain/Html/Markdown`, `Characters`, `WordsStat`.

## Скриншоты

Каталог `/tmp/claude-1001/-home-lex-github-mydevtools/3051f920-6aff-44cf-91a3-0734cea3fd9a/scratchpad/qa-convert/`:
- `before-<slug>.png` — состояние до работ (en, light, 1440);
- `shots/<slug>-<lang>-<theme>-<width>.png` — 72 скриншота после работ;
- скрипты `check.mjs` (функциональный прогон + sweep), `one.mjs`, `ip0.mjs` (/0, пробелы, сбой загрузки WASM), `focus.mjs` (обход Tab), `i18n_add.py`.

## Открытые вопросы и запросы к общему слою (`foundation`)

1. **CJK-шрифты в headless-среде.** На ja-скриншотах вместо иероглифов «тофу»: в системе нет японских шрифтов (`fc-list :lang=ja` пусто). Это ограничение окружения, а не сайта: раскладка и переполнения на ja проверены. Глифы нужно визуально проверить на машине с CJK-шрифтами.
2. **Seo-тексты color/uuid** (`Seo_Introduction`, `Seo_DetailedDescription` во всех языках) утверждают, что инструмент работает «на WebAssembly / Rust» и поддерживает «file processing». На самом деле это чистый JS без файлов. Это шаблонный текст из legacy, я его не переписывал (контент для 10 языков). Нужно решение владельца.
3. **Запрос к `foundation`:** нужен вариант `ds-result-row` с узкой первой колонкой (индекс/номер). Сейчас в uuid колонки переопределены локально через `.uuid-list :global(.ds-result-row) { grid-template-columns: 2.5rem … }`.
4. **Запрос к `foundation`:** общий стиль для `<input type="color">` (`ds-color-well`). Сейчас он локальный (`.color-well` в ColorConverter).
5. **Плюрализация.** «1 слов» / «1 символов» в ru: инфраструктура `pluralVariants` есть, но для lorem не подключена. Это мелочь, её можно сделать отдельно.
6. **ipcalc поддерживает только IPv4** (как и legacy). IPv6 показывает локализованную ошибку формата. Поддержка IPv6 — отдельная фича.
7. **«Private» — только RFC 1918.** CGNAT 100.64/10, loopback и link-local считаются «Public» (паритет с legacy). Возможное улучшение — отдельный бейдж «Reserved/Special».
8. В date-converter вывод «Local» теперь использует Intl в языке страницы (`dateStyle: full`, `timeStyle: long`), а не `Date#toString()` на английском. Это осознанное отличие от legacy.
9. Генерируемые bindings `apps/site/src/generated/wasm/ipcalc/*` в `.gitignore`, их пересобирает пайплайн. Локально пересобраны.

## Изменённые файлы

- `apps/site/src/tools/{ColorConverter,UnitConverter,DateConverter,IpSubnetCalculator,UuidGenerator,LoremIpsumGenerator}.astro`
- `apps/site/src/tools/{color-converter,unit-converter,date-converter,ip-subnet-calculator,uuid-generator,lorem-ipsum-generator}.client.ts`
- `apps/site/src/tools/{color,units,dates,uuid,lorem-ipsum}.ts`
- `apps/site/src/scripts/wasm/ipcalc-client.ts`
- `wasm/ipcalc/src/ipv4.rs`
- `apps/site/test/{color,units,dates,uuid,lorem-ipsum}.test.ts` (новые)
- `apps/site/src/i18n/locales/*/tools/{color-converter,unit-converter,date-converter,ip-subnet-calculator,uuid-generator,lorem-ipsum-generator}.json` (×10 языков)
