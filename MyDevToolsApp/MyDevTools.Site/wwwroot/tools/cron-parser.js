/* global document, window, navigator */

(function () {
    const initializedRoots = new WeakSet();

    // Cron presets
    const PRESETS = {
        '@yearly': '0 0 1 1 *',
        '@annually': '0 0 1 1 *',
        '@monthly': '0 0 1 * *',
        '@weekly': '0 0 * * 0',
        '@daily': '0 0 * * *',
        '@midnight': '0 0 * * *',
        '@hourly': '0 * * * *',
        '@reboot': null
    };

    const DEFAULT_MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const DEFAULT_WEEKDAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

    function getMonthNames(root) {
        if (!root || !root.dataset || !root.dataset.months) {
            return DEFAULT_MONTH_NAMES;
        }
        return root.dataset.months.split(',');
    }

    function getWeekdayNames(root) {
        if (!root || !root.dataset || !root.dataset.weekdays) {
            return DEFAULT_WEEKDAY_NAMES;
        }
        return root.dataset.weekdays.split(',');
    }

    function getLocalizedStrings(root) {
        if (!root) {
            return {
                scheduleReboot: 'Runs when system restarts',
                scheduleYearly: 'Once a year at midnight on January 1st',
                scheduleMonthly: 'Once a month at midnight on the first day',
                scheduleWeekly: 'Once a week at midnight on Sunday',
                scheduleDaily: 'Every day at midnight',
                scheduleHourly: 'Every hour at the beginning of the hour',
                scheduleEveryMinute: 'Every minute',
                scheduleEveryNMinutes: 'Every {0} minutes',
                scheduleAtMinute: 'At minute {0}',
                scheduleAtMinutes: 'At minutes {0}',
                scheduleEveryHour: 'of every hour',
                scheduleEveryNHours: 'every {0} hours',
                scheduleAtHour: 'at hour {0}',
                scheduleAtHours: 'at hours {0}',
                scheduleEveryDay: 'every day',
                scheduleOnDay: 'on day {0} of the month',
                scheduleOnDays: 'on days {0}',
                scheduleLastDay: 'on the last day of the month',
                scheduleOnWeekday: 'on {0}',
                scheduleOnWeekdays: 'on {0}',
                scheduleInMonth: 'in {0}',
                scheduleInMonths: 'in {0}'
            };
        }
        return {
            scheduleReboot: root.dataset.scheduleReboot || 'Runs when system restarts',
            scheduleYearly: root.dataset.scheduleYearly || 'Once a year at midnight on January 1st',
            scheduleMonthly: root.dataset.scheduleMonthly || 'Once a month at midnight on the first day',
            scheduleWeekly: root.dataset.scheduleWeekly || 'Once a week at midnight on Sunday',
            scheduleDaily: root.dataset.scheduleDaily || 'Every day at midnight',
            scheduleHourly: root.dataset.scheduleHourly || 'Every hour at the beginning of the hour',
            scheduleEveryMinute: root.dataset.scheduleEveryMinute || 'Every minute',
            scheduleEveryNMinutes: root.dataset.scheduleEveryNMinutes || 'Every {0} minutes',
            scheduleAtMinute: root.dataset.scheduleAtMinute || 'At minute {0}',
            scheduleAtMinutes: root.dataset.scheduleAtMinutes || 'At minutes {0}',
            scheduleEveryHour: root.dataset.scheduleEveryHour || 'of every hour',
            scheduleEveryNHours: root.dataset.scheduleEveryNHours || 'every {0} hours',
            scheduleAtHour: root.dataset.scheduleAtHour || 'at hour {0}',
            scheduleAtHours: root.dataset.scheduleAtHours || 'at hours {0}',
            scheduleEveryDay: root.dataset.scheduleEveryDay || 'every day',
            scheduleOnDay: root.dataset.scheduleOnDay || 'on day {0} of the month',
            scheduleOnDays: root.dataset.scheduleOnDays || 'on days {0}',
            scheduleLastDay: root.dataset.scheduleLastDay || 'on the last day of the month',
            scheduleOnWeekday: root.dataset.scheduleOnWeekday || 'on {0}',
            scheduleOnWeekdays: root.dataset.scheduleOnWeekdays || 'on {0}',
            scheduleInMonth: root.dataset.scheduleInMonth || 'in {0}',
            scheduleInMonths: root.dataset.scheduleInMonths || 'in {0}'
        };
    }

    function formatString(template, ...values) {
        return template.replace(/{(\d+)}/g, (match, number) => {
            return typeof values[number] !== 'undefined' ? values[number] : match;
        });
    }

    function parseCronField(field, min, max, names) {
        const values = [];
        
        if (names) {
            names.forEach((name, idx) => {
                field = field.replace(new RegExp(name, 'gi'), String(idx));
            });
        }

        if (field === 'L' && min === 1 && max === 31) {
            return ['L'];
        }

        if (field === '?') {
            return ['?'];
        }

        const parts = field.split(',');
        
        for (const part of parts) {
            if (part.includes('/')) {
                const [range, step] = part.split('/');
                const stepVal = parseInt(step, 10);
                let start, end;
                
                if (range === '*') {
                    start = min;
                    end = max;
                } else if (range.includes('-')) {
                    [start, end] = range.split('-').map(Number);
                } else {
                    start = parseInt(range, 10);
                    end = max;
                }
                
                for (let i = start; i <= end; i += stepVal) {
                    values.push(i);
                }
            } else if (part.includes('-')) {
                const [start, end] = part.split('-').map(Number);
                for (let i = start; i <= end; i++) {
                    values.push(i);
                }
            } else if (part === '*') {
                for (let i = min; i <= max; i++) {
                    values.push(i);
                }
            } else {
                const val = parseInt(part, 10);
                if (!isNaN(val)) {
                    values.push(val);
                }
            }
        }
        
        return [...new Set(values)].sort((a, b) => a - b);
    }

    function validateCron(expression, root) {
        if (expression.startsWith('@')) {
            if (expression === '@reboot') {
                return { valid: true, error: null };
            }
            if (PRESETS[expression]) {
                return { valid: true, error: null };
            }
            return { valid: false, error: 'Unknown preset' };
        }

        const parts = expression.trim().split(/\s+/);
        if (parts.length !== 5) {
            return { valid: false, error: `Expected 5 fields, got ${parts.length}` };
        }

        const [minute, hour, day, month, weekday] = parts;

        try {
            parseCronField(minute, 0, 59);
            parseCronField(hour, 0, 23);
            parseCronField(day, 1, 31);
            parseCronField(month, 1, 12, getMonthNames(root));
            parseCronField(weekday, 0, 6, getWeekdayNames(root));
        } catch (e) {
            return { valid: false, error: e.message };
        }

        return { valid: true, error: null };
    }

    function getHumanReadable(expression, root) {
        const str = getLocalizedStrings(root);
        
        if (expression.startsWith('@')) {
            const presetDesc = {
                '@yearly': str.scheduleYearly,
                '@annually': str.scheduleYearly,
                '@monthly': str.scheduleMonthly,
                '@weekly': str.scheduleWeekly,
                '@daily': str.scheduleDaily,
                '@midnight': str.scheduleDaily,
                '@hourly': str.scheduleHourly,
                '@reboot': str.scheduleReboot
            };
            return presetDesc[expression] || 'Unknown preset';
        }

        const parts = expression.trim().split(/\s+/);
        if (parts.length !== 5) return 'Invalid expression';

        const [minute, hour, day, month, weekday] = parts;

        const minuteVals = parseCronField(minute, 0, 59);
        const hourVals = parseCronField(hour, 0, 23);
        const dayVals = parseCronField(day, 1, 31);
        const monthVals = parseCronField(month, 1, 12, getMonthNames(root));
        const weekdayVals = parseCronField(weekday, 0, 6, getWeekdayNames(root));

        let desc = [];

        if (minute === '*') {
            desc.push(str.scheduleEveryMinute);
        } else if (minute.includes('*/')) {
            const step = minute.split('/')[1];
            desc.push(formatString(str.scheduleEveryNMinutes, step));
        } else if (minuteVals.length === 1) {
            desc.push(formatString(str.scheduleAtMinute, minuteVals[0]));
        } else {
            desc.push(formatString(str.scheduleAtMinutes, minuteVals.slice(0, 5).join(', ') + (minuteVals.length > 5 ? '...' : '')));
        }

        if (hour === '*') {
            desc.push(str.scheduleEveryHour);
        } else if (hour.includes('*/')) {
            const step = hour.split('/')[1];
            desc.push(formatString(str.scheduleEveryNHours, step));
        } else if (hourVals.length === 1) {
            desc.push(formatString(str.scheduleAtHour, hourVals[0]));
        } else {
            desc.push(formatString(str.scheduleAtHours, hourVals.slice(0, 5).join(', ') + (hourVals.length > 5 ? '...' : '')));
        }

        if (day === '*' && weekday === '*') {
            desc.push(str.scheduleEveryDay);
        } else if (day !== '*' && day !== '?' && dayVals.length > 0) {
            if (dayVals.length === 1 && dayVals[0] !== 'L') {
                desc.push(formatString(str.scheduleOnDay, dayVals[0]));
            } else if (dayVals[0] === 'L') {
                desc.push(str.scheduleLastDay);
            } else {
                desc.push(formatString(str.scheduleOnDays, dayVals.slice(0, 5).join(', ') + (dayVals.length > 5 ? '...' : '')));
            }
        } else if (weekday !== '*' && weekday !== '?' && weekdayVals.length > 0) {
            const weekdayNames = getWeekdayNames(root);
            const dayNames = weekdayVals.map(v => weekdayNames[v]);
            if (dayNames.length === 1) {
                desc.push(formatString(str.scheduleOnWeekday, dayNames[0]));
            } else {
                desc.push(formatString(str.scheduleOnWeekdays, dayNames.join(', ')));
            }
        }

        if (month !== '*') {
            const monthNamesList = getMonthNames(root);
            const monthNames = monthVals.map(v => monthNamesList[v - 1]);
            if (monthNames.length === 1) {
                desc.push(formatString(str.scheduleInMonth, monthNames[0]));
            } else if (monthNames.length === 12) {
                // All months - no need to mention
            } else {
                desc.push(formatString(str.scheduleInMonths, monthNames.slice(0, 5).join(', ') + (monthNames.length > 5 ? '...' : '')));
            }
        }

        return desc.join(' ').replace(/of every hour every/g, 'every').replace(/at hour every/g, 'every');
    }

    // OPTIMIZED: Parse fields once outside loop, use adaptive step size
    function getNextExecutions(expression, count = 5, root) {
        if (expression === '@reboot') {
            return ['Runs when system restarts'];
        }

        if (expression.startsWith('@') && PRESETS[expression]) {
            expression = PRESETS[expression];
        }

        const parts = expression.trim().split(/\s+/);
        if (parts.length !== 5) return [];

        const [minuteField, hourField, dayField, monthField, weekdayField] = parts;

        // KEY OPTIMIZATION: Parse fields once outside the loop
        const minuteVals = parseCronField(minuteField, 0, 59);
        const hourVals = parseCronField(hourField, 0, 23);
        const dayVals = parseCronField(dayField, 1, 31);
        const monthVals = parseCronField(monthField, 1, 12, getMonthNames(root));
        const weekdayVals = parseCronField(weekdayField, 0, 6, getWeekdayNames(root));
        
        const now = new Date();
        const executions = [];
        
        // Adaptive step size based on specificity
        let stepMinutes = 1;
        if (minuteField !== '*') {
            stepMinutes = 60; // If minute is fixed, check hourly
        }
        if (hourField !== '*' && !hourField.includes('/') && !hourField.includes(',')) {
            stepMinutes = 24 * 60; // If hour is fixed too, check daily
        }
        if (dayField !== '*' && dayField !== '?' && dayField !== 'L' && 
            !dayField.includes('/') && !dayField.includes(',')) {
            stepMinutes = 31 * 24 * 60; // If day is fixed too, check monthly
        }
        
        let checkDate = new Date(now);
        checkDate.setSeconds(0, 0);
        
        const maxAttempts = 100000;
        const maxTimeMs = 100;
        const startTime = Date.now();
        
        for (let attempts = 0; attempts < maxAttempts && executions.length < count; attempts++) {
            if (Date.now() - startTime > maxTimeMs) break;

            const matchesMinute = minuteVals.includes(checkDate.getMinutes());
            const matchesHour = hourVals.includes(checkDate.getHours());
            const matchesMonth = monthVals.includes(checkDate.getMonth() + 1);
            const matchesWeekday = weekdayVals.includes(checkDate.getDay());
            
            let matchesDay = false;
            if (dayField === 'L') {
                const lastDay = new Date(checkDate.getFullYear(), checkDate.getMonth() + 1, 0).getDate();
                matchesDay = checkDate.getDate() === lastDay;
            } else {
                matchesDay = dayVals.includes(checkDate.getDate());
            }

            if (matchesMinute && matchesHour && matchesDay && matchesMonth && matchesWeekday) {
                if (checkDate > now) {
                    executions.push(new Date(checkDate));
                }
            }

            checkDate.setMinutes(checkDate.getMinutes() + stepMinutes);
        }

        return executions;
    }

    function formatDate(date) {
        return date.toLocaleString('en-US', {
            weekday: 'short',
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function getParserElements() {
        const root = document.getElementById('cron-parser-root');
        if (!root) return null;

        return {
            root,
            input: document.getElementById('cron-input'),
            humanReadable: document.getElementById('cron-human-readable'),
            nextExecutions: document.getElementById('cron-next-executions'),
            error: document.getElementById('cron-error'),
            parts: {
                minute: document.getElementById('cron-part-minute'),
                hour: document.getElementById('cron-part-hour'),
                day: document.getElementById('cron-part-day'),
                month: document.getElementById('cron-part-month'),
                weekday: document.getElementById('cron-part-weekday')
            }
        };
    }

    function getGeneratorElements() {
        const root = document.getElementById('cron-parser-root');
        if (!root) return null;

        return {
            root,
            minute: document.getElementById('cron-gen-minute'),
            hour: document.getElementById('cron-gen-hour'),
            day: document.getElementById('cron-gen-day'),
            month: document.getElementById('cron-gen-month'),
            weekday: document.getElementById('cron-gen-weekday'),
            output: document.getElementById('cron-generated'),
            description: document.getElementById('cron-gen-description'),
            nextExecutions: document.getElementById('cron-gen-next-executions'),
            error: document.getElementById('cron-gen-error')
        };
    }

    function setError(errorEl, msg) {
        if (!errorEl) return;
        if (msg) {
            errorEl.textContent = msg;
            errorEl.classList.remove('hidden');
        } else {
            errorEl.classList.add('hidden');
        }
    }

    function parseAction() {
        const els = getParserElements();
        if (!els) return;

        const expression = els.input.value.trim();
        if (!expression) {
            setError(els.error, '');
            return;
        }

        const validation = validateCron(expression, els.root);
        if (!validation.valid) {
            setError(els.error, `Invalid expression: ${validation.error}`);
            els.humanReadable.textContent = '';
            els.nextExecutions.innerHTML = '';
            return;
        }

        setError(els.error, '');

        els.humanReadable.textContent = getHumanReadable(expression, els.root);

        let parts = expression;
        if (expression.startsWith('@') && PRESETS[expression]) {
            parts = PRESETS[expression];
        }
        const [m, h, d, mo, w] = parts.split(/\s+/);
        if (els.parts.minute) els.parts.minute.textContent = m || '*';
        if (els.parts.hour) els.parts.hour.textContent = h || '*';
        if (els.parts.day) els.parts.day.textContent = d || '*';
        if (els.parts.month) els.parts.month.textContent = mo || '*';
        if (els.parts.weekday) els.parts.weekday.textContent = w || '*';

        const nextExecs = getNextExecutions(expression, 5, els.root);
        els.nextExecutions.innerHTML = nextExecs.map((date, idx) => {
            if (typeof date === 'string') {
                return `<div class="p-2 bg-base-100 rounded text-sm">${date}</div>`;
            }
            return `<div class="p-2 bg-base-100 rounded text-sm font-mono">${idx + 1}. ${formatDate(date)}</div>`;
        }).join('');
    }

    function generateAction() {
        const els = getGeneratorElements();
        if (!els) return;

        const minute = els.minute.value.trim() || '*';
        const hour = els.hour.value.trim() || '*';
        const day = els.day.value.trim() || '*';
        const month = els.month.value.trim() || '*';
        const weekday = els.weekday.value.trim() || '*';

        const expression = `${minute} ${hour} ${day} ${month} ${weekday}`;

        const validation = validateCron(expression, els.root);
        if (!validation.valid) {
            setError(els.error, `Invalid expression: ${validation.error}`);
            els.output.value = '';
            els.description.textContent = '';
            els.nextExecutions.innerHTML = '';
            return;
        }

        setError(els.error, '');

        els.output.value = expression;
        els.description.textContent = getHumanReadable(expression, els.root);

        const nextExecs = getNextExecutions(expression, 5, els.root);
        els.nextExecutions.innerHTML = nextExecs.map((date, idx) => {
            if (typeof date === 'string') {
                return `<div class="p-2 bg-base-100 rounded text-sm">${date}</div>`;
            }
            return `<div class="p-2 bg-base-100 rounded text-sm font-mono">${idx + 1}. ${formatDate(date)}</div>`;
        }).join('');
    }

    function clearAction() {
        const els = getParserElements();
        if (!els) return;

        els.input.value = '';
        els.humanReadable.textContent = 'Enter a cron expression to see the description';
        els.nextExecutions.innerHTML = '';
        setError(els.error, '');
        
        if (els.parts.minute) els.parts.minute.textContent = '*';
        if (els.parts.hour) els.parts.hour.textContent = '*';
        if (els.parts.day) els.parts.day.textContent = '*';
        if (els.parts.month) els.parts.month.textContent = '*';
        if (els.parts.weekday) els.parts.weekday.textContent = '*';
    }

    function copyAction(btn) {
        const els = getGeneratorElements();
        if (!els) return;

        const text = els.output.value;
        if (!text) return;

        navigator.clipboard.writeText(text).then(() => {
            const originalHTML = btn.innerHTML;
            btn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5 text-success">
                    <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                </svg>
            `;
            setTimeout(() => {
                btn.innerHTML = originalHTML;
            }, 1500);
        });
    }

    function switchTab(tabName) {
        const parserPanel = document.getElementById('cron-parser-panel');
        const generatorPanel = document.getElementById('cron-generator-panel');
        const parserTab = document.getElementById('cron-tab-parser');
        const generatorTab = document.getElementById('cron-tab-generator');

        if (tabName === 'parser') {
            parserPanel.classList.remove('hidden');
            generatorPanel.classList.add('hidden');
            parserTab.classList.add('tab-active');
            generatorTab.classList.remove('tab-active');
        } else {
            parserPanel.classList.add('hidden');
            generatorPanel.classList.remove('hidden');
            parserTab.classList.remove('tab-active');
            generatorTab.classList.add('tab-active');
        }
    }

    function applyPreset(preset) {
        const els = getParserElements();
        if (!els) return;

        els.input.value = preset;
        parseAction();
    }

    function bindDelegatedHandlersOnce() {
        if (window.__mydevtools_cron_parser_bound) return;
        window.__mydevtools_cron_parser_bound = true;

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            if (!(target instanceof HTMLElement)) return;

            const parserTab = target.closest('#cron-tab-parser');
            if (parserTab) {
                switchTab('parser');
                return;
            }

            const generatorTab = target.closest('#cron-tab-generator');
            if (generatorTab) {
                switchTab('generator');
                return;
            }

            const presetBtn = target.closest('[data-preset]');
            if (presetBtn) {
                applyPreset(presetBtn.dataset.preset);
                return;
            }

            const parseBtn = target.closest('#cron-parse-btn');
            if (parseBtn) {
                parseAction();
                return;
            }

            const clearBtn = target.closest('#cron-clear-btn');
            if (clearBtn) {
                clearAction();
                return;
            }

            const generateBtn = target.closest('#cron-generate-btn');
            if (generateBtn) {
                generateAction();
                return;
            }

            const copyBtn = target.closest('#cron-copy-generated-btn');
            if (copyBtn) {
                copyAction(copyBtn);
                return;
            }
        });

        document.addEventListener('input', (ev) => {
            const target = ev.target;
            if (target.id === 'cron-input') {
                clearTimeout(window._cronParseTimeout);
                window._cronParseTimeout = setTimeout(parseAction, 300);
            }
        });

        document.addEventListener('keypress', (ev) => {
            if (ev.target.id === 'cron-input' && ev.key === 'Enter') {
                parseAction();
            }
        });
    }

    function init() {
        const root = document.getElementById('cron-parser-root');
        if (!root || initializedRoots.has(root)) return;
        initializedRoots.add(root);

        const input = document.getElementById('cron-input');
        if (input && input.value) {
            parseAction();
        }
    }

    bindDelegatedHandlersOnce();

    document.addEventListener('DOMContentLoaded', init);
    document.addEventListener('enhancedload', init);

})();
