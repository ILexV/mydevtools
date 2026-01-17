# 📁 Справочник по структуре проекта

> Быстрый справочник по структуре проекта MyDevTools.app

## 📋 Содержание

- [Корневая структура](#корневая-структура)
- [Blazor приложение](#blazor-приложение)
- [WASM модули](#wasm-модули)
- [Ключевые файлы](#ключевые-файлы)
- [Назначение директорий](#назначение-директорий)

---

## 🌳 Корневая структура

```
mydevtools/
├── README.md                    # Основная документация проекта
├── TASKS.md                     # План задач (roadmap)
├── DEVELOPMENT.md               # Руководство по разработке
├── ARCHITECTURE.md              # Архитектура проекта
├── WASM_INTEGRATION.md          # Руководство по WASM
├── LOCALIZATION_GUIDE.md        # Руководство по локализации
├── PROJECT_STRUCTURE.md         # Этот файл
│
├── MyDevToolsApp/               # Решение .NET
│   ├── MyDevToolsApp.slnx       # Visual Studio solution
│   └── MyDevTools.Site/         # Blazor приложение
│
└── wasm/                        # Rust WebAssembly модули
    ├── Cargo.toml               # Cargo workspace
    ├── Cargo.lock               # Зафиксированные версии зависимостей
    ├── build.ps1                # Скрипт сборки WASM
    ├── hash/                    # Модуль хэширования
    ├── encoding/                # Модуль кодирования
    ├── cryptography/            # Модуль криптографии
    └── structured_data/         # Модуль структурированных данных
```

---

## 🎯 Blazor приложение

### Структура MyDevTools.Site/

```
MyDevToolsApp/MyDevTools.Site/
├── Program.cs                   # Точка входа, конфигурация приложения
├── MyDevTools.Site.csproj      # Проект .NET
├── appsettings.json            # Конфигурация приложения
├── appsettings.Development.json # Конфигурация для разработки
│
├── Components/                  # Razor компоненты
│   ├── _Imports.razor          # Общие директивы для компонентов
│   ├── App.razor               # Корневой компонент приложения
│   ├── Routes.razor            # Определение маршрутов
│   │
│   ├── Pages/                  # Страницы
│   │   ├── Home.razor          # Главная страница
│   │   ├── Error.razor         # Страница ошибки
│   │   └── NotFound.razor      # Страница 404
│   │
│   ├── Layout/                 # Layout компоненты
│   │   ├── MainLayout.razor    # Главный layout (header/footer)
│   │   ├── MainLayout.razor.css # Стили для MainLayout
│   │   └── ToolLayout.razor    # Layout для инструментов
│   │
│   ├── Common/                 # Общие компоненты
│   │   ├── LanguageSwitcher.razor    # Переключатель языков
│   │   ├── ThemeToggle.razor         # Переключатель темы
│   │   └── LoadingSkeleton.razor     # Скелетон загрузки
│   │
│   ├── Seo/                    # SEO компоненты
│   │   ├── MetaTags.razor      # Meta теги (description, og:*)
│   │   ├── JsonLdTool.razor    # JSON-LD разметка
│   │   ├── JsonLdSite.razor    # JSON-LD для сайта
│   │   └── HreflangLinks.razor # Hreflang ссылки
│   │
│   └── Tools/                  # Инструменты
│       ├── HashCalculator.razor      # Калькулятор хэшей
│       ├── Base64Encoder.razor       # Base64 кодировщик
│       ├── Base32Encoder.razor       # Base32 кодировщик
│       ├── Base58Encoder.razor       # Base58 кодировщик
│       ├── HexEncoder.razor          # Hex кодировщик
│       └── UrlEncoder.razor          # URL кодировщик
│
├── Middleware/                 # Middleware
│   └── CultureRedirectMiddleware.cs  # Редирект по языку браузера
│
├── Services/                   # Сервисы
│   ├── ILocalizationService.cs       # Интерфейс локализации
│   └── LocalizationService.cs        # Реализация локализации
│
├── Resources/                  # Ресурсы локализации
│   ├── AppStrings.resx         # Английские тексты (базовый)
│   ├── AppStrings.ru.resx      # Русские переводы
│   ├── AppStrings.es.resx      # Испанские переводы
│   └── AppStrings.Designer.cs  # Автогенерированный класс (strongly-typed)
│
├── Properties/                 # Свойства проекта
│   └── launchSettings.json     # Настройки запуска
│
└── wwwroot/                    # Статические файлы (отдаются как есть)
    ├── app.css                 # Основные стили
    ├── favicon.png             # Иконка сайта
    ├── theme.js                # JavaScript для переключения темы
    │
    ├── tools/                  # JavaScript логика для инструментов
    │   ├── hash-calculator.js  # Логика Hash Calculator
    │   ├── base64-encoder.js   # Логика Base64 Encoder
    │   ├── base32-encoder.js   # Логика Base32 Encoder
    │   ├── base58-encoder.js   # Логика Base58 Encoder
    │   ├── hex-encoder.js      # Логика Hex Encoder
    │   └── url-encoder.js      # Логика URL Encoder
    │
    └── wasm/                   # Скомпилированные WASM модули
        ├── hash/               # WASM модуль хэширования
        │   ├── hash.js         # JavaScript биндинги (wasm-bindgen)
        │   ├── hash_bg.wasm    # Скомпилированный WASM
        │   ├── hash.d.ts       # TypeScript определения
        │   └── hash_bg.wasm.d.ts # TypeScript определения для WASM
        │
        ├── encoding/           # WASM модуль кодирования
        ├── cryptography/       # WASM модуль криптографии
        └── structured_data/    # WASM модуль структурированных данных
```

---

## 🦀 WASM модули

### Структура wasm/

```
wasm/
├── Cargo.toml                  # Cargo workspace конфигурация
├── Cargo.lock                  # Зафиксированные версии зависимостей
├── build.ps1                   # Скрипт сборки всех модулей
│
├── hash/                       # Модуль хэширования
│   ├── Cargo.toml              # Конфигурация crate
│   └── src/
│       └── lib.rs              # Реализация хэширования
│
├── encoding/                   # Модуль кодирования
│   ├── Cargo.toml
│   └── src/
│       └── lib.rs              # Реализация кодирования
│
├── cryptography/               # Модуль криптографии
│   ├── Cargo.toml
│   └── src/
│       └── lib.rs
│
└── structured_data/            # Модуль структурированных данных
    ├── Cargo.toml
    └── src/
        └── lib.rs
```

### Процесс сборки WASM

```
wasm/hash/src/lib.rs
    ↓ (cargo build --target wasm32-unknown-unknown)
target/wasm32-unknown-unknown/release/mydevtools_hash.wasm
    ↓ (wasm-bindgen)
MyDevToolsApp/MyDevTools.Site/wwwroot/wasm/hash/
    ├── hash.js
    ├── hash_bg.wasm
    └── hash.d.ts
```

---

## 📄 Ключевые файлы

### Конфигурация проекта

| Файл | Назначение |
|------|-----------|
| `MyDevTools.Site.csproj` | Конфигурация .NET проекта, зависимости |
| `appsettings.json` | Конфигурация приложения |
| `appsettings.Development.json` | Конфигурация для разработки |
| `launchSettings.json` | Настройки запуска (порты, профили) |

### Точка входа

| Файл | Назначение |
|------|-----------|
| `Program.cs` | Точка входа, конфигурация приложения, middleware, routing |

### Компоненты

| Файл | Назначение |
|------|-----------|
| `App.razor` | Корневой компонент приложения |
| `Routes.razor` | Определение маршрутов |
| `MainLayout.razor` | Главный layout (header, footer) |
| `ToolLayout.razor` | Универсальный layout для инструментов |

### Локализация

| Файл | Назначение |
|------|-----------|
| `AppStrings.resx` | Английские тексты (базовый) |
| `AppStrings.ru.resx` | Русские переводы |
| `AppStrings.es.resx` | Испанские переводы |
| `AppStrings.Designer.cs` | Автогенерированный strongly-typed класс |

### Middleware и Services

| Файл | Назначение |
|------|-----------|
| `CultureRedirectMiddleware.cs` | Редирект с `/` на `/{lang}/` по языку браузера |
| `LocalizationService.cs` | Сервис для работы с локализацией |

### WASM

| Файл | Назначение |
|------|-----------|
| `wasm/Cargo.toml` | Cargo workspace конфигурация |
| `wasm/build.ps1` | Скрипт сборки WASM модулей |
| `wasm/{domain}/Cargo.toml` | Конфигурация конкретного модуля |
| `wasm/{domain}/src/lib.rs` | Реализация модуля |

---

## 📂 Назначение директорий

### MyDevToolsApp/MyDevTools.Site/

| Директория | Назначение |
|-----------|-----------|
| `Components/` | Все Razor компоненты |
| `Components/Pages/` | Страницы приложения (Home, Error, NotFound) |
| `Components/Layout/` | Layout компоненты (MainLayout, ToolLayout) |
| `Components/Common/` | Переиспользуемые общие компоненты |
| `Components/Seo/` | SEO компоненты (MetaTags, JsonLd, Hreflang) |
| `Components/Tools/` | Инструменты (HashCalculator, Base64Encoder, ...) |
| `Middleware/` | ASP.NET Core middleware |
| `Services/` | Сервисы приложения |
| `Resources/` | Ресурсы локализации (.resx файлы) |
| `Properties/` | Свойства проекта (launchSettings.json) |
| `wwwroot/` | Статические файлы (CSS, JS, WASM, изображения) |
| `wwwroot/tools/` | JavaScript логика для инструментов |
| `wwwroot/wasm/` | Скомпилированные WASM модули |

### wasm/

| Директория | Назначение |
|-----------|-----------|
| `hash/` | WASM модуль хэширования (MD5, SHA, BLAKE, ...) |
| `encoding/` | WASM модуль кодирования (Base64, Hex, URL, ...) |
| `cryptography/` | WASM модуль криптографии (в будущем) |
| `structured_data/` | WASM модуль структурированных данных (JSON, XML, YAML) |

---

## 🔍 Быстрый поиск

### Где найти...

**...новый инструмент?**
→ `Components/Tools/YourTool.razor`

**...JavaScript логику инструмента?**
→ `wwwroot/tools/your-tool.js`

**...WASM модуль?**
→ `wasm/{domain}/src/lib.rs`

**...локализованные тексты?**
→ `Resources/AppStrings.{lang}.resx`

**...конфигурацию приложения?**
→ `Program.cs` или `appsettings.json`

**...стили?**
→ `wwwroot/app.css` или `Components/Layout/MainLayout.razor.css`

**...SEO компоненты?**
→ `Components/Seo/`

**...middleware?**
→ `Middleware/`

**...сервисы?**
→ `Services/`

---

## 🎨 Соглашения по именованию

### Razor компоненты

- **Страницы:** `{Name}.razor` (например, `Home.razor`)
- **Layout:** `{Name}Layout.razor` (например, `MainLayout.razor`)
- **Инструменты:** `{Name}Calculator.razor` или `{Name}Encoder.razor`

### JavaScript файлы

- **Инструменты:** `{tool-name}.js` (например, `hash-calculator.js`)
- **Общие:** `{name}.js` (например, `theme.js`)

### WASM модули

- **Crate name:** `mydevtools_{domain}` (например, `mydevtools_hash`)
- **Директория:** `{domain}` (например, `hash`)
- **Скомпилированный JS:** `{domain}.js` (например, `hash.js`)

### Локализация

- **Ключи:** `{Component}_{Property}` (например, `HashCalculator_Title`)
- **Файлы:** `AppStrings.{lang}.resx` (например, `AppStrings.ru.resx`)

---

## 📚 Дополнительная информация

- **README.md** — общая информация о проекте
- **DEVELOPMENT.md** — практические инструкции
- **ARCHITECTURE.md** — архитектура проекта
- **WASM_INTEGRATION.md** — работа с WASM
- **LOCALIZATION_GUIDE.md** — локализация

---

**Последнее обновление:** 2024