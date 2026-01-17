# 🌍 Руководство по локализации

> Детальное руководство по работе с многоязычностью в проекте MyDevTools.app

## 📋 Содержание

- [Обзор локализации](#обзор-локализации)
- [Архитектура локализации](#архитектура-локализации)
- [Strongly-Typed Resources](#strongly-typed-resources)
- [Добавление новых переводов](#добавление-новых-переводов)
- [Использование в компонентах](#использование-в-компонентах)
- [URL структура](#url-структура)
- [Частые задачи](#частые-задачи)
- [Лучшие практики](#лучшие-практики)
- [Отладка локализации](#отладка-локализации)

---

## 🎯 Обзор локализации

### Поддерживаемые языки

- 🇬🇧 **Английский** (`en`) — базовый язык
- 🇷🇺 **Русский** (`ru`)
- 🇪🇸 **Испанский** (`es`)

### Технологии

- **.NET Localization** — инфраструктура локализации
- **.resx файлы** — ресурсы локализации
- **Strongly-Typed Resources** — compile-time проверка
- **Route-based localization** — язык в URL (`/{lang}/...`)

---

## 🏗️ Архитектура локализации

### Компоненты системы

```
┌─────────────────────────────────────────────────────────┐
│  1. Запрос: / (корень)                                  │
│     └─> CultureRedirectMiddleware                       │
│         ├─> Определение языка (Accept-Language)         │
│         └─> Редирект: /en/, /ru/, или /es/             │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  2. Запрос: /en/tool-name                               │
│     └─> RouteDataRequestCultureProvider                 │
│         ├─> Извлечение "en" из пути                     │
│         └─> Установка Culture = "en"                    │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  3. Razor Component                                     │
│     └─> @AppStrings.Tool_Title                          │
│         └─> ResourceManager.GetString("Tool_Title", Culture)
│         └─> Загрузка из AppStrings.en.resx              │
└─────────────────────────────────────────────────────────┘
```

### Файловая структура

```
Resources/
├── AppStrings.resx          # Английский (базовый)
│   ├── AppStrings.Designer.cs (автогенерированный)
│   └── AppStrings.Designer.cs (compile-time класс)
├── AppStrings.ru.resx       # Русский
└── AppStrings.es.resx       # Испанский
```

### Middleware и Services

**CultureRedirectMiddleware:**
- Редирект с `/` на `/{lang}/` по языку браузера

**RouteDataRequestCultureProvider:**
- Извлечение языка из URL (`/{lang}/...`)
- Установка `Culture` для запроса

**LocalizationService:**
- Сервис для работы с локализацией (если нужен программный доступ)

---

## 🔧 Strongly-Typed Resources

### Что это?

**Strongly-Typed Resources** — это автогенерированный класс `AppStrings.Designer.cs`, который предоставляет compile-time доступ к ресурсам локализации.

**Преимущества:**
- ✅ **Compile-time проверка** — ошибки компиляции, если ключ не существует
- ✅ **IntelliSense** — автодополнение в IDE
- ✅ **Рефакторинг** — безопасное переименование ключей
- ✅ **Типобезопасность** — никаких магических строк

### Автогенерация

**Visual Studio автоматически генерирует `AppStrings.Designer.cs`** при изменении `.resx` файлов.

**Настройка в `.csproj`:**
```xml
<ItemGroup>
  <EmbeddedResource Update="Resources\AppStrings.resx">
    <Generator>PublicResXFileCodeGenerator</Generator>
    <LastGenOutput>AppStrings.Designer.cs</LastGenOutput>
  </EmbeddedResource>
</ItemGroup>
```

### Структура класса

**AppStrings.Designer.cs** (пример):
```csharp
namespace MyDevTools.Site.Resources {
    public class AppStrings {
        private static ResourceManager resourceMan;
        
        public static ResourceManager ResourceManager {
            get {
                if (resourceMan == null) {
                    ResourceManager temp = new ResourceManager(
                        "MyDevTools.Site.Resources.AppStrings",
                        typeof(AppStrings).Assembly
                    );
                    resourceMan = temp;
                }
                return resourceMan;
            }
        }
        
        public static string HashCalculator_Title {
            get {
                return ResourceManager.GetString("HashCalculator_Title", resourceCulture);
            }
        }
        
        // ... другие свойства
    }
}
```

**Важно:** Этот файл автогенерируется, **НЕ редактируйте его вручную!**

---

## ➕ Добавление новых переводов

### Шаг 1: Добавление ключа в базовый файл

**Файл:** `Resources/AppStrings.resx`

**В Visual Studio:**
1. Откройте `AppStrings.resx` (двойной клик)
2. Нажмите "Добавить ресурс" или "Add Resource"
3. Введите:
   - **Имя:** `MyTool_Title`
   - **Значение:** `My Tool`
   - **Комментарий:** (опционально) описание
4. Сохраните (`Ctrl+S`)

**Вручную (XML):**
```xml
<data name="MyTool_Title" xml:space="preserve">
  <value>My Tool</value>
  <comment>Title of the My Tool page</comment>
</data>
```

### Шаг 2: Автогенерация Designer.cs

**Visual Studio автоматически:**
1. Обновит `AppStrings.Designer.cs`
2. Добавит свойство `MyTool_Title`

**Проверка:**
```csharp
// AppStrings.Designer.cs теперь содержит:
public static string MyTool_Title {
    get {
        return ResourceManager.GetString("MyTool_Title", resourceCulture);
    }
}
```

### Шаг 3: Добавление переводов

**Русский перевод (`AppStrings.ru.resx`):**
```xml
<data name="MyTool_Title" xml:space="preserve">
  <value>Мой Инструмент</value>
</data>
```

**Испанский перевод (`AppStrings.es.resx`):**
```xml
<data name="MyTool_Title" xml:space="preserve">
  <value>Mi Herramienta</value>
</data>
```

**Важно:** Имя ключа (`name`) должно быть **точно таким же** во всех файлах!

### Шаг 4: Использование в компоненте

```razor
@using MyDevTools.Site.Resources

<h1>@AppStrings.MyTool_Title</h1>
```

**Compile-time проверка:** Если ключ не существует, будет ошибка компиляции.

---

## 📝 Использование в компонентах

### Базовое использование

```razor
@page "/{lang}/my-tool"
@using MyDevTools.Site.Resources

<h1>@AppStrings.MyTool_Title</h1>
<p>@AppStrings.MyTool_Description</p>
<button>@AppStrings.MyTool_Button</button>
```

### В ToolLayout

```razor
<ToolLayout Title="@AppStrings.MyTool_Title" 
            Description="@AppStrings.MyTool_Description">
    <!-- Tool content -->
</ToolLayout>
```

### В MetaTags (SEO)

```razor
<MetaTags Title="@AppStrings.MyTool_Title" 
          Description="@AppStrings.MyTool_Description" 
          CurrentUrl="@Navigation.Uri" />
```

### В JavaScript (data-атрибуты)

```razor
<div id="tool-root"
     data-title="@AppStrings.MyTool_Title"
     data-description="@AppStrings.MyTool_Description">
    <!-- Tool UI -->
</div>

<script>
    const root = document.getElementById('tool-root');
    const title = root.dataset.title;  // Получаем локализованный текст
</script>
```

### В @code блоках

```razor
@code {
    private string GetButtonText() {
        return AppStrings.MyTool_Button;
    }
    
    private void HandleClick() {
        // Использование локализованного текста
        Console.WriteLine(AppStrings.MyTool_ActionMessage);
    }
}
```

---

## 🔗 URL структура

### Формат URL

```
/{lang}/tool-name
```

**Примеры:**
- `/en/hash-calculator` — Hash Calculator (английский)
- `/ru/hash-calculator` — Калькулятор хэшей (русский)
- `/es/hash-calculator` — Calculadora de Hash (испанский)

### Редирект с корня

**Запрос:** `/`

**Логика:**
1. `CultureRedirectMiddleware` проверяет `Accept-Language` заголовок
2. Определяет язык: `en`, `ru`, или `es`
3. Редиректит на `/{lang}/`

**Пример:**
```
GET /
Accept-Language: ru-RU,ru;q=0.9,en;q=0.8
→ Редирект на /ru/
```

### Определение языка из URL

**Запрос:** `/en/tool-name`

**Логика:**
1. `RouteDataRequestCultureProvider` извлекает `en` из пути
2. Устанавливает `Culture = "en"`
3. Компоненты используют `AppStrings.*` с правильным языком

### Переключение языка

**Компонент:** `LanguageSwitcher.razor`

```razor
<LanguageSwitcher CurrentLanguage="@CurrentLanguage" />
```

**Логика:**
- Отображает текущий язык
- Предлагает переключение на другие языки
- Переходит на `/{new-lang}/current-tool`

---

## 📋 Частые задачи

### Задача 1: Добавить новый инструмент с локализацией

**Шаг 1:** Создайте компонент:
```razor
@page "/{lang}/my-new-tool"
@using MyDevTools.Site.Resources
```

**Шаг 2:** Добавьте ключи в `AppStrings.resx`:
- `MyNewTool_Title`
- `MyNewTool_Description`
- `MyNewTool_ActionButton`
- и т.д.

**Шаг 3:** Добавьте переводы в `.ru.resx` и `.es.resx`

**Шаг 4:** Используйте в компоненте:
```razor
<ToolLayout Title="@AppStrings.MyNewTool_Title" 
            Description="@AppStrings.MyNewTool_Description">
    <button>@AppStrings.MyNewTool_ActionButton</button>
</ToolLayout>
```

### Задача 2: Переименовать ключ локализации

**Важно:** Переименование ключа требует обновления всех `.resx` файлов!

**В Visual Studio:**
1. Откройте `.resx` файл
2. Найдите ключ и переименуйте его
3. Повторите для всех `.ru.resx` и `.es.resx`
4. Пересоберите проект (`Ctrl+Shift+B`)
5. Обновите использование в компонентах

**Альтернатива:** Используйте "Find and Replace" во всех файлах.

### Задача 3: Добавить новый язык

**Шаг 1:** Создайте новый `.resx` файл:
- `AppStrings.de.resx` (немецкий, например)

**Шаг 2:** Добавьте переводы всех ключей

**Шаг 3:** Обновите `Program.cs`:
```csharp
var supportedCultures = new[] { "en", "ru", "es", "de" };
```

**Шаг 4:** Обновите `CultureRedirectMiddleware` (если нужно)

**Шаг 5:** Обновите `LanguageSwitcher.razor` (если нужно)

### Задача 4: Локализация с параметрами

**Вариант 1: Форматирование строк**

В `.resx`:
```xml
<data name="WelcomeMessage" xml:space="preserve">
  <value>Welcome, {0}!</value>
</data>
```

В коде:
```csharp
string message = string.Format(AppStrings.WelcomeMessage, userName);
```

**Вариант 2: Использование в Razor**

```razor
@code {
    private string GetWelcomeMessage(string userName) {
        return string.Format(AppStrings.WelcomeMessage, userName);
    }
}
```

---

## ✨ Лучшие практики

### 1. Соглашения по именованию

**Формат:** `{Component}_{Property}`

**Примеры:**
- `HashCalculator_Title` — заголовок Hash Calculator
- `HashCalculator_Description` — описание Hash Calculator
- `HashCalculator_CalculateButton` — кнопка "Calculate"

**Правила:**
- ✅ Используйте `PascalCase` для ключей
- ✅ Используйте подчеркивание `_` для разделения компонента и свойства
- ✅ Начинайте с имени компонента/страницы

### 2. Организация ключей

**Группировка по компонентам:**
```
HashCalculator_Title
HashCalculator_Description
HashCalculator_CalculateButton
HashCalculator_ClearButton

Base64Encoder_Title
Base64Encoder_Description
Base64Encoder_EncodeButton
```

### 3. Общие ключи

**Используйте общие ключи для переиспользуемых текстов:**
```
Common_Loading
Common_Error
Common_Success
Nav_Home
Nav_Tools
```

### 4. Комментарии в .resx

**Добавляйте комментарии для контекста:**
```xml
<data name="HashCalculator_SelectAtLeastOneAlgorithm" xml:space="preserve">
  <value>Please select at least one algorithm</value>
  <comment>Error message shown when no hash algorithms are selected</comment>
</data>
```

### 5. Избегайте магических строк

**❌ Неправильно:**
```razor
<h1>Hash Calculator</h1>
```

**✅ Правильно:**
```razor
<h1>@AppStrings.HashCalculator_Title</h1>
```

### 6. Проверка всех языков

**После добавления ключа:**
1. Проверьте, что ключ добавлен во все `.resx` файлы
2. Проверьте переводы на всех языках
3. Протестируйте на всех языках в браузере

---

## 🐛 Отладка локализации

### Проблема 1: Текст не переводится

**Симптомы:**
- Отображается ключ: `AppStrings.MyTool_Title`
- Или отображается английский текст на всех языках

**Решение:**

1. **Проверьте, что ключ существует во всех `.resx` файлах:**
   ```powershell
   # Проверка наличия ключа
   Select-String -Path "Resources\AppStrings*.resx" -Pattern "MyTool_Title"
   ```

2. **Пересоберите проект:**
   ```powershell
   dotnet clean
   dotnet build
   ```

3. **Проверьте URL:**
   - Убедитесь, что URL содержит `/{lang}/`
   - Например: `/en/tool-name`, а не `/tool-name`

4. **Проверьте `Culture`:**
   ```csharp
   // В компоненте для отладки
   @code {
       private void CheckCulture() {
           var culture = CultureInfo.CurrentCulture;
           Console.WriteLine($"Current Culture: {culture.Name}");
       }
   }
   ```

### Проблема 2: Ошибка компиляции "AppStrings.MyTool_Title не существует"

**Симптомы:**
- Ошибка компиляции при использовании `@AppStrings.MyTool_Title`

**Решение:**

1. **Проверьте, что ключ добавлен в `AppStrings.resx`**
2. **Убедитесь, что `AppStrings.Designer.cs` обновлен**
3. **Пересоберите проект:**
   ```powershell
   dotnet build
   ```

### Проблема 3: Редирект на неправильный язык

**Симптомы:**
- Редирект с `/` всегда на `/en/`, независимо от языка браузера

**Решение:**

1. **Проверьте `CultureRedirectMiddleware`:**
   ```csharp
   // Должен проверять Accept-Language заголовок
   ```

2. **Проверьте в браузере:**
   - F12 → Network → проверьте заголовок `Accept-Language`
   - Убедитесь, что браузер отправляет правильный заголовок

### Проблема 4: Переводы отсутствуют

**Симптомы:**
- На русском/испанском отображается английский текст

**Решение:**

1. **Проверьте файлы переводов:**
   ```powershell
   # Проверка наличия ключа в ru.resx
   Select-String -Path "Resources\AppStrings.ru.resx" -Pattern "MyTool_Title"
   ```

2. **Проверьте правильность имени ключа:**
   - Должно быть **точно такое же** во всех файлах

3. **Проверьте формат XML:**
   ```xml
   <!-- Правильно -->
   <data name="MyTool_Title" xml:space="preserve">
     <value>Мой Инструмент</value>
   </data>
   
   <!-- Неправильно -->
   <data name="MyTool_Title " xml:space="preserve">  <!-- лишний пробел -->
   ```

---

## 📚 Дополнительные ресурсы

- **.NET Localization**: https://learn.microsoft.com/en-us/aspnet/core/fundamentals/localization
- **.resx файлы**: https://learn.microsoft.com/en-us/dotnet/api/system.resources.resxresourcereader
- **Strongly-Typed Resources**: https://learn.microsoft.com/en-us/dotnet/api/system.resources.tools.stronglytypedresourcebuilder

---

**См. также:**
- `DEVELOPMENT.md` — практические инструкции
- `ARCHITECTURE.md` — архитектура проекта