Crypto Utilities for Browser WASM (Rust + wasm-bindgen)
Цель: полностью оффлайн мультитул для IT/DevOps
Принципы:
• Всё на чистом Rust (no C-dependencies где возможно)
• WASM-совместимые crates (no_std / alloc-friendly где нужно)
• Максимальная приватность — ничего не уходит с клиента
• UI-driven (пока только браузерный интерфейс)
• Показывать предупреждения об устаревших/небезопасных алгоритмах
• Обязательно: unit-тесты + примеры использования в UI / docs

Приоритетный порядок реализации (2026 → актуальные алгоритмы и форматы)

1. Генерация и работа с OpenSSH-совместимыми ключами (самый высокий приоритет сейчас)

Функционал:
• Генерация ключевых пар:
  - ed25519           (рекомендуемый, самый быстрый и безопасный)
  - ecdsa-sha2-nistp256 / nistp384 / nistp521
  - rsa-sha2-512 / rsa-sha2-256 (минимум 3072–4096 бит)
• Экспорт в OpenSSH формат (однострочный и многострочный):
  - ssh-ed25519 AAAAC3... user@host
  - -----BEGIN OPENSSH PRIVATE KEY----- ... (new format с bcrypt KDF)
  - -----BEGIN RSA PRIVATE KEY----- ... (legacy PEM)
• Импорт / парсинг OpenSSH публичных и приватных ключей
• Конвертация между форматами:
  OpenSSH → PEM (PKCS#8)
  PEM → OpenSSH
  PKCS#8 encrypted → OpenSSH (с passphrase)
• Генерация passphrase-protected ключей (bcrypt KDF как в ssh-keygen)

Рекомендуемые crates (требует проверки на wasm32-unknown-unknown для каждой фичи):
• ed25519-dalek          → ed25519
• x25519-dalek           → curve25519 (можно для hybrid)
• rsa                    → RSA keys
• ssh-key                → основной crate для OpenSSH форматов (парсинг, генерация, шифрование приватных ключей)
• pem-rfc7468            → для PEM обёртки
• zeroize                → обязательная очистка памяти

2. Базовые X.509 сертификаты (самоподписанные + CSR)

• Генерация самоподписанного сертификата (для localhost, dev-серверов, nginx)
  - Subject + SAN (DNS:localhost, IP:127.0.0.1, IP:::1)
  - Алгоритмы: ed25519, ecdsa P-256/P-384, rsa 3072/4096
  - Валидность: 1 год по умолчанию (настраиваемо)
• Экспорт: server.crt (PEM), server.key (PEM или PKCS#8)
• Генерация CSR (PKCS#10) → для Let's Encrypt / внутренних CA
• Парсинг существующих сертификатов (PEM / DER)
  - Показывать: Subject, Issuer, Validity, SAN, Key algorithm, Signature algorithm
  - Предупреждения: SHA1, RSA <3072, expired, weak curve

Crates:
• x509-cert              (или x509-parser + certificate-builder)
• rcgen                  → удобная генерация самоподписанных cert и CSR
• der, pem-rfc7468

WASM-ограничения для X.509:
• rcgen: генерация RSA (и ECDSA P-521) требует feature `aws-lc-rs` — это native и не работает в wasm32-unknown-unknown.
  → В браузерном WASM остаются ed25519 и ECDSA P-256/P-384. RSA/P-521 лучше пометить как «только native/не поддерживается в WASM». 

3. Симметричное шифрование файлов / данных (AEAD)

• Алгоритмы (все актуальные на 2026):
  - AES-256-GCM
  - ChaCha20-Poly1305     (рекомендуется для мобильных/слабых CPU)
  - XChaCha20-Poly1305    (64-битный nonce → проще)
• Ключ из пароля: Argon2id (рекомендуемый), PBKDF2-SHA512 (совместимость)
• Потоковое шифрование больших файлов (chunk-by-chunk)
• Формат: custom header (algorithm, salt, nonce, tag) + ciphertext

Crates:
• chacha20poly1305
• aes-gcm
• aead (trait)
• argon2
• hkdf (для derivation)

4. Подписи и верификация

• Ed25519 подпись файлов / строк
• ECDSA (P-256 / P-384)
• RSA-PSS
• Детachable подпись (отдельный .sig файл)
• Простая интеграция с вашим hash-модулем (blake3, sha3-256/512)

Crates:
• ed25519-dalek + signature
• ecdsa + signature
• rsa (PSS)

5. Дополнительно (2–3 этап)

• PKCS#12 / .pfx импорт/экспорт  ⚠️ Важно: в WASM практически не реализуемо без native OpenSSL/legacy-крипто.
  → Перенести в «native-only» или заменить на PKCS#8 + PEM.
• JWT (JWS + JWE) — RS256, ES256, EdDSA, A256GCMKW
• HPKE (hybrid public key encryption)
• Конвертация ключей: OpenSSH ↔ PKCS#8 ↔ raw
• Проверка цепочки сертификатов (локально, без сети)

Общие требования к реализации:
• wasm-bindgen экспорт функций
• zeroize для всех ключей/паролей
• UI warnings для:
  - RSA < 3072
  - SHA-1 / MD5
  - expired / not-yet-valid
  - weak curves (secp192r1, etc.)
• Тесты: wasm-bindgen-test + browser test
• Примеры в UI: кнопки «Пример для nginx», «Пример ed25519 SSH ключ»

Рекомендуемый минимальный Cargo.toml фрагмент (feature flags для размера):

[dependencies]
wasm-bindgen = "0.2"
js-sys = "0.3"
getrandom = { version = "0.2", features = ["js"] }
zeroize = { version = "1.8", features = ["zeroize_derive"] }
ssh-key = { version = "0.6", features = ["ed25519", "rsa", "ecdsa"] }
rcgen = "0.13"
x509-cert = "0.2"
chacha20poly1305 = "0.10"
aes-gcm = "0.10"
argon2 = "0.5"
ed25519-dalek = "2.1"
rsa = { version = "0.9", features = ["sha2"] }
pem-rfc7468 = "0.7"
blake3 = "1.5"                  # для вашего hash-модуля

[dev-dependencies]
wasm-bindgen-test = "0.3"

