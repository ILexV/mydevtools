# Отчёт агента `fix-files`: исправления и SEO-тексты группы `files`

Дата: 2026-10-06, примерно 14:40–15:35 (UTC+6). Инструменты: image-compressor, image-converter, image-resizer, pdf-compressor, pdf-merger, pdf-to-text, qr-code-generator, qr-scanner. Ничего не закоммичено.

Проверка: Playwright Chromium на dev-сервере `:3312`. HMR-websocket в тестах подменён, чтобы правки других агентов не перезагружали страницу. Long tasks измерялись через `PerformanceObserver('longtask')` плюс «пульс» `setInterval(16 мс)`: максимальный разрыв между тиками показывает, насколько основной поток был занят.

## Сводка

| # | Что | Итог |
|---|---|---|
| A1 | PDF (сжатие, объединение, извлечение текста) вынесен в Web Worker | ✅ long tasks 0; отмена прерывает текущий файл (раньше — только между файлами) |
| A2 | Распознавание QR вынесено в Web Worker | ✅ long tasks 0 вместо 1279 мс; новый файл отменяет старое распознавание |
| A2 | Камера в сканере | — камеры в инструменте нет (только загрузка, паритет с legacy), добавлять её не стал |
| A3 | WebP с потерями | ✅ браузерный кодер с проверкой типа blob; запасной путь — WASM без потерь с пометкой для пользователя |
| A4 | Прочие дефекты | ✅ исправлено 9 (подробности ниже), открытые пункты перечислены в конце |
| B | SEO-тексты 8 инструментов × 10 языков | ✅ переписаны по `seo-guidelines.md` |

## A1–A2. Web Workers для PDF и QR

Новые файлы:
- `apps/site/src/scripts/wasm/job-worker.ts` — общий раннер разовых задач для worker'ов: ленивое создание, сопоставление ответов по `id`, отмена через `terminate()` (синхронный WASM иначе не прервать), пересоздание worker'а после падения, типизированный `WasmError`;
- `apps/site/src/workers/pdf.worker.ts` + `scripts/wasm/pdf-protocol.ts`; `pdf-client.ts` переписан на worker, у всех функций есть `AbortSignal`;
- `apps/site/src/workers/qrcode.worker.ts` + `scripts/wasm/qrcode-protocol.ts` + `scripts/wasm/qrcode-decode-client.ts`. Генерация QR осталась в основном потоке (`qrcode-client.ts`): она быстрая. Страница генератора не тянет код worker'а.

Контроллеры:
- `pdf-compressor.client.ts` и `pdf-to-text.client.ts`: `cancelRequested` заменён на `AbortController`. «Отмена» прерывает текущий файл, его строка возвращается в «Готово», пакет останавливается. Ошибки по файлам и прогресс работают как раньше;
- `pdf-merger.client.ts` работает через worker; кнопки отмены у объединения нет (как и раньше);
- `qr-code-scanner.client.ts`: новый файл или «Очистить» прерывают распознавание, которое ещё идёт. Токен последовательности остался.

Замеры (`perf.mjs`; `perf-before.json` / `perf-after2.json`):

| Сценарий | До: макс. long task / разрыв таймера | После: long tasks / разрыв таймера |
|---|---|---|
| pdf-to-text, big.pdf 5,44 МБ, 2500 страниц | **8818 мс** / 8838 мс | 0 / 41 мс |
| pdf-compressor, big.pdf | 325 мс / 341 мс | 0 / 53 мс |
| pdf-merger, big + 2 стр. + big (10,81 МБ) | 644 мс / 676 мс | 0 / 56 мс |
| qr-scanner, JPEG 3848×3848 | **1279 мс** / 1327 мс | 0 / 29 мс |

Функциональная проверка (`func.mjs` → `func.json`), консоль везде чистая:
- **сжатие пакета** `[big, corrupted, locked-user, one]`: big «Saved 88%», corrupted и locked — бейдж ошибки с локализованным текстом по имени файла, one «Saved 10%»;
- **отмена сжатия** посреди big.pdf: UI освободился за 82 мс, все строки «Ready»; повторный запуск сжал все 3 файла;
- **отмена извлечения** посреди big.pdf: 91 мс (раньше пришлось бы ждать около 9 с), long tasks 0; повторный запуск дал текст;
- **объединение**: locked-файл назван в ошибке, строка помечена; после удаления — успех (1,32 КБ);
- **гонка в сканере**: большой JPEG, через 100 мс маленький PNG → результат от маленького; фото без кода → «No QR code found…».

## A3. WebP с потерями

`image-tools.worker.ts` для WebP сначала пробует кодер браузера: `createImageBitmap` → `OffscreenCanvas.convertToBlob({type:"image/webp", quality})`. Результат принимается, только если `blob.type === "image/webp"`. Safari в таком случае отдаёт PNG — это ловит одноразовая проверка, а также проверка каждого результата. Форматы, которые браузер не декодирует (TIFF/TGA), сначала переводятся в PNG через WASM. Если браузерный путь не сработал, используется прежний WASM WebP без потерь. В протокол добавлен флаг `webpLossy`. Компрессор и конвертер в этом случае показывают `StatusMessage kind="info"`: новый ключ `WebpLosslessNote` есть во всех 10 языках. Ресайзер (у него нет ползунка) кодирует WebP с качеством 90 после ресайза Lanczos3 в WASM.

Размеры: фото 1920×1280, JPEG 476,38 КБ (`photo.jpg`).

| Режим | До | После |
|---|---|---|
| Компрессор, WebP q80 | 2,22 МБ (+366 %) | **186,58 КБ (−61 %)** |
| Компрессор, WebP q30 | 2,22 МБ (качество не влияло) | 20,98 КБ |
| Конвертер, WebP q80 / q30 | 2,22 МБ / 2,22 МБ | 186,58 КБ / 20,98 КБ |
| Конвертер, WebP q90 | 2,22 МБ | 433,54 КБ |
| Ресайзер 960×640, WebP | 613,32 КБ | 46,94 КБ |

Запасной путь проверен подменой `convertToBlob` в скрипте worker'а (имитация Safari): на выходе настоящий WebP (`RIFF…WEBP`) на 2,22 МБ и видимая пометка на ru (`shots/imgc-fallback-ru.png`).

## A4. Прочие дефекты

| # | Дефект | Исправление | Доказательство |
|---|---|---|---|
| 1 | **WASM PDF писал ~5000 строк `console.log`** при каждом извлечении текста (`Found font resource…`) | `console_log!` в `wasm/pdf` теперь no-op без фичи `debug-log` (добавлена в `Cargo.toml`) | `logs.mjs`: 5008 → 0 сообщений |
| 2 | **pdf-to-text склеивал строки**: игнорировались `T*`, `Td`/`TD` со сдвигом по y, `Tm`, `'`, `"` (открытый пункт files.md) | `normalize_text_ops` (`'`/`"` → `T*`+`Tj`) и переводы строк; убран warning `unused font_map` | Rust-тест `extract_text_breaks_lines_on_next_line_operators` |
| 3 | **pdf-compressor ломал ссылки и закладки**: `/A` и `/AA` удалялись из всех словарей, `/OCProperties` (слои) удалялся из каталога, и скрытые слои становились видимыми | действия и слои сохраняются | тест `compress_keeps_link_actions_and_layers`, мутация (вернуть `remove(b"A")`) → тест падает |
| 4 | **pdf-merger понижал версию** PDF 1.7/2.0 до 1.5 | только повышение до 1.5 | тест `merge_keeps_newer_pdf_version` |
| 5 | **QR с логотипом не читался**: логотип занимал ¼ картинки; на коротком тексте все 7 комбинаций стиль/размер/уровень Q–H не читались нашим сканером | рамка логотипа ограничена долей ширины кода по уровню (L 15 %, M 20 %, Q 25 %, H 30 %) | тест на 36 комбинаций (Q/H × 3 стиля × 256/512/1024 × 2 текста) + мутация; в браузере 7/7 читаются |
| 6 | **PNG генератора не того размера** (512 → меньше, кратно модулю; открытый пункт files.md) | холст ровно 256/512/1024/2048 px, код по центру, quiet zone ≥ 4 модулей | тест `png_is_exactly_the_requested_size_and_decodes`; в браузере 512×512 и 1024×1024 |
| 7 | **TGA на входе не работал нигде**: у TGA нет сигнатуры, `load_from_memory` → «format could not be determined». Отчёт files.md считал, что компрессор и конвертер TGA принимают | нераспознанный ввод пробуется как TGA | тест `tga_input_is_decoded_despite_missing_magic`; в браузере TGA → PNG |
| 8 | **Ресайзер не открывал TIFF/TGA** (открытый пункт files.md) | при ошибке `<img>` превью декодируется в PNG через worker, дальше обычная логика размеров | 640×480 TGA → поля 640/480 → результат 320×240 |
| 9 | **EXIF-ориентация терялась**: перекодирование удаляло EXIF, фото с телефона выходили боком (а браузерный путь WebP её учитывал — было бы рассогласование) | `ImageReader` + `orientation()` + `apply_orientation` | тест `exif_orientation_is_applied_before_reencoding` (JPEG 4×2 с Orientation=6 → 2×4), мутация → падает |
| 10 | **Конвертер: «PNG (Lossless)» мог выдать палитровый PNG**: скрытый ползунок качества сохранял значение < 90 после JPEG, а PNG < 90 квантуется | для форматов кроме jpeg/webp передаётся качество 100 | JPEG q30 → PNG: color type 2 (truecolor), не 3 (palette) |

Привязки WASM пересобраны под lock: `image_tools`, `pdf`, `qrcode`.

## B. SEO-тексты

Ключи: `Description`, `Keywords`, `Seo_Introduction`, `Seo_DetailedDescription`, `Seo_Examples`, `Seo_HowToSteps`, `Seo_Tips`. `Title` не менялся: все названия точные. Английский текст написан по коду после исправлений. Переводы на 9 языков сделаны тремя субагентами по английскому тексту; названия кнопок и сообщения взяты из JSON интерфейса каждой локали. Я затем проверил их скриптом: структура, число шагов и советов, `inline code`.

Все примеры прогнаны в инструментах (`examples.mjs`, `ex2–ex5.mjs`, `func.mjs`, `tga.mjs`):

| Инструмент | Что описано и проверено |
|---|---|
| image-compressor | «Keep original» (jpeg/png/другое → webp); как качество работает для JPEG/PNG(<90 → палитра)/WebP; удаление EXIF/GPS с учётом ориентации; белый фон для JPEG; пометка про WebP без потерь; примеры 476,38 КБ → 186,58 КБ (WebP 80, −61 %), JPEG 60 → 167,27 КБ, JPEG 80 → 396,49 КБ, скриншот 126,47 КБ → 53,49 КБ WebP / 91,26 КБ PNG 90; `_min` |
| image-converter | 8 форматов; качество только для JPEG/WebP; ICO ≤ 256 px (1024 → 256×256, 10,24 КБ); прозрачность → белый в JPEG (пиксель 255,255,255); WebP q90 433,54 КБ; TGA → PNG; первый кадр GIF; нет превью TIFF/TGA |
| image-resizer | замок пропорций, Lanczos3, формат по расширению, JPEG/WebP q90, лимиты 16384 px / 64 МП с точным текстом ошибки, TIFF/TGA, 1920×1280 → 960×640 WebP 46,94 КБ, `_WxH` |
| pdf-compressor | что именно делается: zlib best, только если меньше, dedup, xref-stream, JPEG без APP-сегментов; что удаляется (Info, XMP, миниатюры, теги) и что сохраняется (ссылки, закладки, слои); изображения не пересжимаются; отрицательный «Saved»; пакет, отмена, ошибки по файлам; 5,44 МБ → 685,91 КБ (88 %), 729 B → 658 B (10 %) |
| pdf-merger | порядок списка, Move up/down, база = первый файл (его закладки/формы), без пересжатия; ошибки locked; подсказка «минимум 2»; `merged.pdf` |
| pdf-to-text | ToUnicode / TrueType cmap / WinAnsi, переводы строк, пустая строка между страницами, нет OCR, пакет, отмена; пример из 2 страниц и big.pdf → `big.txt` 36 КБ |
| qr-code-generator | UTF-8, уровни L/M/Q/H, ёмкость 2953/1273 байт, точный размер PNG, стили (finder всегда квадратный), размер логотипа по уровню, SVG только для квадратного стиля без логотипа, Ctrl/⌘+Enter; примеры сверены round-trip (ссылка, Wi-Fi, логотип H rounded 1024, 3000 символов → ошибка) |
| qr-scanner | PNG/JPEG/WebP, rxing в worker, отмена при новом файле, Open Link только для http(s), нет камеры; 3848 px за ~1–1,5 с, страница отзывчива |

Убраны ложные утверждения старых шаблонных текстов: «настройки сохраняются», «текстовый ввод», «скопируйте результат в буфер» у файловых инструментов и т. п.

## Проверка

Итоговый прогон под `flock /tmp/mydevtools-tests.lock`, 15:28 (UTC+6):
- `cargo test -p image_tools -p pdf_tools -p qrcode_tool`: 12 + 17 + 15 = **44 passed**, без warnings (было 37). Новые тесты: TGA, EXIF-ориентация, переводы строк в тексте, ссылки и слои при сжатии, версия при объединении, точный размер PNG, логотип × 36 комбинаций. Для четырёх из них проверено, что мутация роняет тест;
- `node --test test/image-tools.test.ts test/pdf-files.test.ts test/qr-code.test.ts`: 20/20;
- `astro check`: 0 errors (246 файлов);
- `validate:i18n`: 0 errors. Единственный warning — `de/tools/uuid-generator`, не моя группа;
- повторный прогон `func.mjs` после последней пересборки WASM: все 8 сценариев зелёные, консоль чистая; отмена срабатывает за 84–108 мс.

Браузер (`visual.mjs` → `visual.json`): 8 инструментов × en/ru/ja/hi × light/dark × 1440/375 = 128 страниц. Горизонтального скролла нет, ошибок и warnings в консоли нет. Скриншоты лежат в `shots/<tool>-{en-light-1440,ru-dark-375,ja-dark-1440,hi-light-375}.png`; на ja и hi CJK и деванагари отрисованы корректно. `ld.mjs`: на всех 80 страницах (8 × 10 языков) число `HowToStep` в JSON-LD равно числу шагов в тексте (3 или 4).

Скрипты и данные: `/tmp/claude-1001/-home-lex-github-mydevtools/3051f920-6aff-44cf-91a3-0734cea3fd9a/scratchpad/fix-files/`:
- `perf.mjs`, `func.mjs`, `examples.mjs`, `ex2–ex5.mjs`, `tga*.mjs`, `logs.mjs`, `visual.mjs`, `ld.mjs`;
- фикстуры `fx/`;
- SEO-исходники `seo/<lang>.json` и проверка `seo/check.py`.

## Открытые вопросы и запросы к общему слою

- **Камера в qr-scanner** отсутствует, как и в legacy. Пункт задачи про «кадры камеры в worker, пропуск кадров» неприменим. Если камера нужна, это новая функция: `getUserMedia`, `ImageBitmap` в тот же `qrcode.worker` с флагом «занят». Нужно решение владельца.
- **pdf-merger без кнопки отмены**: объединение уже идёт в worker и страницу не блокирует, но прервать его нельзя. Чтобы добавить отмену, нужен `Progress` в `PdfMerger.astro` и ключ `Cancel` в 10 языках. Объединение 10,8 МБ занимает около 0,9 с, поэтому не стал.
- **Извлечение текста big.pdf всё ещё около 6 с** (теперь в worker). Время уходит на эвристики подбора кодировки в `extract_text_impl`: функция на 1500 строк с глубокой вложенностью. Оптимизация — отдельная задача.
- **pdf-compressor удаляет дерево тегов** (`StructTreeRoot`/`MarkInfo`/`StructParents`), и PDF/UA теряет доступность. Это поведение legacy; оно честно описано в SEO-советах. Сохранять ли теги — решение владельца.
- **Качество PNG < 90 в компрессоре** (палитра) не всегда уменьшает файл: на скриншоте q80 дал 102,43 КБ, q90 — 91,26 КБ. Подсказка `QualityHint` («ниже качество = меньше файл») для PNG не всегда верна. В SEO-тексте это учтено.
- **Сканер** по-прежнему использует `MultiFormatReader` (паритет с legacy): читаются и другие штрихкоды. В SEO об этом не пишу.
- **Неточности в существующих UI-строках** (заметили переводчики, тексты UI не менял): в hi «फॉर्मेट» и «फ़ॉर्मैट» в разных инструментах; в ja у конвертера Target Format = «出力フォーマット», так же как Output Format у компрессора; в pt у pdf-to-text европейские «Ficheiros» и «Descarregar». В SEO-текстах эти метки повторены дословно, как в UI.
- **Бейджи в примерах SEO** (`Готово! -61%`, `Сэкономлено 88%` и т. п.) в каждой локали записаны так, как их показывает UI, а не на английском.
- **Общий слой** — запросов нет. `job-worker.ts` сделан в `scripts/wasm/` как общий раннер разовых задач для worker'ов, им могут пользоваться и другие группы. Юнит-тест для него не написан: тесты `node --test` не понимают алиас `@/`, а сам раннер проверен в браузере (отмена, гонки, ошибки).

## Изменённые файлы

- WASM: `wasm/image_tools/src/lib.rs`, `wasm/pdf/{Cargo.toml,src/lib.rs}`, `wasm/qrcode/src/lib.rs`; привязки в `apps/site/src/generated/wasm/{image_tools,pdf,qrcode}` (в gitignore).
- Новые: `src/workers/{pdf,qrcode}.worker.ts`, `src/scripts/wasm/{job-worker,pdf-protocol,qrcode-protocol,qrcode-decode-client}.ts`.
- Изменены:
  - `src/workers/image-tools.worker.ts`;
  - `src/scripts/wasm/{image-tools-protocol,image-tools-client,pdf-client,qrcode-client}.ts`;
  - `src/tools/{image-compressor,image-converter,image-resizer,pdf-compressor,pdf-to-text,qr-code-scanner}.client.ts`;
  - `src/tools/{ImageCompressor,ImageConverter,PdfCompressor,PdfToText,QrCodeScanner}.astro`.
- Локали: `src/i18n/locales/*/tools/{image-compressor,image-converter,image-resizer,pdf-compressor,pdf-merger,pdf-to-text,qr-code-generator,qr-scanner}.json` — SEO-ключи, `Description`, `Keywords`, а также `WebpLosslessNote` у компрессора и конвертера.

---

## Дополнение: решения владельца (2026-10-06, примерно 15:35–16:30 UTC+6)

### 1. Сканирование камерой в qr-scanner

**Что сделано:**
- `src/tools/qr-camera.ts` (новый): `getUserMedia({audio:false, video:{facingMode:{ideal:"environment"}}})`, а при выборе камеры — `{deviceId:{exact}}`.
  - Кадр уменьшается до ≤ 1024 px через `createImageBitmap(video, {resizeWidth, resizeHeight})` и передаётся в worker как transferable. Если `OffscreenCanvas` нет, кадр читается через canvas и отправляется как `ImageData`.
  - Следующий кадр берётся только после ответа на предыдущий: кадры отбрасываются, очереди нет.
  - Сканирование останавливается: при первом распознанном коде, по кнопке «Остановить камеру», при `visibilitychange`→hidden и `pagehide`, при выборе файла. В каждом случае `track.stop()` для всех дорожек и `srcObject = null`.
- `qrcode.worker.ts` / `qrcode-protocol.ts` / `qrcode-decode-client.ts`: добавлены типы запросов `bitmap` (рисуется в `OffscreenCanvas` внутри worker'а) и `rgba`.
- Rust: `decode_qr_rgba(rgba, w, h)` проверяет длину буфера; общий `decode_luma` используется и для файлов. Добавлен тест.
- Разметка (`QrCodeScanner.astro`):
  - кнопка «Сканировать камерой» под зоной файла;
  - карточка с `<video playsinline muted>` и рамкой-прицелом (затемнение вокруг квадрата);
  - подсказка `role=status`;
  - список камер (виден, если камер больше одной) и кнопка «Остановить камеру»;
  - у панели результата `aria-live="polite"`;
  - после распознавания фокус переходит на поле с текстом, после остановки — на кнопку запуска, на кнопке «Сканировать снова».
- Кнопка скрывается, если `getUserMedia` нет в защищённом контексте. На незащищённой странице кнопка остаётся и при нажатии объясняет, что нужен HTTPS.
- Новые ключи (10 языков): `ScanCamera`, `ScanAgain`, `StopCamera`, `CameraSelect`, `CameraHint`, `CameraPreview`, `ErrorCameraDenied`, `ErrorCameraNotFound`, `ErrorCameraInUse`, `ErrorCameraInsecure`, `ErrorCameraGeneric`.
- Чистые хелперы в `qr-code.ts` с тестами: `cameraFrameSize` (≤ 1024, пропорции сохраняются, без увеличения) и `classifyCameraError` (имя DOMException → вид ошибки).
- `registry/tools.ts` не менял: в `ToolCapabilities` нет поля для камеры, а сам тип общий.

**Проверка** (Playwright Chromium; `cam.mjs` → `cam.json`; фейковая камера из y4m, сгенерированного `mky4m.mjs` из PNG с QR — ffmpeg в системе нет):

| Сценарий | Результат |
|---|---|
| Камера с QR | распознано за 444 мс (`https://example.com/path?q=1`); long tasks 0, максимальный разрыв таймера 23 мс; живых дорожек после распознавания 0, `srcObject=null`; карточка скрыта, кнопка — «Scan again», «Open Link» показан, фокус в поле результата; ограничения `facingMode: environment`; одновременно в worker не больше 1 кадра |
| «Сканировать снова» | снова распознано, дорожки освобождены |
| Пустое видео 3 с | сканирование идёт, 16 кадров отправлено в worker, одновременно не больше 1; long tasks 0; при двух камерах виден список |
| Стоп / скрытие вкладки / выбор файла | в каждом случае 0 живых дорожек и карточка скрыта; после выбора файла распознан файл; после «Стоп» фокус на кнопке запуска |
| Отказ в доступе (новый headless, CDP `Browser.setPermission camera=denied`) | `NotAllowedError` → ru «Доступ к камере запрещён…». В старом headless без UI разрешений Chromium отдаёт `NotSupportedError` → общее сообщение |
| Камеры нет / камера занята (подмена `getUserMedia`) | «No camera was found…» / «The camera is busy…» |
| Незащищённый контекст (подмена `isSecureContext=false`, `mediaDevices` отсутствует) | кнопка видна, ja-сообщение про HTTPS |
| Защищённый контекст без `getUserMedia` | кнопка скрыта |
| Вёрстка | 1440 light, 375 dark (ru), 375 light — без горизонтального скролла, консоль чистая (`shots/cam-*.png`) |

### 2. pdf-compressor больше не удаляет структуру доступности

Из `compress_pdf_bytes` убраны удаления `/StructTreeRoot`, `/MarkInfo` (каталог) и `/StructParents` (все словари). `/RoleMap`, `/ParentTree`, `/Lang`, а также `BDC`/`EMC` с MCID в потоках содержимого и раньше не трогались: потоки только пережимаются без изменения содержимого. Остальная очистка метаданных (Info, XMP, Thumb, PieceInfo, LastModified) работает как прежде.

Тест `compress_keeps_tagged_pdf_structure` собирает размеченный PDF: StructTreeRoot с RoleMap и ParentTree, элементы Document→P с `/Pg` и MCID, `/StructParents` у страницы, `MarkInfo /Marked true`, `/Lang en-US`, `BDC /P <</MCID 0>> … EMC`. После сжатия проверяется, что всё это на месте. Мутации (вернуть удаление `StructTreeRoot` или `StructParents`) роняют тест. Привязки `pdf` пересобраны.

### SEO
- qr-scanner: все 7 ключей переписаны с учётом камеры (HTTPS/localhost, разрешение, кадры обрабатываются локально, когда камера выключается), на 10 языках.
- pdf-compressor: фраза об удаляемых данных и совет про теги исправлены: теги, размеченное содержимое и язык документа сохраняются.

### Проверка дополнения

- `cargo test -p image_tools -p pdf_tools -p qrcode_tool`: 12 + 18 + 16 = **46 passed**, без warnings.
- `node --test` (image-tools, pdf-files, qr-code): **22/22**; добавлено 2 теста камеры.
- `astro check`: 0 errors (247 файлов). `validate:i18n`: 0 errors.
- `ld.mjs`: число шагов HowTo в JSON-LD совпадает с текстом на 10 языках для pdf-compressor (4) и qr-scanner (3).
- `visual.mjs` для qr-scanner и pdf-compressor на en/ru/ja/hi × 2 темы × 2 ширины: 32 страницы, проблем нет.
- Попутно исправлено: `Seo_Introduction` рендерится без markdown, и на hi-скриншоте были видны буквальные `**`. Во всех 10 языках убраны `**` и обратные кавычки из `Seo_Introduction` у qr-scanner, image-compressor, pdf-merger и pdf-to-text.
- Ограничение среды: в старом headless Chromium без UI разрешений `getUserMedia` возвращает `NotSupportedError`, и показывается общее сообщение «не удалось включить камеру». Настоящий отказ проверен в новом headless (`channel: "chromium"`) через CDP.
