# Этап 2 — Дизайн-система Prism (утверждено владельцем, Gate 2)

Базовая концепция: `concepts/d-prism.html`. Hi-fi макеты: `concepts/mock-tool.html` (типовая tool page), `concepts/mock-file-tool.html` (сложная file tool), `concepts/mock-mobile.html` (мобильная навигация + drawer). Общие токены макетов: `concepts/prism-base.css`. Скриншоты: `concepts/shots/`.

## 1. Signature-элементы бренда (узнаваемость)

1. **Категорийный цвет как система** — каждая из 13 категорий имеет свой hue; цвет в UI всегда означает категорию (tile-иконки, чипы, акценты tool page, точки в drawer). Никаких «декоративных» цветов.
2. **Tile-иконка** — 38–46px скруглённый квадрат с кастомной stroke-иконкой на тонированном фоне категории; на hover tile поворачивается −6° и увеличивается.
3. **Brand-badge** — градиентный ромб-квадрат `</>` (brand1→brand2) в логотипе, favicon и PWA-иконках.
4. **Ambient-монограммы** — медленно дрейфующие монограммы инструментов (`{}`, `0x`, `▦`, `⚿`) с mouse-parallax за контентом; только на главной, reduced-motion отключает.
5. **Privacy-pill** — зелёный «local only · no upload» бейдж на каждой tool page как часть визуального языка, а не сноска.

## 2. Semantic color tokens (WCAG-проверены, см. §8)

| Token | Dark | Light | Назначение |
|---|---|---|---|
| `--bg` / `--bg2` | `#0a0c12` / `#0e1119` | `#f6f7fb` / `#eef0f7` | канвас / вторичный канвас |
| `--panel` / `--panel2` | `#131722` / `#171c2a` | `#ffffff` / `#f5f6fc` | карточки, панели / вложенные поля |
| `--line` / `--line-soft` | `#232a3b` / `#1b2130` | `#e2e5f0` / `#eceef6` | границы / hairlines |
| `--text` | `#eef1f7` (17.3:1 AAA) | `#151a26` (16.2:1 AAA) | основной текст |
| `--muted` | `#97a1b5` (6.9 AA) | `#57627a` (6.1 AA) | вторичный текст |
| `--faint` | `#626d84` (3.4, только метки) | `#6b7484` (4.7 AA) | mono-метки, placeholder |
| `--brand1` | `#7c6cff` | `#6a5af9` | primary action, акцент бренда |
| `--brand2` | `#38e1c6` | `#0a8a6f` | второй конец градиента (декор/large) |
| `--ok` | `#34d399` (10.2 AAA) | `#0a7a52` (5.0 AA) | success, privacy |
| `--warn` | `#f5b544` | `#8a5a00` (5.9 AA) | warning |
| `--err` | `#f4636e` (6.4 AA) | `#cf2331` (5.0 AA) | error |
| `--focus-ring` | = brand1 | = brand1 | 2px outline + 2px offset |

Категорийные цвета (dark / light, light-варианты скорректированы до AA на белой панели):
encoding `#8b7bff`/`#6a5af9` · structured-data `#38bdf8`/`#0284c7` · text `#e2b93d`/`#8a6d00` · jwt `#fb923c`/`#c2410c` · regex `#4ade80`/`#15803d` · hashing `#f5b544`/`#996500` · cryptography `#f4636e`/`#cf2331` · generators `#2fd4a4`/`#067a60` · converters `#22d3ee`/`#0e7490` · design `#e879c9`/`#b0369b` · images `#f472b6`/`#c42f7e` · pdf `#ff6b5e`/`#d43d2f` · qrcode `#a3a3f5`/`#5b5bd6`

Правило: на одном экране — brand-акцент + цвета видимых категорий + один статусный цвет. Не больше.

## 3. Typography

- **Display/body:** Inter (self-hosted woff2, variable 100–900, subsets `latin` + `cyrillic`; CJK → system stack `system-ui, "PingFang SC", "Hiragino Sans", "Yu Gothic", "Noto Sans JP/KR/SC"`). Display = weight 650, letter-spacing −0.02…−0.035em.
- **Mono/data:** JetBrains Mono (self-hosted woff2, subsets latin+cyrillic) — хэши, JWT, IP, даты, код, kbd, метки, статусы. `font-variant-numeric: tabular-nums` для чисел/статистики.
- **Загрузка:** 2 файла (Inter var, JB Mono var), `<link rel="preload">`, `font-display: swap`, ноль внешних runtime-запросов. Целевой вес ≤ 120 KB на шрифт после сабсеттинга.
- **Scale (rem):** 0.625 (micro-mono), 0.75 (chip/label), 0.8125 (meta), 0.9375 (body-small), 1 (body), 1.25 (h3/card-title 600), 1.625 (h2/tool-title 650), 2.25–4 (display 650, clamp).
- **Line length:** prose ≤ 56–62ch; tool pages — не prose, контент в панелях.
- **Вертикальный ритм:** 4px базовый; секции главной 44–46px, внутри панелей 8/10/12/14/16/18.

## 4. Grid, spacing, breakpoints

- Max-width контента **1180px**, поля 24px (16px на mobile).
- Catalog grid: 3 колонки ≥1024px, 2 ≥640px, 1 < 640px; gap 14px (10px mobile).
- Tool page: content 1fr + sidebar 300px, схлопывается в 1 колонку < 900px; sidebar sticky top 76px.
- Spacing scale: 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 44, 48, 64, 72, 84.

## 5. Radius / shadow / blur / elevation

- Radius: chip 6–8, input/button 10, card 13–15, tile 11–13, pill 999. Одна система, не roulette.
- Elevation: тень = слой. Уровни: `e0` нет; `e1` hover-подъём `0 14px 34px −12px` в цвете категории; `e2` dropdown/drawer `0 12px 40px rgba(0,0,0,.35)`; `e3` modal. Нет «постоянных» теней у карточек.
- Blur: только header/backdrop overlay (14px) — служебный слой, не декор.

## 6. Motion rules

- Длительности: micro 120–180ms (hover, чипы), standard 200–300ms (карточки, drawer 380ms), entrance 400–700ms staggered (60–100ms step), счётчики 900ms.
- Easing: `cubic-bezier(.2,.8,.2,1)` везде (spring-like), linear только для spin/pulse.
- Назначение motion: подтвердить действие (copy → check), показать источник (drawer), смягчить появление (rise-in). Motion НЕ скрывает задержки — для ожидания progress-bar.
- `prefers-reduced-motion: reduce` → всё отключается (уже в base-моках).

## 7. Иконки

Собственный SVG-набор: viewBox 20×20, stroke 1.7, round caps/joins, без fill (кроме status-точек), оптический размер один; размеры 12/13/15/18/20/22 по контексту. Не смешивать внешние библиотеки.

## 8. Контраст (проверено до реализации)

Все текстовые пары ≥ 4.5:1 (большинство AA+/AAA), `--faint` в dark (3.44) — только крупные/декоративные метки, для мелких меток используется `--muted`. Light-тема скорректирована по результатам замера (faint, ok, err, warn, категорийные emerald/amber/pink затемнены до AA). Замер: скрипт WCAG-relative-luminance, значения в истории сессии; повторить для любого нового токена.

## 9. Информационная архитектура и discovery

- Home = каталог по категориям (13 секций, order 10–130), без отдельной страницы «каталога» — один уровень.
- Discovery: search (header + ⌘K palette), favorites, recent, related (sidebar tool page), category filter в drawer (mobile).
- Tool page anatomy: breadcrumb → head (tile + H1 + sub + privacy-pill) → IO-панели (основная колонка) + sticky sidebar (options → progressive disclosure через `details` → privacy/related).
- Progressive disclosure: primary actions видны сразу (input/convert/download), advanced настройки под `details`/secondary UI.

## 10. State matrix (для Stage 6)

default · hover · focus-visible (2px ring) · active · disabled (opacity .45, no-events) · loading (spinner/progress-bar) · drag-over (dropzone: border+scale+icon lift) · progress (градиентный bar + % пилюля) · success (зелёный check/status) · warning · error (красный status + inline message). Проверять пары «пусто/переполнено»: 0 результатов, сотни строк, длинный filename (ellipsis), несколько результатов.

## 11. Microinteractions

- **copy:** иконка → зелёный check + (опц.) toast «copied»; swap: rotate 180°; clear: fade содержимого 150ms.
- **file drop:** dropzone border→cat, scale 1.005, иконка приподнимается; **progress:** градиентный bar `fill` + % пилюля категории; **completion:** status done зелёный.
- **theme toggle:** иконка rotate 18° + scale; фон body crossfade 350ms.
- **navigation:** drawer slide 380ms + scrim fade; tabbar active color brand1.

## 12. Tone of voice / microcopy

Коротко, по-инженерному, без маркетинга. Примеры: privacy «local only · no upload»; empty input «Type or paste text to hash…»; dropzone «Drop images here — files never leave your device»; error «14.6 MB — exceeds 10 MB per-file limit» (факт + причина, без «oops»); offline «You're offline — everything still works». Запрещены: «AI-powered», эмодзи, восклицания.

## 13. Favicon / PWA / social / theme-color

Brand-badge (`</>` на градиентном скруглённом квадрате) — единый источник: favicon.svg (обе темы через media query), icon-192/512, apple-touch-icon (на непрозрачной подложке), og-image 1200×630 (badge + «39 tools · 100% local» + монограммы). `theme-color`: dark `#0a0c12`, light `#f6f7fb` через media.

## 14. Пустые/сложные состояния и особые страницы

Empty states, offline и 404 — в языке Prism: mono-метка статуса + одна primary-кнопка, без иллюстраций; 404 = «route not found» в terminal-эстетике (mono), со ссылкой в каталог. Плотные состояния: сотни строк — моноширинная таблица с sticky-header; длинные строки — ellipsis + copy всегда доступен.

## 15. Design review scorecard (критерии приёмки макетов/реализации)

1. Hierarchy: один focal point на экран. 2. Rhythm: 4px-ритм, секции 44px. 3. Typography: scale соблюдён, mono для данных. 4. Color: ≤ brand + категории + 1 статус; контраст AA. 5. Icons: единый stroke. 6. States: вся матрица §10. 7. Motion: длительности/easing из §6, reduced-motion. 8. Responsiveness: mobile-композиция отдельная (drawer, tabbar, 1-col). 9. Accessibility: focus-visible, aria на интерактиве. 10. Brand distinctiveness: узнаваем по §1 без логотипа.

## Gate 2

Концепция D «Prism» утверждена владельцем 2026-07-25 (выбор из A/B/C/D; A/B/C сохранены в `concepts/` как архив). `packages/ui-kit` не используется — компоненты Stage 6 проектируются под эту систему.
