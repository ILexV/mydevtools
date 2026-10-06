# fix-crypto — отчёт

Агент: `fix-crypto`. Инструменты: hash-calculator, password-generator, hmac-calculator, aead-file, openssh-keys, x509.
Завершено: 2026-10-06 15:26 (UTC+6). Изменения не закоммичены.

## Задача A — исправления

### A1. AEAD: обрезка файла на границе чанка → контейнер MDT3

**Проблема.** В MDT2 у всех чанков одинаковая AAD (пустая), и признака «последний чанк» нет. Поэтому файл, обрезанный ровно по границе чанка, расшифровывался «успешно» и давал неполный результат.

**Решение.** Ввёл новый формат MDT3: новые файлы шифруются только в MDT3, MDT2 по-прежнему читается.

Спецификация MDT3:

```
header = "MDT3" ‖ version u8 = 1 ‖ alg u8 ‖ kdf u8 ‖ salt_len u16le ‖ prefix_len u16le ‖ chunk_size u32le ‖ salt ‖ nonce_prefix
  alg: 1 = AES-256-GCM, 2 = ChaCha20-Poly1305 (prefix 4 B), 3 = XChaCha20-Poly1305 (prefix 16 B)
  kdf: 1 | 2 (на сайте — Argon2id 64 MiB / t=3 / p=1), salt ≥ 8 B, 1 ≤ chunk_size ≤ 64 MiB
  размер заголовка: 35 B (AES/ChaCha) или 47 B (XChaCha)
body = C_0 ‖ … ‖ C_{n-1}, n ≥ 1 (пустой файл → один пустой финальный чанк, всего 51 B)
C_i  = AEAD(key, nonce = prefix ‖ u64be(i), P_i, aad = header ‖ flag)
  flag = 0x01 для последнего чанка, 0x00 для остальных
  все чанки, кроме последнего, имеют длину ровно chunk_size байт открытого текста
```

Как работает защита:
- Заголовок входит в AAD каждого чанка, поэтому правка любого его поля, включая chunk_size, ломает аутентификацию.
- Расшифровщик считает финальным тот чанк, на котором кончается файл. Если файл обрезан по границе, последний оставшийся чанк был зашифрован с flag = 0, и проверка падает.
- Дописанный хвост, перестановка чанков и файл из одного заголовка тоже отвергаются (последний — с ошибкой «truncated container»).

Заголовок MDT3 проверяется строго (алгоритм ↔ длина префикса, kdf, salt, chunk_size). Разбор MDT2 оставлен прежним, нестрогим.

**Код.**
- `wasm/cryptography/src/aead.rs`:
  - ядро без JsValue: `StreamError`, `parse_stream_header_core`, `stream3_seal`, `stream_open`;
  - новые wasm-экспорты: `aead_stream3_header_pack`, `aead_stream3_encrypt_chunk`, `aead_stream3_decrypt_chunk`;
  - `aead_stream_header_info` возвращает 7-й элемент — формат (2 или 3).
- Сообщение «data too short for header» исправлено: раньше в нём были смешаны языки.
- `apps/site/src/scripts/wasm/aead-file-client.ts`: запись идёт в MDT3, чтение — MDT2 и MDT3; результат расшифровки содержит `format` и `passwordIndex`.
- Изменения в крейте `cryptography` только аддитивные: старые экспорты MDT2 и JWT не тронуты.

**Тесты (Rust).** Добавлены:
- `mdt3_roundtrip_all_algorithms_and_sizes`
- `mdt3_chunk_api_matches_reference`
- `mdt3_detects_truncation_at_chunk_boundary`
- `mdt2_cannot_detect_boundary_truncation_but_mdt3_can` — фиксирует исходный баг
- `mdt3_detects_reorder_append_and_tamper`
- `mdt3_header_validation`
- `aead_mdt2_legacy_fixture_still_decrypts` (в `tests/fixtures_tests.rs`). Фикстуры `aead_mdt2_legacy_chacha.b64` и `aead_mdt2_legacy_site.b64` созданы WASM-сборкой до изменений.

**Тесты (TS, `test/crypto-wasm.test.ts`).** Добавлены:
- зеркальный клиентский MDT3: обрезка, дописывание и перестановка отвергаются;
- legacy-фикстура MDT2 с паролем «как введён / обрезанный».

**Браузер.** 15/15 проверок:
- заголовок `4d445433`, round-trip;
- обрезка по границе чанка → ошибка;
- файл из одного заголовка → ошибка;
- legacy MDT2 открывается с заметкой о старом формате;
- пустой файл → 51 B.

Скриншот: `aead-legacy-note.png` (во временной папке агента).

### A2. Пароль без молчаливого trim()

Общий хелпер `apps/site/src/tools/crypto-password.ts`:
- `passwordCandidates(v)` возвращает `[как введён, обрезанный]`; обрезанный вариант добавляется, только если отличается и не пустой;
- `hasEdgeWhitespace(v)` проверяет пробелы по краям.

**aead-file.**
- Шифрование идёт ровно введённым паролем.
- Если по краям есть пробелы, под полем появляется ненавязчивая подсказка (`PasswordWhitespaceHint`).
- Расшифровка: сначала пароль как введён, затем обрезанный вариант. Кандидаты проверяются на первом чанке, по одному Argon2 на кандидата.
- Если подошёл обрезанный вариант, показывается заметка `NoteTrimmedPassword`.

**openssh-keys.**
- Парольная фраза при генерации берётся как введена; подсказка о пробелах — `PassphraseWhitespaceHint`.
- Импорт и конвертация: при ErrorWrongPassphrase делается повтор с обрезанной фразой и показывается заметка `NoteTrimmedPassphrase`.

**Тесты и браузер.**
- Тесты: unit-тесты `passwordCandidates`/`hasEdgeWhitespace`; legacy-фикстура открывается фразой `" legacy pass "` (passwordIndex 1).
- Браузер: файл, зашифрованный паролем с пробелами, не открывается обрезанным паролем; SSH-ключ с фразой `' sp '` сохраняет пробелы; fallback-заметка показывается.

### A3. Генерация ключей в Web Worker с отменой

Сделано по образцу `image-tools-client`:
- `apps/site/src/scripts/wasm/keygen-protocol.ts` — протокол сообщений;
- `apps/site/src/workers/crypto-keygen.worker.ts` — генерирует Ed25519, P-256, P-384 и RSA в OpenSSH, вместе с публичной строкой и предупреждениями;
- `apps/site/src/scripts/wasm/keygen-client.ts` — `sshGenerateInWorker(opts, signal)`; abort завершает воркер через `terminate()` и отклоняет промис с `WasmError("aborted")`.

В UI openssh-keys:
- неопределённый `Progress` с прошедшими секундами;
- кнопка **Cancel**; после отмены — заметка `GenerationCanceled`;
- busy-состояние кнопок сохранено.

Браузер, 10/10:
- RSA 4096 сгенерирован за 14 с, в ключе 4096 бит;
- максимальный разрыв таймера главного потока во время генерации — 53 мс, то есть UI не блокируется;
- Cancel прерывает генерацию.

Скриншот: `ssh-generating.png`.

TS-тест: RSA-генерация через путь воркера с парольной фразой.

### A4. x509: разбор CSR (PKCS#10)

`wasm/cryptography/src/x509.rs`:
- `csr_der_from_pem` принимает метки `CERTIFICATE REQUEST` и `NEW CERTIFICATE REQUEST`;
- `csr_json` возвращает JSON с фиксированным порядком ключей: `type, subject, publicKey, publicKeyAlgorithmOid, signatureAlgorithmOid, signatureValid, subjectAltNames, keyUsage, extendedKeyUsage, basicConstraints`;
- подпись проверяется через `x509-parser` с feature `verify`. `ring` уже был зависимостью; в `Cargo.lock` добавилось одно ребро. `signatureValid` = `true` / `false` / `null`, где `null` означает неподдерживаемый алгоритм;
- новые экспорты: `x509_parse_csr_pem`, `x509_parse_csr_der`. В `crypto-client.ts` только добавлен `x509ParseCsr`.

UI:
- CSR в PEM определяется через `isCsrPem` и разбирается как CSR;
- Base64 DER сначала пробуется как сертификат, затем как CSR;
- при `signatureValid === false` показывается предупреждение `WarningCsrSignature`;
- плейсхолдер теперь говорит «certificate or CSR».

Тесты:
- Rust: CSR всех трёх алгоритмов, созданные инструментом; фикстура OpenSSL RSA-2048 (SAN DNS/IP/email, EKU, KU); Ed25519 DER; изменённый CSR → `false`; не-запрос отвергается;
- TS: разбор CSR.

Браузер, 7/7. Скриншот: `x509-csr.png`.

### A5. HMAC пустого сообщения

`hmac-calculator.client.ts` теперь вычисляет HMAC при непустом ключе, даже если сообщение пустое. Значения сверены с node:crypto; TS-тест покрывает HMAC-SHA256(key="key", "") = `5d5d1395…07d0`. Браузер: 5/5.

## Задача B — SEO-тексты

Для всех 6 инструментов во всех 10 локалях переписаны:
- Description и Keywords;
- `Seo_Introduction`, `Seo_DetailedDescription`;
- `Seo_Examples` — 4 примера;
- `Seo_HowToSteps` — шаги;
- `Seo_Tips` — 5 советов.

Тексты описывают реальное поведение после исправлений: MDT3, пароль как введён, воркер с Cancel, разбор CSR, HMAC пустого сообщения. Примеры проверены в инструменте или тестами. UI-метки взяты дословно из JSON соответствующей локали. Скрипт применения проверяет формат: слова шагов по локалям, 3–5 шагов, 4–6 советов, 3–4 примера, отсутствие ссылок и HTML, одинаковое число шагов во всех локалях.

| Инструмент | Шагов | Что важно в тексте |
|---|---|---|
| hash-calculator | 4 | реальный набор алгоритмов; совет о порядке байтов CRC/xxHash (см. открытые вопросы) |
| password-generator | 4 | реальные опции и оценка энтропии |
| hmac-calculator | 4 | пустое сообщение допустимо, формат ключа |
| aead-file | 4 | MDT3, Argon2id, чанки 1 МиБ, пароль как введён, чтение старых MDT2 |
| openssh-keys | 5 | Ed25519/ECDSA/RSA, bcrypt-pbkdf + aes256-ctr, воркер + Cancel, импорт и конвертация, имена файлов |
| x509 | 4 | генерация без SAN, Ed25519 не для браузерного TLS, разбор сертификата и CSR, `signatureValid` |

Description в zh, ja и ko короче 100 символов (75–92): для CJK это нормальная длина, предупреждение принято сознательно.

## Проверки (все тесты — под `/tmp/mydevtools-tests.lock`)

| Проверка | Результат |
|---|---|
| `cargo test -p mydevtools_cryptography` | lib 84 passed, fixtures 4 passed |
| WASM-биндинги `cryptography` | пересобраны через `wasm/build.ps1 -Domains cryptography` в `src/generated/wasm` |
| `node --test test/crypto-wasm.test.ts test/crypto-tools.test.ts` | 27/27 |
| `npx astro check` | 0 errors, 0 warnings, 4 hints (cron-core, registry.test — не мои) |
| `npm run validate:i18n` | 0 errors, 1 warning (`de/tools/uuid-generator` Title — не мой) |
| Функциональный Playwright | AEAD 15/15, SSH 10/10, x509 7/7, HMAC 5/5 |
| Матрица Playwright: 6 инструментов × en/ru/ja/hi × light/dark × 1440/375 | 96/96: тема применена, нет горизонтального переполнения, в JSON-LD HowTo столько же шагов, сколько заголовков шагов, нет сырых `**`/`###`, консоль чистая |

## Открытые вопросы и просьбы к владельцам общих файлов

1. **hash-calculator — порядок байтов некриптографических контрольных сумм.** Крейт `hash` выводит CRC32/xxHash в little-endian, например CRC32("hello") = `86a61036` вместо стандартного `3610a686`; xxh3 тоже развёрнут. Так было и в старой версии сайта. Не исправлял: это меняет результаты и требует решения владельца. Пока описано в совете SEO.
2. **AEAD.** KDF (Argon2id, около 1 с) и чанковое шифрование идут в главном потоке. Можно перенести в воркер по образцу keygen.
3. **Реестр `tools.ts` (общий).** Для openssh-keys можно добавить capability `cancel`. Не редактировал: файл чужой.
4. **x509.** В UI нет полей SAN для генерации, поэтому сертификаты подходят только для тестов; в SEO это сказано прямо. Если нужно, следующий шаг — поле SAN.

## Изменённые файлы

Rust:
- `wasm/cryptography/Cargo.toml`, `wasm/Cargo.lock`
- `wasm/cryptography/src/aead.rs`, `wasm/cryptography/src/x509.rs`
- `wasm/cryptography/tests/fixtures_tests.rs`
- новые фикстуры `wasm/cryptography/tests/fixtures/{aead_mdt2_legacy_chacha.b64, aead_mdt2_legacy_site.b64, csr_rsa2048_openssl.pem, csr_ed25519_openssl.der.b64}`

Сайт:
- `src/scripts/wasm/{aead-file-client.ts, crypto-client.ts (только добавление)}`
- новые: `src/scripts/wasm/{keygen-client.ts, keygen-protocol.ts}`, `src/workers/crypto-keygen.worker.ts`, `src/tools/crypto-password.ts`
- `src/tools/{AeadFileCrypto.astro, aead-file.client.ts, OpenSshKeys.astro, openssh-keys.client.ts, X509Tool.astro, x509.client.ts, x509-helpers.ts, hmac-calculator.client.ts}`
- `test/{crypto-wasm.test.ts, crypto-tools.test.ts}`
- `src/generated/wasm/cryptography/*` (сгенерировано)

Локали (все 10): `src/i18n/locales/*/tools/{hash-calculator, password-generator, hmac-calculator, aead-file, openssh-keys, x509}.json`, где обновлены SEO-тексты и добавлены новые UI-ключи.
