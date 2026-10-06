# QA-аудит инструментов: качество, тесты, визуал, консистентность

Старт: 2026-10-06. Объект: `apps/site` (Astro, GitHub Pages), 39 инструментов × 10 языков.
Отчёты агентов: `docs/qa/reports/<group>.md`. Отмечать пункт только после проверки в реальном браузере / прогона тестов.

## Исходная проблема консистентности

`src/styles/global.css` определяет примитивы дизайн-системы Prism (`ds-btn`, `ds-btn-primary`, `ds-field`, `ds-check`, `ds-radio`, `ds-chip`, `ds-progress`, `ds-panel`, `ds-switch`…), но ни один инструмент их не использует: 31 инструмент дублирует `.primary-btn` / `.ghost-btn` / `.field-label` / `.file-btn` / `.progress-track` в scoped `<style>`, общих Astro-компонентов UI инструментов нет. Итог — расхождения в отступах, состояниях (hover/focus/disabled), размерах и тёмной теме.

## Фаза 1 — общий слой UI инструментов (агент `foundation`)

- [x] Инвентаризация дублей: какие локальные классы/паттерны повторяются в `src/tools/*.astro` (кнопки, поля, label, select/textarea, чекбоксы/радио, chip, file-picker/dropzone, progress, панель вывода + copy/download, ошибки/статус, settings-grid).
- [x] Общий слой: Astro-компоненты в `src/components/tool/` и/или глобальные классы в `global.css` поверх `ds-*` и токенов `--mdt-*`; классы должны работать и для DOM, создаваемого контроллерами (scoped-стили Astro на него не действуют).
- [x] Единые состояния: hover, `:focus-visible`, disabled, loading, error, success; обе темы; `forced-colors`.
- [x] Эталонная миграция `hash-calculator` + гайд `docs/qa/tool-ui-kit.md` (что чем заменять, примеры).
- [x] Браузер: hash-calculator в light/dark, 375/1440, en/ru — без регрессий.

## Фаза 2 — проверка и доработка инструментов (6 агентов параллельно)

Чек-лист на КАЖДЫЙ инструмент:

1. **Консистентность** — локальные дубли кнопок/полей/file/progress/output заменены общим слоем; в `<style>` остаётся только специфичная раскладка; используются токены, нет хардкод-цветов.
2. **Функционал** — все входы, настройки, действия (copy, download, swap, clear, file, drag&drop, cancel), результаты и ошибки работают; паритет по `docs/inventory/tools.md` и `parity-fixtures.md`.
3. **Ошибки/граничные случаи** — пустой ввод, невалидный ввод, большой ввод/файл, Unicode/эмодзи; ошибки локализованы и видимы.
4. **Визуал** — light и dark, 1440 и 375 px: всё читается (контраст), нет горизонтального скролла, ничего не обрезано, фокус виден, длинные строки переносятся.
5. **Локализация** — en и ru, плюс длинный язык (de) и CJK (ja/zh): нет переполнений, нет непереведённых ключей.
6. **Консоль/сеть** — 0 ошибок в консоли, WASM грузится только на нужной странице, нет внешних запросов.
7. **Тесты** — у чистой логики (`src/tools/*.ts` helpers, вынесенные функции контроллера) есть unit-тесты в `apps/site/test/`; у Rust-домена — тесты в crate для используемых функций; известные векторы из `parity-fixtures.md` покрыты. Слабые/отсутствующие тесты дописаны.
8. **Доступность** — у полей есть label, кнопки с понятным именем, клавиатурная навигация, `aria-live` для результатов/ошибок.

| Группа | Агент | Инструменты |
| --- | --- | --- |
| encoding | `qa-encoding` | base64-encoder, base32-encoder, base58-encoder, hex-encoder, url-encoder, html-entity-encoder |
| crypto | `qa-crypto` | hash-calculator, password-generator, hmac-calculator, aead-file, openssh-keys, x509 |
| structured | `qa-structured` | cron-generator, cron-parser, json-beautifier, json-to-typescript, xml-beautifier, yaml-beautifier-validator |
| text | `qa-text` | word-counter, text-case-converter, text-diff-viewer, regex-tester, jwt-decoder, jwt-encoder, markdown-preview |
| files | `qa-files` | image-compressor, image-converter, image-resizer, pdf-compressor, pdf-merger, pdf-to-text, qr-code-generator, qr-scanner |
| convert | `qa-convert` | color-converter, unit-converter, date-converter, ip-subnet-calculator, uuid-generator, lorem-ipsum-generator |

Статус по инструментам — в отчётах групп (таблица «инструмент × пункты 1–8»).

## Фаза 3 — финал (координатор)

- [x] Запросы групп к общему слою (16 шт.) выполнены `foundation`, локальные обходы заменены (см. `tool-ui-kit.md`).
- [x] WASM пересобран целиком из текущих исходников (11 доменов).
- [x] `npm run verify -w @mydevtools/site`: astro check 0 errors / 0 warnings, i18n 0 errors, unit 236/236, build 404 стр., dist-smoke 5/5.
- [x] `cargo test --workspace`: все крейты зелёные.
- [x] `test:crossbrowser`: Chromium + Firefox 14/14. ⚠️ WebKit не запускается — нет системных библиотек (`sudo npx playwright install-deps webkit`).
- [x] Проход по собранному `dist` (preview): 39 инструментов × en/ru × light/dark × 1440/375 = 312 страниц — 0 ошибок консоли/сети, 0 горизонтального переполнения, 0 видимых `[hidden]`, нет сырых ключей.
- [x] Сборка воспроизводима (две сборки → идентичный HTML/sw.js; `FileDrop` id детерминирован).
- [x] Починен `npm run preview:site` (в `apps/site` не было скрипта `preview`; порт 4321 зафиксирован).
- [x] Сводка и коммит.

## Второй заход (2026-10-06): SEO и исправление открытых вопросов

Отчёты: `docs/qa/reports/{seo-encoding,fix-crypto,fix-structured,fix-text,fix-files,fix-convert}.md`, правила SEO — `docs/qa/seo-guidelines.md`.

- [x] SEO-тексты всех 39 инструментов × 10 языков переписаны по коду (без шаблонов и ложных утверждений про WASM/файлы/сохранение настроек), примеры прогнаны в инструментах; HowTo JSON-LD теперь корректен на всех языках (парсер делил шаги только по английскому «Step»).
- [x] Главная: подзаголовок без ложного «всё на WebAssembly».
- [x] AEAD: формат MDT3 с аутентификацией последнего чанка (обрезка/перестановка детектируются), MDT2 читается.
- [x] Пароли AEAD/SSH без молчаливого trim (расшифровка пробует оба варианта).
- [x] RSA-генерация, PDF-обработка и распознавание QR — в Web Worker; отмена.
- [x] CodeMirror 5 → 6 (вставка 3 МБ с эмодзи: 184 с → 0,3 с).
- [x] WebP с потерями через браузерный кодировщик (fallback lossless).
- [x] x509: разбор CSR; HMAC пустого сообщения; IPv6 в ip-subnet-calculator.
- [x] Камера в qr-scanner; pdf-compressor сохраняет теги доступности.
- [x] CRC32/Adler-32/xxHash/FNV-1a и др. выводятся числом в hex, как в zlib/xxhsum.
- [x] WebKit: горизонтальный скролл на ja/375 из-за длинных option в select (`contain: paint`).
- [x] Склонения: lorem, base64 («1 байт / 2 байта»).

## Открытые вопросы владельцу

- `home.json`: SEO-блок (`SeoContent_Title/P1/P2` + 6 карточек `Feature*`) выведен на главной 2026-10-06; 39 неиспользуемых ключей (наследие Blazor: `SeoContent_Bullet_*`, `WhyChoose*`, `Badge_*`, `FeaturePwa*`, `ReadyToTry*`, избранное/недавние и др.) удалены из всех локалей 2026-10-06 — осталось 36.
- AEAD: деривация ключа Argon2id и шифрование всё ещё в main thread (≈1 с).
- x509: нет полей SAN при генерации; pdf-merger без кнопки отмены; IPv6 без разбиения на подсети.
- Визуальные baselines `e2e/pages.spec.ts-snapshots/` (win32) устарели после редизайна инструментов — перегенерировать на Windows (`npm run test:visual:update`).
- Real-device mobile pass.

## Правила для агентов

- Не запускать `astro build`, `npm run verify`, `build:pages`, деплой. Проверка UI — на общем dev-сервере `http://localhost:3312/mydevtools/` (HMR).
- Тесты — только через блокировку, по одному прогону на проект:
  `flock /tmp/mydevtools-tests.lock <команда>`; точечно (`node --experimental-strip-types --test test/<file>.test.ts`, `cargo test -p <crate>`).
- Править только файлы своих инструментов (`src/tools/<Name>.astro`, `<slug>.client.ts`, их helpers, `src/i18n/locales/*/tools/<slug>.json`, свои тесты, свой WASM-клиент/crate). Общие файлы (`global.css`, `src/components/**`, `layouts`, `common.json`, `[slug].astro`) — только агент `foundation`; остальным — записать запрос в отчёт.
- Не коммитить. Даты/время в отчётах — UTC+6.
