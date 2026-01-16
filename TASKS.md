# План задач (Roadmap)

> Это живой список: отмечай галочки по мере выполнения.

## Документация

- [x] Обновить структуру репозитория в README (добавить `wasm/*`)
- [ ] Описать процесс сборки Rust → WASM (инструменты, команды, пути артефактов)
- [ ] Создать/добавить недостающие документы или убрать ссылки из README:
  - `LOCALIZATION_GUIDE.md`
  - `STRONGLY_TYPED_RESOURCES.md`
  - `FIXES_LOG.md`

## WASM (Rust)

- [x] Создать доменные папки `wasm/cryptography`, `wasm/encoding`, `wasm/structured_data`, `wasm/hash`
- [x] Переименовать домен в `wasm/structured_data`
- [ ] Создать Cargo workspace в `wasm/` (`wasm/Cargo.toml` + members)
- [x] Добавить скрипт сборки WASM → `wwwroot/wasm` (`wasm/build.ps1`)
- [x] Зафиксировать toolchain сборки: `cargo build (wasm32-unknown-unknown)` + `wasm-bindgen`
- [x] Установить `wasm-bindgen-cli` на dev-машинах/в CI (`cargo install wasm-bindgen-cli --locked`)
- [x] Убедиться что добавлен target: `rustup target add wasm32-unknown-unknown`
- [x] Выполнить тестовую сборку WASM в `wwwroot/wasm`
- [x] Добавить первый WASM-crate в `wasm/hash/` (MD5 для строк)
- [x] Добавить хэши файлов (chunking/streaming через JS + WASM)
- [ ] Добавить общий слой загрузки модулей (lazy-load + кеширование + обработка ошибок)
- [ ] Добавить интерфейс для вызова WASM из UI (JS interop + обвязка в C# сервис)

## WASM: Hash (план работ)

### API и тесты (сначала база)

- [ ] Зафиксировать публичный API для `wasm/hash`:
  - строка → hex-строка
  - файл/bytes → hex-строка (через chunking на JS стороне)
  - единый enum/строковый идентификатор алгоритма (например `"sha256"`, `"blake3"`)
- [ ] Покрыть тестами: корректные векторы + edge cases (пустая строка, Unicode, большие входы)
- [ ] Добавить тестовые векторы как таблицу (чтобы легко расширять)
- [ ] Убедиться что `cargo test` гоняется нативно (быстро), а wasm-сборка не тянет лишнего

- [x] Добавить streaming API для файлов: `Hasher.new()` + `update()` + `finalize()`
- [x] Добавить one-shot API: `hash_bytes()` / `hash_text_utf8()`
- [x] Реализовать минимум 1 крипто-хэш с тест-вектором (SHA-256)

### Интеграция с файлами на сайте (конкурентное преимущество)

- [x] JS: чтение `File` чанками (`file.slice`) + `await arrayBuffer()` + `Hasher.update(new Uint8Array(...))`
- [x] UI: прогресс хэширования файла (процент + скорость + время)
- [x] UI: отмена/пауза (AbortController или флаг) для больших файлов
- [ ] Проверка корректности на больших файлах (сравнить с эталоном на стороне пользователя, например через встроенные утилиты)

### Алгоритмы (по списку) + MD5

> Цель: реализовать как отдельные функции/модули внутри `wasm/hash`, но собирать одним доменным `hash.wasm`.

- [x] MD5 — crate: `md-5` (часто нужно для проверки старых хэшей)
- [x] SHA-256 — crate: `sha2`
- [x] SHA-512 — crate: `sha2`
- [x] SHA-512/224 — crate: `sha2`
- [x] SHA-512/256 — crate: `sha2`
- [x] Streebog-256 (ГОСТ Р 34.11-2012) — crate: `streebog`
- [x] Streebog-512 (ГОСТ Р 34.11-2012) — crate: `streebog`
- [x] SHA-384 — crate: `sha2`
- [x] SHA-3-256 — crate: `sha3`
- [x] SHA-3-224 — crate: `sha3`
- [x] SHA-3-384 — crate: `sha3`
- [x] SHA-3-512 — crate: `sha3`
- [x] BLAKE3 — crate: `blake3`
- [x] BLAKE2b — crate: `blake2`
- [ ] aHash — crate: `ahash` (⚠️ требуется решение: тянет `getrandom` и ломает `wasm32-unknown-unknown` без спец. конфигурации)
- [x] FxHash — crate: `rustc-hash`
- [x] HighwayHash64 — crate: `highway` (фиксированный ключ)
- [x] xxHash (xxh3) — crate: `xxhash-rust`
- [x] xxHash32 — crate: `xxhash-rust`
- [x] xxHash64 — crate: `xxhash-rust`
- [ ] GxHash — crate: `gxhash` (⚠️ не подходит: требует AES+SSE2 intrinsics/`target-feature=+aes,+sse2`, не portable для `wasm32-unknown-unknown`)
- [ ] Murmur3 — crate: `murmur3` (⚠️ не подходит текущий crate: API через `std::io::Read`, нет нормального stateful `update(&[u8])` для нашего streaming API)
- [ ] FarmHash — crate: `farmhash` (⚠️ не подходит: по сути one-shot; stateful обертка будет буферизовать весь ввод, что ломает streaming на больших файлах)
- [x] MetroHash64 — crate: `metrohash` (pure Rust)
- [ ] MetroHash через `fasthash` (⚠️ требуется решение: `fasthash-sys` не собирается на Windows MSVC)
- [x] FNV — crate: `fnv`
- [x] SeaHash — crate: `seahash`
- [x] RIPEMD-160 — crate: `ripemd`
- [x] RIPEMD-128 — crate: `ripemd`
- [x] RIPEMD-256 — crate: `ripemd`
- [x] RIPEMD-320 — crate: `ripemd`

- [x] Keccak-256 — crate: `sha3`
- [x] Keccak-512 — crate: `sha3`
- [x] Keccak-224 — crate: `sha3`
- [x] Keccak-384 — crate: `sha3`

- [x] SHAKE128-256 (фиксированный вывод 256 бит) — crate: `sha3`
- [x] SHAKE256-256 (фиксированный вывод 256 бит) — crate: `sha3`

### Дополнительно (часто спрашивают; можно позже)

- [x] SHA-1 — crate: `sha1` (единый wasm-путь)
- [x] SHA-224 — crate: `sha2` (встречается в старых системах)
- [x] BLAKE2s — crate: `blake2` (полезно как "быстрый" вариант для небольших входов)
- [x] SipHash-1-3 / SipHash-2-4 — crate: `siphasher` (фиксированный ключ)
- [x] CRC32 / Adler32 (checksums) — crate: `crc32fast` / `adler` (для файловых проверок, не крипто)

## WASM: Encoding (план работ)

> Домен `wasm/encoding` отвечает за hex/base32/base58/base64/url.
> Требования: отдельная страница на каждый формат; у каждого формата на UI доступны настройки;
> text+file encode/decode для всех кроме URL (URL — только text);
> streaming для файлов — где это возможно; decode ошибки по возможности с позицией;
> обязательно: выбор текстовой кодировки.

### API и тесты (сначала база)

- [ ] Зафиксировать публичный API для `wasm/encoding`:
  - bytes → encoded string
  - encoded string → bytes (с ошибками, включая позицию)
  - text → bytes (с выбранной кодировкой)
  - bytes → text (с выбранной кодировкой)
  - опции (settings) для каждого формата как отдельные структуры/параметры
- [ ] Добавить единый enum/строковый идентификатор кодировки (например: `utf-8`, `utf-16le`, `windows-1251`, ...)
- [ ] Определить поведение ошибок декодирования:
  - позиция (index) + символ/байт + человекочитаемое сообщение
  - режимы: strict / permissive (если нужно)
- [ ] Покрыть тестами: round-trip + известные векторы + edge cases (пустой ввод, Unicode, суррогаты/invalid bytes)
- [ ] Добавить таблицу тест-векторов (по форматам и режимам), чтобы легко расширять
- [ ] Убедиться что `cargo test` гоняется нативно (быстро), а wasm-сборка не тянет лишнего

### Алгоритмы/форматы + настройки

- [ ] Hex:
  - [ ] encode: lower/upper-case
  - [ ] decode: поддержка/игнорирование пробелов и разделителей (` `, `\n`, `:`, `-`), опционально `0x` префикс
  - [ ] decode ошибки: odd-length, invalid char (с позицией)

- [ ] Base64:
  - [ ] режимы alphabet: standard / url-safe
  - [ ] padding: required / optional / no-padding
  - [ ] decode: разрешить/запретить whitespace/newlines
  - [ ] (опционально) line wrapping при encode
  - [ ] decode ошибки: invalid char / invalid padding (с позицией)

- [ ] Base32:
  - [ ] поддержка вариантов алфавита (настройка пользователем)
  - [ ] padding: required / optional / no-padding
  - [ ] case handling при decode (upper/lower/auto)
  - [ ] decode ошибки: invalid char / invalid padding (с позицией)

- [ ] Base58:
  - [ ] поддержка вариантов алфавита (настройка пользователем)
  - [ ] decode ошибки: invalid char (с позицией)
  - [ ] Исследовать streaming для base58 (скорее всего невозможен без буферизации всего ввода) и зафиксировать решение

- [ ] URL encoding (только текст):
  - [ ] режимы: `encodeURIComponent`-подобный / `encodeURI`-подобный / `x-www-form-urlencoded` (space → `+`)
  - [ ] decode: `+` → space (в режиме form)
  - [ ] decode ошибки: invalid percent-encoding (с позицией)

### Streaming для файлов (JS + WASM)

- [ ] Зафиксировать общий streaming API (по аналогии с `wasm/hash`):
  - [ ] encode stream (update bytes → output chunks)
  - [ ] decode stream (update encoded text/bytes → output chunks)
- [ ] Реализовать streaming там, где это реально:
  - [ ] hex encode/decode (да)
  - [ ] base64 encode/decode (да)
  - [ ] base32 encode/decode (да)
  - [ ] base58 encode/decode (решение после исследования)

### Интеграция с сайтом

- [ ] Добавить общий слой загрузки `encoding.wasm` (lazy-load + кеширование + обработка ошибок)
- [ ] Добавить общий JS-слой чтения/записи файлов чанками (progress + cancel) для encoding tools
- [ ] Добавить соглашение по имени выходного файла: добавлять расширение (например `.hex`, `.b64`, `.b32`, `.b58`, `.url.txt`)

- [ ] Создать отдельные страницы инструментов (SSR + ToolLayout + SEO + hreflang), каждая со ссылками на другие форматы:
  - [ ] Hex Encoder/Decoder
  - [ ] Base32 Encoder/Decoder
  - [ ] Base58 Encoder/Decoder
  - [ ] Base64 Encoder/Decoder
  - [ ] URL Encoder/Decoder (text only)

- [ ] UI требования для каждой страницы:
  - [ ] режим `Text` / `File` (кроме URL)
  - [ ] выбор кодировки текста (обязательно)
  - [ ] панель настроек формата (все доступные настройки)
  - [ ] copy результата, download результата, и понятные ошибки (с подсветкой позиции, где возможно)

## Инструменты сайта

- [x] Hash Calculator (все алгоритмы через WASM)
- [x] MD5 (через WASM)
- [ ] JSON Beautifier / Minifier
- [ ] XML Formatter
- [ ] Hex Encoder/Decoder
- [ ] Base32 Encoder/Decoder
- [ ] Base58 Encoder/Decoder
- [ ] Base64 Encoder/Decoder
- [x] URL Encoder/Decoder

## CI/CD

- [ ] GitHub Actions: build .NET + build WASM + тесты
- [ ] Пайплайн релиза (публикация статики/сайта)

## Идеи / открытые вопросы

- [ ] Нужен ли один crate на домен или несколько crates внутри домена?
- [ ] Нужны ли "чистые" Rust-реализации алгоритмов (без зависимостей), или можно использовать проверенные crates?
