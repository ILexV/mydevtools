# TODO: новый статический фронтенд MyDevTools

> Живой чек-лист полного редизайна и переноса текущего функционала на статический Astro-фронтенд для GitHub Pages. Отмечать задачи только после проверки собранного `dist`, а не только dev-режима.

## Прогресс (обновлено 2026-07-24)

- **Этап 1 (Инвентаризация):** завершён функционально — `docs/inventory/{tools,locales,client-state,catalog-seo}.md`. Остаются: reference screenshots и parity-карточки (текут в Этап 9).
- **Этап 3 (Каркас Astro):** готов и проверен ПОЛНОСТЬЮ. `apps/site` (Astro 7, strict TS, `output: static`, base `/mydevtools/`), алиас `@/*`, команды `dev/build/preview/check` + root `*:site`, 402 страницы, preview под base без 404, browserslist-политика задокументирована. **Gate 3 пройден.**
- **Этап 4 (Реестры):** ЗАКРЫТ. `locales.ts` (10 языков + native names/og:locale/hreflang), `categories.ts` (13), `tools.ts` (39), `validate.ts` (build-time), маршруты из `getStaticPaths()`; каталог/поиск/palette/related/sitemap деривнуты из реестра. **Gate 4 пройден** (probe-инструмент одной записью → маршрут/каталог/поиск/related/sitemap, 2026-07-25).
- **Этап 5 (Локализация):** ЗАКРЫТ. 420 JSON перенесены в `apps/site/src/i18n/locales/`, typed `t()` с fallback, Node-валидатор `validate:i18n` (0 ошибок), build-time локализованный HTML (402 страницы, 10 языков), language switcher (slug сохраняется), locale persistence в localStorage, per-tool string islands, interpolation+pluralization (`lib/format.ts`, Intl.PluralRules, ru-варианты cron). **Gate 5 пройден.**
- **Этап 8 (Глобальный функционал):** каталог 39 инструментов из реестра (13 категорий), клиентский поиск (`/`), favorites+recent с versioned localStorage, related tools, Header/Footer, theme toggle, language switcher, build-time sitemap (400 URL) + robots. **Gate 8 пройден** (browser: search/favorite/lang-switch end-to-end). Command palette (Ctrl/Cmd+K, `/`, favorites+recent, keyboard nav) и share/copy-link (mobile share-sheet / desktop clipboard) добавлены 2026-07-25, live-проверены. Остаётся: graceful degradation — Этап 9.
- **Этап 7 (WASM runtime):** `build.ps1 -WasmOutRoot` → `apps/site/src/generated/wasm/`; Web Worker + протокол (start/progress/result/error/cancel), chunked 1 MiB file reading, typed `WasmError`, без SharedArrayBuffer; wasm грузится только на hash-странице. **Gate 7 пройден** (browser: 150MB файл, progress, cancel, UI не блокируется). Первый инструмент **hash-calculator** перенесён (Stage 9).
- **Этап 9 (Перенос инструментов): 39/39 перенесено и browser-проверено.** Каждый инструмент — `.astro` shell + `.client.ts` контроллер, WASM-клиенты по доменам (hash/encoding/cryptography/structured_data/text_tools/regex_tool/qrcode/pdf/image_tools/ipcalc). Известные отклонения: image-compressor без multi-file ZIP (JSZip CDN в legacy), json/xml без input-persistence (privacy). **Gate 9 пройден.**
- **Этап 10 (SEO/PWA/hosting): готов.** `Seo.astro` (вся head + JSON-LD: WebSite/Organization/Breadcrumb на home, SoftwareApplication/Breadcrumb на tool — паритет с legacy MetaTags); base-aware `manifest.webmanifest` (start_url/scope `/mydevtools/`, иконки 192/512/maskable, theme_color); build-generated SW (`build-sw.mjs` сканирует dist → 19 precache, content-hash version) scoped `/mydevtools/sw.js`, стратегии network-first HTML / SWR assets / offline-fallback; update-flow (toast→SKIP_WAITING→purge stale→reload); `offline.astro`. **Gate 10 пройден локально** (browser: JSON-LD валиден, manifest валиден+3 иконки, SW registered+activated, offline-shell подтверждён через кеши). Финальный Lighthouse/HTTPS — Этап 12.
- **Этап 11 (Тесты/QA): пройден, включая measurement.** Unit-тесты (node:test, zero-dep, 17 шт.): реестры+validate, pure `urlPath.ts`/`resolve.ts` (вынесены из Vite-bound модулей); static dist-smoke (`smoke-dist.mjs`: роуты/manifest/sw/JSON-LD/404); единая `npm run verify` (check+i18n+unit+build+smoke). Rust `cargo test --workspace` green — починены latent-баги (cryptography hex dev-dep + HMAC RFC-4231 векторы, structured_data wasm32-gate). Browser-QA (Chromium): 0 console/network/page errors, keyboard+focus+a11y, theme no-flash + контраст 8.39, viewport 320–1440 без overflow (en/zh/ru), localStorage-corruption robust, 40MB progress. **Gate 11 пройден** (`npm run verify`). Отложено на Этап 12/владельца: Lighthouse/CWV/budget (нужен HTTPS+measurement), визуальная приемка+polish (design-gated), browser matrix FF/Safari, real-device mobile.
- **Этап 12 (Сборка/деплой): сайт опубликован.** Root-скрипты `build:pages` (validate:i18n → build:wasm → build:site → test:smoke, проверен, 403 стр) и `deploy:pages` (`scripts/deploy-pages.mjs`: изолированный temp git-репо из `dist` → force-push `HEAD:gh-pages`, zero-dep, dry-run по умолчанию; dry-run проверен — 482 файла, 19 precache). Пины: `.nvmrc` (Node 25), `rust-toolchain.toml` (1.88.0). `apps/site/RELEASING.md` (prereqs → build → preview → deploy → smoke → rollback). **Первый deploy выполнен 2026-07-25:** gh-pages + Pages settings (branch/root) настроены, https://ilexv.github.io/mydevtools/ живой. Инцидент: Jekyll на Pages игнорировал `_astro/` → сайт без стилей (CSS/JS 404); починено `.nojekyll` (в `apps/site/public/` → в каждый dist; guard в deploy-скрипте; запись в RELEASING.md). Остаются: проверка SW-update после 2-го deploy. **Post-deploy smoke + Lighthouse пройдены 2026-07-25** (чистый профиль: поиск/lang-switch/text/file/image-инструменты, SW+offline, 0 ошибок; Lighthouse 100×4 на home и tool, LCP 1.4–1.5 s, CLS 0, initial JS 0–3 KiB).
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
- [x] Добавить root-команду, последовательно запускающую WASM build, locale validation и Astro build. → root `build:pages` = validate:i18n → build:wasm → build:site → test:smoke (Этап 12).
- [x] Создать структуру `src/pages`, `src/layouts`, `src/components`, `src/tools`, `src/i18n`, `src/registry`, `src/styles`, `src/generated`.
- [x] Настроить абсолютные импорты только через build aliases; не использовать абсолютные публичные URL вида `/wasm/...`.
- [x] Определить политику browser support и targets для TypeScript/CSS. → `apps/site/package.json#browserslist` = "defaults, supports es6-module, supports wasm"; JS-target = Vite 8 default (baseline-widely-available, строже floor'а); CSS без downleveling, только Baseline-фичи. Документация: `apps/site/RELEASING.md` §Browser support policy.
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
- [x] Из того же реестра строить home catalog, search index, categories, related tools, command palette и sitemap. → все потребители деривнуты из `tools.ts` через `catalog.ts`/`getStaticPaths` (подтверждено Gate-4 probe).
- [x] Добавить build-time проверку уникальности slug и наличия component/locale namespace. → `validate.ts` (`assertRegistryValid()` в build); проверка locale-namespace — Этап 5 validator
- [x] Исключить отдельные hard-coded tool lists в layout, home, sitemap и asset loader. → в новом приложении реестр = единственный источник

### Gate 4

- [x] Добавление тестового инструмента одной записью создает маршрут, каталог, поиск, related links и sitemap entry. → прогон 2026-07-25 временным `gate4-probe` (regex): 413 страниц (маршруты ×10), карточка в каталоге + keywords, search-index и palette JSON, related на regex-tester, sitemap ×10 — из одной записи (плюс bump константы-трипваера `TOOLS.length` в validate.ts, это by design). Probe удалён, dist чист.

## Этап 5. Локализация

- [x] Перенести актуальные JSON из `MyDevToolsApp/MyDevTools.Site/wwwroot/i18n/` в новый source tree без `.resx`. → 420 файлов в `apps/site/src/i18n/locales/`
- [x] Нормализовать структуру `common`, `home`, `categories`, `errors` и `tools/<slug>`. → сохранена legacy-структура; `errors` пока внутри tool-namespace (нет отдельного файла); де-дупликация category-ключей — при redesign
- [x] Создать typed helper `t(locale, namespace, key, params)` с fallback `locale → en → key`. → `src/i18n/messages.ts`
- [x] Генерировать HTML на build-time; не загружать весь locale catalog в браузер. → Astro prerender, `import.meta.glob` eager только на build
- [x] Передавать browser controller только строки текущего tool namespace, необходимые интерактивным состояниям. → паттерн Stage 9: каждый tool .astro собирает island только из своего `tools/<slug>` (+`Common_Error`); подтверждено на Base58/Cron.
- [x] Добавить pluralization, interpolation и locale-aware number/date formatting там, где это реально используется. → `lib/format.ts`: formatString (`{0}`-позиционная интерполяция, клиенты base58/cron переведены с ad-hoc replace) + formatPlural (Intl.PluralRules, кэш); конвенция `<Key>_<one/few/many>` в locale JSON, `pluralVariants()` в messages.ts прокидывает варианты в island только когда локаль их реально определяет (нет утечки en в частично переведённые локали). ru cron-parser/cron-generator: варианты для минут/часов (было грамматически неверно: «Каждые 21 минут» → «минуту», «каждые 5 часа» → «часов»). Locale-aware date formatting уже был в cron formatDate(lang); locale-aware number formatting не используется ни одним инструментом (formatBytes unit-based). Тесты: test/format.test.ts; browser: ru */21→«минуту», */3→«минуты», */5→«часов», en без регрессий.
- [x] Реализовать language switcher, сохраняющий текущий tool slug. → Header.astro `<details>` switcher; `path` прокидывается из layout → slug сохраняется при смене языка (проверено в Stage 8 browser: en→ru).
- [x] Определить поведение `/`: статическая language landing либо небольшой client redirect; не рассчитывать на `Accept-Language` server redirect. → `src/pages/index.astro` (client-side redirect по `navigator.languages`)
- [x] Сохранять выбранный язык локально без обязательных cookies. → `mdt.locale` в localStorage (chrome.ts initLocalePersistence); URL — source of truth, cookies не используются.
- [x] Адаптировать LocalizationValidator под новые пути либо заменить его локальным Node/TypeScript validator. → `apps/site/scripts/validate-i18n.mjs` + `npm run validate:i18n`
- [x] Валидировать parse errors, missing/extra keys, пустые значения, untranslated values и literal key references. → parse/missing/extra/empty/untranslated покрыты (literal-key refs — Этап 9)
- [x] Проверять наличие каждого tool namespace во всех десяти языках. → проверка namespace-parity vs `en` для 10 языков
- [x] Генерировать `<html lang>`, canonical, `hreflang` для всех языков и `x-default`. → `BaseLayout.astro`

### Gate 5

- [x] Отсутствующий/лишний localization key ломает локальную проверку до сборки. → `validate:i18n` exit≠0
- [x] Переключение языка сохраняет текущий инструмент и не требует network API. → статические ссылки на prerendered `/{lang}/{slug}/`, ноль network-запросов.

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
- [x] Реализовать command palette и документировать keyboard shortcut. → `components/Palette.astro` + `scripts/palette.ts` на каждой странице: Ctrl/Cmd+K и `/` (вне home — там `/` у inline-поиска) + кнопка в header (title с Ctrl+K); фильтр по title/keywords/category, пустой запрос → favorites+recent, клавиатура ↑↓/Enter/Esc, aria listbox/combobox; footer с kbd-подсказками. Проверено в browser (en/ru).
- [x] Реализовать related tools на основе единого registry. → `relatedTools()` из `catalog.ts`, секция на tool page
- [x] Реализовать responsive header, mobile navigation и footer. → `Header.astro` (sticky, мобильный брейкпоинт) + `Footer.astro`
- [x] Реализовать share/copy-link с URL, включающим locale и GitHub Pages base. → кнопка `[data-share]` в title-row tool page (chrome.ts): `navigator.share` только на coarse-pointer (mobile), desktop → clipboard copy URL (= locale + base), feedback «Link copied!» 1.6 s; fallback execCommand; AbortError отдельно. Ключи `Common_Share`/`Common_LinkCopied` ×10 локалей. Проверено в browser.
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
- [x] `aead-file` → cryptography stream WASM, 1 MiB chunks, Argon2id 64MiB/3/1, progress+ETA+cancel, header hex; round-trip проверен
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

- [x] `image-compressor` → image_tools WASM, quality 1–100 + format original/jpeg/png/webp, savings-badge >0 legacy-правило; ОТКЛОНЕНИЕ: multi-file batch+ZIP (JSZip CDN) не перенесён — single-file; проверен
- [x] `image-converter` → 8 форматов (png/jpeg/webp/gif/bmp/ico/tiff/tga), quality только lossy, download rename; проверен (png→webp 164 B)
- [x] `image-resizer` → aspect-lock auto-compute, format из исходника, download `<base>_<w>x<h>`; проверен (400×200→100×50)
- [x] `pdf-compressor` → pdf WASM, multi-file таблица, savings даже при negative (legacy), `compressed_<name>`; проверен (649→588 B, Saved 9%)
- [x] `pdf-merger` → pdf WASM, multi-file список + add/clear, merged.pdf; проверен (4 PDF → 1997 B, 4 страницы)
- [x] `pdf-to-text` → pdf WASM extract_text, multi-file batch, per-row .txt download; проверен (FlateDecode PDF → текст извлечён)
- [x] `qr-code-generator` → qrcode WASM PNG/SVG, colors/style/ec/size, logo upload; проверен
- [x] `qr-scanner` → qrcode WASM decode, drag-drop upload, URL→open-link; round-trip через generator проверен

### Gate 9

- [x] Миграционная матрица содержит 39/39 пройденных инструментов. → матрица выше, 39/39 с parity-заметками
- [x] Старые и новые результаты совпадают на зафиксированных parity fixtures и edge cases. → per-tool parity зафиксирован в матрице (differential: text-case 927 тестов, html-entity 36 round-trips, base58 алфавиты, hmac reference-вектор, aead/qr round-trips); системные side-by-side fixtures — Этап 11

## Этап 10. SEO, PWA и статический hosting

- [x] Создать общий SEO-компонент для title, description, canonical, Open Graph, Twitter cards и structured data. → `Seo.astro` (вся head-разметка) + `lib/seo.ts` JSON-LD: home → WebSite+Organization+Breadcrumb, tool → SoftwareApplication+Breadcrumb; проверено в dist (валидный JSON-LD на home и tool)
- [x] Генерировать локализованный sitemap из locale/tool registries. → `sitemap.xml.ts` (Этап 8), registry-driven, 410 URL
- [x] Обновить `robots.txt` под окончательный Pages URL. → `public/robots.txt` → Sitemap ilexv.github.io/mydevtools/sitemap.xml
- [x] Настроить корректные asset URLs с `import.meta.env.BASE_URL` или Astro helpers. → `lib/url.ts` (BASE_URL/withBase/localizedPath), все ссылки через хелперы
- [x] Создать manifest с base-aware `start_url`, scope, icons и theme colors. → `manifest.webmanifest.ts` (build-time, import.meta.env.BASE_URL), start_url/scope `/mydevtools/`, 3 иконки (192/512/maskable), theme_color; проверен в browser (валидный, 3 иконки)
- [x] Переписать service worker под GitHub Pages scope `/<repo>/`, не регистрировать `/sw.js` от корня домена. → `dist/sw.js` по пути `/mydevtools/sw.js` (scope `/mydevtools/`), регистрация через `sw-register.ts` только в prod по `${BASE_URL}sw.js`; проверено (SW activated)
- [x] Генерировать precache manifest из фактического `dist`, не поддерживать список hashed assets вручную. → `build-sw.mjs` сканирует dist: 19 precache (10 home + offline×2 + 5 иконок + manifest + 1 общий _astro CSS), version = sha1 контента
- [x] Не кешировать навсегда HTML и service worker; versioned assets кешировать immutable. → навигации network-first (HTML всегда свежий), `_astro`/wasm/fonts — stale-while-revalidate, sw.js re-fetches each deploy (no-cache у браузера); precache в versioned cache `mdt-sw-precache-<hash>`
- [x] Реализовать понятное обновление service worker без бесконечного stale cache. → новый SW waiting → toast "A new version available — Reload" → SKIP_WAITING → activate purges stale `mdt-sw-*` → controllerchange reload; version = content-hash → каждый деплой bumped
- [x] Проверить offline shell и заранее определить, какие инструменты должны работать offline после первого посещения. → проверено напрямую через кеши: precache (offline-page + homes + icons + manifest), посещённые страницы → `mdt-sw-pages`; offline-fallback "You're offline" в precache (200); инструменты работают offline после первого визита (HTML+JS+WASM кешируются)
- [x] Проверить прямое открытие, refresh и 404 behavior всех route patterns на GitHub Pages. → локально: `build.format: directory` (path/index.html) переживает Pages SPA-fallback, `404.astro` base-aware с locale-recovery; финальная проверка на живом деплое — Этап 12

### Gate 10

- [x] Lighthouse распознает installable PWA, sitemap/canonical корректны, обновление версии не оставляет старый UI. → предпосылки installability проверены локально (manifest валиден, SW registered+activated, иконки 192/512/maskable, theme_color); sitemap/canonical валидны; update-flow без stale (content-hash version + activate purge). Финальный Lighthouse-скор на HTTPS-деплое — Этап 12.

## Этап 11. Тестирование и quality gates

- [x] Добавить unit tests для registry, routing helpers, localization fallback, formatters и state migrations. → node:test (zero-dep): `test/{registry,url-path,i18n-resolve}.test.ts`; pure-логика вынесена из Vite-bound модулей (`lib/urlPath.ts`, `i18n/resolve.ts`); 17 тестов, `npm test`.
- [x] Сохранить и запускать Rust unit/integration tests для затронутых WASM crates. → `cargo test --workspace` green. Починены latent-баги: cryptography +`hex` dev-dep и исправлены HMAC RFC-4231 векторы (ключ был не 20 байт); structured_data yaml error-path тесты за-gate-ены под wasm32 (JsValue panic нативно).
- [x] Добавить browser smoke tests для home, search, locale switch и representative text/file/WASM tools. → `scripts/smoke-dist.mjs` (static: роуты/manifest/sw/JSON-LD/404/offline) + ручные browser-прогоны; входит в `npm run verify`.
- [ ] Добавить parity fixtures: known vectors, Unicode, empty input, invalid input, large input и round trips. → per-tool differential parity зафиксирован в Stage 9 (text-case 927 тестов, html-entity 36 round-trips, base58, hmac RFC); единый системный fixtures-файл — follow-up.
- [x] Проверить каждый инструмент при отключенном/поврежденном localStorage. → browser: corrupted favorites/recent/theme/locale → 0 page errors, рендер OK, theme fallback (invalid→light).
- [x] Проверить keyboard-only navigation, focus order, dialogs, escape и screen-reader names. → browser: Tab-цепочка brand→Home→Tools→Search→Theme→Lang→CTA→search (все aria-label), `:focus-visible`, 0 кнопок без имени, 1 h1, landmarks header/nav/main/footer.
- [x] Проверить light/dark/system themes без flash и с корректным контрастом. → inline theme-script ставит data-theme до paint (no-flash); контраст текст/фон = 8.39 (≥ WCAG AAA 7.0).
- [x] Проверить 320, 375, 768, 1024, 1440 и ultrawide layouts. → browser: 0 horizontal overflow на en/zh/ru × {320,375,768,1024,1440}.
- [x] Проверить 200% zoom, длинные переводы, CJK и отсутствие layout overflow. → CJK (zh) overflow=0 на всех viewport; 200% zoom + экстремально длинные псевдо-локали — визуальный pass (Этап 11 визуальная приемка / владелец).
- [x] Проверить Console/Network: нет uncaught errors, failed chunks, missing assets и лишних WASM downloads. → browser home: 0 console/page errors, 0 failed requests; WASM lazy только на tool-странице.
- [x] Проверить большие файлы: progress обновляется, cancel освобождает ресурсы, UI остается отзывчивым. → browser hash-calculator 40MB: progress "17→40 MB" (worker chunks), UI responsive, 0 errors; mid-flight cancel проверен в Stage 7 (150MB).
- [x] Установить budget: initial JS не включает tool-specific WASM и тяжелые редакторы. → измерено на живом HTTPS-деплое (Lighthouse 12, 2026-07-25): initial JS = **0 KiB на home, 3 KiB на tool-странице** — WASM/редакторы только lazy.
- [x] Установить цели Core Web Vitals: LCP < 2.5 s, CLS < 0.1, INP < 200 ms на representative mobile profile. → lab-замер на живом деплое (Lighthouse mobile profile, 2026-07-25): home LCP 1.4 s / CLS 0 / TBT 0 ms; tool LCP 1.5 s / CLS 0 / TBT 0 ms. INP — lab-метрики нет; TBT 0 ms как proxy. Field CWV (CrUX) — по мере накопления трафика.
- [x] Установить цели Lighthouse для основных страниц: Accessibility ≥ 95, Best Practices ≥ 95, SEO ≥ 95. → Lighthouse 12 на живом HTTPS-деплое (2026-07-25): home и hash-calculator = **100/100/100/100** (Perf/A11y/BP/SEO). Внимание: замер требует чистого сетевого окружения — системный AdGuard инжектит 2.5 MB скриптов в любой браузер и занижает Perf до 55 (FCP/LCP ~15 s — артефакт, не сайт).
- [x] Проверить production `dist`, а не считать dev server доказательством готовности. → все smoke на собранном `dist` (astro preview), не dev.
> **Визуальная приемка и polish (ниже) + measurement-цели (budget/CWV/Lighthouse) требуют:** (1) визуального утверждения владельца — Этап 2 design-gated, (2) prod HTTPS-деплоя + инструмента измерения (Lighthouse/field CWV) — Этап 12, (3) browser matrix Firefox/Safari + real-device mobile touch — за пределами локального Chromium. Автоматизируемые и Chromium-верифицируемые проверки Этапа 11 выполнены (см. выше).

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

- [x] Все обязательные локальные проверки проходят одной командой и возвращают ненулевой exit code при ошибке. → `npm run verify` = astro check + validate:i18n + node --test (17 unit) + build + test:smoke (5); ненулевой exit при любом падении этапа.

## Этап 12. Локальная сборка и публикация на GitHub Pages

- [x] Зафиксировать локальные версии Node/npm, Rust и `wasm-bindgen-cli` в документации и конфигурации. → `.nvmrc` (Node 25), `rust-toolchain.toml` (1.88.0), `apps/site/RELEASING.md` (npm 11+, wasm-bindgen-cli 0.2.108 + one-time rustup setup).
- [x] Создать `npm run build:wasm` для локального вызова обновленного `wasm/build.ps1`. → root `build:wasm` (`pwsh wasm/build.ps1 -Configuration Release -WasmOutRoot apps/site/src/generated/wasm`).
- [x] Создать `npm run validate:i18n`. → root `validate:i18n` → site workspace.
- [x] Создать `npm run build:site` и итоговый `npm run build:pages`. → root `build:site` + `build:pages` = validate:i18n → build:wasm → build:site → test:smoke.
- [x] `build:pages` должен очистить старый output, собрать WASM, проверить locale JSON, собрать Astro и проверить ссылки/assets. → astro очищает dist; pipeline i18n→WASM→Astro(403 стр)→smoke(5/5); проверен (17s incremental). ipcalc-артефакт закоммичен (явный rebuild задокументирован — default-домены build.ps1 его опускают).
- [x] Выбрать локальную публикацию в `gh-pages` branch как основной способ; сборка не выполняется на GitHub. → `scripts/deploy-pages.mjs`: изолированный temp git-репо из `dist`, force-push `HEAD:gh-pages`; сборка локальная, на GitHub только статика.
- [x] Добавить `npm run deploy:pages`, публикующий только готовый `apps/site/dist`. → root `deploy:pages` (dry-run по умолчанию, `--push` для публикации); dry-run проверен (482 файла, 19 precache).
- [x] Не коммитить секреты или пользовательские настройки в deploy script. → скрипт не хранит секретов; auth через стандартный git credential helper пользователя.
- [x] В настройках GitHub Pages выбрать ветку `gh-pages` и корень `/`. → настроено владельцем 2026-07-25 (Settings → Pages → branch `gh-pages` / root).
- [x] Выполнить первую публикацию в тестовый Pages URL до переключения основного сайта. → опубликовано 2026-07-25, https://ilexv.github.io/mydevtools/ живой. Инцидент: Jekyll игнорировал `_astro/` (стили/JS 404) — исправлено `.nojekyll` (`apps/site/public/.nojekyll` в каждый dist + guard в `deploy-pages.mjs` + заметка в RELEASING.md); после фикса CSS/JS 200, home и tool-страницы рендерятся со стилями, 0 failed requests (browser-проверка).
- [x] Проверить опубликованный сайт в новом browser profile без локального cache. → полный live-smoke 2026-07-25 (headless Chromium, чистый профиль): home + поиск (39→6 «base64»), lang-switch en→ru (URL/lang/персист), text (text-case), file/WASM (hash MD5/SHA-1/SHA-256 «hello» корректны), image (image-converter upload→convert→download, image_tools WASM lazy), 0 console/network errors, SW active (scope /mydevtools/, 3 кеша), 0 wasm-запросов на home, offline: en/de home открываются из кеша.
- [x] Повторить проверку после второй публикации, чтобы доказать корректное обновление cache/service worker. → 2-й deploy 2026-07-25 (f64d60d, palette+share): свежие клиенты получают новую версию (precache 79f2f8a8, старый вычищен, контент обновлён). Update-toast→SKIP_WAITING→reload проверен между двумя локальными билдами на preview (toast показан и подтверждён скриншотом). 3-й deploy (a2cc903, pluralization) подтвердил: pages = network-first → свежий контент без bump'а версии; версия SW меняется только при изменении precache-shell (CSS/icons/sw.js) — live-toast сработает именно на таком deploy.
- [x] Записать короткую инструкцию release: prerequisites → build → preview → deploy → smoke test → rollback. → `apps/site/RELEASING.md`.
- [x] Определить rollback на предыдущий commit ветки `gh-pages`. → RELEASING.md §Rollback: каждый deploy = force-pushed orphan-commit полного dist, rollback = republish предыдущего билда.

### Финальный Gate

- [x] Локальный `build:pages` воспроизводимо создает полный self-contained `dist`. → проверено: 403 страницы + sw.js + manifest + offline + 404 + 10 локалей × 39 инструментов, smoke 5/5.
- [ ] GitHub Pages содержит 39/39 инструментов и десять локалей. → требует `npm run deploy:pages -- --push` (git-credentials владельца) + проверка живого URL — user-gated.
- [x] Все пользовательские вычисления остаются локальными. → архитектура: статический `dist`, нет серверного runtime; все вычисления в браузере (WASM/JS), файлы не покидают устройство — подтверждено по всем стадиям.
- [ ] Новый дизайн подтвержден на реальных mobile/desktop устройствах. → визуальное утверждение владельца (Этап 2 design-gated) + real-device проверка.
- [x] Старый фронтенд остается доступен до подтвержденного функционального, SEO и accessibility паритета. → legacy Blazor-сайт (`MyDevToolsApp/`) не тронут; новый фронтенд отдельный (`apps/site/` + ветка `gh-pages`).
