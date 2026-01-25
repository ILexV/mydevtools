# Tool Development Guide

Руководство по разработке инструментов для MyDevTools.app с учётом особенностей Blazor SSR и архитектуры проекта.

## Содержание

1. [Общие принципы](#общие-принципы)
2. [JavaScript и обработка событий](#javascript-и-обработка-событий)
3. [Blazor Enhanced Navigation](#blazor-enhanced-navigation)
4. [Типичные проблемы и решения](#типичные-проблемы-и-решения)
5. [Шаблоны и примеры](#шаблоны-и-примеры)

---

## Общие принципы

### Архитектурные правила

❌ **ЗАПРЕЩЕНО:**
- Обрабатывать пользовательские данные на сервере
- Отправлять файлы/текст на backend
- Создавать уникальные layouts для каждого инструмента
- Использовать "магические строки" для локализации
- Размещать XML-комментарии перед `@page` или `@inject`

✅ **ОБЯЗАТЕЛЬНО:**
- Server-Side Rendering только для HTML
- Клиентская обработка данных через WASM
- Использовать компонент `ToolLayout` для всех инструментов
- Включать SEO компоненты: `MetaTags`, `HreflangLinks`, `JsonLdTool`
- Использовать строго типизированные ресурсы через `AppStrings.*`
- Ленивая загрузка WASM модулей (отдельный bundle на домен)

---

## JavaScript и обработка событий

### ⚠️ КРИТИЧЕСКИ ВАЖНО: Blazor SSR и Enhanced Navigation

**Статус Enhanced Navigation:** ОТКЛЮЧЕНА в `App.razor` (строка 40):
```javascript
window.Blazor.enhancedNavigationEnabled = false;
```

Однако некоторые механизмы SSR всё равно влияют на жизненный цикл страниц и обработчиков событий.

### Проблема: Кнопки перестают работать

**Симптомы:**
- Кнопки не реагируют на клики
- `addEventListener` не срабатывает
- События работают только при первой загрузке страницы

**Причины:**
1. Обработчики событий привязываются к DOM-элементам, которые могут быть заменены при навигации
2. Использование `addEventListener` без переинициализации
3. Поиск несуществующих DOM-элементов приводит к `null` и блокирует инициализацию

### ✅ Решение 1: Делегирование событий (РЕКОМЕНДУЕТСЯ)

Используйте глобальный обработчик на `document` с проверкой `target.id`:

```javascript
(function () {
    function bindDelegatedHandlersOnce() {
        if (window.__mydevtools_TOOLNAME_bound) return;
        window.__mydevtools_TOOLNAME_bound = true;

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof HTMLElement)) return;

            if (target.id === 'my-button-id') {
                handleMyButton();
                return;
            }
            if (target.id === 'another-button-id') {
                handleAnotherButton();
                return;
            }
        });
    }

    bindDelegatedHandlersOnce();

    function initIfPresent() {
        const root = document.getElementById('tool-root');
        if (!root) return;
        // Инициализация UI, но НЕ обработчиков событий
    }

    initIfPresent();

    // Следить за изменениями DOM
    try {
        const observer = new MutationObserver(() => initIfPresent());
        observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch {
        // ignore
    }
})();
```

**Преимущества:**
- ✅ Работает независимо от замены DOM-элементов
- ✅ Обработчики регистрируются один раз
- ✅ Минимальные накладные расходы

**Примеры:**
- `wwwroot/tools/aead-file.js`
- `wwwroot/tools/hash-calculator.js`
- `wwwroot/tools/json-beautifier.js`

### ✅ Решение 2: Использование `onclick` с переинициализацией

Для простых инструментов без сложной логики:

```javascript
(function() {
    'use strict';

    function init() {
        const root = document.getElementById('tool-root');
        if (!root) return;

        const button1 = document.getElementById('my-button-1');
        const button2 = document.getElementById('my-button-2');

        // Проверяем существование ВСЕХ элементов
        if (!button1 || !button2) return;

        // Используем onclick вместо addEventListener
        button1.onclick = function() { handleButton1(); };
        button2.onclick = function() { handleButton2(); };
    }

    // Инициализация при загрузке
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
    
    // Переинициализация при навигации
    window.addEventListener('pageshow', init);
})();
```

**Преимущества:**
- ✅ Простая переинициализация
- ✅ `onclick` перезаписывается, нет дубликатов

**Примеры:**
- `wwwroot/js/markdown-preview.js`

### ❌ Антипаттерны: Что НЕ делать

```javascript
// ❌ ПЛОХО: addEventListener без переинициализации
document.getElementById('my-button').addEventListener('click', handleClick);

// ❌ ПЛОХО: addEventListener с повторной привязкой (дубликаты)
function init() {
    const btn = document.getElementById('my-button');
    btn.addEventListener('click', handleClick); // Создаст дубликаты!
}

// ❌ ПЛОХО: Не проверять существование элементов
const button = document.getElementById('my-button');
button.addEventListener('click', handleClick); // Упадёт, если button === null
```

---

## Типичные проблемы и решения

### Проблема 1: `getElements()` возвращает `null`

**Симптом:**
```javascript
function getElements() {
    const root = document.getElementById('tool-root');
    const button = document.getElementById('my-button');
    const output = document.getElementById('output');
    const container = output?.closest('.some-class'); // ❌ Класс не существует!
    
    if (!root || !button || !output || !container) {
        return null; // Всегда возвращает null!
    }
    return { root, button, output, container };
}
```

**Решение:**
```javascript
function getElements() {
    const root = document.getElementById('tool-root');
    const button = document.getElementById('my-button');
    const output = document.getElementById('output');
    
    // ✅ Используем fallback или удаляем ненужную проверку
    const container = output?.closest('.space-y-4') || output?.parentElement;
    
    // Проверяем только критичные элементы
    if (!root || !button || !output) {
        return null;
    }
    return { root, button, output, container };
}
```

**Урок:** Всегда проверяйте, что CSS-классы существуют в HTML!

### Проблема 2: Razor интерпретирует JavaScript код

**Симптом:**
```razor
<script>
    const html = `<html lang="en">
        <head>...</head>
    </html>`; // ❌ Razor видит <html> как реальный HTML тег!
</script>
```

**Решение:**
Выносите JavaScript в отдельные файлы `wwwroot/js/` или `wwwroot/tools/`:

```razor
<!-- ✅ Правильно -->
<script src="/js/my-tool.js"></script>
```

### Проблема 3: CDN блокируется браузером

**Симптом:**
```
Tracking Prevention blocked access to storage for https://cdn.jsdelivr.net/...
```

**Решение:**
Используйте локальные копии библиотек:

```bash
# Установить через npm
npm install marked@11.1.1

# Скопировать в wwwroot
cp node_modules/marked/marked.min.js wwwroot/js/
```

```razor
<!-- Подключить локально -->
<script src="/js/marked.min.js"></script>
```

### Проблема 4: Бесконечные редиректы

**Симптом:**
```
ERR_TOO_MANY_REDIRECTS на /not-found
```

**Решение:**
Добавьте исключение в `Middleware/CultureRedirectMiddleware.cs`:

```csharp
if (path.StartsWith("/_") || 
    path.StartsWith("/css") || 
    path.StartsWith("/js") || 
    path.StartsWith("/lib") ||
    path.StartsWith("/not-found") ||  // ✅ Добавить исключение
    path.Contains('.'))
{
    await _next(context);
    return;
}
```

---

## Шаблоны и примеры

### Шаблон 1: Простой инструмент с кнопками

**Razor компонент:** `Components/Tools/MyTool.razor`

```razor
@page "/{lang}/my-tool"
@using MyDevTools.Site.Resources
@inject NavigationManager Navigation

<MetaTags Title="@AppStrings.MyTool_Title"
          Description="@AppStrings.MyTool_Description"
          CurrentUrl="@Navigation.Uri" />

<HreflangLinks ToolPath="my-tool" />

<JsonLdTool ToolName="@AppStrings.MyTool_Title"
            Description="@AppStrings.MyTool_Description"
            CurrentUrl="@Navigation.Uri" />

<ToolLayout Title="@AppStrings.MyTool_Title" Description="@AppStrings.MyTool_Description">
    <div id="my-tool-root"
         data-loading="@AppStrings.Common_Loading"
         data-error="@AppStrings.Common_Error">
        
        <div class="form-control w-full">
            <label class="label" for="my-input">
                <span class="label-text font-semibold">@AppStrings.MyTool_InputLabel</span>
            </label>
            <input id="my-input" type="text" class="input input-bordered w-full" />
        </div>

        <div class="flex gap-2 mt-4">
            <button class="btn btn-primary" id="my-process-btn" type="button">
                @AppStrings.MyTool_ProcessButton
            </button>
            <button class="btn btn-secondary" id="my-clear-btn" type="button">
                @AppStrings.MyTool_ClearButton
            </button>
        </div>

        <div class="form-control w-full mt-4">
            <label class="label" for="my-output">
                <span class="label-text font-semibold">@AppStrings.MyTool_OutputLabel</span>
            </label>
            <textarea id="my-output" rows="6" readonly class="textarea textarea-bordered w-full font-mono"></textarea>
        </div>

        <div class="alert alert-error mt-4" id="my-error" style="display: none;"></div>
    </div>
</ToolLayout>

<script src="/js/my-tool.js"></script>

@code {
    /// <summary>
    /// Language parameter from URL route
    /// </summary>
    [Parameter]
    public string Lang { get; set; } = "en";
}
```

**JavaScript:** `wwwroot/js/my-tool.js`

```javascript
(function() {
    'use strict';

    function init() {
        const root = document.getElementById('my-tool-root');
        if (!root) return;

        const input = document.getElementById('my-input');
        const output = document.getElementById('my-output');
        const processBtn = document.getElementById('my-process-btn');
        const clearBtn = document.getElementById('my-clear-btn');
        const errorDiv = document.getElementById('my-error');

        // Проверка существования всех элементов
        if (!input || !output || !processBtn || !clearBtn || !errorDiv) {
            return;
        }

        // Получение локализованных строк из data-атрибутов
        const strings = {
            loading: root.dataset.loading || 'Loading...',
            error: root.dataset.error || 'Error'
        };

        function showError(message) {
            errorDiv.textContent = message;
            errorDiv.style.display = '';
        }

        function hideError() {
            errorDiv.style.display = 'none';
        }

        function processData() {
            hideError();
            try {
                const inputValue = input.value;
                if (!inputValue.trim()) {
                    showError('Input is required');
                    return;
                }

                // Обработка данных (всё на клиенте!)
                const result = inputValue.toUpperCase(); // Пример
                output.value = result;

            } catch (error) {
                showError(strings.error + ': ' + error.message);
            }
        }

        function clearAll() {
            input.value = '';
            output.value = '';
            hideError();
        }

        // Использование onclick для избежания дубликатов
        processBtn.onclick = processData;
        clearBtn.onclick = clearAll;
        input.onkeypress = function(e) {
            if (e.key === 'Enter') processData();
        };
    }

    // Инициализация
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
    
    window.addEventListener('pageshow', init);
})();
```

### Шаблон 2: Инструмент с WASM и делегированием событий

**JavaScript:** `wwwroot/tools/my-wasm-tool.js`

```javascript
(function () {
    const initializedRoots = new WeakSet();
    let wasmPromise = null;

    async function getWasm() {
        if (!wasmPromise) {
            wasmPromise = import('/wasm/my-domain/my-domain.js').then(async (m) => {
                await m.default();
                return m;
            });
        }
        return wasmPromise;
    }

    function getElements() {
        const root = document.getElementById('my-tool-root');
        if (!root) return null;

        const input = document.getElementById('my-input');
        const output = document.getElementById('my-output');
        const processBtn = document.getElementById('my-process-btn');

        if (!input || !output || !processBtn) {
            return null;
        }

        return { root, input, output, processBtn };
    }

    async function processAction() {
        const els = getElements();
        if (!els) return;

        try {
            const wasm = await getWasm();
            const result = wasm.process_data(els.input.value);
            els.output.value = result;
        } catch (error) {
            console.error('Processing error:', error);
        }
    }

    function bindDelegatedHandlersOnce() {
        if (window.__mydevtools_mytool_bound) return;
        window.__mydevtools_mytool_bound = true;

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof HTMLElement)) return;

            if (target.id === 'my-process-btn') {
                return void processAction();
            }
        });
    }

    bindDelegatedHandlersOnce();

    function initIfPresent() {
        const els = getElements();
        if (!els) return;
        if (initializedRoots.has(els.root)) return;
        initializedRoots.add(els.root);
        // Дополнительная инициализация UI
    }

    initIfPresent();

    try {
        const observer = new MutationObserver(() => initIfPresent());
        observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch {
        // ignore
    }
})();
```

---

## Регистрация инструмента в App.razor

После создания инструмента, зарегистрируйте его в `Components/App.razor`:

```csharp
@code {
    // ...
    private bool IsMyTool => CurrentPath.Contains("/my-tool", StringComparison.OrdinalIgnoreCase);
    // ...
}
```

```razor
@if (IsMyTool)
{
    <script src="@Assets["tools/my-tool.js"]"></script>
}
```

---

## Чеклист перед коммитом

- [ ] Обработчики событий используют делегирование или `onclick` с переинициализацией
- [ ] Все DOM-элементы проверяются на существование перед использованием
- [ ] JavaScript вынесен в отдельные файлы (не встроен в Razor)
- [ ] Используются строго типизированные ресурсы `AppStrings.*`
- [ ] Включены SEO компоненты: `MetaTags`, `HreflangLinks`, `JsonLdTool`
- [ ] Используется компонент `ToolLayout`
- [ ] Все данные обрабатываются на клиенте (WASM или JavaScript)
- [ ] Локализация работает на всех языках (en, ru, es)
- [ ] CSS классы, используемые в `querySelector`, существуют в HTML
- [ ] Внешние библиотеки подключены локально (не через CDN)

---

## Ссылки на документацию

- [README.md](./README.md) - Обзор проекта
- [DEVELOPMENT.md](./DEVELOPMENT.md) - Руководство по разработке
- [ARCHITECTURE.md](./ARCHITECTURE.md) - Архитектура системы
- [LOCALIZATION_GUIDE.md](./LOCALIZATION_GUIDE.md) - Локализация
- [WASM_INTEGRATION.md](./WASM_INTEGRATION.md) - Интеграция WASM
- [AGENTS.md](./AGENTS.md) - Руководство для AI агентов

---

## История изменений

### 2026-01-25
- Создан документ на основе исправления проблем в Markdown Preview и AEAD File Crypto
- Добавлены паттерны делегирования событий и использования `onclick`
- Документированы типичные проблемы и решения
