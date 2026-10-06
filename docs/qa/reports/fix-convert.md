# Отчёт агента `fix-convert`

Дата: 2026-10-06, завершено 15:09 (UTC+6). Объект: `apps/site`, dev-сервер `http://localhost:3312/mydevtools/` (Chromium через Playwright).
Инструменты: color-converter, unit-converter, date-converter, ip-subnet-calculator, uuid-generator, lorem-ipsum-generator.
Основа: открытые пункты из `docs/qa/reports/convert.md`, правила SEO из `docs/qa/seo-guidelines.md`.

## A. Исправления

### A1. Плюрализация в lorem-ipsum («1 слов» → «1 слово»)

- `LoremIpsumGenerator.astro`: в клиентский остров добавлены `...pluralVariants(lang, ns)`. Подписи счётчиков вынесены в `data-li-words-label` / `data-li-chars-label`.
- `lorem-ipsum-generator.client.ts`: подпись выбирается через `formatPlural()` из `lib/format.ts`. Сам хелпер не менял.
- Локали, где нужны формы:
  - ru — `WordsStat_one/_few/_many`, `Characters_one/_few/_many` (слово/слова/слов, символ/символа/символов);
  - en, es, pt, fr — `_one`;
  - de — только `WordsStat_one` (Wort), потому что «Zeichen» не склоняется.
  - ja, zh, ko, hi форм не различают, там остаётся базовый ключ.
- Остальные 5 инструментов проверил: счётных строк с числом там нет. В ip значения стоят в ячейках таблицы, а не во фразе «N чего-то».
- Тест `test/lorem-ipsum.test.ts` («stats labels use locale plural forms»):
  - ru на 1/2/4/5/11/21/22/112/1001;
  - en, de, es, pt, fr;
  - для ja, zh, ko, hi — неизменная базовая подпись.
- Проверено в браузере: ru «1 слово / 2 слова / 5 слов / 21 слово», «33 символа»; en «1 word / 2 words»; fr «1 mot».

### A2. ip-subnet-calculator: ограничение «только private» и IPv6

**Ограничение на частные адреса.** Искусственного запрета не было: публичные IPv4 и раньше рассчитывались. «Ограничение» касалось только бейджа: Private ставился по RFC 1918, всё остальное считалось Public. Бейдж заменён классификацией по реестру IANA special-purpose:
- поле `scope` в Rust;
- значения: `private`, `shared` (100.64/10 CGNAT), `loopback`, `link-local`, `documentation` (TEST-NET-1/2/3), `multicast`, `reserved` (0/8, 240/4, 198.18/15, 192.0.0/24), `public`.

Поле `is_private` оставлено для совместимости.

**IPv6 реализован** (`wasm/ipcalc/src/ipv6.rs`, новый экспорт `calc_ipv6`):
- ввод: `addr/prefix` или голый адрес (считается /128); пробелы вокруг `/` допускаются; zone id (`%eth0`) отклоняется;
- результат:
  - адрес в сжатой (RFC 5952) и полной форме;
  - сеть и маска префикса;
  - first/last;
  - число адресов — десятичной строкой, потому что /0 = 2^128 не помещается в u128. На клиенте строка форматируется через `BigInt` + `Intl.NumberFormat` языка страницы;
  - `scope`: unspecified, loopback, ipv4-mapped, documentation (2001:db8::/32), link-local (fe80::/10), unique-local (fc00::/7), multicast, global (2000::/3), reserved.
- broadcast и «usable» для IPv6 не показываются: в IPv6 их нет, учитываются все адреса префикса.

**Клиентская часть:**
- `ipcalc-client.ts` получил `calcIpv6` и `isIpv6Input` (наличие `:`);
- `ip-subnet-calculator.client.ts` рендерит отдельную таблицу IPv6. Двоичный вид показывается только для IPv4;
- бейдж типа подкрашивается по классу: public/global — success, private/shared/unique-local — warning, остальные — нейтральный;
- новый пример `2001:db8:abcd:12::1/64`; placeholder `192.168.1.1/24 · 2001:db8::1/64`.

**Локали** (10 языков): `Expanded`, `FirstAddress`, `LastAddress`, `Addresses`, `Type`, `Scope_*` × 10. `Error_InvalidFormat` теперь упоминает IPv6.

**Rust-тесты:** 16 → 23, в том числе:
- /0, /1, /127, /128, все префиксы 1–128;
- префикс не по границе ниббла (/45);
- нормализация верхнего регистра и полной формы;
- все scope;
- ошибки: /129, `:::`, 9 групп, zone id, IPv4 на входе IPv6;
- IPv4 scope, включая публичную /20.

Bindings пересобраны под lock (`wasm/build.ps1 -Domains ipcalc`).

**Проверено в браузере (en, ru):**
- `2001:db8:abcd:12::1/64` → сеть `2001:db8:abcd:12::/64`, последний адрес `…:ffff:ffff:ffff:ffff`, 18 446 744 073 709 551 616 (2⁶⁴), «Документация»;
- `::/0` → 340 282 366 920 938 463 463 374 607 431 768 211 456;
- `100.64.1.1/10` → «Общий (CGNAT)»;
- `/129` → локализованная ошибка;
- консоль чистая, на 375px нет переполнения.

### A3. Прочие дефекты (из convert.md и найденные при проверке)

| Дефект | Что сделано |
| --- | --- |
| uuid: в режиме UPPERCASE префикс URN тоже становился заглавным (`URN:UUID:…`). Тест закреплял это как «поведение legacy» | Регистр теперь применяется только к hex, префикс остаётся каноническим `urn:uuid:` (RFC 9562). Тест `uuid.test.ts` обновлён: дополнительно проверяются фигурные скобки в верхнем регистре |
| date: формат «RFC 2822 / 5322» выдавал `… GMT`, то есть то же самое, что «UTC String». По RFC 5322 §3.3 `GMT` — устаревший синтаксис, генерировать его нельзя | Теперь выводится `Tue, 14 Nov 2023 22:13:20 +0000`. Тест `dates.test.ts` обновлён, добавлен round-trip через парсер |
| lorem: чекбокс «Обернуть абзацы тегами `<p>`» был активен везде, хотя влияет только на HTML-абзацы | Вне режима «HTML + абзацы» чекбокс становится `disabled` (приглушение даёт `ds-check-row:has(:disabled)`) |
| convert.md п. 3/4 (запросы к foundation: `ds-result-row-index`, `ds-color-well`) | Уже закрыто: в uuid используется `ds-result-row-index`, в color — `ds-color-well` |
| convert.md п. 1 (CJK «тофу») | Шрифты установлены; ja и hi проверены визуально, глифы на месте |
| convert.md п. 2 (ложные утверждения в SEO color/uuid про WASM и файлы) | Закрыто в части B |
| convert.md п. 5/6/7 | Закрыты в A1/A2 |

## B. SEO-тексты (6 инструментов × 10 языков)

Перед написанием прочитал код каждого инструмента (astro, client, pure-модули, `registry/tools.ts`):
- localStorage нет ни в одном из 6 инструментов → обещание «настройки сохраняются» убрано;
- файлового ввода нет → «обработка файлов» убрана;
- WASM есть только у ip → для color, uuid, unit, date, lorem явно написано «чистый JavaScript», а для ip — «WebAssembly из Rust, грузится при первом расчёте».

Переписаны `Description` и все `Seo_*`. `Keywords` обновлены у ip (добавлен IPv6). `Title` не трогал.

Тексты генерировались скриптом с подстановкой `{{Key}}`: названия кнопок и полей берутся из той же локали, поэтому в HowTo они совпадают с интерфейсом. Скрипт также проверял формат заголовков шагов (Step / Шаг / Paso / Schritt / Passo / 步骤N： / Étape N : / ステップ / N단계 / चरण).

| Инструмент | Суть текста | Примеры (каждый проверен в инструменте) |
| --- | --- | --- |
| color-converter | автоопределение HEX/rgb/hsl/cmyk, CSS4-синтаксис через пробел, alpha игнорируется; палитра из 9 оттенков (L 10–90%); 4 порога WCAG; CMYK без ICC; округление | `#3b82f6` → rgb/hsl/cmyk; `hsl(0,100%,50%)` и `cmyk(0%,100%,100%,0%)` → `#FF0000`; `#777777` на белом = `4.48:1` (AA large pass, AA normal fail); пара по умолчанию `10.36:1` |
| unit-converter | 31 единица, точные международные определения, температура со смещениями, абсолютный ноль, 10 значащих цифр и экспонента, разделитель по локали без группировки, быстрые и частые конверсии; галлоны США (не имперские), short ton | `1 mi = 1.609344 km` вместе со строкой формулы (`1 Мили × 1,609344 = …` в ru); `98.6 °F = 37 °C`; `1 gal = 3.78541 L`; `-40 °C = -40 °F`; `1E9` |
| date-converter | правило автоопределения (≤11 цифр — секунды), отрицательные и дробные значения, строгий режим Unix, 8 форматов вывода, токены своего шаблона, UTC и локальная зона, диапазон Date | `1700000000` → `2023-11-14T22:13:20.000Z`; ms определяются автоматически; `2024-02-29T12:00:00Z` → `1709208000`; `-86400` → `1969-12-31T00:00:00.000Z`; RFC → `… +0000` |
| ip-subnet-calculator | IPv4 (CIDR / маска / голый IP), классы, типы адресов, /31 и /32; IPv6 (сжатая и полная форма, first/last, точное число адресов, типы); WASM при первом расчёте; zone id и диапазоны не поддерживаются | `192.168.1.10/24`; `172.16.0.1 255.240.0.0` → /12 и 1 048 574; `10.0.0.1/31` → 2 адреса; IPv6 /64 → 2⁶⁴. В hi числа даны в индийской группировке (`10,48,574`), как их показывает Intl |
| uuid-generator | v4 (122 бита из Web Crypto), v7 (48-битный ms + 12-битный счётчик RFC 9562 §6.2 + 62 бита, строго монотонный), 4 формата, регистр только у hex, 1–100, TXT; без WASM | структура v4 (`…-4xxx-Yxxx-…`); v7 на `1700000000000` начинается с `018bcfe5-6800-7` (проверено через `randomUuidBytes`); фигурные скобки + верхний регистр; пакет из 100 строк в TXT |
| lorem-ipsum-generator | словарь ~160 латинских слов, предложения 5–15 слов, абзацы 3–7 предложений, ровное число слов, классическое начало, HTML `<p>` (только для HTML-абзацев), Markdown = абзацы через пустую строку, лимиты 1–1000, счётчики с тегами, случайный результат | слова=5 + classic → `lorem ipsum dolor sit amet` (проверено в en/ru/fr/ja); HTML-абзацы; предложения + classic; 50 абзацев |

## Проверка

- Тесты (все под `flock /tmp/mydevtools-tests.lock`, точечно):
  - `node --test` для `lorem-ipsum`, `uuid`, `dates`, `color`, `units`: **54/54 pass**;
  - `cargo test -p ipcalc`: **23/23 pass**.
- `npx astro check`: **0 errors, 0 warnings**.
- `npm run validate:i18n`: **0 ошибок**, 1 предупреждение (`de/uuid-generator Title` = «UUID/GUID Generator» — это нормальный термин, не перевод).
- Браузер, функциональная часть (`verify.mjs`): прогнаны все примеры из SEO в en (и выборочно в ru); вывод совпал с текстами. Проверены плюрализация lorem в ru/en/fr/ja, отключение чекбокса wrap, префикс URN в нижнем регистре при UPPERCASE.
- Браузер, sweep (`sweep.mjs`): 6 инструментов × en/ru/ja/hi × light/dark × 1440/375 = **96 комбинаций**. Горизонтального переполнения нет, ошибок консоли нет, сырых ключей и `{{` нет.
- JSON-LD HowTo (`ld.mjs`): в каждой из 60 страниц (6 × 10 языков) число шагов совпадает с текстом (color, unit, date, uuid — 4; ip, lorem — 3), названия шагов локализованы.
- Скриншоты: `/tmp/claude-1001/-home-lex-github-mydevtools/3051f920-6aff-44cf-91a3-0734cea3fd9a/scratchpad/fix-convert/shots/` (IPv6 ru light/dark 1440/375, страницы инструментов ru/ja/hi, SEO-блоки hi/ja). Скрипты лежат там же: `seo_*.py`, `seo_apply.py`, `verify.mjs`, `sweep.mjs`, `ld.mjs`, `ipcheck.mjs`.

## Открытые вопросы и запросы к общему слою

1. **ip, 375px:** длинные IPv6-адреса переносятся посреди группы (`…12::/` + `64`), потому что у таблицы `overflow-wrap: anywhere`. Переполнения нет, читаемо. Улучшение — вставить `<wbr>` после `:` или запретить перенос префикса. Это косметика, не делал.
2. **IPv6 вне объёма:** нет разбиения на подсети (например, «/48 → сколько /64»), reverse-DNS (ip6.arpa) и диапазонов `a-b`. Двоичное представление для IPv6 сознательно не показывается (128 бит). При необходимости — отдельная фича.
3. **lorem:** формат «Markdown» по выводу совпадает с «Обычным текстом» (абзацы через пустую строку — валидный Markdown; паритет с legacy). В SEO это описано честно. Если нужен «настоящий» Markdown (например, заголовки), это отдельная фича.
4. **date:** «UTC String» и «RFC» теперь различаются только зоной (`GMT` / `+0000`). Если владелец предпочитает legacy-вывод `GMT` в RFC, достаточно откатить одну строку в `dates.ts`.
5. **Сгенерированные bindings** `apps/site/src/generated/wasm/ipcalc/*` в `.gitignore`, их пересобирает пайплайн. Для Docker/Release нужна пересборка домена `ipcalc` (`-Domains ipcalc`), потому что в нём появились новый экспорт `calc_ipv6` и поле `scope`.
6. Общие файлы (`global.css`, `tool-ui.css`, `components/**`, `lib/**`, `common.json`, `home.json`) не трогал, запросов к ним нет.

## Изменённые файлы

- `wasm/ipcalc/src/{lib.rs,ipv4.rs}`, `wasm/ipcalc/src/ipv6.rs` (новый)
- `apps/site/src/scripts/wasm/ipcalc-client.ts`
- `apps/site/src/tools/{IpSubnetCalculator.astro,ip-subnet-calculator.client.ts}`
- `apps/site/src/tools/{LoremIpsumGenerator.astro,lorem-ipsum-generator.client.ts}`
- `apps/site/src/tools/{uuid.ts,dates.ts}`
- `apps/site/test/{lorem-ipsum,uuid,dates}.test.ts`
- `apps/site/src/i18n/locales/*/tools/{color-converter,unit-converter,date-converter,ip-subnet-calculator,uuid-generator,lorem-ipsum-generator}.json` (×10 языков)
- `docs/qa/reports/fix-convert.md` (этот отчёт)

Коммитов не делал.
