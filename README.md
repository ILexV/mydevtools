# 📘 Copilot Project Instructions — MyDevTools.app

## 📌 Общая идея проекта

Проект **MyDevTools.app** — это веб-сервис инструментов для разработчиков
(JSON, XML, Base64, hash, formatter, validator и т.д.).

### Ключевые принципы

* 🔐 **Privacy-first** — все преобразования выполняются **в браузере пользователя**
* 🚫 **Никакие пользовательские данные не отправляются на сервер**
* ⚡ **WASM для вычислений**, сервер используется только для SSR и статики
* 🌍 **Многоязычный сайт (i18n)**
* 🔍 **SEO-friendly (SSR, JSON-LD, hreflang)**

---

## 🧱 Технологический стек

* **.NET 10**
* **Blazor Web App (SSR / prerendering)**
* **Blazor Components** (переиспользуемые)
* **WebAssembly**

  * основной язык WASM: **Rust**
  * C# используется только для UI и orchestration
* **Cloudflare CDN** (кэширование статики)
* **Без server-side API для обработки данных**

---

## 🧠 Архитектурные правила (ОЧЕНЬ ВАЖНО)

### ❌ Запрещено

* ❌ Любая обработка пользовательских данных на сервере
* ❌ Отправка файлов, текста, JSON, XML на backend
* ❌ Использование ASP.NET Minimal API для логики инструментов

### ✅ Разрешено

* ✅ Server-Side Rendering **только для HTML**
* ✅ Client-side WASM для всех вычислений
* ✅ JS interop для вызова WASM
* ✅ Сервер — только:

  * SSR
  * отдача статики
  * SEO-метаданные
  * токены доступа (без данных пользователя)

---

## 🧩 Структура Blazor-компонентов

### Основные принципы

* UI компонентов **многоразовый**
* Все инструменты визуально похожи
* Каждый инструмент решает **одну чёткую задачу**

### Пример структуры

```
Components/
 ├── Layout/
 │   ├── MainLayout.razor
 │   └── ToolLayout.razor
 ├── Common/
 │   ├── ToolHeader.razor
 │   ├── ToolFooter.razor
 │   ├── LoadingSkeleton.razor
 │   └── LanguageSwitcher.razor
 ├── Seo/
 │   ├── MetaTags.razor
 │   ├── JsonLdTool.razor
 │   └── HreflangLinks.razor
 └── Tools/
     ├── JsonBeautifier.razor
     ├── Base64Encoder.razor
     └── XmlFormatter.razor
```

---

## 🧱 ToolLayout — базовый шаблон инструмента

### Copilot должен:

* использовать `ToolLayout` для всех инструментов
* **НЕ создавать уникальные layouts для каждого инструмента**

Пример использования:

```razor
<ToolLayout Title="@Title" Description="@Description">
    <InputArea />
    <OutputArea />
    <ToolActions />
</ToolLayout>
```

---

## ⚙️ WASM: правила интеграции

### Общие требования

* WASM **загружается лениво**
* При загрузке показывается skeleton / loading state
* Вычисления происходят:

  * в памяти браузера
  * без network calls

### Категоризация WASM (оптимизация)

* WASM делится по доменам:

  * `json.wasm`
  * `xml.wasm`
  * `encoding.wasm`
* Простые операции (hash, base64) — отдельный минимальный WASM

Copilot **НЕ должен объединять всё в один огромный wasm**.

---

## 🌍 Локализация (i18n)

* Все тексты **только через ресурсы**
* Никаких хардкод-строк в компонентах

Пример:

```razor
@inject IStringLocalizer<AppStrings> L

<h1>@L["JsonBeautifier_Title"]</h1>
```

### URL-структура

```
/en/json-beautifier
/ru/json-beautifier
/es/json-beautifier
```

---

## 🔍 SEO и AI-дружественность

Copilot должен:

* использовать SSR-совместимые компоненты
* добавлять:

  * `<meta>` теги
  * JSON-LD schema (`SoftwareApplication`)
  * `hreflang` ссылки

### JSON-LD пример

```json
{
  "@type": "SoftwareApplication",
  "name": "JSON Beautifier",
  "applicationCategory": "DeveloperTool",
  "operatingSystem": "Web",
  "isAccessibleForFree": true
}
```

---

## 🔐 Безопасность и защита

* WASM **может**:

  * проверять `window.location.hostname`
  * проверять подписанный сервером токен
* WASM **не должен**:

  * полагаться только на домен (это не защита, а обфускация)

Copilot не должен реализовывать «жёсткие» DRM-механизмы — только soft-protection.

---

## 🧼 Код-стайл и качество

### Обязательные требования

* Nullable reference types — включены
* XML-комментарии у базовых компонентов
* Минимум логики в UI
* Чёткие имена компонентов (`JsonBeautifier`, а не `Tool1`)

### Пример комментария

```csharp
/// <summary>
/// Universal SSR-compatible layout for all developer tools.
/// All data processing happens client-side via WASM.
/// </summary>
```

---

## 🤖 Как Copilot должен себя вести

Copilot **должен**:

* предлагать переиспользуемые компоненты
* избегать дублирования UI
* учитывать SSR
* учитывать WASM-first подход

Copilot **не должен**:

* предлагать server-side processing
* использовать API endpoints для логики
* хардкодить тексты или URL

---

## 🧭 Краткий принцип проекта (one-liner)

> **MyDevTools.app** — privacy-first developer tools,
> where **all data stays in your browser**.

---
