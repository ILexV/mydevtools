# План задач (Roadmap)

> Это живой список: отмечай галочки по мере выполнения.

## Документация

- [x] Обновить структуру репозитория в README (добавить `wasm/*`)
- [ ] Описать процесс сборки Rust → WASM (инструменты, команды, пути артефактов)
- [ ] Создать/добавить недостающие документы или убрать ссылки из README:
  - [x] `LOCALIZATION_GUIDE.md`
  - [ ] `STRONGLY_TYPED_RESOURCES.md`
  - [ ] `FIXES_LOG.md`

## WASM (Rust)

- [x] Создать доменные папки `wasm/cryptography`, `wasm/encoding`, `wasm/structured_data`, `wasm/hash`
- [x] Переименовать домен в `wasm/structured_data`
- [x] Создать Cargo workspace в `wasm/` (`wasm/Cargo.toml` + members)
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

  - строка → hex-строка
  - единый enum/строковый идентификатор алгоритма (например `"sha256"`, `"blake3"`)
- [ ] Покрыть тестами: корректные векторы + edge cases (пустая строка, Unicode, большие входы)
- [ ] Добавить тестовые векторы как таблицу (чтобы легко расширять)

- [x] Добавить streaming API для файлов: `Hasher.new()` + `update()` + `finalize()`
- [x] Добавить one-shot API: `hash_bytes()` / `hash_text_utf8()`
- [x] Реализовать минимум 1 крипто-хэш с тест-вектором (SHA-256)
### Интеграция с файлами на сайте (конкурентное преимущество)

- [x] JS: чтение `File` чанками (`file.slice`) + `await arrayBuffer()` + `Hasher.update(new Uint8Array(...))`
- [x] UI: прогресс хэширования файла (процент + скорость + время)
- [ ] Проверка корректности на больших файлах (сравнить с эталоном на стороне пользователя, например через встроенные утилиты)

### Алгоритмы (по списку) + MD5

- [x] MD5 — crate: `md-5` (часто нужно для проверки старых хэшей)
- [x] SHA-256 — crate: `sha2`
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
- [ ] Добавить тесты для `wasm/encoding` (Rust):
  - корректность: round-trip для bytes/text, известные векторы, edge cases (пустой ввод, Unicode, большие входы)
  - ошибки: invalid char/padding с позицией (index) и сообщением
  - (опционально) `wasm-bindgen-test` для проверки wasm-сборки в браузерном раннере
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
- [ ] Добавить соглашение по имени выходного файла:
  - encode: добавлять расширение формата (например `.hex`, `.b64.txt`, `.b32.txt`, `.b58.txt`, `.url.txt`)
  - decode: восстанавливать «разумное» расширение по сигнатуре/MIME (если возможно), иначе fallback `.bin`

- [ ] Перенести текущие JS-реализации кодировщиков/декодеров в `wasm/encoding` (Rust) и использовать WASM в UI по умолчанию
  - причины: производительность (Base58 заметно медленный даже на маленьких файлах), единый корректный core, единые ошибки с позицией
  - цель: сохранить текущий UI/страницы, заменить реализацию под капотом (JS ↔ WASM interop)
  - (опционально) оставить JS fallback на случай проблем загрузки wasm

- [ ] Создать отдельные страницы инструментов (SSR + ToolLayout + SEO + hreflang), каждая со ссылками на другие форматы:
  - [x] Hex Encoder/Decoder
  - [x] Base32 Encoder/Decoder
  - [x] Base58 Encoder/Decoder
  - [x] Base64 Encoder/Decoder
  - [x] URL Encoder/Decoder (text only)

- [ ] UI требования для каждой страницы:
  - [ ] режим `Text` / `File` (кроме URL)
  - [ ] выбор кодировки текста (обязательно)
  - [ ] панель настроек формата (все доступные настройки)
  - [ ] copy результата, download результата, и понятные ошибки (с подсветкой позиции, где возможно)

- [ ] После того как все кодировки будут реализованы: при decode файла, если понятно что результат — изображение, показывать превью
  - [ ] Определение MIME по сигнатуре (PNG/JPEG/GIF/WebP/BMP/SVG)
  - [ ] UI: блок превью (img) + fallback на download
  - [ ] Ограничение размера превью/ленивая отрисовка для больших файлов (size limits)
  - [ ] Если decoded bytes успешно декодируются в выбранной кодировке → показывать text-preview
  - [ ] Иначе показывать «похоже на бинарник» + hex-preview первых N байт (настройка N)

- [ ] Улучшить ввод файлов/картинок: drag&drop + paste из буфера (без выбора через input)

## WASM: Cryptography (план работ)

### OpenSSH ключи

- [x] Проверить wasm-совместимость: `ssh-key`, `rsa`, `ed25519-dalek`, `p256/p384`, `pem-rfc7468`, `zeroize`, `bcrypt-pbkdf` (KDF OpenSSH) — используем собственный OpenSSH codec + `bcrypt-pbkdf`
  - [x] Базовый wasm: ed25519-dalek, p256/p384, base64 (используется для OpenSSH public keys)
- [x] Генерация ключевых пар: ed25519, ecdsa P-256/P-384, RSA 3072/4096
  - [x] Базовый WASM core: keygen Ed25519
  - [x] Базовый WASM core: keygen ECDSA P-256/P-384
  - [x] Базовый WASM core: keygen RSA (PKCS#8) + SPKI public key
- [x] Экспорт OpenSSH публичных ключей (one-line) + приватных ключей (new format с bcrypt KDF)
  - [x] Базовый WASM core: OpenSSH public key для Ed25519
  - [x] Базовый WASM core: OpenSSH public key для ECDSA P-256/P-384
  - [x] Базовый WASM core: OpenSSH public key для RSA (SPKI → ssh-rsa)
  - [x] Базовый WASM core: OpenSSH public key для RSA (PKCS#8 → ssh-rsa)
  - [x] Базовый WASM core: OpenSSH private key (new format, bcrypt KDF)
- [x] Импорт/парсинг OpenSSH public/private keys
  - [x] Базовый WASM core: парсинг OpenSSH public key (Ed25519)
  - [x] Базовый WASM core: парсинг OpenSSH public key (ECDSA P-256/P-384)
  - [x] Базовый WASM core: определение алгоритма и универсальный парсер
  - [x] Базовый WASM core: парсинг OpenSSH public key (RSA → SPKI)
  - [x] Базовый WASM core: парсинг OpenSSH private key (new format, bcrypt KDF)
- [x] Конвертация: OpenSSH ↔ PKCS#8 (PEM)
  - [x] Базовый WASM core: OpenSSH public key → SPKI (RSA/ECDSA)
  - [x] Базовый WASM core: OpenSSH public key → SPKI PEM (RSA/ECDSA)
  - [x] Базовый WASM core: SPKI PEM → OpenSSH public key (RSA/ECDSA)
  - [x] Базовый WASM core: OpenSSH private key → PKCS#8 (DER/PEM)
- [x] PKCS#8 encrypted → OpenSSH (passphrase)
- [ ] UI-предупреждения: RSA < 3072, устаревшие алгоритмы
- [x] UI-предупреждения: RSA < 3072, устаревшие алгоритмы

### X.509 (самоподписанные + CSR)

- [x] Генерация сертификатов (ed25519, ECDSA P-256/P-384) в WASM
- [x] RSA и ECDSA P-521 для X.509 пометить как native-only (rcgen требует `aws-lc-rs`)
- [x] Генерация CSR (PKCS#10) и экспорт PEM (crt/key)
- [x] Парсинг PEM/DER и вывод: Subject, Issuer, Validity, SAN, algos
- [x] UI-warnings: SHA-1/MD5, expired/not-yet-valid, weak curve, RSA < 3072

### Следующие шаги (ближайшие)

- [x] Потоковое шифрование больших файлов (chunk-by-chunk) поверх AEAD
- [x] OpenSSH private key (new format, bcrypt KDF) — исследование wasm-совместимых crates
- [x] X.509: выбрать wasm-совместимый путь (ed25519 + P-256/P-384) и минимальный набор полей

### Симметричное шифрование (AEAD)

- [x] AES-256-GCM, ChaCha20-Poly1305, XChaCha20-Poly1305
  - [x] Базовый WASM core: encrypt/decrypt для байтов
- [x] KDF из пароля: Argon2id + PBKDF2-SHA512
  - [x] Базовый WASM core: Argon2id/PBKDF2-SHA512
- [x] Потоковое шифрование больших файлов (chunk-by-chunk)
- [x] Потоковое шифрование больших файлов (chunk-by-chunk)
  - [x] Базовый WASM core: chunk helpers + nonce derivation
- [x] Формат: custom header (algorithm, salt, nonce, tag) + ciphertext
  - [x] Базовый WASM core: header pack/unpack + encrypt/decrypt
  - [x] Базовый WASM core: AEAD + KDF (password → key) end-to-end

### Подписи и верификация

- [x] Ed25519 подпись файлов/строк
  - [x] Базовый WASM core: keygen/sign/verify для байтов
- [x] ECDSA P-256/P-384
  - [x] Базовый WASM core: keygen/sign/verify для байтов
- [x] RSA-PSS
  - [x] Базовый WASM core: sign/verify RSA-PSS (SHA-256, PKCS#8/SPKI)
- [x] Detachable подпись (.sig) и интеграция с hash-модулем
  - [x] Базовый WASM core: pack/unpack .sig формата
  - [x] Базовый WASM core: sign/verify по алгоритму (Ed25519/ECDSA)
  - [x] Базовый WASM core: sign+pack и verify packed

### Дополнительно / ограничения

- [x] PKCS#12 / .pfx → native-only (не реализуемо в чистом WASM без OpenSSL)
- [x] JWT (JWS + JWE), HPKE — оценка wasm-совместимости библиотек (отложено, не в scope)
- [x] Конвертация ключей: OpenSSH ↔ PKCS#8 ↔ raw
- [x] Проверка цепочки сертификатов (локально, без сети)

## UI: Cryptography (Blazor + JS)

### Инфраструктура и интеграция

- [x] Сформировать список задач для UI криптографии
- [x] Добавить JS-лоадер для `cryptography.wasm` с lazy-load и кешированием в `wwwroot/` (по шаблону существующих инструментов)
- [x] Добавить C# сервис-обертку для JS interop (по образцу существующих инструментов)
- [x] Добавить общий JS-слой для файлов: chunking + progress + cancel (переиспользовать подход из hash/encoding)
- [x] Обеспечить корректное восстановление обработчиков при enhanced navigation (делегирование событий / re-init)

### UI: OpenSSH Keys

- [x] Создать страницу OpenSSH Keys (ToolLayout + AppStrings, SEO)
- [x] Реализовать генерацию ключей (ed25519, ECDSA P-256/P-384, RSA 3072/4096)
- [x] Реализовать импорт OpenSSH public/private и экспорт
- [x] Реализовать конвертацию PKCS#8 ↔ OpenSSH (public/private)
- [x] Добавить UI-предупреждения (RSA < 3072, устаревшие алгоритмы)
- [x] Добавить копирование и сохранение ключей в файл

### UI: X.509

- [x] Создать страницу X.509 (ToolLayout + AppStrings, SEO)
- [x] Реализовать генерацию self-signed сертификатов
- [x] Реализовать генерацию CSR
- [x] Реализовать парсинг PEM/DER (сертификат/ключ) с выводом полей
- [x] Добавить UI-предупреждения (SHA-1/MD5, expired/not-yet-valid, слабые ключи)
- [x] Добавить копирование и сохранение сертификатов/ключей в файл

### UI: AEAD File Encrypt/Decrypt

- [x] Создать страницу AEAD File Encrypt/Decrypt (ToolLayout + AppStrings, SEO)
- [x] Реализовать streaming encrypt/decrypt для файлов (chunking + progress + cancel)
- [x] Добавить вывод/редактирование заголовка формата (header) при необходимости
- [x] Добавить копирование/сохранение результата в файл

### Критерии проверки

- [ ] Убедиться, что UI выводит warnings (RSA < 3072, SHA-1/MD5, expired/not-yet-valid)
- [ ] Проверить, что ключи/сертификаты корректно копируются и сохраняются в файлы

## Инструменты сайта

- [x] Hash Calculator (все алгоритмы через WASM)
- [x] MD5 (через WASM)
- [ ] JSON Beautifier / Minifier
- [ ] XML Formatter
- [x] Hex Encoder/Decoder
- [x] Base32 Encoder/Decoder
- [x] Base58 Encoder/Decoder
- [x] Base64 Encoder/Decoder
- [x] URL Encoder/Decoder

## CI/CD

- [ ] GitHub Actions: build .NET + build WASM + тесты
- [ ] Пайплайн релиза (публикация статики/сайта)

## Идеи / открытые вопросы

- [ ] Нужен ли один crate на домен или несколько crates внутри домена?
- [ ] Нужны ли "чистые" Rust-реализации алгоритмов (без зависимостей), или можно использовать проверенные crates?
