# Tool UI kit — общий слой UI инструментов (Фаза 1)

Автор: агент `foundation`, 2026-10-06 (UTC+6). Эталон миграции: `hash-calculator`.

## Зачем

31 из 39 инструментов заново объявляли в scoped `<style>` свои `.primary-btn`, `.ghost-btn`, `.field-label`, `.file-btn`, `.progress-*`, `.<prefix>-error`, `.<prefix>-drop` и т. п. Определения расходились (padding 0.5–0.65rem, radius `--mdt-radius` vs `--mdt-radius-sm`, hover через `filter`/`opacity`/border, у части нет `:disabled`, у полей свой outline вместо focus-ring DS). Вдобавок **scoped-стили Astro не действуют на DOM, созданный контроллером** (`innerHTML`/`createElement`): например, строки результата hash-calculator (`.result-row`) фактически были без стилей.

Решение — глобальные классы `ds-*` поверх примитивов Prism и токенов `--mdt-*`, плюс тонкие Astro-компоненты и небольшой TS-хелпер.

## Файлы

| Файл | Что внутри |
| --- | --- |
| `apps/site/src/styles/global.css` | Примитивы Prism (`@layer components`): `ds-btn`, `ds-btn-primary`, `ds-btn-small`, `ds-icon-btn`, `ds-field`, `ds-field-textarea`, `ds-field-select`, `ds-check`, `ds-radio`, `ds-switch`, `ds-chip`, `ds-chip-cat`, `ds-panel`, `ds-progress`, `ds-spinner`, `ds-dialog`, `ds-scrim`, `seg`, `alert`/`ds-alert-*`, `toast`, `skeleton`, `[data-tip]`. Импортирует `tool-ui.css`. |
| `apps/site/src/styles/tool-ui.css` | **Новый.** Составные классы инструментов, `@layer tools` (см. каталог ниже) + `forced-colors`. |
| `apps/site/src/components/tool/*.astro` | **Новые** компоненты-«сахар»: `Field`, `FileButton`, `FileDrop`, `Progress`, `OutputPanel`, `StatusMessage`. |
| `apps/site/src/scripts/tool-ui.ts` | **Новый.** `copyWithFeedback()`, `bindDropzone()`; с раунда 4 — `revealOutput()`, `startPreparing()`/`withPreparing()`. |
| `apps/site/src/lib/format.ts` | Добавлены `formatBytes()`, `formatMs()`, `progressPercent()` (тесты — `test/format.test.ts`). |

### Каскад (важно)

`@layer reset, tokens, base, utilities, components, tools`. Всё общее — в слоях; **scoped-стили инструментов не в слое, поэтому всегда побеждают**. Следствия:

- Немигрированные инструменты не меняются: новые классы не совпадают с их локальными именами.
- При миграции **удалите локальное правило с тем же назначением** — иначе локальный `.ghost-btn {…}` или `textarea {…}` молча перебьёт общий вид.
- Локальная правка общего класса (`.ds-btn { padding: … }` в scoped style) — запрещена; если нужен вариант — запрос агенту `foundation` (через отчёт).
- **Атрибут `hidden` авторитетен на всём сайте** (с 2026-10-06, после Фазы 2): в `@layer reset` стоит `[hidden]:not([hidden="until-found"]) { display: none !important }`. Важное объявление в самом раннем слое побеждает любые scoped `display:flex|grid`. Контроллеры просто переключают `el.hidden`; локальные `.foo[hidden] { display: none }` не нужны. Показать элемент с `hidden` через CSS теперь нельзя.

## Каталог классов

### Раскладка

| Класс | Назначение |
| --- | --- |
| `ds-tool-grid` | 2 колонки ≥900px, 1 колонка ниже. Пропорции — переменной `--ds-tool-grid-cols` в локальном стиле (`minmax(0,1.4fr) minmax(0,1fr)`). |
| `ds-stack` | Вертикальный flex, `gap: 1rem`, `min-width: 0`. |
| `ds-card` | Панель с отступом (`ds-panel` + padding 1.1/1.2rem). |
| `ds-card-head` / `ds-card-title` | Шапка карточки: mono-uppercase заголовок слева, `.ds-actions` справа. |

### Поля

| Класс | Назначение |
| --- | --- |
| `ds-field-group` | Колонка label + control + hint. |
| `ds-label` | Подпись поля (0.8125rem, 600, muted, `margin-bottom: 6px`). На `<label for>` или `<span>`/`<legend>`. |
| `ds-label-row` + `ds-label-aside` | Подпись со счётчиком/ссылкой справа (`Selected: 3`). |
| `ds-hint`, `ds-hint-error` | Подсказка под полем / текст ошибки поля. |
| `ds-input-group` | Поле + кнопка(и) в один ряд: пароль + «показать», результат + copy/download, hex + `ds-color-well`, ввод + «Вычислить». Поля растягиваются, кнопки — нет; `ds-icon-btn` внутри по высоте поля. |
| `ds-color-well` (+ `ds-color-well-wide`) | `<input type="color">`: высота как у `ds-field`, рамка и радиус DS, свотч без системной рамки. |
| `ds-field`, `ds-field-textarea`, `ds-field-select` (+ `.mono`) | Примитивы. Новое: `[aria-invalid="true"]` → красная рамка; `[readonly]` → фон `surface-muted`; textarea `min-height: 6rem`. |
| `ds-settings`, `ds-settings-wide`, `ds-settings-flat` | Сетка настроек auto-fill `minmax(11rem,1fr)` во вложенной рамке; `-wide` — на всю строку; `-flat` — без рамки/фона. |
| `ds-check`, `ds-radio`, `ds-switch` | Примитивы (appearance none, цвет категории). |
| `ds-check-row` | `<label>` с чекбоксом/радио + текст; при `:disabled` — приглушение. |
| `ds-check-group` | `<fieldset>` без рамки; `<legend class="ds-label">`. |
| `seg` | Сегментированный переключатель (`button[aria-pressed=true]` или `.on`). |

### Кнопки

| Класс | Назначение |
| --- | --- |
| `ds-btn` | Вторичная кнопка (бывш. `ghost-btn`/`secondary-btn`). |
| `ds-btn ds-btn-primary` | Основное действие (градиент категории). Одна на группу. |
| `ds-btn ds-btn-small` | Компактная (copy в строке, cancel в прогрессе). |
| `ds-btn ds-btn-ghost` | Тихая кнопка без рамки — действия в шапке панели (paste/sample/copy). |
| `ds-btn ds-btn-danger` | Деструктивная вторичная (clear all/delete). |
| `ds-btn ds-btn-block` | На всю ширину. |
| `ds-btn-link` | Кнопка-ссылка (reset, «очистить файл»). **Без** `ds-btn`. |
| `ds-icon-btn` | Квадратная иконка 34px; обязателен `aria-label`. |
| `ds-actions`, `ds-actions-end` | Ряд кнопок (wrap, gap 0.6rem); `-end` — выравнивание вправо. |
| Состояния | `:disabled`/`aria-disabled="true"` → opacity .45; `aria-busy="true"` → спиннер перед текстом; `.is-copied` → зелёный (ставит `copyWithFeedback`); `:focus-visible` — глобальное 2px кольцо. |

### Файлы

| Класс / компонент | Назначение |
| --- | --- |
| `ds-btn ds-file-btn` (`FileButton`) | `<label>` вокруг `<input type="file">`. Input **визуально скрыт, но фокусируем** (не `hidden`!) → клавиатура и кольцо фокуса на label работают. |
| `ds-file-row`, `ds-file-name` | Ряд «кнопка + имя файла (+ ссылка очистить)»; пустое имя скрыто (`:empty`). |
| `ds-dropzone` (`FileDrop`) | Зона drop: пунктир цвета категории, `.is-dragover` (рамка, фон, scale 1.005, подъём иконки), `aria-disabled`, `.has-file`. Части: `ds-dropzone-icon`, `ds-dropzone-title`, `ds-dropzone-sub`. Внутри — видимая `ds-file-btn` (текст в `ds-file-btn-text`) для клавиатуры. Зона — `role="group"` с именем из заголовка. |
| `ds-dropzone-compact` (`FileDrop compact`) | Однострочная зона для инструментов, где файл вторичен (base32/58/64, hex, openssh): иконка 36px · заголовок + подзаголовок · кнопка; слот — следующей строкой. На ≤480px кнопка уходит вниз. |
| `ds-file-list`, `ds-file-item`, `ds-file-item-name`, `ds-file-item-meta`, `ds-file-item-actions` | Список выбранных файлов (PDF/изображения). Имя с ellipsis на широком экране; **на ≤480px строка складывается в колонку, имя переносится**, действия уходят вниз. `ds-file-item-name-wrap` — перенос всегда. Первый ребёнок `ds-file-item` получает `min-width: 0`. |
| `ds-file-row` | Если все дети пустые/`hidden`, ряд схлопывается (без лишнего отступа). |

### Прогресс, вывод, статусы

| Класс / компонент | Назначение |
| --- | --- |
| `ds-progress-block` (`Progress`) | Обёртка: `ds-progress-head` (`ds-progress-title`, `ds-progress-value` — пилюля %, кнопка cancel справа), `ds-progress` + `<i>` (ширина из контроллера, старт 0), `ds-progress-label` (mono). `ds-progress.is-indeterminate` — бегущая полоса (`<Progress indeterminate>`). |
| `ds-output` (`OutputPanel`) | Шапка `ds-output-head` (label + `ds-actions` справа) над полем/блоком результата. |
| `ds-output-summary` (`OutputPanel summaryProps`) | Строка-сводка под результатом, `role="status" aria-live="polite"`, скрыта пока пуста. Заполнять `setLiveText()` — изменение `value` у readonly textarea скринридер не озвучивает (пример: html-entity-encoder, «Результат: 53 симв.»). |
| `ds-code-block` | Read-only mono результат (`pre`/`div`): pre-wrap, перенос длинных токенов, `max-height: 28rem` со скроллом. |
| `ds-result-list`, `ds-result-row`, `ds-result-key`, `ds-result-value` | Строки «ключ → значение → кнопка» (хэши, детали), **разделённые линиями, без вложенных карточек** (с 2026-10-06, Фаза 3). Отдельно стоящий список — одна рамка `surface-inset`; внутри `.ds-card`/`.ds-output` (или `-flush`) рамка снимается. Колонка ключа — `--ds-result-key-w` (6rem). На ≤560px значение уходит на вторую строку. Строка вне списка сохраняет старый «коробочный» вид. |
| `ds-result-row-info` / `ds-result-row-bare` / `ds-result-row-index` | Варианты: «ключ + значение» без кнопки (image-resizer); «значение + кнопка» без ключа (история паролей); узкая колонка 2.5rem под номер (uuid). `-info`/`-bare` остаются в одну строку и на телефоне. |
| `ds-alert ds-alert-error\|success\|warning\|info\|neutral` (`StatusMessage`) | Блочное сообщение. error → `role="alert"`, прочие → `role="status"`. **`ds-alert-info` и `ds-alert-neutral` нейтральные** (текст, рамка `--mdt-border`, фон `surface-inset`): на странице инструмента `--mdt-accent` = цвет категории, и на красных/оранжевых категориях (crypto, jwt) акцентный info выглядел как ошибка. Старый `.alert-info` (только `/design`) остался акцентным. |
| `ds-status` + `.is-success\|.is-error\|.is-warning` | Короткий инлайн-статус (valid/invalid, счётчики). |
| `ds-badge`, `ds-badge-cat\|success\|warning\|danger` | Пилюля статуса (строка файла: working/done/error). |
| `ds-empty` | Пустое состояние списка (mono, faint, по центру). Для пустого редактора/вывода — `ds-empty-state` (см. «Фаза 3»). |
| `ds-spinner` | Примитив; теперь `display: inline-block` — сохраняет размер и вне flex-родителя. |
| `ds-dialog` + `::backdrop` | Нативный `<dialog class="ds-dialog">` (`showModal`) получает общий scrim: токен `--mdt-scrim` (его же использует `.ds-scrim`) + blur 3px. Свой `::backdrop` в инструменте не пишите. |
| `ds-chip` | Неинтерактивная метка (примитив). |
| `ds-chip-list`, `ds-chip-btn` | Кликабельные пресеты (cron, единицы); `aria-pressed="true"` — выбран. Цвета — через `--ds-chip-bg`/`--ds-chip-border` (раунд 6, touch-«пилюля»). |

### Конвенции состояний

- Runtime-состояния — классы `is-*` (`is-dragover`, `is-copied`, `is-success`, `is-error`, `is-indeterminate`) или ARIA (`aria-busy`, `aria-invalid`, `aria-pressed`, `aria-disabled`). Не изобретайте `copied`, `drag-over`, `<prefix>-dragover`, `checked`.
- Цвет акцента внутри инструмента — `var(--mdt-cat)` / `var(--mdt-accent)` (на странице инструмента `--mdt-accent` = цвет категории). Никаких хардкод-цветов.
- `forced-colors`: в `tool-ui.css` фокус полей заменяется на `outline: Highlight`, отмеченные `ds-check/ds-radio`, заливка прогресса и активные состояния — системные цвета. Свой локальный стиль с `box-shadow`-фокусом в HC невидим — не делайте так.

## Фаза 3: workbench, пустые состояния, результаты, копирование (2026-10-06, агент `K-tool-kit`)

Цель — читать инструмент как верстак «ввод → настройка → результат». Всё ниже — opt-in: немигрированные инструменты выглядят как раньше, кроме общих улучшений (disabled-primary, FileDrop, строки результата, копирование).

### Новые классы

| Класс | Назначение |
| --- | --- |
| `ds-workbench` | Сетка ввод \| вывод: 2 **равные** колонки ≥900px, стопка ниже; gap 16px; панели выровнены по верху (пустой вывод остаётся компактным). `-single` — всегда одна колонка; `-stretch` — равная высота панелей; дети `.ds-workbench-wide` — на обе колонки. Треки — `--ds-workbench-cols`. `ds-tool-grid` остаётся для старых раскладок. |
| `ds-panel-head` | Шапка панели ~48px: заголовок слева, действия справа, перенос на узких экранах. Первым ребёнком `.ds-card` становится полосой во всю ширину карточки с линией снизу. |
| `ds-panel-title` | Заголовок панели (sentence case, 15px/600) с 2px линией цвета категории слева. На `<label for>`, если в панели одно поле; иначе `h2`/`h3`/`span`. **Не** uppercase-микроподпись. |
| `ds-panel-meta` | Тихая mono-метка после заголовка (счётчик символов, имя файла). |
| `ds-panel-actions` | Действия уровня панели справа: `ds-btn ds-btn-small ds-btn-ghost` (Open = ghost `ds-file-btn`, Paste, Clear, Copy, Download). Высота 36px, 44px на touch и ≤480px (раунд 6). |
| `ds-action-row` (+ `ds-action-row-aside`) | Ряд основного действия **сразу под настройками**: primary первым, затем вторичные; кнопки 44px; `-aside` (пояснение «сначала выберите файл», инлайн-статус) уходит вправо. На ≤480px primary — на всю ширину. `ds-action-row-aside-when-disabled` — подсказка-предусловие видна, только пока `.ds-btn-primary` ряда `disabled` и не `aria-busy` (свяжите с кнопкой через `aria-describedby`). |
| `ds-editor` | Обёртка поля ввода (`textarea` или `.mdt-cm`) под оверлей пустого состояния. Textarea внутри — `min-height: 20rem` (11rem на ≤560px), `resize: vertical` сохраняется. `ds-editor-compact` — короткие вводы (timestamp, содержимое QR): `min-height: 8rem`. |
| `ds-empty-state` (+ `ds-empty-state-hint`) | Пустое состояние: короткая подсказка + необязательная кнопка «Load example». Должно быть **прямым ребёнком хоста с классом `is-empty`**. В `.ds-editor` — оверлей по центру поля (клики проходят в поле, интерактивна только кнопка); в остальных местах (панель вывода) — компактная пунктирная заглушка ~72px. Без `is-empty` у хоста скрыто. |
| `ds-when-filled` | Тело результата (readonly textarea, `ds-code-block`, `ds-result-list`), скрытое, пока хост `is-empty`. Растёт, когда появились данные. |
| `ds-result-headline` (`-label`, `-value`, `-meta`) | Одна главная метрика крупно (контраст, энтропия, итоговый размер): подпись, mono-значение 24–34px, кнопка копирования справа, тихая строка/сетка вторичных исходов (`-meta`, напр. AA/AAA) ниже. |
| `ds-result-list-flush` | Список результатов без рамки вне карточки. |
| `ds-copy-faces`, `ds-copy-face(-idle\|-done\|-fail)` | Грани кнопки копирования (ставит `prepareCopyButton`/`CopyButton`); вручную не пишите. |
| `.is-copy-failed` | Состояние кнопки при неудачном копировании (красный, ⚠ **только иконка**; текст ошибки — в `aria-label`/`title` и в polite-объявлении). |
| `ds-settings-checks` (+ `-inline`) | Ячейка чекбоксов внутри `ds-settings`: `align-self: end` и высота не меньше поля, поэтому чекбоксы стоят на одной линии с соседними select/input (у которых подпись сверху). На `<div>` или `<fieldset class="ds-check-group ds-settings-checks">` (legend остаётся сверху). `-inline` — чекбоксы в строку с переносом. Заменяет локальные `.json-checks { align-self: end; … }`. |
| `.is-empty` | Состояние хоста пустого состояния (ставит разметка, переключает `syncEmptyState`). |

Общие правки, действующие на всех: disabled `ds-btn-primary` — плоская нейтральная заливка без свечения и с faint-текстом (busy-кнопка сохраняет акцент); у `ds-btn` добавлен переход `color`, у `ds-icon-btn` — явный список переходов вместо `all` (150ms); при `prefers-reduced-motion` подъём кнопок, scale dropzone и сдвиги иконок отключены; `ds-dropzone` — ~180px на десктопе (`min-height: 11.25rem`), иконка 40px, кнопка выбора файла 44px (и в `compact`); CodeMirror — 320–400px по умолчанию.

### Новые компоненты

| Компонент | Props | Рендер |
| --- | --- | --- |
| `ToolPanel` | `title`, `for?`, `as?` (`h2`/`h3`/`span`), `meta?`, `metaProps?`, `empty?`, slot `actions`, slot | `section.ds-card.ds-stack[.is-empty]` > `.ds-panel-head` (`.ds-panel-title` + `.ds-panel-meta` + `.ds-panel-actions`) > slot |
| `OutputPanel` (расширен) | + `panel?`, `emptyHint?`, `emptyProps?` | `panel` → `ds-card` + `ds-panel-head` вместо `ds-output-head`; `emptyHint` → корень `is-empty` + `.ds-empty-state`. Без новых props — как раньше. |
| `EmptyState` | `hint`, `hintId?`, `exampleLabel?`, `buttonProps?`, slot | `div.ds-empty-state` > `p.ds-empty-state-hint#hintId` + `button.ds-btn.ds-btn-small` |
| `CopyButton` | `label`, `copiedLabel`, `failedLabel?`, `iconOnly?`, `ghost?`, `icon?` (true) | `button.ds-btn.ds-btn-small[.ds-btn-ghost]` или `button.ds-icon-btn[aria-label]` с тремя гранями, отрисованными на сервере. Ширина резервируется только под «копировать» / «✓ скопировано»; грань ошибки — только ⚠ (длинный `failedLabel` ширину не раздувает). В `.ds-panel-actions` на ≤480px текст визуально скрыт (остаётся доступным именем) — кнопка становится иконкой, чтобы действия шапки не уезжали на вторую строку в ru/de. |

### Новые TS-хелперы (`@/scripts/tool-ui`)

- `copyWithFeedback(btn, text, copiedLabel, ms = 1500, { failedLabel?, announce? = true })` — **только после успешной записи** в буфер: ✓ + `copiedLabel` на самой кнопке (`.is-copied`), объявление через общий polite live-регион, `aria-label` → `copiedLabel`. При неудаче: ⚠ (только иконка) и `.is-copy-failed`; `failedLabel` (из опций или `data-copy-failed-label`) временно ставится в `aria-label` и `title` и объявляется через live-регион, затем атрибуты восстанавливаются. Содержимое меняется через грани в одной grid-ячейке — **ширина не меняется** (резерв — только под idle и «Copied»). Если Clipboard API нет/отказал — пробует `execCommand("copy")`. `copiedLabel = null` — без подписи (только ✓). Старые вызовы `(btn, text, copiedLabel, ms)` работают; у немигрированных кнопок грани создаются при первом клике (ширина фиксируется на максимуме один раз) — чтобы не было и этого скачка, используйте `CopyButton` или `prepareCopyButton()` при инициализации.
- `prepareCopyButton(btn, copiedLabel, failedLabel?)` — обернуть содержимое кнопки в грани заранее (идемпотентно). Пустая icon-only кнопка (`ds-icon-btn` с одним `aria-label`, создана контроллером) получает иконку копирования как idle-грань.
- `announce(text)` — общий скрытый `role="status"` регион.
- `syncEmptyState(host, isEmpty)` — переключить `is-empty` (и, с раунда 6, выключить кнопки копирования панели, пока пусто). Вызывайте после **каждой** программной записи (`textarea.value = …` событий не шлёт).
- `bindEmptyState(host, field)` — синхронизация по `input`/`change` + сразу; возвращает `sync()`.
- `setFieldValue(field, value)` — записать значение и отправить `input` (сработают и обработчики инструмента, и `bindEmptyState`).
- `bindLoadExample(button, apply, focusTarget?)` — пример вставляется **только по клику**; после `apply` фокус уходит в поле внутри `.ds-editor` (кнопка исчезает вместе с оверлеем — иначе фокус потеряется). Возвращает unbind.

### Строки (locale)

Общие: `common/Common_EmptyHint` («Paste your data here or load an example.»), `Common_LoadExample`, `Common_Copy`, `Common_Copied`, `Common_Open`, `Common_Download`, `Common_Output`. Подсказка, специфичная для инструмента, и подсказка пустого вывода — в `tools/<slug>.json` во всех 10 языках (напр. `emptyHint`, `outputEmpty`). Пример данных (`EXAMPLE`) — константа в контроллере, не перевод. `failedLabel` — существующий `copyFailed` инструмента, если есть.

### Рецепт миграции (для агентов миграции)

1. **Раскладка.** `<div class="ds-workbench">` с двумя панелями: ввод (`ToolPanel`) и вывод (`OutputPanel panel`). Один редактор (json/xml/yaml, markdown) — `ds-workbench ds-workbench-single` или без сетки. Не навязывайте две колонки инструментам с одним рабочим полем.
2. **Шапки.** Open/Paste/Clear — в `slot="actions"` панели ввода; Copy/Download — в `slot="actions"` вывода. Все ghost-small. Убрать общий «тулбар со всем подряд».
3. **Настройки** (`ds-settings`; группа чекбоксов рядом с select — `ds-settings-checks`, локальный `align-self: end` удалить) — под полем ввода в той же панели (или `ds-workbench-wide` между рядом и панелями, если общие). **Основное действие** — `ds-action-row` сразу под настройками; пояснение недоступности — `ds-action-row-aside` (строка в locale).
4. **Пустые состояния.** Поле ввода — в `.ds-editor.is-empty` + `EmptyState` (подсказка + «Load example», если пример осмыслен); убрать дублирующий `placeholder` или сократить его. Вывод — `OutputPanel emptyHint=…`, тело с `ds-when-filled`. В контроллере: `bindEmptyState(host, textarea)`, `syncEmptyState(outputPanel, !result)` после каждого пересчёта/очистки, `bindLoadExample(btn, () => setFieldValue(textarea, EXAMPLE))`.
5. **Результаты.** Списки «ключ → значение» — `ds-result-list` / `ds-result-row` (кнопка — `CopyButton iconOnly` или `ds-btn-small ds-btn-ghost`); одна ключевая метрика — `ds-result-headline`. Убрать вложенные карточки и локальные `grid-template-columns` (ширина ключа — `--ds-result-key-w`).
6. **Копирование.** Разметка — `CopyButton`; для кнопок, созданных контроллером, — `prepareCopyButton(btn, strings.copied)` сразу после создания. Клик — `copyWithFeedback(btn, text, strings.copied, undefined, { failedLabel: strings.copyFailed })`. Свой текст «Copied!» / тост / `setTimeout` для отката — удалить.
7. **Проверка.** 1440/375, светлая/тёмная, пусто → пример → результат → копирование → очистка (пустое состояние вернулось), Tab-фокус после «Load example» в поле, нет горизонтального скролла.

```astro
---
import ToolPanel from "@/components/tool/ToolPanel.astro";
import OutputPanel from "@/components/tool/OutputPanel.astro";
import EmptyState from "@/components/tool/EmptyState.astro";
import CopyButton from "@/components/tool/CopyButton.astro";
---
<div class="ds-workbench" data-x-tool>
  <ToolPanel title={s.inputLabel} for="x-in" meta="" metaProps={{ "data-x-count": true }}>
    <Fragment slot="actions">
      <label class="ds-btn ds-btn-small ds-btn-ghost ds-file-btn"><input type="file" data-x-file />{c.open}</label>
      <button type="button" class="ds-btn ds-btn-small ds-btn-ghost" data-x-clear>{s.clear}</button>
    </Fragment>
    <div class="ds-editor is-empty" data-x-input-host>
      <textarea id="x-in" class="ds-field-textarea mono" aria-describedby="x-in-empty" data-x-input></textarea>
      <EmptyState hint={s.emptyHint} hintId="x-in-empty" exampleLabel={c.loadExample}
        buttonProps={{ "data-x-example": true }} />
    </div>
    <div class="ds-settings">…ds-field-group…</div>
    <div class="ds-action-row">
      <button type="button" class="ds-btn ds-btn-primary" data-x-run>{s.run}</button>
      <button type="button" class="ds-btn" data-x-swap>{s.swap}</button>
    </div>
  </ToolPanel>

  <OutputPanel panel label={c.output} for="x-out" emptyHint={s.outputEmpty} data-x-output-panel>
    <Fragment slot="actions">
      <CopyButton ghost label={c.copy} copiedLabel={c.copied} failedLabel={s.copyFailed} data-x-copy />
      <button type="button" class="ds-btn ds-btn-small ds-btn-ghost" data-x-download>{c.download}</button>
    </Fragment>
    <textarea id="x-out" class="ds-field-textarea mono ds-when-filled" readonly rows="10" data-x-output></textarea>
  </OutputPanel>
</div>
```

```ts
import { bindEmptyState, bindLoadExample, copyWithFeedback, setFieldValue, syncEmptyState } from "@/scripts/tool-ui";

const syncInput = bindEmptyState(inputHost, input);          // call syncInput() after input.value = …
bindLoadExample(exampleBtn, () => setFieldValue(input, EXAMPLE));
function render(result: string) {
  output.value = result;
  syncEmptyState(outputPanel, result === "");
}
copyBtn.addEventListener("click", () =>
  void copyWithFeedback(copyBtn, output.value, strings.copied, undefined, { failedLabel: strings.copyFailed }));
```

Результаты-строки, созданные контроллером:

```ts
const row = document.createElement("div");
row.className = "ds-result-row";
row.innerHTML = `<span class="ds-result-key"></span><span class="ds-result-value"></span>`;
row.children[0].textContent = name; row.children[1].textContent = value;
const btn = document.createElement("button");
btn.type = "button"; btn.className = "ds-btn ds-btn-small ds-btn-ghost"; btn.textContent = strings.copy;
prepareCopyButton(btn, strings.copied);   // reserve width before the first click
row.append(btn);
```

CodeMirror: `<div class="ds-editor is-empty"><div class="mdt-cm" …></div><EmptyState … /></div>`; `syncEmptyState(host, editor.getValue() === "")` в обработчике изменений редактора; `bindLoadExample(btn, () => editor.setValue(EXAMPLE), editorContentEl)`.

## Раунд 4: обратная связь инструментов (2026-10-06, агент `r4-D`)

### Новые TS-хелперы (`@/scripts/tool-ui`)

- `revealOutput(panel)` — после **явного** действия (Generate, Compress, Beautify, Compare…) прокручивает панель результата в видимую область, если её верх не виден: ниже липкой шапки (+12px) или в нижних ~30% экрана. Если панель уже видна (десктопный workbench), скрыта или пуста по раскладке — ничего не делает. Smooth только без `prefers-reduced-motion`; фокус не трогает. **Не вызывайте** из живых обновлений по вводу, автозапуска при загрузке и смены настроек. Передавайте корень панели (`ToolPanel`/`OutputPanel`), а не внутреннюю textarea.
- `startPreparing(engine, { host, label, delay = 300 })` → `done()` — обратная связь первого запуска лениво загружаемого WASM-домена. Только первый вызов на ключ `engine` (имя домена: `hash`, `password`, `regex`, `image_tools`, `pdf`, `encoding`, `cryptography`, `structured_data`, `ipcalc`, `qrcode`; для worker-вариантов — `encoding:worker`, `cryptography:aead` и т. п.) за загрузку страницы: если через `delay` мс ответа нет, в `host` добавляется `.ds-preparing` (подпись `Common_Preparing` + тонкая неопределённая полоса цвета `--mdt-cat`), подпись один раз объявляется через общий polite-регион, у `host` ставится `.is-preparing` (панель прячет устаревший `.ds-when-filled`). `done()` убирает индикатор и помечает движок «тёплым» — вызывайте на результате, ошибке **и первом тике прогресса** (у файловых задач свой прогресс). Идемпотентно.
- `withPreparing(engine, promise, opts)` — то же для одного `await`: индикатор снимается, когда промис завершился.
- Host: `.ds-action-row` основной кнопки (`btn.closest(".ds-action-row")`), для живых инструментов без кнопки — панель вывода. Строка — `preparing: t(lang, "common", "Common_Preparing")` в JSON-островке инструмента.

### Новые классы

| Класс | Назначение |
| --- | --- |
| `ds-preparing` (`-text`, `-bar`) | Индикатор «Preparing…» (создаёт `startPreparing`, вручную не пишите). В `.ds-action-row` — рядом с кнопкой, в `.ds-card`/`.ds-output` — на всю ширину. При reduced motion полоса статична. |
| `.is-preparing` | Состояние host на время индикатора: прямые дети `.ds-when-filled` скрыты (`!important`, т. к. scoped-стили инструмента не в слое). |
| `ds-meter` (+ `> i`) | Сегментная шкала одной оценки (сила пароля): заливка `--ds-meter` 0..1, цвет по `data-level` 1–4 (danger → warning → `--mdt-cat` → success). `role="meter"` + `aria-valuenow/-valuetext` ставит контроллер. Переход ширины отключён при reduced motion. |

### Главные метрики (`ds-result-headline`)

- password-generator — шкала энтропии под паролем: «Очень надёжный · 103 бита» (`alphabetSize`/`entropyBits`/`strengthLevel`/`strengthFill` в `tools/password-settings.ts`, повторяют `build_charset` из Rust; пороги <50 / <70 / <100 / ≥100 бит; тесты в `test/crypto-tools.test.ts`). Считается по настройкам, с которыми пароль создан.
- image-compressor — «Изменение размера −85%» (цвет категории; «+N%», если файл вырос) + «Исходный → Сжатый».
- pdf-compressor — сводка пакета над списком: общий «−N%» и сумма размеров до → после.
- regex-tester — «Найдено совпадений» крупным числом (вместо счётчика в мете панели; хук `data-rx-count` сохранён).
- text-diff-viewer — «Изменённые строки +4 −3» (успех/опасность; для скринридера — скрытый текст «добавлено: 4»).
- Уже были: word-counter, color-converter, cron, ip-subnet, image-resizer/converter, pdf-merger, unit-converter.

## Раунд 5: сравнение изображений `ImageCompare` (2026-10-07, агент `r5-1`)

Компонент `components/tool/ImageCompare.astro` + контроллер `scripts/image-compare.ts` (`bindImageCompare(root, meta)` → `{ show(original, result), reset() }`); стили — раздел «Round 5 — ImageCompare» в конце `styles/tool-ui.css` (`ds-compare*`). Используют image-compressor, image-converter, image-resizer.

- Разметка: `<ImageCompare strings={…} idPrefix="imgc-cmp" data-imgc-compare />`; строки — ключи `Compare*` в locale JSON инструмента (`CompareTitle/Original/Result/Slider/ValueText/Zoom/Fit/Actual/ActualName/Viewport`, опционально `CompareChange` — скрытая подпись к «±N%», `CompareScaledNote` — подсказка под тулбаром). Стартует `hidden`: до первого результата заглушки нет.
- Наложение в одной рамке: оригинал («до») слева от разделителя, результат («после») справа (`clip-path` по `--ic-pos`); разделитель 2px, ручка 44px. У каждого слоя своя «шахматка», прозрачность не просвечивает другим изображением.
- Управление — нативный `<input type=range>` 0–100 (старт 50, визуально скрыт, фокус рисуется на ручке), `aria-label` + локализованный `aria-valuetext` («Result visible: 50%», шаблон `{percent}`; значение range — позиция разделителя слева, в тексте — видимая доля результата, 100 − N); стрелки/Home/End — нативные. Drag — pointer capture: в Fit по всей рамке (`touch-action: pan-y`, касание двигает ручку только после горизонтального движения), в 1:1 — только за ручку. Стиль пишется раз за кадр (rAF).
- Fit / 1:1 (`.seg`, `aria-pressed`). 1:1: `.is-actual`, пиксель источника = CSS-пиксель, вьюпорт с прокруткой получает `tabindex=0`, `role=region`, `aria-label`; ручка держится по вертикальному центру видимой области, разделитель прокручивается в вид при вводе с клавиатуры. Лупы по hover нет.
- `show()` декодирует оба изображения (`img.decode()`) до показа панели — инструменты раскрывают результат только после него. Нечитаемый браузером результат (TIFF/TGA) → сравнение скрыто; нечитаемый оригинал → `.is-single` (только результат).
- Мета под рамкой: что не сказано в главной метрике (`meta`: `originalDims/originalSize/resultDims/resultSize/change`). Компрессор — только размеры в px (в шапке уже размеры файлов и −N%); конвертер — px обеих сторон, размер оригинала и знаковое изменение; ресайзер — px и размер оригинала + изменение (в шапке уже px и размер результата). Рост файла — «+N%» нейтральным цветом, не «экономия» (`formatSizeChange` в `tools/image-tools.ts`).
- Компонент не владеет object URL: инструмент вызывает `reset()` (снимает `src`, отменяет rAF/устаревший `show`) перед `revokeObjectURL` на новом файле, новом результате и «Очистить».

## Раунд 5: точные указатели ошибок разбора в редакторах (2026-10-07, агент `r5-3`)

json-beautifier, json-to-typescript, xml-beautifier, yaml-beautifier-validator. Модель — `tools/parse-diagnostics.ts` (`ParseDiagnostic {messageKey, args, from, to, detail}`, офсеты UTF-16 = офсеты CodeMirror; `from: null` — место неизвестно, `from === to` — точка вставки).

- Позиции — только от своих сканеров/парсера, не из текста исключений движка: `locateJsonError` (строгий сканер RFC 8259), `locateXmlError` (минимальная проверка well-formedness; если сканер «не уверен» — line/col из `<parsererror>` через `xmlEngineDiagnostic`), `yamlDiagnostic` (маркер yaml-rust из WASM). Колонки — 1-based по code points; табы = 1, CRLF/CR/LF, EOF.
- Редактор: `createEditor({ diagnostics: { box, goToLabel, keepPanelOnEdit? } })`, затем `editor.setDiagnostic(presentDiagnostic(strings, diag, text), { announce })` / `setDiagnostic(null)`. Подчёркивание токена (или каретка вставки на EOF), подсветка строки, отметка в гуттере, `aria-invalid` + `aria-describedby` на сообщение; любая правка снимает подсветку. «Go to error» (44px) — `revealDiagnostic()`: фокус, выделение, прокрутка `nearest` с учётом sticky-шапки.
- Панель — `<StatusMessage kind="error" role="none" class="mdt-diag" id="…-editor-error">` (без live-роли): озвучка один раз через `announce()` только по явному действию (Format/Validate/Convert/Ctrl-Enter), не при вводе и не при автоформате от настроек. Живая проверка (json-to-typescript) — `keepPanelOnEdit`: панель тускнеет (`.is-stale`) до перепроверки.
- Строки — ключи `Diag_*` в `tools/json-beautifier` (все 10 языков), в остров попадают через `diagnosticStrings(lang)` (`tools/editor-phrases.ts`); `SyntaxNoLocation` — локальная подмена инструмента («Invalid JSON. Please check your input.»). Стили — `styles/codemirror.css` (`cm-mdt-diag-*`, `.mdt-diag*`). Тесты — `test/parse-diagnostics.test.ts`.

## Раунд 6: кит и оболочка (2026-10-07, агент `r6-F1`)

- **Пустое копирование.** `copyWithFeedback(btn, "", …)` — тихий no-op: сразу `false`, без ✓/⚠, без объявления и без записи в буфер. `syncEmptyState(host, isEmpty)` теперь ещё и выключает кнопки копирования (`button` с `.ds-copy-faces`) в шапке панели, которой принадлежит хост (сам хост — `ToolPanel`/`OutputPanel`, или его родитель-панель, если хост — прямой дочерний `.ds-editor`), пока хост пуст. Включает обратно только те, что выключил сам (`data-ds-empty-disabled`), поэтому собственная логика `disabled` контроллера не ломается. `bindEmptyState()` получает это автоматически.
- **Touch-цели 44px** — `@media (pointer: coarse), (max-width: 30rem)` в `tool-ui.css` (десктоп с мышью не меняется): `ds-btn-small` (в т.ч. «Load example» и ghost-кнопки шапок), кнопки `ds-panel-actions`/`ds-result-row`, `ds-field-select` — `min-height: 44px`; `ds-icon-btn` — 44×44 (в `ds-input-group` — ширина 44, высота по полю); `ds-check-row` — `min-height: 44px` (у `ds-check-group` gap 0); `ds-btn-link` и ссылка `ds-related-hint` — `inline-block` с `padding-block`/равным отрицательным `margin-block` (бокс 44px, строка не растёт); `ds-chip-btn` — сам бокс 44px и прозрачный, видимая «пилюля» ~30px рисуется `::before` теми же `--ds-chip-bg`/`--ds-chip-border` (у `ds-chip-list` row-gap 0). Заливку/рамку чипа меняйте через эти переменные, а не `background`/`border-color`.
- **Шапка панели в длинных локалях.** `.ds-panel-title` — `flex: 1 1 7rem`: заголовок сначала переносит собственный текст, и только потом действия уходят на вторую строку (там они — один ровный ряд, прижатый вправо). С `ds-panel-meta` заголовок не растягивается. На ≤480px ghost-кнопки действий с иконкой (`> svg`: Download, Upload…) сворачиваются в иконку 44px, текст скрыт `font-size: 0` и остаётся доступным именем — как у `CopyButton`.
- **`ds-related-hint`** — перекрёстная ссылка на соседний инструмент (cron-generator ↔ cron-parser, jwt-encoder ↔ jwt-decoder): `<p class="ds-related-hint">Вводный текст <a href>Название</a></p>`. 13px, вводный текст `--mdt-text-muted`, ссылка — оттенок категории, смешанный с `--mdt-text` (72%), ≥4.5:1 в обеих темах; стрелка «→» ставится после ссылки (`::after`, скрыта от AT), ссылка переносится целиком (`inline-block`).
- **Контраст мелкого текста (светлая тема).** `--mdt-text-faint` `#6b7484` → `#646d7d`: ≥4.5:1 на panel, canvas, inset и surface-muted (было 4.37–4.40 у `ds-dropzone-sub`, `ds-file-item-meta`, `ds-hint`, невыбранных `.seg`). Тёмная тема без изменений. Текст `ds-chip-btn` при hover и `aria-pressed="true"` — оттенок категории, смешанный с `--mdt-text` (72%), вместо чистого `--mdt-cat` (было 3.80:1).
- **H1 инструмента ≤640px:** `letter-spacing: -0.02em; word-spacing: 0.06em` (пробел ~4.9px при 22px вместо 3.3px; fr/de/es больше не слипаются).

## Компоненты (`src/components/tool/`)

Опциональный сахар над классами; без клиентского JS. Все пробрасывают `id`/`class`/`data-*` на корень; хуки для внутренних элементов — через `*Props`.

| Компонент | Props | Рендер |
| --- | --- | --- |
| `Field` | `label`, `for?`, `hint?`, `hintId?`, `aside?`, `hintProps?`, `asideProps?`, slot (контрол), slot `aside` | `div.ds-field-group` > `label.ds-label` (или `span` без `for`) > slot > `p.ds-hint#<hintId или for-hint>`. На контроле ставьте `aria-describedby="<for>-hint"`. |
| `FileButton` | `label`, `accept?`, `multiple?`, `inputProps?`, `nameProps?`, slot (после имени) | `div.ds-file-row` > `label.ds-btn.ds-file-btn > input[type=file]` + `span.ds-file-name[aria-live]` |
| `FileDrop` | `title`, `buttonLabel`, `changeLabel?`, `sub?`, `compact?`, `accept?`, `multiple?`, `inputProps?`, slot | `div.ds-dropzone[role=group][aria-labelledby=title][aria-describedby=sub]` > иконка upload, заголовок, подзаголовок, `ds-file-btn`. `changeLabel` (обычно `common/Common_FileChangeButton`) включается `setDropzoneHasFile(zone, true)`. |
| `Progress` | `title?`, `barLabel?`, `cancelLabel?`, `cancelProps?`, `barProps?`, `fillProps?`, `labelProps?`, `indeterminate?`, `hidden` (по умолчанию `true`) | `div.ds-progress-block` > head > `div.ds-progress[role=progressbar] > i` > `span.ds-progress-label[aria-live]` |
| `OutputPanel` | `label`, `for?`, `summaryProps?`, slot `actions`, slot | `section.ds-output` > `.ds-output-head` (label + `.ds-actions`) > slot > (`p.ds-output-summary[role=status][aria-live=polite]`, если задан `summaryProps`) |
| `StatusMessage` | `kind?` (`error` по умолчанию), `role?`, `hidden` (по умолчанию `true`), slot | `p.ds-alert.ds-alert-<kind>` с ролью alert/status |

Пример хуков: `<FileButton label={s.file} inputProps={{ "data-b64-file": true }} nameProps={{ "data-b64-filename": true }} />`.

## TS-хелперы

- `@/scripts/tool-ui` → `copyWithFeedback(btn, text, copiedLabel, ms = 1500, { failedLabel?, announce? })` — см. «Фаза 3 → Копирование». Сигнатура обратно совместима; возвращает `false`, если скопировать не удалось (кнопка уже показала ⚠; своя локализованная ошибка — по желанию).
- `@/scripts/tool-ui` → `bindDropzone(zone, input, onFiles)` — `.is-dragover` (со счётчиком enter/leave), drop, клик по фону зоны открывает input, `change` input тоже вызывает `onFiles` и **затем сбрасывает `input.value`** (повторный выбор того же файла снова даёт `change`; храните полученные `File`, а не `input.files`). Учитывает `multiple` и `aria-disabled`. Возвращает unbind. Четвёртый аргумент `{ clickToOpen: false }` — зона оборачивает редактор (drop файла на textarea): клик ставит курсор, а не открывает выбор; `change` input по-прежнему вызывает `onFiles` (пример — openssh-keys).
- `@/scripts/tool-ui` → `setDropzoneHasFile(zone, hasFile)` — `.has-file` + смена текста кнопки на `changeLabel`.
- `@/scripts/tool-ui` → `setLiveText(el, text)` — обновить live-регион так, чтобы повтор того же текста тоже озвучивался.
- `@/lib/format` → `formatBytes(bytes, digits?)` (по умолчанию 1 знак, с GB — 2; `digits=2` = поведение image/pdf/aead-инструментов), `formatMs(ms)`, `progressPercent(processed, total)`. 13 контроллеров держат свои копии `formatBytes` — заменяйте, сверив формат вывода.

## Маппинг «старый локальный класс → общий»

Колонка «где» — инструменты, где класс найден в scoped `<style>` (инвентаризация 2026-10-06).

| Старый класс / паттерн | Где (кол-во) | Новый класс / компонент |
| --- | --- | --- |
| `.primary-btn` | 31 | `ds-btn ds-btn-primary` |
| `.ghost-btn`, `.secondary-btn` | 27 / 2 (url, yaml) | `ds-btn` |
| `.ghost-btn.danger` | json-to-ts, text-case, yaml | `ds-btn ds-btn-danger` |
| `.small-btn`, `.copy-btn` (текстовые) | base32, hex / color, cron-parser, hash, unit, uuid | `ds-btn ds-btn-small` (в шапке панели — `ds-btn-ghost`) |
| `.copy-btn` (иконка), `rx-icon-btn`, `imgr-clear`, `pdf*-remove` | cron-parser, unit, regex, image/pdf | `ds-icon-btn` (+ `aria-label`) |
| `.aead-password-row`, `.aead-result-row`, `.qrg-color-row`, `.crong-output-row`, `.ip-input-row` | aead, qr-gen, cron-gen, ip | `ds-input-group` (мигрировано) |
| `.color-well`, `.qrg-swatch` | color, qr-gen | `ds-color-well` (мигрировано) |
| `.jwtd-status.is-neutral` | jwt-decoder | `ds-alert-neutral` (мигрировано) |
| локальные `grid-template-columns` у `ds-result-row` | uuid, password, image-resizer | `ds-result-row-index` / `-bare` / `-info` (мигрировано) |
| `.rx-dialog::backdrop` | regex | общий `.ds-dialog::backdrop` (мигрировано) |
| `.<x>[hidden] { display: none }` | base64, image-converter, text-diff, qr-* , Header, InstallPrompt | не нужно — глобальное правило `[hidden]` (удалено) |
| `progressBar.classList.add("is-indeterminate")` | image-* | `<Progress indeterminate>` (мигрировано) |
| ручной `input.value = ""` после выбора файла | image-*, pdf-*, qr-*, openssh | делает `bindDropzone` (удалено); сброс в «Очистить» остаётся |
| `.copied`, `.crong-copy.copied` | cron-generator, cron-parser, openssh, unit | `.is-copied` через `copyWithFeedback()` |
| `.link-btn` | 7 (aead, base32/58/64, hash, hex, password) | `ds-btn-link` |
| `.generate-btn` | password | `ds-btn ds-btn-primary` |
| `<prefix>-actions` (`b32-actions`, `hash-actions`, `url-actions`, …), `.output-actions` | ~25 / 4 | `ds-actions` / `ds-actions ds-actions-end` |
| `.field-label`, `.progress-title` | 29 / 3 | `ds-label` / `ds-progress-title` (или `Field`, `Progress`) |
| `.file-hint` | 8 | `ds-hint` |
| `<prefix>-field-error` (`jwte-field-error`) | jwt-encoder | `ds-hint ds-hint-error` + `aria-invalid="true"` на поле |
| `textarea` в `.<prefix>-input/.<prefix>-output`, `.hmac-textarea`, `.wc-input` | ~20 | `ds-field-textarea` (+ `mono`) |
| `select` в `.setting`, `.hmac-select`, `.ent-select` | 8+ | `ds-field-select` |
| `input[type=text/number/search]` (`algo-search`, `value-input`, `imgr-field input`) | много | `ds-field` |
| `.setting` + `.settings-grid` / `.settings` | 6 / 3 / 2 | `ds-field-group` внутри `ds-settings` |
| `.setting-wide` | base32, hex | `ds-settings-wide` |
| `.check`, `.check-row`, `.imgr-check` | 5 / 3 / image-* | `ds-check-row` + `<input class="ds-check">` |
| `.check-group` | hex | `ds-check-group` |
| `.file-btn` + `input hidden` | 6 | `FileButton` или `label.ds-btn.ds-file-btn > input` (**без** `hidden`) |
| `.file-row`, `.file-name`, `.file-selected` | 6 / 6 / openssh | `ds-file-row`, `ds-file-name` |
| `<prefix>-drop` (`imgc/imgv/imgr/pdfc/pdfm/pdft/qrg/qrs/ssh-drop`), `.json-editor.drag-over` | 9 | `FileDrop` / `ds-dropzone` |
| `<prefix>-dragover`, `.drag-over`, `.qrg-active` | 10 | `.is-dragover` через `bindDropzone()` |
| `<prefix>-drop-text`, `-drop-title`, `-drop-sub`, `-icon` | 9 | `ds-dropzone-title`, `ds-dropzone-sub`, `ds-dropzone-icon` |
| `pdfm-row`/`pdft-cell-*`/`pdfc-cell-*` имя/размер/удалить | pdf-* | `ds-file-item*` (или оставить таблицу, но ячейки — глобальными классами) |
| `.progress-track` + `.progress-fill` | 6 | `ds-progress` > `<i>` |
| `.progress-head`, `.progress-label` | 3 / 5 | `ds-progress-head`, `ds-progress-label` (`Progress`) |
| `pdft-spinner`, `pdfc-spinner` | pdf-* | `ds-spinner` |
| `<prefix>-error` (`hash-error`, `b32-error`, `imgr-error`, …, `diff-alert-error`, `md-lib-error`) | ~30 | `StatusMessage kind="error"` / `ds-alert ds-alert-error` |
| `json-notification-*`, `xml-notification-*`, `diff-alert-*` | json, xml, diff | `ds-alert ds-alert-<kind>` |
| `.is-valid`/`.is-invalid`, `yaml-status`, `jwtd-sig-status`, `pdfm-status(-done)` | jwt-decoder, yaml, pdf-merger | `ds-status.is-success/.is-error` или `ds-badge-success/-danger` |
| `.card`, `<prefix>-card` (`crong/cronp/imgr/ip/pw/jwte-card`), `aead-panel`, `rx-panel`, `ent-panel` | ~10 | `ds-card` |
| `.card-title`, `aead-panel-title`, `pw-card-title` | cron-*, unit, aead, password | `ds-card-title` (в `ds-card-head`) |
| `<prefix>-output-head`, `aead-output-title` | jwt-encoder, aead | `OutputPanel` / `ds-output-head` |
| `<prefix>-output` (pre/div с текстом), `crong-output`, `url-output` | много | `ds-code-block` (или `ds-field-textarea readonly`) |
| `.result-row`, `pw-result-row` + `result-algo`/`result-hex` | hash, aead, password | `ds-result-row`, `ds-result-key`, `ds-result-value` |
| `.chip`, `.chips` (кликабельные) | cron-parser, unit | `ds-chip-btn`, `ds-chip-list` |
| `rx-empty`, `-empty` | regex, image-* | `ds-empty` |
| `<prefix>-grid` (2 колонки) | ~15 | `ds-tool-grid` (+ `--ds-tool-grid-cols`) |

Не трогаем общим слоем (остаются локально): превью изображений/QR, diff-подсветка, markdown-рендер, regex-подсветка совпадений, cron-таблицы.

**CodeMirror** — общая тема в `apps/site/src/styles/codemirror.css` (создана группой structured): хост редактора `<div class="mdt-cm">`, все правила под `.mdt-cm`, цвета только из `--mdt-*`, состояния хоста `.is-error`, `.is-dragover`, `:focus-within`, высота — `--mdt-cm-height` (по умолчанию с Фазы 3 `clamp(20rem, 50vh, 25rem)` = 320–400px, на узких экранах 20rem, максимум 400px). Импортируется только из json-beautifier, json-to-typescript, xml-beautifier, yaml-beautifier-validator (не из `global.css`). Новые редакторы подключают этот файл, а не пишут свои `.cm-*`.

## Правила для scoped `<style>` инструмента

Можно оставить:
- раскладку конкретного инструмента: grid/flex-шаблоны, ширины колонок, `max-height` списков, порядок на мобильных;
- уникальные визуальные элементы (превью, подсветка, диаграммы, тема CodeMirror) — только на токенах `--mdt-*`;
- переменные-настройки общего слоя (`--ds-tool-grid-cols`).

Нельзя:
- переопределять кнопки, поля, label, hint, file/progress/alert/chip — используйте `ds-*`;
- хардкод-цвета, собственные focus-стили (`outline: … ; outline-offset: 1px` у полей), `filter: brightness` на hover;
- писать `.foo[hidden] { display: none }` — уже глобально;
- стилизовать в scoped `<style>` элементы, которые создаёт контроллер, — до них стили не дойдут; используйте `ds-*` или (для специфики) `:global(...)` внутри корня инструмента: `.hash-tool :global(.foo)`.
- прятать `<input type="file">` атрибутом `hidden` — теряется клавиатура.

## Пример: hash-calculator, до/после

**До** (`HashCalculator.astro`, ~125 строк CSS): локальные `.field-label`, `textarea`, `.file-row/.file-btn/.file-name/.file-hint`, `.algo-search`, `.primary-btn/.ghost-btn/.link-btn`, `.progress-track/.progress-fill/.progress-label`, `.hash-error`, `.result-row/.result-algo/.result-hex/.copy-btn`. Строки результатов создавались `innerHTML` с этими классами — scoped-стиль на них не действовал (строки были без оформления); input файла был `hidden` (не доступен с клавиатуры); счётчик алгоритмов показывал только «Selected» без числа.

```astro
<label class="field-label" for="hash-textarea">{strings.inputLabel}</label>
<textarea id="hash-textarea" data-hash-textarea rows="8"></textarea>
<div class="file-row">
  <label class="file-btn"><input type="file" data-hash-file hidden />{strings.fileLabel}</label>
  <span class="file-name" data-hash-filename></span>
</div>
…
<button class="primary-btn" data-hash-calculate>…</button>
<div class="hash-progress" data-hash-progress hidden>
  <div class="progress-track"><div class="progress-fill" data-hash-progress-fill></div></div>
  <span class="progress-label" data-hash-progress-label></span>
</div>
<p class="hash-error" data-hash-error role="alert" hidden></p>
```

**После** (CSS — ~45 строк, только раскладка сетки и списка алгоритмов):

```astro
<div class="ds-stack" data-hash-tool>
  <div class="ds-tool-grid hash-grid">
    <section class="ds-card ds-stack">
      <Field label={strings.inputLabel} for="hash-textarea">
        <textarea id="hash-textarea" class="ds-field-textarea mono" data-hash-textarea rows="8"></textarea>
      </Field>
      <FileButton label={strings.fileLabel}
        inputProps={{ "data-hash-file": true }} nameProps={{ "data-hash-filename": true }} />
      …
  <div class="ds-actions">
    <button class="ds-btn ds-btn-primary" data-hash-calculate>…</button>
    <button class="ds-btn" data-hash-cancel hidden>…</button>
  </div>
  <Progress data-hash-progress barProps={{ "data-hash-progress-bar": true }}
    fillProps={{ "data-hash-progress-fill": true }} labelProps={{ "data-hash-progress-label": true }} />
  <StatusMessage kind="error" data-hash-error />
  <div class="ds-result-list" data-hash-results aria-live="polite" hidden></div>
</div>
<style>
  .hash-grid { --ds-tool-grid-cols: minmax(0, 1.4fr) minmax(0, 1fr); }
  .algo-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr)); … }
  .algo-item:has(:checked) { color: var(--mdt-cat); }
</style>
```

Контроллер: строки результата строятся через `createElement` с `ds-result-row/-key/-value` и кнопкой `ds-btn ds-btn-small ds-btn-ghost`; копирование — `copyWithFeedback(btn, hex, strings.copied)`; кнопка «Вычислить» получает `aria-busy` во время работы; прогресс — `progressPercent()` + `aria-valuenow`; `formatBytes/formatMs` — из `@/lib/format`; JS-переключение класса `.checked` у алгоритмов заменено на CSS `:has(:checked)`.

## Чек-лист миграции инструмента

1. Разметка: заменить классы по таблице; хуки `data-*` не трогать (контроллер ищет по ним).
2. Удалить из `<style>` все правила, ставшие общими; оставить раскладку.
3. Контроллер: классы в `innerHTML`/`className`/`classList` — на `ds-*`/`is-*`; копирование — `copyWithFeedback`; drop — `bindDropzone`; `formatBytes` — из `@/lib/format`.
4. Браузер: light/dark, 1440/375, фокус с клавиатуры (Tab до file-кнопки — кольцо на label), disabled/busy, ошибка, `hidden`-элементы действительно скрыты.
