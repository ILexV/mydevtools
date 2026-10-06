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

## Открытые вопросы владельцу (из отчётов групп)

- **SEO-тексты** большинства инструментов — шаблонные и местами ложные («работает на WebAssembly», «обрабатывает файлы» для чисто JS/текстовых инструментов). Переписать?
- **AEAD (MDT2):** обрезка файла ровно по границе чанка не детектируется — нужна новая версия формата с флагом последнего чанка.
- **trim() паролей** AEAD и фразы SSH — оставлен ради совместимости со старыми файлами.
- **Производительность:** RSA-4096 (18–48 с) и PDF/QR-сканер работают в main thread — кандидаты в Web Worker; CodeMirror 5 медленный на огромных однострочных JSON → миграция на CodeMirror 6.
- **WebP** только lossless (ползунок качества не влияет).
- **x509:** разбор CSR не поддерживается (плейсхолдер обещает).
- **CJK-глифы** не проверены визуально: на Linux-машине нет CJK-шрифтов (раскладка проверена).
- **Real-device** mobile pass — по-прежнему за владельцем.

## Правила для агентов

- Не запускать `astro build`, `npm run verify`, `build:pages`, деплой. Проверка UI — на общем dev-сервере `http://localhost:3312/mydevtools/` (HMR).
- Тесты — только через блокировку, по одному прогону на проект:
  `flock /tmp/mydevtools-tests.lock <команда>`; точечно (`node --experimental-strip-types --test test/<file>.test.ts`, `cargo test -p <crate>`).
- Править только файлы своих инструментов (`src/tools/<Name>.astro`, `<slug>.client.ts`, их helpers, `src/i18n/locales/*/tools/<slug>.json`, свои тесты, свой WASM-клиент/crate). Общие файлы (`global.css`, `src/components/**`, `layouts`, `common.json`, `[slug].astro`) — только агент `foundation`; остальным — записать запрос в отчёт.
- Не коммитить. Даты/время в отчётах — UTC+6.
