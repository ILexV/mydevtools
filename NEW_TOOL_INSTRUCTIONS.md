# Инструкция по созданию нового инструмента (Quick Start)

Эта инструкция описывает 4 обязательных шага для добавления нового инструмента в проект MyDevTools.app.

---

## 1. Плитка на главном экране (`Home.razor`)

Чтобы инструмент появился на главной странице, нужно обновить `MyDevToolsApp/MyDevTools.Site/Components/Pages/Home.razor`:

1.  Добавьте инструмент в метод `GetTools()`:
    ```csharp
    new("slug-инструмента", "emoji", AppStrings.ToolName_Title, AppStrings.ToolName_Description)
    ```
2.  Добавьте его в соответствующую категорию в методу `GetToolsByCategory()`:
    ```csharp
    new("category-slug", AppStrings.Category_Name, new[]
    {
        tools.First(t => t.Slug == "slug-инструмента"),
        // ... другие инструменты
    })
    ```

---

## 2. Регистрация в Middleware (SEO и редиректы)

Чтобы инструмент корректно индексировался поисковиками и работал редирект на язык браузера, добавьте его slug в следующие файлы в папке `MyDevToolsApp/MyDevTools.Site/Middleware/`:

1.  **`CultureRedirectMiddleware.cs`**: Добавьте slug в массив `ToolSlugs`.
2.  **`HeadRequestMiddleware.cs`**: Добавьте slug в массив `ToolSlugs`.

Это критически важно для SEO, так как эти файлы управляют белым списком валидных путей.

---

## 3. Локализация и SEO (10 языков)

Все строки должны быть вынесены в ресурсы. Необходимо обновить **10 файлов** в `MyDevToolsApp/MyDevTools.Site/Resources/`:
`AppStrings.resx` (основной), `.ru.resx`, `.es.resx`, `.de.resx`, `.fr.resx`, `.pt.resx`, `.zh.resx`, `.ja.resx`, `.ko.resx`, `.hi.resx`.

### Обязательные ключи для каждого инструмента:
*   `ToolName_Title`: Название инструмента.
*   `ToolName_Description`: Краткое описание (для плитки и meta-тегов).
*   `ToolName_Seo_Introduction`: Вступление для SEO-блока.
*   `ToolName_Seo_DetailedDescription`: Подробное описание функционала.
*   `ToolName_Seo_Examples`: Примеры использования.
*   `ToolName_Seo_HowToSteps`: Пошаговая инструкция.
*   `ToolName_Seo_Tips`: Советы и особенности (приватность, офлайн-работа).

**Важно:** 
*   После обновления `.resx` файлов необходимо убедиться, что `AppStrings.Designer.cs` обновился (через `dotnet build`) или обновить его вручную, чтобы свойства были доступны в C# коде.
*   **Переносы строк:** В файлах локализации (особенно для SEO-ключей) избегайте использования текстового литерала `\n`. Используйте реальные переносы строк внутри тега `<value>`, чтобы Markdown-разметка (списки, абзацы) отображалась корректно.

---

## 4. Валидация локализации (JSON файлы)

После создания JSON файлов локализации необходимо проверить их корректность с помощью **LocalizationValidator**:

```bash
cd MyDevToolsApp/Tools/LocalizationValidator
dotnet run
```

Эта утилита проверит:
- ✅ Валидность синтаксиса всех JSON файлов
- ✅ Наличие всех ключей во всех 10 языках
- ✅ Соответствие ключей между Razor компонентами и JSON файлами
- ✅ Отсутствие пустых значений

**При обнаружении ошибок**, утилита выведет блоки `<LLM_FIX>` с конкретными инструкциями для исправления. Исправьте все ошибки перед продолжением.

### Дополнительные опции:
```bash
dotnet run --verbose                    # Подробный вывод
dotnet run --format json                # Вывод в JSON формате
dotnet run --lang ru,es,de              # Проверка конкретных языков
dotnet run --scope tools                # Только инструменты (без common/home)
```

---

## 5. Компиляция WASM (`wasm/`)

Если инструмент использует Rust, выполните следующие шаги:

1.  Создайте/обновите проект в папке `wasm/your_tool`.
2.  Добавьте домен в скрипт сборки `wasm/build.ps1`, если это новый домен.
3.  Скомпилируйте модуль для нужного домена:
    ```powershell
    cd wasm
    powershell -ExecutionPolicy Bypass -File .\build.ps1 -Configuration Release -Domains @('your_domain')
    ```
4.  Проверьте, что артефакты (`.js` и `.wasm`) появились в `wwwroot/wasm/your_domain/`.

---

## 6. Подписка на события JS (Нюанс Blazor SSR)

Из-за особенностей Blazor SSR (частичное обновление DOM), **нельзя** использовать простую привязку `element.addEventListener` при загрузке.

### Правильный паттерн (Делегирование):
Используйте один глобальный обработчик на `document` и `MutationObserver` для инициализации:

```javascript
(function () {
    const rootState = new WeakMap();

    // 1. Делегированный обработчик (не пропадает при обновлении DOM)
    function bindDelegatedHandlersOnce() {
        if (window.__tool_name_bound) return;
        window.__tool_name_bound = true;

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            const root = target.closest('#tool-root-id');
            if (!root) return;

            // Обработка клика по кнопке
            const btn = target.closest('#my-action-btn');
            if (btn) {
                handleAction(root);
                return;
            }
            
            // Клик по зоне загрузки для открытия диалога выбора файла
            const dropZone = target.closest('.upload-box');
            if (dropZone && !target.closest('button')) {
                root.querySelector('input[type="file"]')?.click();
            }
        });
    }

    // 2. Инициализация при каждом появлении элемента
    function initIfPresent() {
        const root = document.getElementById('tool-root-id');
        if (root) {
            bindDelegatedHandlersOnce();
            // Дополнительная настройка (например, загрузка WASM)
        }
    }

    initIfPresent();
    new MutationObserver(() => initIfPresent()).observe(document.documentElement, { childList: true, subtree: true });
})();
```

**Примечание:** Для компонентов `FileDropZone` всегда указывайте уникальный `Id` (например, `Id="my-tool-drop-zone"`). Глобальный скрипт `file-drop.js` автоматически найдет его по суффиксу `-zone` и привяжет открытие окна выбора файла. Не добавляйте ручной вызов `input.click()` в скрипт инструмента, иначе окно будет открываться дважды.

---

## 7. Добавление в Command Palette (поиск по сайту)

Чтобы инструмент был доступен через поиск по сайту (Ctrl+K), добавьте его в метод `GetTools()` в файле `MyDevToolsApp/MyDevTools.Site/Components/Layout/MainLayout.razor`:



```csharp

new() { 

    Slug = "your-tool-slug", 

    Name = GetToolTitle("your-tool-slug"), 

    Description = GetToolDescription("your-tool-slug"), 

    Category = JsonLocalization.Get(CurrentLanguage, "categories", "CategoryName"), 

    Icon = "🎯",

    IsPopular = true  // Опционально: добавляет бейдж "Popular"

}

```



**Важно:** Убедитесь, что:

- `Slug` совпадает с slug из Home.razor

- `Icon` - подходящий emoji (или HTML entity для спецсимволов)

- `Category` соответствует одной из существующих категорий (Images, Encoding, StructuredData, и т.д.)



---

## Чек-лист проверки:
1. [ ] Плитка видна на главной.
2. [ ] Переключение языков (RU/EN/ES...) меняет весь текст, включая SEO-блок.
3. [ ] **Валидация локализации проходит без ошибок** (`dotnet run` в LocalizationValidator).
4. [ ] Клик по кнопкам работает после перехода на страницу с главной (без F5).
5. [ ] WASM загружается и корректно обрабатывает данные.
6. [ ] В консоли браузера нет ошибок `null reference` при поиске элементов.
7. [ ] Инструмент находится через поиск (Ctrl+K) по названию и ключевым словам.
