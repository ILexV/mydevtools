# 📘 MyDevTools.app — Privacy-First Developer Tools

[![.NET 10](https://img.shields.io/badge/.NET-10-blue)](https://dotnet.microsoft.com/)
[![Blazor](https://img.shields.io/badge/Blazor-SSR-purple)](https://blazor.net/)

## 📌 Общая идея проекта

Проект **MyDevTools.app** — это веб-сервис инструментов для разработчиков
(JSON, XML, Base64, hash, formatter, validator и т.д.).

### Ключевые принципы

* 🔐 **Privacy-first** — все преобразования выполняются **в браузере пользователя**
* 🚫 **Никакие пользовательские данные не отправляются на сервер**
* ⚡ **WASM для вычислений**, сервер используется только для SSR и статики
* 🌍 **Многоязычный сайт (i18n)** — поддержка английского, русского, испанского
* 🔍 **SEO-friendly (SSR, JSON-LD, hreflang)**

---

## ✅ Реализованные функции

### 🎯 Готово к использованию

- ✅ **SSR (Server-Side Rendering)** — быстрая первая загрузка, SEO-оптимизация
- ✅ **Многоязычность** — автоматическое определение языка браузера
  - 🇬🇧 Английский (en)
  - 🇷🇺 Русский (ru)
  - 🇪🇸 Испанский (es)
- ✅ **Strongly-Typed Resources** — compile-time безопасность для переводов
- ✅ **Темная/Светлая тема** — CSS-переменные для кастомизации
- ✅ **Первый инструмент: Hash Calculator** — хэши текста и файлов (streaming) через Rust→WASM.
  - вычисляет **только по выбранным алгоритмам** (для файла — по кнопке, для текста — можно пересчитать сразу)
  - выбор алгоритмов сохраняется в **localStorage** (по умолчанию: **MD5, SHA-1, SHA-256**)
  - большой список алгоритмов: поиск, «выбранные сверху», сортировка по алфавиту
  - прогресс и отмена для файлов, кнопка копирования результата
  Поддерживаются: MD5, SHA-1/2/3, Keccak, SHAKE, BLAKE2/3, RIPEMD, CRC32/Adler32, xxHash, SipHash, HighwayHash, MetroHash, FNV/FxHash/SeaHash, Streebog-256/512 (ГОСТ Р 34.11-2012).
- ✅ **Encoding инструменты (WASM + JS UI)** — Hex, Base32, Base58, Base64, URL (text+file где применимо)
- ✅ **Cryptography WASM core** — OpenSSH keys (public/private + bcrypt KDF), AEAD (AES-GCM/ChaCha/XChaCha + streaming), X.509 self-signed + CSR, PEM/DER parsing + warnings
- ✅ **SEO компоненты** — MetaTags, JSON-LD, Hreflang
- ✅ **Переиспользуемые UI компоненты** — ToolLayout, LoadingSkeleton, ThemeToggle

### 🚧 В разработке

- 🔜 **Новые инструменты** — JSON Beautifier, XML Formatter
- 🔜 **Structured Data WASM** — JSON/XML/YAML форматирование и валидация

---

## 🧱 Технологический стек

* **.NET 10** — последняя версия платформы
* **Blazor Web App (SSR)** — server-side rendering без WebSocket
* **Blazor Components** — переиспользуемые UI компоненты
* **WebAssembly** (используется)
  * основной язык WASM: **Rust**
  * C# используется только для UI и orchestration
* **Web Crypto API** — опционально (для некоторых сценариев), но Hash Calculator считает всё через WASM
* **Cloudflare CDN** — кэширование статики (планируется)
* **Без server-side API для обработки данных**

---

## 🧠 Архитектурные правила (ОЧЕНЬ ВАЖНО)

### ❌ Запрещено

* ❌ Любая обработка пользовательских данных на сервере
* ❌ Отправка файлов, текста, JSON, XML на backend
* ❌ Использование ASP.NET Minimal API для логики инструментов
* ❌ WebSocket / SignalR для интерактивности (только SSR + JavaScript)

### ✅ Разрешено

* ✅ Server-Side Rendering **только для HTML**
* ✅ Client-side JavaScript для UI интерактивности
* ✅ Client-side WASM для вычислений (а JS — для UI)
* ✅ Сервер — только:
  * SSR
  * отдача статики
  * SEO-метаданные
  * токены доступа (без данных пользователя)

---

## 🏗️ Структура проекта

### 🗂️ Структура репозитория (актуально)

> Ниже — структура от корня репозитория. Папки `bin/`, `obj/`, `.vs/`, `_ReSharper.Caches/` и т.п. намеренно опущены.

```
/
├── README.md
├── MyDevToolsApp/
│   ├── MyDevToolsApp.slnx
│   └── MyDevTools.Site/
│       ├── Program.cs
│       ├── Components/
│       ├── Middleware/
│       ├── Resources/
│       ├── Services/
│       └── wwwroot/
└── wasm/
    ├── cryptography/   # Rust → WASM: шифрование/подпись/ключи (реализовано)
    ├── encoding/       # Rust → WASM: hex/base64/url/… (реализовано)
  ├── structured_data/ # Rust → WASM: JSON/XML/YAML форматирование + валидация (планируется)
    └── hash/           # Rust → WASM: хэши строк/файлов (реализовано)
  └── build.ps1       # Сборка cargo+wasm-bindgen → wwwroot/wasm/<domain>
```

### `wasm/structured_data`: назначение

Этот домен — “всё про структурированные форматы”:

* форматирование: beautify/minify/normalize
* валидация (syntax + schema, где применимо)
* в перспективе: YAML (и возможно конвертации, если будет нужно)

---

### MyDevTools.Site (Blazor SSR)

```
MyDevToolsApp/MyDevTools.Site/
├── Components/
│   ├── Layout/
│   │   ├── MainLayout.razor           ✅ Главный layout с header/footer
│   │   └── ToolLayout.razor            ✅ Универсальный layout для инструментов
│   ├── Common/
│   │   ├── LanguageSwitcher.razor     ✅ Переключатель языков
│   │   ├── ThemeToggle.razor          ✅ Переключатель темы
│   │   └── LoadingSkeleton.razor      ✅ Скелетон загрузки
│   ├── Seo/
│   │   ├── MetaTags.razor             ✅ Meta теги для SEO
│   │   ├── JsonLdTool.razor           ✅ Schema.org разметка
│   │   └── HreflangLinks.razor        ✅ Языковые альтернативы
│   ├── Tools/
│   │   └── HashCalculator.razor       ✅ Калькулятор хэшей (первый инструмент)
│   └── Pages/
│       └── Home.razor                  ✅ Главная страница
├── Services/
│   ├── ILocalizationService.cs        ✅ Интерфейс локализации
│   └── LocalizationService.cs         ✅ Реализация (en, ru, es)
├── Middleware/
│   └── CultureRedirectMiddleware.cs   ✅ Редирект + определение языка
├── Resources/
│   ├── AppStrings.resx                ✅ Английские тексты
│   ├── AppStrings.ru.resx             ✅ Русские переводы
│   ├── AppStrings.es.resx             ✅ Испанские переводы
│   └── AppStrings.Designer.cs         ✅ Автогенерированный strongly-typed класс
├── wwwroot/
│   └── app.css                         ✅ Стили с поддержкой тем
└── Program.cs                          ✅ Настройка локализации и middleware
```

---

## 🧩 Использование компонентов

### ToolLayout — базовый шаблон инструмента

**Все инструменты** должны использовать `ToolLayout`:

```razor
@page "/{lang}/my-tool"
@using MyDevTools.Site.Resources

<ToolLayout Title="@AppStrings.MyTool_Title" 
            Description="@AppStrings.MyTool_Description">
    
    <div class="tool-grid">
        <div class="input-section">
            <!-- Input UI -->
        </div>
        <div class="output-section">
            <!-- Output UI -->
        </div>
    </div>
    
</ToolLayout>

<script>
    // Client-side logic here
    // All processing happens in browser!
</script>
```

**НЕ создавайте** уникальные layouts для каждого инструмента!

---

## 🌍 Локализация (i18n)

### ✅ Реализовано: Strongly-Typed Resources

**Все тексты** используют strongly-typed ресурсы из `AppStrings.Designer.cs`:

```razor
@using MyDevTools.Site.Resources

<!-- ✅ Правильно: compile-time безопасность -->
<h1>@AppStrings.HashCalculator_Title</h1>
<button>@AppStrings.HashCalculator_Calculate</button>

<!-- ❌ Неправильно: магические строки -->
<h1>@L["HashCalculator_Title"]</h1>
```

### URL-структура

```
/                          → редирект на /en/, /ru/ или /es/ (по языку браузера)
/en/hash-calculator       → Hash Calculator
/ru/hash-calculator       → Калькулятор хэшей
/es/hash-calculator       → Calculadora de Hash
```

### Добавление новых переводов

1. Откройте `Resources/AppStrings.resx` в Visual Studio
2. Добавьте новый ключ: `MyTool_ActionButton`
3. Visual Studio автоматически обновит `AppStrings.Designer.cs`
4. Добавьте переводы в `.ru.resx` и `.es.resx`
5. Используйте: `@AppStrings.MyTool_ActionButton`

**См. также:** `LOCALIZATION_GUIDE.md`

---

## ⚙️ WASM: правила интеграции (будущее)

### Общие требования

* WASM **загружается лениво**
* При загрузке показывается skeleton / loading state
* Вычисления происходят:
  * в памяти браузера
  * без network calls

### Категоризация WASM (оптимизация)

* WASM делится по доменам (соответствует папке `wasm/`):
  * `hash.wasm` — MD5, SHA, Blake2, xxHash и т.д.
  * `encoding.wasm` — Base64, Hex, URL encoding, etc.
  * `cryptography.wasm` — шифрование/подпись/ключи (реализовано)
  * `structured_data.wasm` — JSON/XML/YAML: форматирование + валидация

### Важно про криптографию в WASM

* PKCS#12/.pfx — **native-only** (нужен OpenSSL/`aws-lc-rs`).
* Для X.509 в WASM реалистичны **ed25519** и **ECDSA P-256/P-384**; RSA/P-521 — помечаются как *native-only*.
* JWT (JWS/JWE) и HPKE — отложено, требует отдельной оценки wasm-совместимости.
* Реализовано в WASM: OpenSSH public/private keys (bcrypt KDF), AEAD (AES-GCM/ChaCha/XChaCha, streaming), X.509 self-signed + CSR и парсинг PEM/DER.
* Детали и актуальные ограничения: см. crypto-roadmap.md.

### Рекомендованное оформление Rust/WASM

* `wasm/` как **Cargo workspace** (один `Cargo.toml` на корне `wasm/`)
* 1 домен = 1 crate (простая сборка + простой lazy-load):
  * `wasm/hash/` → crate, который собирается в `hash.wasm`
  * `wasm/encoding/` → crate → `encoding.wasm`
  * `wasm/structured_data/` → crate → `structured_data.wasm`
  * и т.д.
* Артефакты сборки складывать в `MyDevToolsApp/MyDevTools.Site/wwwroot/wasm/<domain>/...` (чтобы сайт мог грузить модули как статику)
* Экспорт функций — через `wasm-bindgen` (удобно вызывать из JS и потом обвязать в C#)

### Сборка и тесты (рекомендованный базовый путь)

Цели: (1) писать тесты на все функции, (2) грузить минимум данных (1 wasm на домен), (3) после сборки складывать артефакты в `wwwroot/wasm`.

* Логику держать в обычных Rust-модулях внутри доменного crate и покрывать `cargo test`.
* Для wasm-crate выставить типы библиотеки так, чтобы тесты тоже работали (примерно: `cdylib` + `rlib`).
* Для сборки использовать `cargo build --target wasm32-unknown-unknown` + `wasm-bindgen` (стабильно, прозрачно и удобно для CI).

Предварительная установка (1 раз на машину/в CI):

```powershell
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --locked
```

Команда сборки всех доменов (складывает результат в `MyDevToolsApp/MyDevTools.Site/wwwroot/wasm/<domain>`):

```powershell
pwsh ./wasm/build.ps1 -Configuration Release
```

Пример запуска тестов в домене (когда появится `Cargo.toml`):

```powershell
cd ./wasm/hash
cargo test
```

Для `wasm/cryptography` дополнительно есть wasm-специфичные smoke-тесты (`wasm-bindgen-test`).
Пример (локально):

```powershell
cd ./wasm/cryptography
cargo test

# wasm-тесты (нужен wasm-bindgen-test-runner)
$env:CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER = "wasm-bindgen-test-runner"
cargo test --target wasm32-unknown-unknown
```

**НЕ объединяйте** всё в один огромный wasm — используйте lazy loading!

### Текущая реализация (временная)

Сейчас все хэши в Hash Calculator считаются **внутри Rust WASM** (единый путь для всех алгоритмов).

Для файлов хэши считаются потоково (chunking) и можно вычислять несколько алгоритмов **за один проход чтения файла**: один и тот же чанк обновляет несколько независимых hasher-состояний.

### Важный нюанс: Blazor SSR + Enhanced Navigation

В Blazor SSR с включённой **enhanced navigation** страница может обновляться через DOM-morphing (частичная замена DOM без полной перезагрузки).
Из-за этого обработчики, повешенные напрямую на элементы через `addEventListener`/`onclick` в момент initial load, иногда «теряются» после переходов.

Рекомендация для инструментов:
- использовать **делегирование событий** (один `document.addEventListener('click', ...)` + `target.closest(...)`) или
- переинициализировать биндинги на событиях `enhancedload` / `pageshow`.

---

## 🔍 SEO и AI-дружественность

### ✅ Реализовано

Каждый инструмент автоматически получает:

1. **Meta теги** (`MetaTags.razor`):
   ```html
   <meta name="description" content="..." />
   <meta property="og:title" content="..." />
   ```

2. **JSON-LD разметка** (`JsonLdTool.razor`):
   ```json
   {
     "@type": "SoftwareApplication",
     "name": "Hash Calculator",
     "applicationCategory": "DeveloperApplication",
     "isAccessibleForFree": true
   }
   ```

3. **Hreflang ссылки** (`HreflangLinks.razor`):
   ```html
   <link rel="alternate" hreflang="en" href="/en/hash-calculator" />
   <link rel="alternate" hreflang="ru" href="/ru/hash-calculator" />
   <link rel="alternate" hreflang="es" href="/es/hash-calculator" />
   ```

---

## 🎨 Темизация

### Светлая / Темная тема

Используются CSS-переменные для легкой кастомизации:

```css
:root {
    --bg-primary: #ffffff;
    --text-primary: #212529;
    --accent-color: #0066cc;
}

[data-theme="dark"] {
    --bg-primary: #1a1a1a;
    --text-primary: #e9ecef;
    --accent-color: #4d9fff;
}
```

Переключатель темы сохраняет выбор пользователя в `localStorage`.

---

## 🚀 Быстрый старт

### Запуск проекта

```bash
cd MyDevToolsApp/MyDevTools.Site
dotnet run
```

Откройте браузер: `https://localhost:5001`

Автоматический редирект на:
- `/en/` — если браузер на английском
- `/ru/` — если браузер на русском
- `/es/` — если браузер на испанском

### Проверка локализации

1. Откройте `/en/hash-calculator` — все тексты на английском
2. Откройте `/ru/hash-calculator` — все тексты на русском
3. Используйте переключатель языков в header

---

## 🧼 Код-стайл и качество

### Обязательные требования

* ✅ **Nullable reference types** — включены
* ✅ **XML-комментарии** у базовых компонентов (в блоке `@code`)
* ✅ **Минимум логики в UI** — вся обработка в JavaScript/WASM
* ✅ **Чёткие имена компонентов** (`HashCalculator`, а не `Tool1`)
* ✅ **Strongly-typed ресурсы** — никаких магических строк

### Пример правильного комментария

```razor
@code {
    /// <summary>
    /// Universal SSR-compatible layout for all developer tools.
    /// All data processing happens client-side via WASM.
    /// </summary>
    [Parameter, EditorRequired]
    public string Title { get; set; } = default!;
}
```

**❌ НЕ размещайте** XML-комментарии перед `@inject` или `@page` — они рендерятся как текст!

---

## 📚 Дополнительная документация

- **`LOCALIZATION_GUIDE.md`** — как добавлять переводы
- **`STRONGLY_TYPED_RESOURCES.md`** — использование AppStrings
- **`FIXES_LOG.md`** — история исправлений и улучшений

---

## 🔐 Безопасность и Privacy

### Privacy-First подход

1. **Никакие данные не покидают браузер пользователя**
2. **Нет server-side API** для обработки данных
3. **Нет логирования** пользовательского контента
4. **Нет аналитики** без согласия пользователя

### WASM Security (будущее)

* WASM **может** проверять `window.location.hostname`
* WASM **может** проверять подписанный сервером токен
* **НЕ полагаться** только на домен (это обфускация, а не защита)

---

## 🤖 Для AI помощников (GitHub Copilot, ChatGPT и др.)

### При создании новых инструментов:

1. ✅ Используйте `ToolLayout` для всех инструментов
2. ✅ Добавляйте переводы в `.resx` файлы
3. ✅ Используйте `@AppStrings.*` для текстов
4. ✅ Вся обработка данных — только в браузере (JavaScript → WASM)
5. ✅ Добавляйте SEO компоненты: `MetaTags`, `JsonLdTool`, `HreflangLinks`
6. ❌ НЕ создавайте server-side API для обработки
7. ❌ НЕ отправляйте данные на сервер

### Пример нового инструмента

```razor
@page "/{lang}/json-beautifier"
@using MyDevTools.Site.Resources

<MetaTags Title="@AppStrings.JsonBeautifier_Title" 
          Description="@AppStrings.JsonBeautifier_Description" />
<HreflangLinks ToolPath="json-beautifier" />
<JsonLdTool ToolName="@AppStrings.JsonBeautifier_Title" 
            Description="@AppStrings.JsonBeautifier_Description" />

<ToolLayout Title="@AppStrings.JsonBeautifier_Title" 
            Description="@AppStrings.JsonBeautifier_Description">
    <!-- Tool UI here -->
</ToolLayout>

<script>
    // Client-side processing only!
</script>
```

---

## 🧭 Краткий принцип проекта

> **MyDevTools.app** — privacy-first developer tools,  
> where **all data stays in your browser**.

**Никакого server-side processing. Только SSR для HTML.**

