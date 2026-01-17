# 🏗️ Архитектура проекта MyDevTools.app

> Детальное описание архитектуры, паттернов и принципов проекта

## 📋 Содержание

- [Обзор архитектуры](#обзор-архитектуры)
- [Принципы проектирования](#принципы-проектирования)
- [Слои приложения](#слои-приложения)
- [Поток данных](#поток-данных)
- [Компонентная архитектура](#компонентная-архитектура)
- [WASM интеграция](#wasm-интеграция)
- [Локализация](#локализация)
- [SEO и метаданные](#seo-и-метаданные)

---

## 🎯 Обзор архитектуры

### Высокоуровневая схема

```
┌─────────────────────────────────────────────────────────┐
│                    Клиент (Browser)                      │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Blazor SSR HTML                     │   │
│  │  ┌─────────────┐  ┌──────────────┐             │   │
│  │  │  Razor      │  │   JavaScript │             │   │
│  │  │ Components  │──│   Logic      │             │   │
│  │  └─────────────┘  └──────┬───────┘             │   │
│  │                          │                       │   │
│  │  ┌───────────────────────▼──────────┐          │   │
│  │  │       WASM Modules (Rust)        │          │   │
│  │  │  ┌──────┐ ┌────────┐ ┌────────┐ │          │   │
│  │  │  │ Hash │ │Encoding│ │Structured│ │          │   │
│  │  │  └──────┘ └────────┘ └────────┘ │          │   │
│  │  └──────────────────────────────────┘          │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                           ▲
                           │ HTTP (SSR only)
                           │
┌──────────────────────────┴──────────────────────────────┐
│              Сервер (.NET Blazor SSR)                    │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Program.cs                                       │   │
│  │  - Middleware (CultureRedirect)                  │   │
│  │  - Localization                                  │   │
│  │  - Routing                                       │   │
│  └──────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Razor Components                                │   │
│  │  - Pages (Home, Error, NotFound)                │   │
│  │  - Layouts (MainLayout, ToolLayout)             │   │
│  │  - Tools (HashCalculator, Base64Encoder, ...)   │   │
│  │  - Common (LanguageSwitcher, ThemeToggle, ...)  │   │
│  │  - SEO (MetaTags, JsonLdTool, HreflangLinks)    │   │
│  └──────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Services                                         │   │
│  │  - LocalizationService                           │   │
│  └──────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Resources (.resx)                               │   │
│  │  - AppStrings.resx (en)                          │   │
│  │  - AppStrings.ru.resx                            │   │
│  │  - AppStrings.es.resx                            │   │
│  └──────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
                           ▲
                           │ Static Files
                           │
┌──────────────────────────┴──────────────────────────────┐
│              wwwroot (Static Assets)                     │
│  - CSS (app.css)                                         │
│  - JavaScript (tools/*.js, theme.js)                     │
│  - WASM Modules (wasm/*/)                                │
└──────────────────────────────────────────────────────────┘
```

### Ключевые принципы

1. **Privacy-First**: Все данные обрабатываются в браузере, никакие данные не отправляются на сервер
2. **SSR для SEO**: Server-Side Rendering только для HTML, без обработки данных
3. **WASM для вычислений**: Все тяжелые вычисления в Rust WASM модулях
4. **Модульность**: Разделение WASM по доменам (hash, encoding, structured_data, cryptography)
5. **Локализация**: Strongly-typed ресурсы с compile-time проверкой

---

## 🎨 Принципы проектирования

### 1. Privacy-First Architecture

**Правило:** Никакие пользовательские данные не покидают браузер.

**Реализация:**
- ❌ Нет server-side API для обработки данных
- ❌ Нет отправки файлов/текста на сервер
- ✅ Вся обработка в JavaScript → WASM
- ✅ Сервер используется только для SSR HTML

**Проверка соблюдения:**
```razor
<!-- ✅ Правильно: обработка в JavaScript -->
<script>
    const result = await processDataLocally(input);
</script>

<!-- ❌ Неправильно: отправка на сервер -->
@code {
    private async Task<string> ProcessOnServer(string input) {
        // НЕ ДЕЛАЙТЕ ТАК!
    }
}
```

### 2. Separation of Concerns

**Слои:**
- **Presentation Layer**: Razor Components (только UI)
- **Logic Layer**: JavaScript (orchestration и UI логика)
- **Computation Layer**: WASM (тяжелые вычисления)
- **Server Layer**: SSR, локализация, статика

**Правило:** Каждый слой имеет четкую ответственность.

### 3. Lazy Loading

**Принцип:** WASM модули загружаются только когда нужны.

**Реализация:**
```javascript
// Модуль загружается только при первом использовании
let wasmModulePromise = null;

async function getWasm() {
    if (!wasmModulePromise) {
        wasmModulePromise = import('/wasm/hash/hash.js').then(async (m) => {
            await m.default();
            return m;
        });
    }
    return wasmModulePromise;
}
```

### 4. Domain-Driven WASM Organization

**Структура:** WASM модули организованы по доменам.

```
wasm/
├── hash/          # Алгоритмы хэширования
├── encoding/      # Кодирование (base64, hex, url)
├── cryptography/  # Шифрование/подпись
└── structured_data/ # JSON/XML/YAML обработка
```

**Преимущества:**
- Маленькие модули (быстрая загрузка)
- Ясная структура
- Независимая разработка

---

## 📦 Слои приложения

### 1. Server Layer (.NET Blazor SSR)

**Ответственность:**
- Server-Side Rendering HTML
- Маршрутизация (`/{lang}/tool-name`)
- Локализация (определение языка, загрузка ресурсов)
- Отдача статических файлов
- SEO метаданные

**Файлы:**
- `Program.cs` — конфигурация приложения
- `Middleware/CultureRedirectMiddleware.cs` — редирект по языку
- `Services/LocalizationService.cs` — сервис локализации

**Важно:** Нет обработки пользовательских данных!

### 2. Presentation Layer (Razor Components)

**Ответственность:**
- Рендеринг UI
- Структурирование контента
- Интеграция SEO компонентов

**Компоненты:**
- **Pages**: `Home.razor`, `Error.razor`, `NotFound.razor`
- **Layouts**: `MainLayout.razor`, `ToolLayout.razor`
- **Tools**: `HashCalculator.razor`, `Base64Encoder.razor`, ...
- **Common**: `LanguageSwitcher.razor`, `ThemeToggle.razor`, `LoadingSkeleton.razor`
- **SEO**: `MetaTags.razor`, `JsonLdTool.razor`, `HreflangLinks.razor`

**Паттерн использования:**
```razor
@page "/{lang}/tool-name"
@using MyDevTools.Site.Resources

<MetaTags ... />
<HreflangLinks ... />
<JsonLdTool ... />

<ToolLayout ...>
    <!-- Tool UI -->
</ToolLayout>

<script>
    // Client-side logic
</script>
```

### 3. Logic Layer (JavaScript)

**Ответственность:**
- UI интерактивность
- Обработка событий
- Оркестрация вызовов WASM
- Управление состоянием (localStorage)
- Прогресс операций

**Файлы:**
- `wwwroot/tools/*.js` — логика для каждого инструмента
- `wwwroot/theme.js` — переключение темы

**Паттерн:**
```javascript
// Изоляция состояния по компоненту
function getState(root) {
    let state = rootStates.get(root);
    if (!state) {
        state = { /* initial state */ };
        rootStates.set(root, state);
    }
    return state;
}

// Делегирование событий (для Blazor Enhanced Navigation)
document.addEventListener('click', (e) => {
    if (e.target.closest('#button')) {
        handleClick(e);
    }
});
```

### 4. Computation Layer (WASM)

**Ответственность:**
- Тяжелые вычисления
- Алгоритмическая логика
- Обработка больших данных

**Модули:**
- `wasm/hash/` — хэширование
- `wasm/encoding/` — кодирование/декодирование
- `wasm/cryptography/` — криптография
- `wasm/structured_data/` — обработка JSON/XML/YAML

**Интерфейс:**
```rust
// Rust (wasm/hash/src/lib.rs)
#[wasm_bindgen]
pub fn hash_text_utf8(text: &str, algorithm: &str) -> String {
    // Implementation
}

// JavaScript использование
const wasm = await getHashWasm();
const hash = wasm.hash_text_utf8("hello", "sha256");
```

---

## 🔄 Поток данных

### Пример: Hash Calculator

```
┌─────────────────────────────────────────────────────────┐
│  1. Пользователь вводит текст                          │
│     └─> JavaScript: addEventListener('input')          │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  2. Пользователь нажимает "Calculate"                  │
│     └─> JavaScript: handleClick()                      │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  3. JavaScript: Проверка выбранных алгоритмов          │
│     └─> localStorage: getSelectedAlgorithms()          │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  4. JavaScript: Ленивая загрузка WASM                  │
│     └─> import('/wasm/hash/hash.js')                   │
│     └─> await module.default()                         │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  5. JavaScript → WASM: Вызов функции                   │
│     └─> wasm.hash_text_utf8(text, "sha256")            │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  6. WASM: Вычисление хэша                              │
│     └─> Rust: SHA-256 алгоритм                         │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  7. WASM → JavaScript: Результат                       │
│     └─> return "hex_string"                            │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  8. JavaScript: Обновление UI                          │
│     └─> document.getElementById('result').textContent  │
└─────────────────────────────────────────────────────────┘
```

**Важно:** Весь поток происходит в браузере, без обращения к серверу!

### Поток для файлов (streaming)

```
┌─────────────────────────────────────────────────────────┐
│  1. Пользователь выбирает файл                         │
│     └─> <input type="file">                            │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  2. JavaScript: Чтение файла чанками                   │
│     └─> file.slice(offset, offset + chunkSize)         │
│     └─> await chunk.arrayBuffer()                      │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  3. JavaScript → WASM: Обновление хэшера               │
│     └─> wasm.Hasher_new("sha256")                      │
│     └─> wasm.Hasher_update(hasher, chunk)              │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  4. JavaScript: Обновление прогресса                   │
│     └─> onProgress((offset / file.size) * 100)         │
└────────────────────────┬────────────────────────────────┘
                         │ (повторяется для каждого chunk)
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  5. JavaScript → WASM: Финализация                     │
│     └─> wasm.Hasher_finalize(hasher)                   │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  6. JavaScript: Отображение результата                 │
│     └─> Update UI with hash                            │
└─────────────────────────────────────────────────────────┘
```

---

## 🧩 Компонентная архитектура

### Иерархия компонентов

```
App.razor
└── Router
    ├── MainLayout.razor
    │   ├── Header
    │   │   ├── LanguageSwitcher.razor
    │   │   └── ThemeToggle.razor
    │   ├── Body
    │   │   └── @Body (Page Content)
    │   │       ├── Home.razor
    │   │       ├── HashCalculator.razor
    │   │       │   └── ToolLayout.razor
    │   │       │       └── LoadingSkeleton.razor
    │   │       ├── Base64Encoder.razor
    │   │       │   └── ToolLayout.razor
    │   │       └── ...
    │   └── Footer
    └── Error.razor / NotFound.razor
```

### ToolLayout — универсальный шаблон

**Назначение:** Единый layout для всех инструментов.

**Преимущества:**
- Единообразие UI
- Автоматическая интеграция SEO компонентов
- Упрощение разработки новых инструментов

**Использование:**
```razor
<ToolLayout Title="@AppStrings.Tool_Title" 
            Description="@AppStrings.Tool_Description">
    <!-- Tool-specific content -->
</ToolLayout>
```

### SEO компоненты

**MetaTags.razor:**
- Meta description
- Open Graph теги
- Twitter Card теги

**JsonLdTool.razor:**
- Schema.org разметка (SoftwareApplication)
- Структурированные данные для поисковых систем

**HreflangLinks.razor:**
- Альтернативные языковые версии
- SEO для многоязычного контента

---

## 🔗 WASM интеграция

### Архитектура WASM модулей

```
wasm/
├── Cargo.toml (workspace)
└── hash/
    ├── Cargo.toml
    ├── src/
    │   └── lib.rs
    └── (target/) → сборка
        └── wasm32-unknown-unknown/
            └── release/
                └── mydevtools_hash.wasm
                └── (wasm-bindgen) →
                    └── wwwroot/wasm/hash/
                        ├── hash.js
                        ├── hash_bg.wasm
                        └── hash.d.ts
```

### Процесс сборки

1. **Rust компиляция**
   ```powershell
   cargo build --target wasm32-unknown-unknown --release -p mydevtools_hash
   ```
   Результат: `target/wasm32-unknown-unknown/release/mydevtools_hash.wasm`

2. **wasm-bindgen обработка**
   ```powershell
   wasm-bindgen target/.../mydevtools_hash.wasm --target web --out-dir wwwroot/wasm/hash
   ```
   Результат: `wwwroot/wasm/hash/hash.js`, `hash_bg.wasm`, `hash.d.ts`

3. **Загрузка в браузере**
   ```javascript
   const module = await import('/wasm/hash/hash.js');
   await module.default(); // Инициализация WASM
   ```

### Интерфейс WASM модуля

**Rust (lib.rs):**
```rust
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Hasher {
    // internal state
}

#[wasm_bindgen]
impl Hasher {
    #[wasm_bindgen(constructor)]
    pub fn new(algorithm: &str) -> Hasher { /* ... */ }
    
    #[wasm_bindgen]
    pub fn update(&mut self, data: &[u8]) { /* ... */ }
    
    #[wasm_bindgen]
    pub fn finalize(self) -> String { /* ... */ }
}

#[wasm_bindgen]
pub fn hash_text_utf8(text: &str, algorithm: &str) -> String {
    // One-shot function
}
```

**JavaScript использование:**
```javascript
// One-shot
const hash = wasm.hash_text_utf8("hello", "sha256");

// Streaming
const hasher = wasm.Hasher.new("sha256");
hasher.update(chunk1);
hasher.update(chunk2);
const hash = hasher.finalize();
```

---

## 🌍 Локализация

### Архитектура локализации

```
┌─────────────────────────────────────────────────────────┐
│  1. Запрос: / (корень)                                  │
│     └─> CultureRedirectMiddleware                       │
│         └─> Определение языка (Accept-Language)         │
│         └─> Редирект: /en/, /ru/, или /es/             │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  2. Запрос: /en/tool-name                               │
│     └─> RouteDataRequestCultureProvider                 │
│         └─> Извлечение "en" из пути                     │
│         └─> Установка Culture = "en"                    │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  3. Razor Component                                     │
│     └─> @AppStrings.Tool_Title                         │
│         └─> ResourceManager.GetString("Tool_Title", Culture)
│         └─> Загрузка из AppStrings.en.resx             │
└─────────────────────────────────────────────────────────┘
```

### Структура ресурсов

```
Resources/
├── AppStrings.resx          # Английский (базовый)
├── AppStrings.ru.resx       # Русский
├── AppStrings.es.resx       # Испанский
└── AppStrings.Designer.cs   # Автогенерированный класс
```

**AppStrings.Designer.cs** содержит strongly-typed свойства:
```csharp
public static string Tool_Title {
    get {
        return ResourceManager.GetString("Tool_Title", resourceCulture);
    }
}
```

**Использование:**
```razor
@using MyDevTools.Site.Resources

<h1>@AppStrings.Tool_Title</h1>
<!-- Compile-time проверка: ошибка если ключ не существует -->
```

---

## 🔍 SEO и метаданные

### Компоненты SEO

**MetaTags.razor:**
```html
<meta name="description" content="@Description" />
<meta property="og:title" content="@Title" />
<meta property="og:description" content="@Description" />
<meta property="og:url" content="@CurrentUrl" />
<meta name="twitter:card" content="summary" />
```

**JsonLdTool.razor:**
```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "@ToolName",
  "description": "@Description",
  "applicationCategory": "DeveloperApplication",
  "isAccessibleForFree": true,
  "url": "@CurrentUrl"
}
</script>
```

**HreflangLinks.razor:**
```html
<link rel="alternate" hreflang="en" href="/en/@ToolPath" />
<link rel="alternate" hreflang="ru" href="/ru/@ToolPath" />
<link rel="alternate" hreflang="es" href="/es/@ToolPath" />
<link rel="alternate" hreflang="x-default" href="/en/@ToolPath" />
```

### URL структура

```
/                          → Редирект на /en/, /ru/, или /es/
/en/                      → Главная (английский)
/ru/                      → Главная (русский)
/es/                      → Главная (испанский)
/en/hash-calculator       → Hash Calculator (английский)
/ru/hash-calculator       → Калькулятор хэшей (русский)
/es/hash-calculator       → Calculadora de Hash (испанский)
```

---

## 🎯 Итоговые принципы

1. **Privacy-First**: Все данные обрабатываются в браузере
2. **SSR для SEO**: Server-Side Rendering только для HTML
3. **WASM для вычислений**: Тяжелые вычисления в Rust
4. **Модульность**: Разделение по доменам
5. **Локализация**: Strongly-typed ресурсы
6. **SEO-Friendly**: Метаданные, JSON-LD, hreflang
7. **Lazy Loading**: Загрузка модулей по требованию

---

**См. также:**
- `DEVELOPMENT.md` — практические инструкции
- `WASM_INTEGRATION.md` — детали WASM интеграции
- `LOCALIZATION_GUIDE.md` — руководство по локализации