# ?? Добавление переводов в проект

## Текущая ситуация

Файлы локализации созданы:
- ? `AppStrings.resx` — английский (заполнен)
- ?? `AppStrings.ru.resx` — русский (пустой)
- ?? `AppStrings.es.resx` — испанский (пустой)

## Как добавить переводы

### Вариант 1: Через Visual Studio (рекомендуется)

1. Откройте файл `MyDevTools.Site\Resources\AppStrings.ru.resx` в Visual Studio
2. Для каждой строки из `AppStrings.resx` добавьте перевод:

| Name (ключ) | Value (перевод на русский) |
|-------------|---------------------------|
| `AppName` | `MyDevTools` |
| `AppTagline` | `Инструменты для разработчиков с приоритетом конфиденциальности, все данные остаются в вашем браузере` |
| `Nav_Home` | `Главная` |
| `Nav_Tools` | `Инструменты` |
| `Home_Title` | `Инструменты для разработчиков` |
| `Home_Subtitle` | `Инструменты для разработчиков с приоритетом конфиденциальности. Вся обработка происходит в вашем браузере.` |
| `Home_NoDataSent` | `Никакие данные не отправляются на сервер` |
| `HashCalculator_Title` | `Калькулятор хэшей` |
| `HashCalculator_Description` | `Вычисление MD5, SHA-1, SHA-256, SHA-512 хэшей из текста или файлов` |
| `HashCalculator_InputLabel` | `Входной текст` |
| `HashCalculator_InputPlaceholder` | `Введите текст для хэширования...` |
| `HashCalculator_Calculate` | `Вычислить` |
| `HashCalculator_Clear` | `Очистить` |
| `HashCalculator_Copy` | `Копировать` |
| `HashCalculator_Copied` | `Скопировано!` |
| `Common_Input` | `Ввод` |
| `Common_Output` | `Вывод` |
| `Common_Loading` | `Загрузка...` |
| `Common_Error` | `Ошибка` |
| `Theme_Light` | `Светлая` |
| `Theme_Dark` | `Тёмная` |
| `Theme_Toggle` | `Переключить тему` |

### Вариант 2: Ручное редактирование XML

Если вы хотите отредактировать XML напрямую, вот пример структуры:

```xml
<data name="AppName" xml:space="preserve">
  <value>MyDevTools</value>
</data>
<data name="AppTagline" xml:space="preserve">
  <value>Инструменты для разработчиков с приоритетом конфиденциальности</value>
</data>
```

?? **Важно**: Сохраняйте файл в кодировке **UTF-8 with BOM**!

В Visual Studio:
- File ? Advanced Save Options ? выберите `UTF-8 with signature`

## Испанский перевод

Аналогично для `AppStrings.es.resx`:

| Name | Value (espa?ol) |
|------|----------------|
| `AppName` | `MyDevTools` |
| `AppTagline` | `Herramientas para desarrolladores que priorizan la privacidad` |
| `Nav_Home` | `Inicio` |
| `Nav_Tools` | `Herramientas` |
| `HashCalculator_Title` | `Calculadora de Hash` |
| `HashCalculator_Calculate` | `Calcular` |
| и т.д. |

## Проверка

После добавления переводов:

1. Пересоберите проект:
   ```bash
   dotnet build
   ```

2. Запустите:
   ```bash
   dotnet run
   ```

3. Проверьте страницы:
   - `/en/hash-calculator` — английский
   - `/ru/hash-calculator` — русский
   - `/es/hash-calculator` — испанский

---

## ? Что исправлено

1. **Убран WebSocket** - теперь только SSR + JavaScript
2. **Клиентские вычисления** - хэши считаются в браузере через Web Crypto API
3. **Готово к WASM** - JavaScript легко заменить на вызовы WASM
4. **Никаких данных на сервер** - всё остаётся в браузере

## ?? TODO для WASM интеграции

Когда будет готов Rust WASM модуль:

1. Загрузить `.wasm` файл
2. Заменить `computeHash()` на вызов WASM функции
3. MD5 также будет работать (сейчас заглушка)
