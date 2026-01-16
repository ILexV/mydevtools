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
- [ ] GxHash — crate: `gxhash`
- [ ] Murmur3 — crate: `murmur3`
- [ ] FarmHash — crate: `farmhash`
- [x] MetroHash64 — crate: `metrohash` (pure Rust)
- [ ] MetroHash через `fasthash` (⚠️ требуется решение: `fasthash-sys` не собирается на Windows MSVC)
- [x] FNV — crate: `fnv`
- [x] SeaHash — crate: `seahash`
- [x] RIPEMD-160 — crate: `ripemd`

### Дополнительно (часто спрашивают; можно позже)

- [x] SHA-1 — crate: `sha1` (единый wasm-путь)
- [x] SHA-224 — crate: `sha2` (встречается в старых системах)
- [x] BLAKE2s — crate: `blake2` (полезно как "быстрый" вариант для небольших входов)
- [x] SipHash-1-3 / SipHash-2-4 — crate: `siphasher` (фиксированный ключ)
- [x] CRC32 / Adler32 (checksums) — crate: `crc32fast` / `adler` (для файловых проверок, не крипто)

## Инструменты сайта

- [x] Hash Calculator (все алгоритмы через WASM)
- [x] MD5 (через WASM)
- [ ] JSON Beautifier / Minifier
- [ ] XML Formatter
- [ ] Base64 / Hex / URL encoding

## CI/CD

- [ ] GitHub Actions: build .NET + build WASM + тесты
- [ ] Пайплайн релиза (публикация статики/сайта)

## Идеи / открытые вопросы

- [ ] Нужен ли один crate на домен или несколько crates внутри домена?
- [ ] Нужны ли "чистые" Rust-реализации алгоритмов (без зависимостей), или можно использовать проверенные crates?
