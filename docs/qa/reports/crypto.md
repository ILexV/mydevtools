# QA-отчёт: группа crypto (агент `qa-crypto`)

Дата: 2026-10-06, завершено 12:45 (UTC+6). Объект: `apps/site`, dev-сервер `http://localhost:3312/mydevtools/`.
Инструменты: hash-calculator, password-generator, hmac-calculator, aead-file, openssh-keys, x509.

## Сводка по чек-листу

| Инструмент | 1 Консист. | 2 Функционал | 3 Ошибки/границы | 4 Визуал | 5 Локализация | 6 Консоль/сеть | 7 Тесты | 8 Доступность |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hash-calculator | ✅ эталон foundation, не трогал | ✅ 39 алгоритмов, поиск, счётчик, файл 5 МиБ, отмена 120 МиБ | ✅ пустой ввод, Unicode/эмодзи, нет алгоритмов → ошибка | ✅ | ✅ en/ru/de/ja | ✅ 0 ошибок, только `hash_bg.wasm` | ✅ + контракт «каталог TS ↔ Rust» на реальном WASM | ✅ |
| password-generator | ✅ мигрирован | ✅ авто-генерация, длина 4–128, наборы, свои символы, история ≤10, copy, сохранение настроек | ✅ нет наборов → локализованная ошибка; Unicode/эмодзи-символы; мусор в localStorage | ✅ | ✅ (3 непереведённые строки исправлены) | ✅ только `password_bg.wasm` | ✅ Rust 9 + TS | ✅ `aria-invalid`, `role=alert`, `<output>` для длины |
| hmac-calculator | ✅ мигрирован (кнопки были без стилей) | ✅ живой пересчёт, SHA-256/512, copy, clear | ✅ RFC 4231 TC2/TC6, ключ > блока, эмодзи, 1 МБ сообщение | ✅ | ✅ | ✅ только `cryptography_bg.wasm` | ✅ RFC 4231 на реальном WASM | ✅ |
| aead-file | ✅ мигрирован | ✅ 3 алгоритма, round-trip, 0 байт, 3,5 МиБ (4 чанка), скачивание, прогресс, отмена 60 МиБ | ✅ неверный пароль / подмена / не-.aead / пустой файл → локализованные ошибки | ✅ | ✅ (+3 ключа × 10 языков) | ✅ | ✅ Rust +3, WASM-контракт (ошибки, перестановка чанков) | ✅ `aria-pressed` у «показать пароль», `aria-busy`, `aria-valuenow` |
| openssh-keys | ✅ мигрирован, FileDrop + `bindDropzone` | ✅ Ed25519/P-256/P-384/RSA 3072/4096, импорт/конвертация всех форматов, файл, drag&drop, copy/download | ✅ без/с неверной фразой, мусор, битая строка/PEM | ✅ | ✅ (+3 ключа × 10 языков) | ✅ | ✅ Rust +7 (RFC 8410) + фикстура | ✅ |
| x509 | ✅ мигрирован | ✅ self-signed/CSR, DN, срок, алгоритм, разбор PEM/Base64-DER, copy/download | ✅ плохой DN, срок 0/36501/1.5/пусто, битый PEM/Base64 → локализованные ошибки | ✅ | ✅ (+3 ключа × 10 языков, ru-подпись) | ✅ | ✅ Rust +8, WASM-контракт | ✅ |

Легенда: ✅ проверено в реальном браузере (Playwright/Chromium) и/или тестами.

## Найденные и исправленные баги

**openssh-keys**
1. **Кнопка «Импорт» не работала**: у textarea и кнопки был один хук `data-ssh-import`, `querySelector` возвращал textarea для обоих → обработчик импорта висел на клике по полю ввода. Хуки разведены (`data-ssh-import-text` / `data-ssh-import-btn`).
2. **«RSA 4096» генерировал 3072-битный ключ** (размер брался только из селекта «Key size» = «Default»). Вынесено `rsaBits()`; проверено: модуль 4096 бит (node `createPublicKey`).
3. **ECDSA public-строки (`ecdsa-sha2-…`) → «Unsupported key format»** (распознавался только префикс `ssh-`).
4. **Ed25519 ↔ SPKI не поддерживался** («ed25519 SPKI conversion not implemented yet») — а Ed25519 алгоритм по умолчанию. Реализовано в `wasm/cryptography/src/openssh.rs` (в обе стороны + из приватного ключа).
5. **Битая public-строка импортировалась как валидная** (`ssh-ed25519 AAAA!!!… c`). Теперь полный разбор через `openssh_public_key_bytes`.
6. **`id_key` скачивался как `id_key.txt`** (MIME `text/plain`). Теперь `application/octet-stream`.
7. Зона «Key file» выглядела как drop-зона, но drop не обрабатывала; input был `hidden` (нет клавиатуры). Теперь `FileDrop` + `bindDropzone`, файл загружается в textarea (видно, что импортируется).
8. Нет индикации занятости при RSA-генерации (до ~18–48 с, главный поток): добавлены `aria-busy` + блокировка кнопок + отрисовка до тяжёлого вызова.
9. Ошибки фразы-пароля показывались сырыми строками WASM → локализованы (`ErrorPassphraseRequired`, `ErrorWrongPassphrase`); «Default» и ошибки отделены от предупреждений (отдельные `StatusMessage` error/warning).

**x509**
10. **Поле «Validity (days)» игнорировалось**: сертификаты были действительны 1975–4096 (умолчание rcgen). Добавлен `x509_self_signed_pem_ex(…, validity_days, now_unix, …)`; проверено node `X509Certificate`: ровно N дней.
11. **Subject `CN=example.com,O=My Org,C=US` целиком попадал в CN** (подсказка UI предлагает именно DN-формат). Добавлен разбор DN (CN/O/OU/L/ST/C, `\,`, проверка страны; «голое» имя = CN, как раньше) — `x509_self_signed_pem_ex` / `x509_csr_pem_ex`.
12. Неверный комментарий: «algorithm fixed to ecdsa-p256 (1)» — на деле 1 = Ed25519 (и в legacy). Поведение по умолчанию сохранено (Ed25519), добавлен выбор алгоритма (Ed25519 / P-256 / P-384); комментарий в `crypto-client.ts` исправлен.
13. Захардкоженное «Error:» и сырые «invalid PEM»/«invalid certificate» → локализовано (`Common_Error`, `InvalidFormat`, новые `ErrorValidityDays`, `ErrorInvalidSubject`); Base64 теперь проверяется строго.

**aead-file**
14. Неверный пароль / подмена / «не .aead» показывали сырые строки WASM (в т. ч. смешанные «data too короткие для header»). Клиент помечает этап (`AeadError.failure`: header/auth/crypto), UI показывает локализованные `ErrorDecryptFailed` / `ErrorInvalidContainer`. Заголовок с неизвестным алгоритмом / нулевым размером чанка отклоняется до KDF.
15. После ошибки оставались результат и активная кнопка «Скачать» от прошлой операции → выход сбрасывается перед запуском.
16. `URL.revokeObjectURL` сразу после `click()` → отложен (как и в openssh/x509).

**password-generator**
17. Ошибка «нет набора символов» писалась **в поле пароля** (и могла быть скопирована) → `StatusMessage` + `aria-invalid`, поле пустое.
18. Дубликаты в «своих символах» искажали распределение (`!!!!a` → `!` в 4 раза вероятнее); пробелы/управляющие символы попадали в пароль. Исправлено в `wasm/password` (дедупликация, фильтр, пробельный ввод → набор по умолчанию).
19. Массив в localStorage принимался за настройки (`[].length` → длина 4) — найден тестом, исправлен в `sanitizeSettings`.
20. Локализация: `OptionsLabel`, `HistoryEmpty`, `ErrorNoCharset` были на английском во всех 9 языках — переведены.

**hmac-calculator**
21. Кнопки «Calculate»/«Clear» были **без стилей** (классы `mdt-btn…` не существуют) — видно на скриншоте до миграции.
22. Защита от устаревшего результата при живом пересчёте (счётчик запусков).

## Миграция на общий слой

Все 5 инструментов (hash — эталон foundation) переведены на `ds-*` и компоненты `Field`, `FileButton`, `FileDrop`, `Progress`, `OutputPanel`, `StatusMessage`; `copyWithFeedback` (`.is-copied`), `bindDropzone` (`.is-dragover`), `formatBytes`/`progressPercent` из `@/lib/format`. Удалены локальные `.primary-btn/.ghost-btn/.link-btn/.field-label/.file-btn/.progress-*/textarea/.check/.*-error`; input файлов больше не `hidden`. В scoped `<style>` осталась только раскладка (без хардкод-цветов). Строки истории паролей — `ds-result-row` (раньше scoped-стили на них не действовали).

## Тесты

| Файл | Что | Результат |
| --- | --- | --- |
| `wasm/password/src/lib.rs` (было 0) | 9 тестов: длина в символах (вкл. эмодзи), только выбранные классы, свои символы, дедупликация/пробелы, размер алфавита, нет наборов, длина 0, неповторяемость, равномерность (χ-подобная проверка ±15 %) | 9/9 ✅ |
| `wasm/cryptography/src/openssh.rs` | +6: Ed25519 → SPKI = RFC 8410 §10.1, SPKI → строка, private/public SPKI совпадают, SPKI round-trip Ed25519/P-256/P-384, зашифрованный ключ (фраза с пробелом, комментарий, PKCS#8 туда-обратно), RSA PKCS#8 → OpenSSH | ✅ |
| `wasm/cryptography/src/x509.rs` | +8: голое имя = CN, полный DN (экранирование, страна в верхнем регистре), ошибки DN, окно срока = N дней + предупреждение «expired», границы 0/36501/36500, CSR с DN, неизвестный алгоритм, DER = PEM + SAN | ✅ |
| `wasm/cryptography/src/aead.rs` | +3: потоковый формат как в `aead-file-client` (3 алгоритма × 3 чанка, Argon2id, Unicode-пароль), другой пароль → другой ключ, nonce по чанкам | ✅ |
| `wasm/cryptography/tests/fixtures_tests.rs` | +1: реальная ssh-keygen Ed25519 фикстура → SPKI → обратно | ✅ |
| Итого crate `mydevtools_cryptography` | lib 73 + fixtures 3 | 76/76 ✅ |
| `apps/site/test/crypto-tools.test.ts` (новый) | 14 тестов: `password-settings`, `aead-file-helpers`, `openssh-keys-helpers`, `x509-helpers`, каталог хэшей | 14/14 ✅ |
| `apps/site/test/crypto-wasm.test.ts` (новый) | 6 контрактных тестов на **сгенерированных** WASM (`src/generated/wasm`): все 39 id каталога принимаются Rust + сверка с node; password; HMAC RFC 4231 TC2/TC6 + пустые/Unicode; AEAD-контейнер с параметрами сайта (неверный пароль, подмена тега, перестановка чанков, не-контейнер, пустой файл — пути ошибок, недоступные нативным Rust-тестам); X.509 Ex API + префиксы ошибок, на которые опирается UI; OpenSSH-сообщения, которые мапит `sshErrorKey`. Пропускается, если биндинги не сгенерированы | 6/6 ✅ (~3,7 с) |
| `npx astro check` | весь сайт | 0 ошибок ✅ |
| `npm run validate:i18n` | | 0 ошибок ✅ (7 предупреждений — чужие инструменты) |

Вынесенные чистые модули: `src/tools/password-settings.ts`, `aead-file-helpers.ts`, `openssh-keys-helpers.ts`, `x509-helpers.ts`.
Биндинги пересобраны под блокировкой: `-Domains password`, `-Domains cryptography`.

Браузер (Playwright, `scratchpad/qa-crypto/func.mjs`): **99 проверок, 0 провалов**; эталон сверки — `node:crypto` (хэши, HMAC, SPKI/PKCS#8, X509Certificate, модуль RSA).

## Визуал / локализация / консоль

- Матрица: 6 инструментов × en (light/dark × 1440/375) + ru/de/ja (light/dark × 375) + de/ja (light × 1440) = 72 страницы — горизонтального скролла нет, ошибок консоли нет, внешних запросов нет. Заполненные состояния (длинные ключи RSA, длинные имена файлов, ошибки, результаты): 24 снимка — ничего не вылезает за корень инструмента, длинные строки переносятся.
- WASM грузится только на своей странице (`hash_bg`, `password_bg`, `cryptography_bg`).
- Фокус: Tab-обход AEAD / OpenSSH / password — кольцо есть у всех контролов (поля — box-shadow DS, кнопки и file-label — 2px outline).
- ja: в headless Chromium этой машины нет CJK-шрифтов (квадраты на скриншотах) — проверено по DOM (переведено, сырых ключей нет); не баг сайта.

Скриншоты: `/tmp/claude-1001/-home-lex-github-mydevtools/3051f920-6aff-44cf-91a3-0734cea3fd9a/scratchpad/qa-crypto/`
- `before-*.png` — до миграции (в т. ч. HMAC без стилей кнопок);
- `m-<slug>-<lang>-<theme>-<width>.png` — матрица;
- `s-<slug>-<theme>-<width>.png` — заполненные состояния;
- `aead-progress.png` — прогресс шифрования 60 МиБ.
Скрипты: `shot.mjs`, `func.mjs` (лог `func-final.log`), `state.mjs`, `l10n.mjs`.

## Открытые вопросы (владельцу)

1. **AEAD: усечение по границе чанка не обнаруживается** — у формата `MDT2` нет флага последнего чанка; файл, обрезанный ровно после N целых чанков, расшифровывается без ошибки (укороченным). Исправление требует новой версии формата (например, флаг/AAD «last» в последнем чанке) с сохранением чтения v1 — отдельная задача.
2. **Пароль AEAD и фраза OpenSSH обрезаются `trim()`** — паритет с legacy (иначе не расшифровать файлы старого сайта); пароль с пробелами по краям молча меняется. Решить, оставлять ли.
3. RSA-генерация идёт в главном потоке (4096 бит ≈ 18–48 с, UI заморожен; есть только индикатор занятости). Кандидат на Web Worker.
4. x509: разбор CSR не поддерживается (плейсхолдер обещает «certificate, CSR, or key») — сейчас понятная ошибка «Invalid format». Ed25519-сертификаты (умолчание legacy) браузеры для TLS не принимают — оставлен по паритету, добавлен выбор ECDSA.
5. Rust-ошибки в `aead.rs` содержат смешанный текст («data too короткие для header») — в UI больше не показываются; править строки не стал (crate общий, нужна пересборка в момент работы других агентов).
6. HMAC: пустое сообщение даёт пустой результат (паритет), хотя HMAC от пустой строки валиден.

## Запросы к общему слою (foundation)

1. `ds-alert-info` красится в `--mdt-accent` = цвет категории; в «Cryptography» (красная) info неотличим от ошибки. Нужен нейтральный/синий info-тон. Я обошёл: заметка AEAD — `ds-hint`, инфо-строка OpenSSH — `ds-status`.
2. `FileButton`/`FileDrop` не дают способа пометить зону для скринридера (у зоны нет имени); вариант — проп `labelledby`.
3. Нет варианта «поле + кнопка-иконка в одном ряду» (пароль + «показать») — сделал локальной flex-раскладкой `.aead-password-row`; можно добавить `ds-input-group`.

## Изменённые файлы

`apps/site/src/tools/{PasswordGenerator,HmacCalculator,AeadFileCrypto,OpenSshKeys,X509Tool}.astro`, `{password-generator,hmac-calculator,aead-file,openssh-keys,x509}.client.ts`, новые `{password-settings,aead-file-helpers,openssh-keys-helpers,x509-helpers}.ts`; `src/scripts/wasm/aead-file-client.ts` (добавлен `AeadError`), `src/scripts/wasm/crypto-client.ts` (только добавления `x509SelfSignedEx`/`x509CsrEx`/`X509_ALG` + исправлен комментарий); локали `*/tools/{aead-file,openssh-keys,x509,password-generator}.json`; `wasm/password/src/lib.rs`; `wasm/cryptography/{Cargo.toml (+time),src/openssh.rs,src/x509.rs,src/aead.rs,tests/fixtures_tests.rs}`; тесты `apps/site/test/crypto-{tools,wasm}.test.ts`. `wasm/cryptography/src/jwt.rs` — изменения не мои (группа text). Коммитов нет.
