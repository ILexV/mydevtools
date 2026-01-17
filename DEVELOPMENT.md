# 🛠️ Руководство по разработке

> Практические инструкции для ежедневной работы над проектом MyDevTools.app

## 📋 Содержание

- [Быстрый старт](#быстрый-старт)
- [Команды разработки](#команды-разработки)
- [Создание нового инструмента](#создание-нового-инструмента)
- [Работа с WASM модулями](#работа-с-wasm-модулями)
- [Локализация](#локализация)
- [Отладка](#отладка)
- [Частые проблемы](#частые-проблемы)

---

## 🚀 Быстрый старт

### Первоначальная настройка (один раз)

1. **Установите .NET 10 SDK**
   ```powershell
   # Проверка версии
   dotnet --version
   # Должно быть 10.x.x или выше
   ```

2. **Установите Rust toolchain**
   ```powershell
   # Проверка установки Rust
   rustc --version
   cargo --version
   
   # Если не установлен: https://www.rust-lang.org/tools/install
   ```

3. **Установите WASM target для Rust**
   ```powershell
   rustup target add wasm32-unknown-unknown
   ```

4. **Установите wasm-bindgen CLI**
   ```powershell
   cargo install wasm-bindgen-cli --locked
   ```

5. **Соберите WASM модули (первый раз)**
   ```powershell
   cd wasm
   .\build.ps1 -Configuration Release
   ```

### Ежедневная работа

1. **Запуск приложения**
   ```powershell
   cd MyDevToolsApp\MyDevTools.Site
   dotnet run
   ```

2. **Открыть в браузере**
   - URL: `https://localhost:5001` (или порт из `launchSettings.json`)
   - Автоматический редирект на `/en/`, `/ru/` или `/es/` по языку браузера

---

## 💻 Команды разработки

### Сборка Blazor приложения

```powershell
# Debug сборка
cd MyDevToolsApp\MyDevTools.Site
dotnet build

# Release сборка
dotnet build -c Release

# Запуск в режиме разработки
dotnet run
```

### Сборка WASM модулей

```powershell
# Из корня репозитория
cd wasm

# Debug сборка (быстрее, но больше размер)
.\build.ps1 -Configuration Debug

# Release сборка (оптимизированная)
.\build.ps1 -Configuration Release

# Сборка конкретного домена
.\build.ps1 -Configuration Release -Domains @('hash')
```

**Результат сборки:** Артефакты попадают в `MyDevToolsApp/MyDevTools.Site/wwwroot/wasm/<domain>/`

### Очистка артефактов

```powershell
# Очистка .NET артефактов
dotnet clean

# Очистка Rust артефактов
cd wasm
cargo clean
```

### Тестирование Rust модулей

```powershell
# Тесты для всех модулей (из workspace корня)
cd wasm
cargo test

# Тесты для конкретного модуля
cd wasm/hash
cargo test

# Тесты с выводом (для отладки)
cargo test -- --nocapture
```

---

## 🆕 Создание нового инструмента

### Шаг 1: Создание Razor компонента

Создайте файл `Components/Tools/YourTool.razor`:

```razor
@page "/{lang}/your-tool"
@using MyDevTools.Site.Resources
@inject NavigationManager Navigation

<MetaTags Title="@AppStrings.YourTool_Title" 
          Description="@AppStrings.YourTool_Description" 
          CurrentUrl="@Navigation.Uri" />

<HreflangLinks ToolPath="your-tool" />

<JsonLdTool ToolName="@AppStrings.YourTool_Title" 
            Description="@AppStrings.YourTool_Description" 
            CurrentUrl="@Navigation.Uri" />

<ToolLayout Title="@AppStrings.YourTool_Title" 
            Description="@AppStrings.YourTool_Description">
    
    <div class="tool-grid">
        <div class="input-section">
            <!-- Ваш UI здесь -->
        </div>
        <div class="output-section">
            <!-- Результаты здесь -->
        </div>
    </div>
    
</ToolLayout>

<script>
    // Client-side JavaScript логика
    // Вся обработка данных происходит в браузере!
</script>
```

### Шаг 2: Добавление локализации

1. Откройте `Resources/AppStrings.resx` в Visual Studio
2. Добавьте ключи:
   - `YourTool_Title` = "Your Tool"
   - `YourTool_Description` = "Description..."
   - `YourTool_ActionButton` = "Process"
   - и т.д.
3. Visual Studio автоматически обновит `AppStrings.Designer.cs`
4. Добавьте переводы в `AppStrings.ru.resx` и `AppStrings.es.resx`

### Шаг 3: Регистрация маршрута

Маршрут автоматически регистрируется через `@page "/{lang}/your-tool"`.

### Шаг 4: Добавление на главную страницу (опционально)

Обновите `Components/Pages/Home.razor` для добавления ссылки на новый инструмент.

---

## 🔧 Работа с WASM модулями

### Создание нового WASM модуля

Если нужен новый домен (например, `compression`):

1. **Создайте структуру проекта**
   ```powershell
   cd wasm
   cargo new compression --lib
   ```

2. **Добавьте в workspace**
   Откройте `wasm/Cargo.toml` и добавьте в `members`:
   ```toml
   members = [
     "hash",
     "encoding",
     "cryptography",
     "structured_data",
     "compression",  # новый модуль
   ]
   ```

3. **Настройте Cargo.toml модуля**
   ```toml
   [package]
   name = "mydevtools_compression"
   version = "0.1.0"
   edition = "2021"

   [lib]
   crate-type = ["cdylib", "rlib"]

   [dependencies]
   wasm-bindgen = "0.2"
   # другие зависимости

   [dev-dependencies]
   # тесты
   ```

4. **Реализуйте функции в `src/lib.rs`**
   ```rust
   use wasm_bindgen::prelude::*;

   #[wasm_bindgen]
   pub fn compress(data: &[u8]) -> Vec<u8> {
       // Ваша логика
   }
   ```

5. **Соберите модуль**
   ```powershell
   .\build.ps1 -Configuration Release -Domains @('compression')
   ```

6. **Используйте в JavaScript**
   ```javascript
   // В вашем tool JavaScript файле
   async function getCompressionWasm() {
       const module = await import('/wasm/compression/compression.js');
       await module.default();
       return module;
   }
   ```

### Паттерны использования WASM

**Ленивая загрузка (lazy loading):**
```javascript
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

// Использование
const wasm = await getWasm();
const result = wasm.hash_text_utf8("hello", "sha256");
```

**Обработка ошибок:**
```javascript
try {
    const wasm = await getWasm();
    const result = wasm.some_function(input);
} catch (error) {
    console.error('WASM error:', error);
    // Показать ошибку пользователю
}
```

**Прогресс для больших операций:**
```javascript
async function processLargeFile(file, onProgress) {
    const chunkSize = 1024 * 1024; // 1MB chunks
    let offset = 0;
    
    while (offset < file.size) {
        const chunk = file.slice(offset, offset + chunkSize);
        const buffer = await chunk.arrayBuffer();
        
        // Обработка chunk через WASM
        processChunk(new Uint8Array(buffer));
        
        offset += chunkSize;
        onProgress(Math.min(100, (offset / file.size) * 100));
    }
}
```

---

## 🌍 Локализация

### Добавление новых строк

1. **Откройте `Resources/AppStrings.resx`** в Visual Studio
2. **Добавьте ключ** (например, `MyTool_ButtonLabel`)
3. **Добавьте значение** на английском
4. **Visual Studio автоматически обновит `AppStrings.Designer.cs`**
5. **Добавьте переводы:**
   - `Resources/AppStrings.ru.resx` — русский перевод
   - `Resources/AppStrings.es.resx` — испанский перевод

### Использование в Razor

```razor
@using MyDevTools.Site.Resources

<!-- Правильно: compile-time безопасность -->
<h1>@AppStrings.MyTool_Title</h1>
<button>@AppStrings.MyTool_Button</button>

<!-- Неправильно: магические строки -->
<h1>@L["MyTool_Title"]</h1>
```

### Проверка локализации

1. Откройте `/en/your-tool` — должен быть английский
2. Откройте `/ru/your-tool` — должен быть русский
3. Откройте `/es/your-tool` — должен быть испанский
4. Используйте переключатель языков в header

**См. также:** `LOCALIZATION_GUIDE.md` для детальных инструкций

---

## 🐛 Отладка

### Отладка Blazor приложения

1. **Запустите с отладчиком**
   - В Visual Studio: F5
   - В VS Code: нажмите F5 и выберите ".NET Core"

2. **Логирование**
   ```csharp
   // В C# коде
   _logger.LogInformation("Debug message");
   
   // В Razor компонентах
   @code {
       private void SomeMethod() {
           Console.WriteLine("Debug output");
       }
   }
   ```

3. **DevTools в браузере**
   - F12 → Console для JavaScript ошибок
   - F12 → Network для проверки загрузки WASM модулей
   - F12 → Application → LocalStorage для проверки сохраненных данных

### Отладка WASM модулей

1. **Rust отладка (нативный тест)**
   ```powershell
   cd wasm/hash
   cargo test -- --nocapture
   ```

2. **JavaScript отладка**
   ```javascript
   // Добавьте console.log для проверки
   console.log('WASM module loaded:', wasm);
   console.log('Function result:', result);
   ```

3. **Проверка размера WASM**
   ```powershell
   # Размер файла после сборки
   Get-Item MyDevToolsApp\MyDevTools.Site\wwwroot\wasm\hash\hash_bg.wasm | Select-Object Length
   ```

4. **Проверка загрузки в браузере**
   - F12 → Network → фильтр "wasm"
   - Проверьте MIME type: должен быть `application/wasm`

---

## ⚠️ Частые проблемы

### Проблема: WASM модуль не загружается

**Симптомы:**
- Ошибка в консоли браузера: "Failed to load module"
- 404 для `hash.js` или `hash_bg.wasm`

**Решение:**
1. Проверьте, что модуль собран:
   ```powershell
   Test-Path MyDevToolsApp\MyDevTools.Site\wwwroot\wasm\hash\hash.js
   ```
2. Пересоберите модуль:
   ```powershell
   cd wasm
   .\build.ps1 -Configuration Release
   ```
3. Проверьте MIME type в `Program.cs` (должен быть настроен автоматически)

### Проблема: Локализация не работает

**Симптомы:**
- Тексты не переводятся
- Появляются ключи типа `AppStrings.MyTool_Title`

**Решение:**
1. Проверьте, что ключ существует в `.resx` файлах
2. Пересоберите проект:
   ```powershell
   dotnet clean
   dotnet build
   ```
3. Проверьте, что используется `@AppStrings.*`, а не `@L["..."]`

### Проблема: Blazor SSR Enhanced Navigation ломает обработчики

**Симптомы:**
- JavaScript обработчики работают только при первой загрузке
- После перехода на другую страницу обработчики перестают работать

**Решение:**
Используйте делегирование событий:
```javascript
// Вместо
document.getElementById('button').addEventListener('click', handler);

// Используйте
document.addEventListener('click', (e) => {
    if (e.target.closest('#button')) {
        handler(e);
    }
});
```

Или переинициализируйте на событиях:
```javascript
document.addEventListener('DOMContentLoaded', init);
document.addEventListener('enhancedload', init); // Blazor Enhanced Navigation
```

### Проблема: Rust crate не собирается для WASM

**Симптомы:**
- Ошибка компиляции: `target 'wasm32-unknown-unknown' not found`
- Ошибка: `no such subcommand: wasm-bindgen`

**Решение:**
1. Установите target:
   ```powershell
   rustup target add wasm32-unknown-unknown
   ```
2. Установите wasm-bindgen:
   ```powershell
   cargo install wasm-bindgen-cli --locked
   ```
3. Проверьте версию Rust:
   ```powershell
   rustc --version  # Должна быть стабильная версия
   ```

### Проблема: Большой размер WASM файла

**Симптомы:**
- `hash_bg.wasm` весит > 5MB

**Решение:**
1. Используйте Release сборку:
   ```powershell
   .\build.ps1 -Configuration Release
   ```
2. Проверьте зависимости в `Cargo.toml` (уберите ненужные)
3. Используйте оптимизацию (если доступна):
   ```powershell
   # В будущем можно добавить wasm-opt оптимизацию
   ```

---

## 📚 Дополнительные ресурсы

- **README.md** — общая информация о проекте
- **ARCHITECTURE.md** — архитектура проекта
- **WASM_INTEGRATION.md** — детали работы с WASM
- **LOCALIZATION_GUIDE.md** — руководство по локализации
- **PROJECT_STRUCTURE.md** — структура проекта

---

## 💡 Советы по продуктивности

1. **Используйте горячие клавиши IDE**
   - `Ctrl+.` — быстрые действия в Visual Studio/VS Code
   - `F12` — переход к определению
   - `Shift+F12` — найти все использования

2. **Автоматизация**
   - Настройте pre-commit hook для проверки форматирования
   - Используйте `dotnet watch` для автоматической пересборки

3. **Отладка**
   - Используйте браузерные DevTools для JavaScript
   - Используйте `console.log` для быстрой отладки
   - Используйте breakpoints в IDE для C# кода

4. **Тестирование**
   - Пишите Rust тесты для WASM функций
   - Тестируйте в разных браузерах
   - Проверяйте локализацию для всех языков

---

**Последнее обновление:** 2024