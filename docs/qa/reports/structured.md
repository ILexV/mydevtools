# QA-отчёт группы `structured` (агент `qa-structured`)

Дата: 2026-10-06, завершено ~12:50 (UTC+6). Инструменты: cron-generator, cron-parser, json-beautifier, json-to-typescript, xml-beautifier, yaml-beautifier-validator.
Проверка: Chromium (Playwright, dev-сервер `http://localhost:3312/mydevtools/`, TZ Asia/Omsk), тесты под `flock /tmp/mydevtools-tests.lock`.

## Итог по чек-листу

| Инструмент | 1 Консист. | 2 Функционал | 3 Граничные | 4 Визуал | 5 Локализация | 6 Консоль/сеть | 7 Тесты | 8 A11y |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cron-parser | ✅ ds-card/ds-chip-btn/ds-icon-btn/OutputPanel/StatusMessage; локально только сетка «частей» | ✅ пресеты, live 300 мс, Enter, clear, copy, формат дат (сохраняется) | ✅ строгая валидация, `L`/`?`, 7=ВС, «никогда не сработает» | ✅ | ✅ en/ru/de/ja, ru-плюралы | ✅ 0 ошибок, без WASM | ✅ `cron-core.test.ts` (15) | ✅ aria-invalid, alert, aria-live, dl для частей |
| cron-generator | ✅ Field/ds-field/OutputPanel/StatusMessage | ✅ Generate/Enter, copy, формат дат | ✅ ошибка указывает поле (aria-invalid на нём) | ✅ | ✅ ошибки больше не хардкод EN | ✅ | ✅ общий `cron-core` | ✅ |
| json-beautifier | ✅ ds-btn/ds-file-btn/ds-check/ds-field-select/StatusMessage; тема CM — `codemirror.css` | ✅ format/indent/sort/compact/open/save/drop/copy/clear, Ctrl-Enter | ✅ big int/`1.0`/`__proto__`/эмодзи/глубина; ⚠️ CM5 медленный на огромной однострочной строке | ✅ 375 px без переполнения | ✅ | ✅ без WASM, 0 внешних | ✅ `json-format.test.ts` (8) | ✅ Esc→Tab, aria-label редактора, alert |
| json-to-typescript | ✅ то же | ✅ live (debounce 250 мс), опции, copy/download/clear | ✅ коллизии имён, массивы, Unicode-ключи | ✅ | ✅ | ✅ без WASM | ✅ `json-to-typescript.test.ts` (10) | ✅ |
| xml-beautifier | ✅ то же | ✅ format 2/4/tab, compact, open/save/drop/copy/clear | ✅ комментарии/PI до корня, xml-stylesheet, ошибка с позицией | ✅ | ✅ | ✅ без WASM | ✅ `xml-format.test.ts` (8) | ✅ |
| yaml-beautifier-validator | ✅ ds-btn/OutputPanel/ds-badge/StatusMessage | ✅ format/validate/paste/copy/clear, бейдж valid/invalid | ✅ мультидокумент, ошибка со строкой/колонкой | ✅ | ✅ | ✅ WASM грузится только по первому действию | ✅ Rust 12 тестов | ✅ read-only редактор не ловит Tab |

## Найденные и исправленные баги

**Cron (оба инструмента; логика вынесена в общий `src/tools/cron-core.ts`, DOM-хелперы — `cron-ui.ts`)**
1. Валидации фактически не было: `99 * * * *`, `abc`, `*/0`, `5-1` считались валидными (мусорное описание, пустые запуски; `*/0` — бесконечный цикл, ограниченный только 500 мс). Теперь строгий разбор с локализованной ошибкой «поле: недопустимое значение «X» (допустимо a–b)».
2. Имена месяцев/дней недели: `JAN` → 0 (месяц сдвигался на 1); имена брались из локали, поэтому в ru `MON-FRI` не работало, а работало `ПН-ПТ`. Теперь всегда принимаются JAN–DEC/SUN–SAT, локальные имена — как алиасы.
3. День месяца + день недели объединялись через AND; по стандарту Vixie cron — OR, если оба ограничены (`0 0 13 * FRI`).
4. Поиск запусков — перебор минут с бюджетом 500 мс/1М итераций: редкие расписания (`0 0 29 2 *`) возвращали пусто. Теперь перебор по дням (до 30 лет), невозможные (`30 февраля`) дают сообщение «Ближайших запусков не найдено…».
5. Формат «ISO 8601» показывал UTC без `Z` среди локальных времён — теперь локальное время со смещением (`…T09:00:00+06:00`).
6. cron-generator: сообщения об ошибках были захардкожены на английском; `@reboot` в списке запусков — тоже EN-строка.
7. `*/1` описывалось как «Every 1 minutes»; `*/2` в дне месяца описывалось как «every day».

**JSON beautifier** (`src/tools/json-format.ts`)
8. Потеря точности чисел: `12345678901234567890` → `12345678901234567000`, `1.0` → `1`. Теперь числа сохраняются как в исходнике (`JSON.rawJSON`, с feature-detect).
9. «Sort keys» терял ключ `__proto__` (присваивание в обычный объект).
10. Перетаскивание файла: срабатывали и обработчик CodeMirror (вставка текста в позицию), и наш (замена) — гонка. Теперь capture-обработчик, `.is-dragover`.
11. Уведомление об ошибке исчезало через 3 с и не объявлялось скринридеру — теперь постоянный `StatusMessage` (role=alert) с деталью парсера.
12. `viewportMargin: Infinity` (рендер всех строк) убран — форматирование 3 МБ → 440 000 строк ≈ 0,5 с JS + отрисовка.

**XML** (`src/tools/xml-format.ts`)
13. Комментарии и processing instructions до/после корневого элемента терялись.
14. `<?xml-stylesheet …?>` в начале принимался за XML-декларацию → дублировался.
15. Ошибка без подробностей — теперь «Неверный XML… (error on line 1 at column 11: …)».

**JSON → TypeScript** (`src/tools/json-to-typescript.ts`)
16. При коллизии имён интерфейс `Name2` упоминался, но не выводился (ссылка на несуществующий тип).
17. Корневой `[null]` → ссылка на несуществующий `RootItem`; массив объектов брал форму только первого элемента. Теперь объекты массива сливаются в один интерфейс, отсутствующие ключи — `?`, смешанные массивы — `(A | B)[]`.
18. Ключи с `\` экранировались неверно; имена типов могли быть невалидными идентификаторами (`1st`, `a@b`, имя корня `123`).

**YAML** (Rust `wasm/structured_data/src/yaml.rs`)
19. Мультидокумент склеивался: `a: 1\n---\nb: 2` → `---\na: 1---\nb: 2` (порча данных). Исправлено + регрессионный тест.
20. Ошибка была английским префиксом из Rust («YAML parsing error: …»); теперь Rust отдаёт деталь, UI добавляет локализованное «YAML is invalid:». WASM загружается лениво (по первому Format/Validate), а не при открытии страницы.

**Общее**
21. Ctrl/Cmd-K «очистить» в json/xml никогда не срабатывал: эту комбинацию на window перехватывает командная палитра сайта. Привязка удалена (осталась Ctrl/Cmd-Enter).
22. Клавиатурная ловушка: Tab в CodeMirror вставлял отступ без выхода, в т. ч. в read-only редакторах. Теперь Esc → Tab уводит фокус (WCAG 2.1.2), read-only Tab не перехватывает; у скрытого textarea есть `aria-label`, видимая подсказка `EditorKeyboardHint`.
23. Скрытые `<input type=file hidden>` заменены на `ds-file-btn` (доступно с клавиатуры, кольцо фокуса на label).

## Общая тема CodeMirror

Новый `apps/site/src/styles/codemirror.css` (импорт из 4 редакторных инструментов): хост `.mdt-cm`, все правила с префиксом `.mdt-cm` (перебивают вендорный `codemirror.min.css`, который подгружается позже), синтаксис на токенах `--mdt-*` (keyword→`cat-design`, string→`success`, number→`cat-jwt`, property→`cat-converters` …), обе темы автоматически, состояния `.is-error`/`.is-dragover`/`:focus-within`, `forced-colors`, высота `--mdt-cm-height` (по умолчанию `min(600px,70vh)`, ≤768 px — 400 px). Удалены 4 дублирующих набора правил, включая хардкод-палитры VS Code/GitHub. Минимальный контраст токенов/номеров строк — 4.71:1 (light) по всем 72 прогонам.
Мобильные 375 px: элементы шире viewport — это внутренности CodeMirror (`CodeMirror-scroll` с margin −50 px для скрытия скроллбара, скрытый textarea 1000 px), обрезанные `overflow:hidden` у `.CodeMirror`; `scrollWidth == clientWidth`, реального переполнения нет. Хост получил `min-width:0; max-width:100%; overflow:hidden`.

Хелперы в `codemirror-loader.ts`: `CmEditor`/`getCodeMirror`, `makeEditorAccessible` (Esc→Tab, aria-label), `refreshOnThemeChange`, `bindEditorFileDrop`, `downloadText` (revoke отложен).

## Приватность

json/xml: ввод НЕ сохраняется (проверено в браузере: после ввода/drop в `localStorage` только настройки). yaml/jts/cron ввод не сохраняют; cron хранит только формат дат.

## Локализация

Новые ключи во всех 10 языках: cron-parser — `ErrorFieldValue`, `NoUpcomingRuns`, `ScheduleDayOrWeekday`; cron-generator — то же + `ErrorInvalidExpression`, `ErrorExpectedFields`, `ErrorUnknownPreset`, `PartMinute…PartWeekday` (скопированы из cron-parser); json/xml/yaml/json-to-typescript — `EditorKeyboardHint`. `validate:i18n`: 0 ошибок (7 предупреждений — чужие инструменты).

## Тесты

| Файл | Тестов | Результат | Что покрыто |
| --- | --- | --- | --- |
| `apps/site/test/cron-core.test.ts` (новый) | 15 | ✅ | разбор полей, имена (EN + ru-алиасы), `L`/`?`/7, 18 невалидных вариантов, пресеты, next runs от фиксированного момента (Asia/Omsk), OR-правило, 29/30 февраля, описания en и ru (плюралы 1/2/5/21), локализованные ошибки, ключи во всех 10 локалях, форматы дат |
| `apps/site/test/json-format.test.ts` (новый) | 8 | ✅ | отступы 2/4/tab, compact, рекурсивная сортировка, `__proto__`, точность чисел, Unicode/эмодзи/escape, примитивы, 10 невалидных, глубина 2000, 50 000 объектов round-trip |
| `apps/site/test/xml-format.test.ts` (новый) | 8 | ✅ | pretty/compact/tab, экранирование, CDATA/комментарии/PI/DOCTYPE на уровне документа, смешанный контент, глубина 500, декларация vs xml-stylesheet, разбор parsererror |
| `apps/site/test/json-to-typescript.test.ts` (новый) | 10 | ✅ | раскладка как в legacy, опции, слияние массива объектов, union, корневые массивы/примитивы, коллизии (все ссылки объявлены), ключи с кавычками/`\`/Unicode/эмодзи, валидность имён, глубина 200, невалидный JSON |
| `wasm/structured_data` (Rust, `cargo test -p mydevtools_structured_data`) | 12 (было 3 нативных) | ✅ | форматирование map/seq, типы скаляров, Unicode, мультидокумент + регрессия склейки, идемпотентность, глубина 200, пустой ввод, позиция ошибки, обёртки wasm |

Итого TS: 41/41 ✅; Rust: 12/12 ✅; `astro check`: 0 ошибок. Bindings `structured_data` перегенерированы (`src/generated/` в .gitignore).

Браузерные сценарии (`func.mjs`): 72 проверки PASS — форматирование, ошибки, copy (буфер), open/save/drop, отсутствие WASM где не нужен, приватность, Esc→Tab, cron ru/en.

## Скриншоты и скрипты

`/tmp/claude-1001/-home-lex-github-mydevtools/3051f920-6aff-44cf-91a3-0734cea3fd9a/scratchpad/qa-structured/`:
- `sweep-<tool>-<lang>-<theme>-<width>.png` — 72 полностраничных (en/ru × light/dark × 1440/375 + de/ja dark × 1440/375); по всем: 0 горизонтального переполнения, 0 ошибок консоли, 0 внешних запросов, фокус-кольцо 2px, нет утечек ключей.
- `func-*-error*.png` — состояния ошибок; `view-*.png` — вьюпорт крупным планом.
- Скрипты: `lib.mjs`, `func.mjs`, `sweep.mjs`, `add-keys.mjs`.

## Открытые вопросы / запросы

1. **Производительность CodeMirror 5 на очень длинной строке** (ограничение вендорной библиотеки, было и в legacy): вставка минифицированного JSON 2,8 МБ ASCII одной строкой ≈ 2–3 с; со множеством эмодзи — патологически (≈ 7 с на 250 КБ, ≈ 100 с на 3 МБ). Форматирование 3 МБ → 440 000 строк ≈ 8 с полного цикла (JS ≈ 0,5 с, остальное — рендер). Решение — переход на CodeMirror 6 (отдельная задача).
2. DOCTYPE с внутренним подмножеством (`<!DOCTYPE x [<!ENTITY …>]>`) теряет подмножество — DOM браузера его не отдаёт (как в legacy).
3. Описания cron строятся склейкой фраз (наследие legacy): в ru звучат «В минуту 0 в час 9…» — грамматически корректно, но шаблонно; правка требует переработки шаблонов во всех 10 языках.
4. Скриншоты ja показывают «тофу» — в headless-окружении нет CJK-шрифтов (касается всей страницы, не инструментов); раскладка без переполнений.
5. Запросов к `foundation` нет: общего слоя хватило. Пожелание: в `tool-ui-kit.md` упомянуть `styles/codemirror.css` (`.mdt-cm`) в разделе «Не трогаем общим слоем».
