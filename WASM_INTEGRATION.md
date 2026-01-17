# 🔗 Руководство по интеграции WASM

> Детальное руководство по работе с WebAssembly модулями в проекте

## 📋 Содержание

- [Обзор WASM интеграции](#обзор-wasm-интеграции)
- [Создание WASM модуля](#создание-wasm-модуля)
- [Интерфейсы и API](#интерфейсы-и-api)
- [Загрузка и использование](#загрузка-и-использование)
- [Оптимизация производительности](#оптимизация-производительности)
- [Обработка ошибок](#обработка-ошибок)
- [Тестирование](#тестирование)
- [Отладка](#отладка)

---

## 🎯 Обзор WASM интеграции

### Зачем WASM?

**Преимущества:**
- ⚡ Высокая производительность (близка к нативной)
- 🔐 Безопасность (изоляция в песочнице)
- 🌐 Кроссплатформенность
- 🦀 Rust — надежность и производительность

**Использование в проекте:**
- Хэширование (MD5, SHA, BLAKE, xxHash, ...)
- Кодирование/декодирование (Base64, Hex, URL)
- Обработка структурированных данных (JSON, XML, YAML)
- Криптография (в будущем)

### Технологический стек

- **Rust** — язык реализации
- **wasm-bindgen** — биндинги для JavaScript
- **cargo** — система сборки
- **wasm32-unknown-unknown** — целевая платформа

---

## 🆕 Создание WASM модуля

### Шаг 1: Создание структуры проекта

```powershell
# Из корня wasm/
cd wasm
cargo new my_new_domain --lib
```

### Шаг 2: Добавление в workspace

Откройте `wasm/Cargo.toml` и добавьте модуль:

```toml
[workspace]
resolver = "2"

members = [
  "hash",
  "encoding",
  "cryptography",
  "structured_data",
  "my_new_domain",  # новый модуль
]
```

### Шаг 3: Настройка Cargo.toml модуля

```toml
[package]
name = "mydevtools_my_new_domain"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]
# cdylib для WASM сборки
# rlib для нативных тестов

[dependencies]
wasm-bindgen = "0.2"
# Другие зависимости

[dev-dependencies]
# Тестовые зависимости
```

### Шаг 4: Реализация в src/lib.rs

```rust
use wasm_bindgen::prelude::*;

// Импорт JS типов (если нужно)
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

// One-shot функция
#[wasm_bindgen]
pub fn process_data(input: &str) -> String {
    // Ваша логика
    let result = format!("Processed: {}", input);
    log(&result);
    result
}

// Stateful структура (для streaming)
#[wasm_bindgen]
pub struct Processor {
    state: String,
}

#[wasm_bindgen]
impl Processor {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Processor {
        Processor {
            state: String::new(),
        }
    }
    
    #[wasm_bindgen]
    pub fn update(&mut self, data: &[u8]) {
        // Обработка chunk
        self.state.push_str(&format!("Chunk: {} bytes\n", data.len()));
    }
    
    #[wasm_bindgen]
    pub fn finalize(self) -> String {
        self.state
    }
}
```

### Шаг 5: Сборка модуля

```powershell
cd wasm
.\build.ps1 -Configuration Release -Domains @('my_new_domain')
```

**Результат:** Артефакты в `MyDevToolsApp/MyDevTools.Site/wwwroot/wasm/my_new_domain/`

---

## 🔌 Интерфейсы и API

### Типы данных

#### Rust → JavaScript

```rust
// Примитивы
pub fn get_string() -> String { "hello".to_string() }
pub fn get_number() -> i32 { 42 }
pub fn get_boolean() -> bool { true }

// Массивы
pub fn get_bytes() -> Vec<u8> { vec![1, 2, 3] }
pub fn get_strings() -> Vec<String> { vec!["a".to_string(), "b".to_string()] }

// Объекты (через wasm-bindgen)
#[wasm_bindgen]
pub struct Result {
    value: String,
    success: bool,
}

#[wasm_bindgen]
impl Result {
    #[wasm_bindgen(getter)]
    pub fn value(&self) -> String { self.value.clone() }
    
    #[wasm_bindgen(getter)]
    pub fn success(&self) -> bool { self.success }
}
```

#### JavaScript → Rust

```rust
// Примитивы
#[wasm_bindgen]
pub fn process_string(s: &str) -> String { /* ... */ }

#[wasm_bindgen]
pub fn process_number(n: i32) -> i32 { /* ... */ }

// Массивы
#[wasm_bindgen]
pub fn process_bytes(data: &[u8]) -> Vec<u8> { /* ... */ }

// Опциональные значения
#[wasm_bindgen]
pub fn process_optional(s: Option<String>) -> String {
    s.unwrap_or_else(|| "default".to_string())
}
```

### Паттерны API

#### 1. One-Shot функции

**Использование:** Простые операции без состояния.

```rust
#[wasm_bindgen]
pub fn hash_text_utf8(text: &str, algorithm: &str) -> String {
    // Простая функция
    match algorithm {
        "sha256" => sha256(text),
        "md5" => md5(text),
        _ => panic!("Unknown algorithm"),
    }
}
```

**JavaScript:**
```javascript
const hash = wasm.hash_text_utf8("hello", "sha256");
```

#### 2. Stateful структуры (для streaming)

**Использование:** Операции с большими данными, требующие состояния.

```rust
#[wasm_bindgen]
pub struct Hasher {
    hasher: Sha256,  // внутреннее состояние
}

#[wasm_bindgen]
impl Hasher {
    #[wasm_bindgen(constructor)]
    pub fn new(algorithm: &str) -> Hasher {
        Hasher {
            hasher: Sha256::new(),
        }
    }
    
    #[wasm_bindgen]
    pub fn update(&mut self, data: &[u8]) {
        self.hasher.update(data);
    }
    
    #[wasm_bindgen]
    pub fn finalize(self) -> String {
        format!("{:x}", self.hasher.finalize())
    }
}
```

**JavaScript:**
```javascript
const hasher = wasm.Hasher.new("sha256");
hasher.update(chunk1);
hasher.update(chunk2);
const hash = hasher.finalize();
```

#### 3. Обработка ошибок

**Вариант 1: Result с JS Error**
```rust
#[wasm_bindgen]
pub fn process_with_error(input: &str) -> Result<String, JsValue> {
    if input.is_empty() {
        return Err(JsValue::from_str("Input cannot be empty"));
    }
    Ok(format!("Processed: {}", input))
}
```

**JavaScript:**
```javascript
try {
    const result = wasm.process_with_error("hello");
    console.log(result);
} catch (error) {
    console.error("Error:", error);
}
```

**Вариант 2: Опциональные значения**
```rust
#[wasm_bindgen]
pub fn process_optional(input: &str) -> Option<String> {
    if input.is_empty() {
        None
    } else {
        Some(format!("Processed: {}", input))
    }
}
```

**JavaScript:**
```javascript
const result = wasm.process_optional("hello");
if (result !== null && result !== undefined) {
    console.log(result);
}
```

---

## 📥 Загрузка и использование

### Ленивая загрузка (Lazy Loading)

**Паттерн:** Загрузка модуля только при первом использовании.

```javascript
let wasmModulePromise = null;

async function getWasm() {
    if (!wasmModulePromise) {
        wasmModulePromise = import('/wasm/my_domain/my_domain.js').then(async (m) => {
            // Инициализация WASM
            await m.default();
            return m;
        });
    }
    return wasmModulePromise;
}

// Использование
async function processData(input) {
    const wasm = await getWasm();
    return wasm.process_data(input);
}
```

### Индикация загрузки

```javascript
let isLoading = false;

async function processWithLoading(input, onProgress) {
    if (isLoading) {
        onProgress({ type: 'loading', message: 'Loading WASM module...' });
    }
    
    isLoading = true;
    try {
        const wasm = await getWasm();
        isLoading = false;
        
        onProgress({ type: 'processing', message: 'Processing...' });
        const result = wasm.process_data(input);
        
        onProgress({ type: 'complete', result });
        return result;
    } catch (error) {
        isLoading = false;
        onProgress({ type: 'error', error: error.message });
        throw error;
    }
}
```

### Кеширование модулей

**Модули кешируются браузером**, но можно явно управлять:

```javascript
// Использование Map для кеширования нескольких модулей
const wasmModules = new Map();

async function getWasmModule(domain) {
    if (wasmModules.has(domain)) {
        return wasmModules.get(domain);
    }
    
    const promise = import(`/wasm/${domain}/${domain}.js`).then(async (m) => {
        await m.default();
        return m;
    });
    
    wasmModules.set(domain, promise);
    return promise;
}
```

---

## ⚡ Оптимизация производительности

### 1. Streaming для больших данных

**Проблема:** Загрузка всего файла в память может вызвать проблемы.

**Решение:** Обработка чанками.

```javascript
async function processLargeFile(file, onProgress) {
    const chunkSize = 1024 * 1024; // 1MB
    let offset = 0;
    
    // Создание stateful обработчика
    const processor = wasm.Processor.new();
    
    while (offset < file.size) {
        const chunk = file.slice(offset, offset + chunkSize);
        const buffer = await chunk.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        
        // Обработка chunk
        processor.update(bytes);
        
        offset += chunkSize;
        const progress = Math.min(100, (offset / file.size) * 100);
        onProgress(progress);
    }
    
    // Финализация
    return processor.finalize();
}
```

### 2. Minimize allocations

**Rust:**
```rust
// ❌ Плохо: лишние аллокации
pub fn process_bad(data: Vec<u8>) -> Vec<u8> {
    let mut result = Vec::new();
    for byte in data {
        result.push(byte + 1);
    }
    result
}

// ✅ Хорошо: предварительное выделение памяти
pub fn process_good(data: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(data.len());
    for &byte in data {
        result.push(byte + 1);
    }
    result
}
```

### 3. Release сборка

**Всегда используйте Release сборку для production:**

```powershell
.\build.ps1 -Configuration Release
```

**Разница:**
- Debug: ~10-50MB, медленнее
- Release: ~1-5MB, быстрее

### 4. Оптимизация wasm-bindgen

```rust
// Используйте #[wasm_bindgen(skip)] для внутренних типов
#[wasm_bindgen]
pub struct PublicApi {
    #[wasm_bindgen(skip)]
    internal_data: InternalType,  // не экспортируется
}

// Используйте &str вместо String где возможно
#[wasm_bindgen]
pub fn process_string(s: &str) -> String {  // &str копируется один раз
    // ...
}
```

---

## 🚨 Обработка ошибок

### Обработка ошибок загрузки

```javascript
async function loadWasmSafely() {
    try {
        const wasm = await getWasm();
        return { success: true, module: wasm };
    } catch (error) {
        console.error('Failed to load WASM:', error);
        
        // Fallback на JS реализацию (если есть)
        if (window.jsFallback) {
            return { success: true, fallback: true, module: window.jsFallback };
        }
        
        return { success: false, error: error.message };
    }
}
```

### Обработка ошибок выполнения

```javascript
async function processWithErrorHandling(input) {
    try {
        const wasm = await getWasm();
        const result = wasm.process_data(input);
        return { success: true, result };
    } catch (error) {
        // Различение типов ошибок
        if (error instanceof TypeError) {
            return { success: false, error: 'Invalid input type' };
        } else if (error.message.includes('memory')) {
            return { success: false, error: 'Out of memory' };
        } else {
            return { success: false, error: error.message };
        }
    }
}
```

### Проверка поддержки WASM

```javascript
if (!('WebAssembly' in window)) {
    console.warn('WebAssembly is not supported');
    // Fallback на JS реализацию
}
```

---

## 🧪 Тестирование

### Нативные Rust тесты

**Файл:** `wasm/my_domain/src/lib.rs`

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_process_data() {
        let result = process_data("test");
        assert_eq!(result, "Processed: test");
    }
    
    #[test]
    fn test_processor_streaming() {
        let mut processor = Processor::new();
        processor.update(b"chunk1");
        processor.update(b"chunk2");
        let result = processor.finalize();
        assert!(result.contains("chunk1"));
        assert!(result.contains("chunk2"));
    }
}
```

**Запуск:**
```powershell
cd wasm/my_domain
cargo test
```

### Тесты с векторами

```rust
#[test]
fn test_hash_vectors() {
    let vectors = vec![
        ("", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
        ("hello", "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"),
    ];
    
    for (input, expected) in vectors {
        let result = hash_text_utf8(input, "sha256");
        assert_eq!(result, expected, "Failed for input: {}", input);
    }
}
```

### JavaScript тесты (будущее)

Для тестирования в браузере можно использовать `wasm-bindgen-test`:

```rust
use wasm_bindgen_test::*;

wasm_bindgen_test_configure!(run_in_browser);

#[wasm_bindgen_test]
fn test_in_browser() {
    let result = process_data("test");
    assert_eq!(result, "Processed: test");
}
```

---

## 🐛 Отладка

### Отладка Rust кода

**1. Логирование:**
```rust
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
    
    #[wasm_bindgen(js_namespace = console)]
    fn error(s: &str);
}

pub fn process_data(input: &str) -> String {
    log(&format!("Processing: {}", input));
    // ...
}
```

**2. Отладочная сборка:**
```powershell
.\build.ps1 -Configuration Debug
```

**3. Инспекция в браузере:**
```javascript
// В DevTools Console
const wasm = await getWasm();
console.log(wasm);  // Инспекция экспортированных функций
```

### Измерение производительности

```javascript
async function benchmark(iterations) {
    const wasm = await getWasm();
    
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
        wasm.process_data("test");
    }
    const end = performance.now();
    
    console.log(`Average: ${(end - start) / iterations}ms`);
}
```

### Проверка размера модуля

```powershell
Get-Item MyDevToolsApp\MyDevTools.Site\wwwroot\wasm\my_domain\my_domain_bg.wasm | 
    Select-Object Name, @{Name="Size (KB)";Expression={[math]::Round($_.Length/1KB, 2)}}
```

---

## 📚 Дополнительные ресурсы

- **wasm-bindgen документация**: https://rustwasm.github.io/wasm-bindgen/
- **Rust WASM Book**: https://rustwasm.github.io/docs/book/
- **wasm-pack**: https://rustwasm.github.io/wasm-pack/ (альтернатива)
- **MDN WebAssembly**: https://developer.mozilla.org/en-US/docs/WebAssembly

---

**См. также:**
- `DEVELOPMENT.md` — практические инструкции
- `ARCHITECTURE.md` — архитектура проекта