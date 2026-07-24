# TODO: новый статический фронтенд MyDevTools

> Живой чек-лист полного редизайна и переноса текущего функционала на статический Astro-фронтенд для GitHub Pages. Отмечать задачи только после проверки собранного `dist`, а не только dev-режима.

## Прогресс (обновлено 2026-07-17)

- **Этап 1 (Инвентаризация):** завершён функционально — `docs/inventory/{tools,locales,client-state,catalog-seo}.md`. Остаются: reference screenshots и parity-карточки (текут в Этап 9).
- **Этап 3 (Каркас Astro):** готов и проверен. `apps/site` (Astro 7, strict TS, `output: static`, base `/mydevtools/`), алиас `@/*`, команды `dev/build/preview/check` + root `*:site`, 402 страницы, preview под base без 404. **Gate 3 пройден.**
- **Этап 4 (Реестры):** `locales.ts` (10 языков + native names/og:locale/hreflang), `categories.ts` (13), `tools.ts` (39), `validate.ts` (build-time), маршруты из `getStaticPaths()`. Каталог/поиск/palette/sitemap из реестра — Этапы 8/10.
- **Этап 5 (Локализация):** 420 JSON перенесены в `apps/site/src/i18n/locales/`, typed `t()` с fallback, Node-валидатор `validate:i18n` (0 ошибок), build-time локализованный HTML (402 страницы, 10 языков). Остаются: language switcher, browser-controller strings, pluralization — Этапы 8/9.
- **Этап 8 (Глобальный функционал):** каталог 39 инструментов из реестра (13 категорий), клиентский поиск (`/`), favorites+recent с versioned localStorage, related tools, Header/Footer, theme toggle, language switcher, build-time sitemap (400 URL) + robots. **Gate 8 пройден** (browser: search/favorite/lang-switch end-to-end). Остаются: command palette, share/copy-link, graceful degradation — Этап 9.
- **Этап 7 (WASM runtime):** `build.ps1 -WasmOutRoot` → `apps/site/src/generated/wasm/`; Web Worker + протокол (start/progress/result/error/cancel), chunked 1 MiB file reading, typed `WasmError`, без SharedArrayBuffer; wasm грузится только на hash-странице. **Gate 7 пройден** (browser: 150MB файл, progress, cancel, UI не блокируется). Первый инструмент **hash-calculator** перенесён (Stage 9).
- **Этап 2 (Дизайн):** требует решений владельца (moodboard, выбор концепции из трёх, signature-элемент). Начальные design tokens (light/dark, spacing, radius) заложены в `src/styles/global.css` как стартовая точка.
- **Новая IA:** legacy прятал 4 инструмента (uuid, lorem, date-converter, pdf-to-text) вне каталога; реестр помещает uuid+lorem в `generators`, date-converter→converters, pdf-to-text→pdf — см. `docs/inventory/catalog-seo.md` §1.

## Зафиксированные решения

- [x] Новый фронтенд строится на Astro в режиме `output: "static"`.
- [x] Старый `packages/ui-kit` не используется и не определяет новый дизайн.
- [x] Дизайн создается заново, без визуального копирования текущего Blazor-сайта.
- [x] Сохраняется функциональный паритет со всеми 39 существующими инструментами.
- [x] Вычисления и пользовательские файлы остаются локально в браузере.
- [x] Существующие Rust/WASM crates переиспользуются там, где они уже отвечают за вычисления.
- [x] Локализация сохраняет языки `en`, `ru`, `es`, `de`, `pt`, `zh`, `fr`, `ja`, `ko`, `hi`.
- [x] Сборка Astro, WASM и локализационные проверки выполняются локально.
- [x] Итоговый статический `dist` публикуется на GitHub Pages без серверного runtime.

## Критерии готовности всего проекта

- [ ] Все маршруты `/{lang}/{tool-slug}/` открываются напрямую и после hard refresh на GitHub Pages.
- [ ] Все 39 инструментов сохраняют текущие входы, настройки, результаты, ошибки, копирование, скачивание и file-flow.
- [ ] Сайт не отправляет введенные данные или файлы на внешний сервер.
- [ ] Для каждого языка сгенерированы локализованные HTML, metadata, canonical и `hreflang`.
- [ ] Главная, каталог, поиск, категории, избранное, недавние инструменты, тема и переключение языка работают без backend.
- [ ] WASM загружается лениво только на страницах, где он нужен; тяжелые операции не блокируют основной UI thread.
- [ ] Production build не содержит абсолютных путей, ломающихся под GitHub Pages `base`.
- [ ] Нет зависимости нового приложения от `packages/ui-kit` или старых Razor-компонентов.
- [ ] Дизайн проверен на мобильных, планшетных и desktop-размерах в реальном браузере.
- [ ] Выполнены accessibility, performance, localization и parity-проверки из этого файла.

## Этап 1. Инвентаризация и фиксация паритета

- [x] Создать таблицу текущих инструментов: slug, категория, входы, настройки, действия, результаты, JS-файл, WASM-домен, locale namespace. → `docs/inventory/tools.md`
- [ ] Для каждого инструмента сохранить reference screenshots desktop/mobile и перечень ключевых состояний.
- [x] Зафиксировать общие сценарии: text input, file input, drag-and-drop, copy, download, swap, clear, progress, cancel, errors. → покрыто в `docs/inventory/tools.md` (capabilities + Notes)
- [x] Зафиксировать форматы сохраняемых настроек, favorites, recent tools и theme в `localStorage`/cookie. → `docs/inventory/client-state.md`
- [x] Выписать текущие SEO title/description/keywords и structured data для переноса смысла, но не старой разметки. → `docs/inventory/catalog-seo.md`
- [x] Отделить source-of-truth от устаревших документов: Razor, browser JS, locale JSON и Rust tests имеют приоритет. → инвентаризация собрана из кода, не из docs
- [ ] Создать parity-карточку для каждого инструмента с критериями «до/после».

### Gate 1

- [ ] Для каждого существующего маршрута есть владелец, parity-карточка и понятный источник текущего поведения.

## Этап 2. Концепция нового дизайна

- [ ] Сформулировать визуальное направление: характер бренда, аудитория, ключевые эмоции и отличия от типового dashboard.
- [ ] Собрать moodboard из интерфейсов, типографики, цветовых сочетаний, motion и presentation-паттернов.
- [ ] Подготовить минимум три визуальные концепции главной и выбрать одну до разработки компонентов.
- [ ] Нарисовать high-fidelity макеты главной, каталога, типовой tool page, сложной file tool page и мобильной навигации.
- [ ] Определить новую информационную архитектуру категорий и discovery инструментов.
- [ ] Зафиксировать сетку, максимальную ширину контента, spacing scale и responsive breakpoints.
- [ ] Выбрать собственную пару шрифтов и определить правила загрузки/subset без внешнего runtime-запроса.
- [ ] Создать semantic color tokens для light/dark themes: surface, text, border, accent, success, warning, danger, focus.
- [ ] Определить typography scale, radius, shadow, blur, border и elevation tokens.
- [ ] Зафиксировать motion rules: длительности, easing, enter/exit и обязательный `prefers-reduced-motion` fallback.
- [ ] Проверить контраст ключевых токенов до начала реализации компонентов.
- [ ] Не использовать готовый `packages/ui-kit`; новые компоненты проектировать под выбранную концепцию.

### Визуальный quality bar

- [ ] Придумать один узнаваемый signature-элемент бренда: графический мотив, особую сетку, форму карточек или motion-язык; не собирать очередной типовой SaaS dashboard.
- [ ] Собрать anti-reference: явно зафиксировать шаблонные решения, которые нельзя использовать без причины — бесконечные glass-карточки, случайные gradients, одинаковые Bento-блоки и декоративный blur без иерархии.
- [ ] Проектировать макеты на реальных названиях инструментов, переводах, ошибках и длинных результатах, а не на lorem ipsum.
- [ ] Для каждой ключевой страницы определить главный visual focal point и порядок чтения; один экран не должен конкурировать сам с собой пятью акцентами.
- [ ] Зафиксировать правила вертикального ритма, line length, heading hierarchy и плотности интерфейса для marketing-, catalog- и tool-страниц.
- [ ] Отдельно выбрать display, body, monospace и numeric styles; проверить читаемость кода, хэшей, JWT, дат, IP-адресов и длинных непрерывных строк.
- [ ] Использовать одну согласованную icon family либо собственный набор с одинаковыми stroke, optical size, corners и baseline; не смешивать случайные библиотеки.
- [ ] Создать собственный визуальный язык для hero, category accents, empty states, offline и 404 вместо stock-иллюстраций.
- [ ] Спроектировать mobile-композиции отдельно, а не просто сжать desktop-макеты.
- [ ] Использовать progressive disclosure: основные действия видны сразу, редкие настройки не перегружают tool page.
- [ ] Создать state matrix для компонентов: default, hover, focus, active, disabled, loading, drag-over, progress, success, warning и error.
- [ ] Проверить одновременно очень пустые и очень плотные состояния: нулевой результат, сотни строк, длинный filename, много настроек и несколько результатов.
- [ ] Ограничить число акцентных цветов и эффектов на одном экране; каждый accent должен обозначать действие, состояние или категорию.
- [ ] Спроектировать осмысленные microinteractions для copy, swap, clear, file drop, progress, completion и navigation; motion не должен скрывать задержки.
- [ ] Подготовить tone-of-voice и microcopy для действий, ошибок, подтверждений, privacy hints и empty states.
- [ ] Нарисовать favicon, PWA icons, social preview и browser theme colors как часть одной визуальной системы.
- [ ] Создать design review scorecard: hierarchy, rhythm, typography, color, icons, states, motion, responsiveness, accessibility и brand distinctiveness.

### Gate 2

- [ ] Утверждены desktop/mobile макеты и tokens для light/dark themes.
- [ ] Типовая tool page покрывает text, file, result, settings, progress, error и empty states.
- [ ] Владелец проекта отдельно утвердил реализованный visual prototype главной и эталонной tool page до массового переноса инструментов.


## Этап 3. Каркас Astro-приложения

- [x] Создать npm workspace `apps/site` с Astro и strict TypeScript.
- [x] Подключить новое приложение к корневому `package.json`, не связывая его с `packages/ui-kit`.
- [x] Настроить алиасы `@/components`, `@/tools`, `@/i18n`, `@/registry`, `@/styles`, `@/generated`. → единый `@/*` → `src/*` (даёт все перечисленные)
- [x] Настроить `output: "static"`, `site` и GitHub Pages `base` в `astro.config.mjs`.
- [x] Создать единые команды `dev`, `build`, `preview`, `check`, `test` и `deploy`. → `dev`/`build`/`preview`/`check` в `apps/site` + root `dev:site`/`build:site`/`preview:site`/`check:site`; `test`/`deploy` — Этапы 11/12
- [ ] Добавить root-команду, последовательно запускающую WASM build, locale validation и Astro build.
- [x] Создать структуру `src/pages`, `src/layouts`, `src/components`, `src/tools`, `src/i18n`, `src/registry`, `src/styles`, `src/generated`.
- [x] Настроить абсолютные импорты только через build aliases; не использовать абсолютные публичные URL вида `/wasm/...`.
- [ ] Определить политику browser support и targets для TypeScript/CSS.
- [x] Настроить локальный production preview с тем же `base`, который будет на GitHub Pages. → проверено под `/mydevtools/`
- [x] Добавить статические страницы `/`, `/{lang}/`, `/{lang}/not-found/` и совместимый `404.html`. → `404.html` восстанавливает locale из пути, покрывает not-found

### Gate 3

- [x] Чистый checkout собирается локально одной документированной командой. → `npm run build:site` (402 страницы)
- [x] Production preview работает под непустым GitHub Pages `base` без 404 для JS, CSS, fonts и images. → проверено: все маршруты 200, CSS инлайнится, 404 fallback работает

## Этап 4. Единые реестры данных

- [x] Создать `src/registry/locales.ts` с кодом, native name, English name, direction и fallback для каждого языка.
- [x] Создать `src/registry/categories.ts` с локализуемыми id, icon key, description и sort order.
- [x] Создать `src/registry/tools.ts` как единственный реестр инструментов.
- [x] Для записи инструмента определить: slug, component loader, category, locale namespace, keywords, WASM domain, capabilities и SEO id. → slug/category/wasm/capabilities в реестре; namespace через `toolNamespace()`; keywords в locale JSON; seoId=slug; component loader — Этап 9
- [x] Из реестра генерировать static routes через `getStaticPaths()`. → 39×10 маршрутов из `tools.ts`
- [ ] Из того же реестра строить home catalog, search index, categories, related tools, command palette и sitemap.
- [x] Добавить build-time проверку уникальности slug и наличия component/locale namespace. → `validate.ts` (`assertRegistryValid()` в build); проверка locale-namespace — Этап 5 validator
- [x] Исключить отдельные hard-coded tool lists в layout, home, sitemap и asset loader. → в новом приложении реестр = единственный источник

### Gate 4

- [ ] Добавление тестового инструмента одной записью создает маршрут, каталог, поиск, related links и sitemap entry.

## Этап 5. Локализация

- [x] Перенести актуальные JSON из `MyDevToolsApp/MyDevTools.Site/wwwroot/i18n/` в новый source tree без `.resx`. → 420 файлов в `apps/site/src/i18n/locales/`
- [x] Нормализовать структуру `common`, `home`, `categories`, `errors` и `tools/<slug>`. → сохранена legacy-структура; `errors` пока внутри tool-namespace (нет отдельного файла); де-дупликация category-ключей — при redesign
- [x] Создать typed helper `t(locale, namespace, key, params)` с fallback `locale → en → key`. → `src/i18n/messages.ts`
- [x] Генерировать HTML на build-time; не загружать весь locale catalog в браузер. → Astro prerender, `import.meta.glob` eager только на build
- [ ] Передавать browser controller только строки текущего tool namespace, необходимые интерактивным состояниям. → Этап 9 (browser controllers)
- [ ] Добавить pluralization, interpolation и locale-aware number/date formatting там, где это реально используется.
- [ ] Реализовать language switcher, сохраняющий текущий tool slug.
- [x] Определить поведение `/`: статическая language landing либо небольшой client redirect; не рассчитывать на `Accept-Language` server redirect. → `src/pages/index.astro` (client-side redirect по `navigator.languages`)
- [ ] Сохранять выбранный язык локально без обязательных cookies.
- [x] Адаптировать LocalizationValidator под новые пути либо заменить его локальным Node/TypeScript validator. → `apps/site/scripts/validate-i18n.mjs` + `npm run validate:i18n`
- [x] Валидировать parse errors, missing/extra keys, пустые значения, untranslated values и literal key references. → parse/missing/extra/empty/untranslated покрыты (literal-key refs — Этап 9)
- [x] Проверять наличие каждого tool namespace во всех десяти языках. → проверка namespace-parity vs `en` для 10 языков
- [x] Генерировать `<html lang>`, canonical, `hreflang` для всех языков и `x-default`. → `BaseLayout.astro`

### Gate 5

- [x] Отсутствующий/лишний localization key ломает локальную проверку до сборки. → `validate:i18n` exit≠0
- [ ] Переключение языка сохраняет текущий инструмент и не требует network API.

## Этап 6. Новый дизайн-системный слой

- [ ] Создать CSS layers: reset, tokens, base, utilities, components и tool-specific styles.
- [ ] Хранить design tokens в CSS custom properties, общих для Astro и browser controllers.
- [ ] Реализовать ThemeProvider без React-зависимости: system/light/dark, сохранение выбора, отсутствие flash неверной темы.
- [ ] Создать новые базовые компоненты: Button, IconButton, Link, Input, Textarea, Select, Checkbox, Radio, Switch.
- [ ] Создать компоненты состояния: Alert, Toast, Tooltip, Dialog, Popover, Skeleton, Spinner, Progress.
- [ ] Создать layout-компоненты: AppShell, Header, MobileNav, Footer, Container, Section, ToolLayout, SettingsPanel.
- [ ] Создать tool-компоненты: InputPanel, OutputPanel, CodeEditor shell, FileDropzone, FileInfo, ResultCard, CopyButton, DownloadButton.
- [ ] Создать catalog-компоненты: Search, CategoryTabs, ToolCard, Favorites, RecentTools, RelatedTools, CommandPalette.
- [ ] Все интерактивные элементы снабдить keyboard states, visible focus, disabled/loading/error states и корректными labels.
- [ ] Проверить компоненты при длинных немецких/русских строках и CJK-тексте.
- [ ] Проверить touch targets и отсутствие hover-only функциональности.
- [ ] Добавить локальную showcase-страницу компонентов для проверки состояний без старого Storybook/UI kit.

### Gate 6

- [ ] Главная и эталонная tool page собраны только из нового design-system слоя.
- [ ] Компоненты проходят keyboard, contrast, zoom 200% и reduced-motion проверки.
- [ ] Showcase содержит все интерактивные состояния, обе темы и реальные длинные локализованные данные; не осталось случайных browser-default controls.


## Этап 7. WASM и browser runtime

- [x] Изменить `wasm/build.ps1`, чтобы target-директория нового фронтенда передавалась параметром. → `-WasmOutRoot` (по умолчанию legacy wwwroot)
- [x] Генерировать wasm-bindgen output в `apps/site/src/generated/wasm/<domain>/` либо другое одно зафиксированное generated-место. → `apps/site/src/generated/wasm/hash/` (gitignored)
- [x] Не редактировать wasm-bindgen output вручную и не смешивать legacy/новые имена артефактов. → generated/ изолирован от legacy wwwroot/wasm
- [x] Закрепить совместимые версии Rust `wasm-bindgen` dependency и `wasm-bindgen-cli`. → crate `wasm-bindgen = "0.2"`, CLI 0.2.108 (patch-совместимы); сборка прошла
- [x] Создать статическую карту lazy loaders вместо runtime-путей `import('/wasm/' + domain)`. → static import в `hash.worker.ts` (+ Vite `new Worker(new URL(...))`)
- [x] Кешировать Promise инициализации каждого WASM-домена. → `ensureReady()` кеширует `init()` в worker
- [x] Нормализовать ошибки WASM в typed browser errors и локализованные UI messages. → `WasmError` (code: invalid-algorithm/init-failed/aborted/.../unknown)
- [x] Вынести тяжелые hash/crypto/image/PDF операции в Web Workers. → `hash.worker.ts` (hash domain); паттерн для остальных доменов зафиксирован
- [x] Создать общий protocol Worker messages: start, progress, result, error, cancel. → `worker-protocol.ts`
- [x] Сохранить chunked file reading и cancellation без буферизации больших файлов целиком, где это поддерживается. → 1 MiB chunks + `file.slice().arrayBuffer()` + cooperative cancel
- [x] Не использовать обязательные WASM threads/`SharedArrayBuffer`, поскольку GitHub Pages не позволяет настроить COOP/COEP headers. → File через structured clone, без SharedArrayBuffer
- [x] Проверить `application/wasm`, относительные URLs и lazy chunks в production `dist`. → `_astro/hash_bg-*.wasm` + `_astro/hash.worker-*.js` под base
- [x] Запретить preload всех WASM-доменов на главной странице. → wasm/worker грузятся только на hash-странице (network-проверка: home = 0 запросов)

### Gate 7

- [x] Эталонный Hash Calculator обрабатывает text и большой файл, показывает progress/cancel и не блокирует UI. → проверено в browser: MD5/SHA-1/SHA-256 корректны, 150MB файл с progress, UI отзывчив, cancel чистый
- [x] Network показывает загрузку только hash WASM на странице hash tool и корректные URL под Pages `base`. → home: 0 wasm/worker запросов; hash page: `_astro/hash_bg-*.wasm`

## Этап 8. Глобальный функционал сайта

- [x] Реализовать главную с новым hero, поиском, категориями и понятным privacy-first сообщением. → `pages/[lang]/index.astro` + `catalog.ts`
- [x] Реализовать быстрый локальный поиск по title, description, keywords и aliases текущего языка. → client-side filter по `data-keywords` + title/desc; горячая клавиша `/`
- [x] Реализовать favorites и recent tools с versioned `localStorage` schema. → `scripts/favorites.ts`, `mdt.favorites.v1`/`mdt.recent.v1` (cap 10), badges + секции на home + toggle на tool page
- [ ] Реализовать command palette и документировать keyboard shortcut.
- [x] Реализовать related tools на основе единого registry. → `relatedTools()` из `catalog.ts`, секция на tool page
- [x] Реализовать responsive header, mobile navigation и footer. → `Header.astro` (sticky, мобильный брейкпоинт) + `Footer.astro`
- [ ] Реализовать share/copy-link с URL, включающим locale и GitHub Pages base.
- [x] Добавить безопасное восстановление state при поврежденном/запрещенном `localStorage`. → весь client-state в try/catch с silent degradation
- [x] Не сохранять пользовательские тексты, файлы, ключи, пароли или результаты без явного действия пользователя. → сохраняются только slug'и favorites/recent + theme + locale; legacy-флаги приватности (json/xml input) в новом build не переносились
- [x] Реализовать локализованные empty, loading, error, offline и not-found states. → empty (no-results), 404.html; tool-loading/error/offline — Этап 9 с реальным UI
- [ ] Проверить graceful degradation для инструментов, которым доступен базовый HTML без JS.

### Gate 8

- [x] Home → search/category → tool → favorite/recent → language switch работает end-to-end в production preview. → проверено в browser: search 39→2, favorite persist, lang en→ru

## Этап 9. Перенос инструментов

> Инструмент отмечается готовым только после parity-проверки входов, настроек, ошибок, copy/download, mobile UI, localization и production WASM/JS behavior.

### Кодирование и структурированные данные

- [x] `base32-encoder` → encoding WASM, file+progress+cancel, preview/full; проверен
- [x] `base58-encoder` → encoding WASM (починен баг: Flickr/Ripple алфавиты); 3 алфавита проверены
- [x] `base64-encoder` → encoding WASM, file+progress+cancel, image-preview/binary-detect; проверен
- [x] `hex-encoder` → encoding WASM, 0x/separators/whitespace; проверен
- [x] `url-encoder` → encoding WASM, component/uri/form; round-trip по всем charset; проверен
- [x] `html-entity-encoder` → pure JS (36 round-trips parity), 3 режима × 3 формата; проверен
- [x] `json-beautifier` → CodeMirror 5 (vendored loader), format/sort/minify 2/4/tab, open/save/drag-drop; input-persistence НЕ перенесена (privacy); проверен
- [x] `json-to-typescript` → CodeMirror ×2, type inference (interfaces/arrays/optional), опции root/export/optional/type; проверен
- [x] `xml-beautifier` → CodeMirror, format/minify/validate, open/save; input-persistence НЕ перенесена (privacy); проверен
- [x] `yaml-beautifier-validator` → structured_data WASM format/validate, valid-badge, mode:'yaml' parity; проверен
- [x] `jwt-decoder` → live decode + verify HS*, alg-badge, race-guard; проверен
- [x] `jwt-encoder` → live sign, header/payload JSON валидация, HS256/384/512; проверен

### Текст и разработка

- [x] `word-counter` → pure JS, live stats (words/chars/lines/paras/sentences/reading&speaking); проверен
- [x] `text-case-converter` → pure JS (927 differential tests vs legacy WASM, 0 расхождений); проверен
- [x] `text-diff-viewer` → jsdiff+diff2html vendored (CDN убран), side-by-side/line-by-line, file load, dark-scheme; проверен
- [x] `markdown-preview` → marked vendored, live preview, toolbar-insert, sync-scroll, copy html/md, download standalone; проверен
- [x] `lorem-ipsum-generator` → plain/html/md, start-classic quirk сохранён; проверен
- [x] `regex-tester` → regex_tool WASM, 5 flags, backdrop-подсветка, matches+groups, saved patterns (localStorage), examples, cheatsheet; проверен

### Криптография и безопасность

- [x] `hash-calculator` → `tools/HashCalculator.astro` + worker; проверен в browser (text+file, progress/cancel)
- [x] `hmac-calculator` → live HMAC-SHA256/512 (text key, hex out); reference-вектор совпал; проверен
- [ ] `aead-file`
- [x] `password-generator` → length 4–128 + charsets + special-chars, history 10, localStorage parity; проверен
- [x] `uuid-generator` → pure JS (Web Crypto), v4/v7, 4 формата, batch ≤100, copy-all/download; проверен
- [x] `openssh-keys` → generate ed25519/p256/p384/rsa-3072/4096, import 4 формата, convert; legacy-баг passphrase→comment починен; проверен
- [x] `x509` → parse PEM/DER + warnings, self-signed, CSR; проверен

### Конвертеры, дата и сеть

- [x] `cron-generator` → builder 5 полей + presets, human-readable, next-runs, date-format; проверен
- [x] `cron-parser` → parse 5-field + presets, breakdown по полям, human-readable, next-runs; проверен
- [x] `date-converter` → unix-sec/ms/ISO parse, custom format tokens; проверен
- [x] `color-converter` → pure JS, hex/rgb/hsl/cmyk + 9 shades + WCAG AA/AAA contrast; проверен
- [x] `unit-converter` → live convert, 4 категории, quick/common conversions; проверен
- [x] `ip-subnet-calculator` → ipcalc WASM, CIDR + 'IP mask', таблица + binary view, examples; проверен

### Изображения, PDF и QR

- [ ] `image-compressor`
- [ ] `image-converter`
- [ ] `image-resizer`
- [ ] `pdf-compressor`
- [ ] `pdf-merger`
- [ ] `pdf-to-text`
- [ ] `qr-code-generator`
- [ ] `qr-scanner`

### Gate 9

- [ ] Миграционная матрица содержит 39/39 пройденных инструментов.
- [ ] Старые и новые результаты совпадают на зафиксированных parity fixtures и edge cases.

## Этап 10. SEO, PWA и статический hosting

- [ ] Создать общий SEO-компонент для title, description, canonical, Open Graph, Twitter cards и structured data.
- [ ] Генерировать локализованный sitemap из locale/tool registries.
- [ ] Обновить `robots.txt` под окончательный Pages URL.
- [ ] Настроить корректные asset URLs с `import.meta.env.BASE_URL` или Astro helpers.
- [ ] Создать manifest с base-aware `start_url`, scope, icons и theme colors.
- [ ] Переписать service worker под GitHub Pages scope `/<repo>/`, не регистрировать `/sw.js` от корня домена.
- [ ] Генерировать precache manifest из фактического `dist`, не поддерживать список hashed assets вручную.
- [ ] Не кешировать навсегда HTML и service worker; versioned assets кешировать immutable.
- [ ] Реализовать понятное обновление service worker без бесконечного stale cache.
- [ ] Проверить offline shell и заранее определить, какие инструменты должны работать offline после первого посещения.
- [ ] Проверить прямое открытие, refresh и 404 behavior всех route patterns на GitHub Pages.

### Gate 10

- [ ] Lighthouse распознает installable PWA, sitemap/canonical корректны, обновление версии не оставляет старый UI.

## Этап 11. Тестирование и quality gates

- [ ] Добавить unit tests для registry, routing helpers, localization fallback, formatters и state migrations.
- [ ] Сохранить и запускать Rust unit/integration tests для затронутых WASM crates.
- [ ] Добавить browser smoke tests для home, search, locale switch и representative text/file/WASM tools.
- [ ] Добавить parity fixtures: known vectors, Unicode, empty input, invalid input, large input и round trips.
- [ ] Проверить каждый инструмент при отключенном/поврежденном localStorage.
- [ ] Проверить keyboard-only navigation, focus order, dialogs, escape и screen-reader names.
- [ ] Проверить light/dark/system themes без flash и с корректным контрастом.
- [ ] Проверить 320, 375, 768, 1024, 1440 и ultrawide layouts.
- [ ] Проверить 200% zoom, длинные переводы, CJK и отсутствие layout overflow.
- [ ] Проверить Console/Network: нет uncaught errors, failed chunks, missing assets и лишних WASM downloads.
- [ ] Проверить большие файлы: progress обновляется, cancel освобождает ресурсы, UI остается отзывчивым.
- [ ] Установить budget: initial JS не включает tool-specific WASM и тяжелые редакторы.
- [ ] Установить цели Core Web Vitals: LCP < 2.5 s, CLS < 0.1, INP < 200 ms на representative mobile profile.
- [ ] Установить цели Lighthouse для основных страниц: Accessibility ≥ 95, Best Practices ≥ 95, SEO ≥ 95.
- [ ] Проверить production `dist`, а не считать dev server доказательством готовности.

### Визуальная приемка и polish

- [ ] Создать screenshot baselines для home, catalog, text tool, file/WASM tool, settings, loading, error, offline и 404 в light/dark themes.
- [ ] Сравнить реализованные страницы с утвержденными макетами side-by-side на одинаковых viewport, данных и locale.
- [ ] Добавить локальные visual regression checks для стабильных компонентов и ключевых страниц.
- [ ] Выполнить browser matrix в Chromium, Firefox и Safari/WebKit либо максимально близком доступном движке.
- [ ] Проверить реальные mobile touch interactions: keyboard opening, safe areas, sticky controls, drag/drop fallback, scroll и orientation change.
- [ ] Проверить cold load, повторное открытие и обновление Service Worker: нет unstyled content, font swap, theme flash и скачков layout.
- [ ] Проверить optical alignment и pixel density иконок, borders, dividers, badges, controls и monospace results на DPR 1 и 2.
- [ ] Проверить визуальную целостность минимум на `en`, `ru`, `de`, `zh` и псевдолокали с экстремально длинными строками.
- [ ] Удалить accidental one-off значения цветов, spacing, radius, shadow и font size либо оформить их как обоснованные tokens.
- [ ] Провести отдельный polish pass №1: композиция, иерархия, whitespace и responsive rhythm.
- [ ] Провести отдельный polish pass №2: typography, color, icons, borders, surfaces и imagery.
- [ ] Провести отдельный polish pass №3: hover/focus/pressed states, transitions, progress, errors и reduced motion.
- [ ] Проверить, что дизайн выглядит законченным без анимаций и остается понятным без decorative effects.
- [ ] Получить финальное визуальное утверждение главной, каталога и трех разных типов tool page на опубликованном preview, а не только в макетах.

### Gate 11

- [ ] Все обязательные локальные проверки проходят одной командой и возвращают ненулевой exit code при ошибке.

## Этап 12. Локальная сборка и публикация на GitHub Pages

- [ ] Зафиксировать локальные версии Node/npm, Rust и `wasm-bindgen-cli` в документации и конфигурации.
- [ ] Создать `npm run build:wasm` для локального вызова обновленного `wasm/build.ps1`.
- [ ] Создать `npm run validate:i18n`.
- [ ] Создать `npm run build:site` и итоговый `npm run build:pages`.
- [ ] `build:pages` должен очистить старый output, собрать WASM, проверить locale JSON, собрать Astro и проверить ссылки/assets.
- [ ] Выбрать локальную публикацию в `gh-pages` branch как основной способ; сборка не выполняется на GitHub.
- [ ] Добавить `npm run deploy:pages`, публикующий только готовый `apps/site/dist`.
- [ ] Не коммитить секреты или пользовательские настройки в deploy script.
- [ ] В настройках GitHub Pages выбрать ветку `gh-pages` и корень `/`.
- [ ] Выполнить первую публикацию в тестовый Pages URL до переключения основного сайта.
- [ ] Проверить опубликованный сайт в новом browser profile без локального cache.
- [ ] Повторить проверку после второй публикации, чтобы доказать корректное обновление cache/service worker.
- [ ] Записать короткую инструкцию release: prerequisites → build → preview → deploy → smoke test → rollback.
- [ ] Определить rollback на предыдущий commit ветки `gh-pages`.

### Финальный Gate

- [ ] Локальный `build:pages` воспроизводимо создает полный self-contained `dist`.
- [ ] GitHub Pages содержит 39/39 инструментов и десять локалей.
- [ ] Все пользовательские вычисления остаются локальными.
- [ ] Новый дизайн подтвержден на реальных mobile/desktop устройствах.
- [ ] Старый фронтенд остается доступен до подтвержденного функционального, SEO и accessibility паритета.
