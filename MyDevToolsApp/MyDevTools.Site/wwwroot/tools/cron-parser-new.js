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
        '@reboot': null // Special case
    };

    // Month names
    const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const WEEKDAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

    // Get localized strings from data attributes
    function getLocalizedStrings(root) {
        if (!root) {
            // Fallback to English if root not found
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

    // Format template string with values
    function formatString(template, ...values) {
        return template.replace(/{(\d+)}/g, (match, number) => {
            return typeof values[number] !== 'undefined' ? values[number] : match;
        });
    }

    // Parse cron field and return array of values
    function parseCronField(field, min, max, names) {
        const values = [];
        
        // Handle names (MON, JAN, etc.)
        if (names) {
            names.forEach((name, idx) => {
                field = field.replace(new RegExp(name, 'gi'), String(idx));
            });
        }

        // Handle 'L' (last day of month) - special case
        if (field === 'L' && min === 1 && max === 31) {
            return ['L'];
        }

        // Handle '?' (no specific value)
        if (field === '?') {
            return ['?'];
        }

        const parts = field.split(',');
        
        for (const part of parts) {
            if (part.includes('/')) {
                // Step value: */5 or 1-10/2
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
                // Range: 1-5
                const [start, end] = part.split('-').map(Number);
                for (let i = start; i <= end; i++) {
                    values.push(i);
                }
            } else if (part === '*') {
                // All values
                for (let i = min; i <= max; i++) {
                    values.push(i);
                }
            } else {
                // Single value
                const val = parseInt(part, 10);
                if (!isNaN(val)) {
                    values.push(val);
                }
            }
        }
        
        return [...new Set(values)].sort((a, b) => a - b);
    }

    // Validate a cron expression
    function validateCron(expression) {
        // Check for presets
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

        // Validate each field
        const [minute, hour, day, month, weekday] = parts;
        
        try {
            parseCronField(minute, 0, 59);
            parseCronField(hour, 0, 23);
            parseCronField(day, 1, 31);
            parseCronField(month, 1, 12, MONTH_NAMES);
            parseCronField(weekday, 0, 6, WEEKDAY_NAMES);
        } catch (e) {
            return { valid: false, error: e.message };
        }

        return { valid: true, error: null };
    }

    // Generate human-readable description
    function getHumanReadable(expression, root) {
        const str = getLocalizedStrings(root);
        
        // Handle presets
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
        const monthVals = parseCronField(month, 1, 12, MONTH_NAMES);
        const weekdayVals = parseCronField(weekday, 0, 6, WEEKDAY_NAMES);

        // Build description
        let desc = [];

        // Minute description
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

        // Hour description
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

        // Day/Weekday description
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
            const dayNames = weekdayVals.map(v => WEEKDAY_NAMES[v]);
            if (dayNames.length === 1) {
                desc.push(formatString(str.scheduleOnWeekday, dayNames[0]));
            } else {
                desc.push(formatString(str.scheduleOnWeekdays, dayNames.join(', ')));
            }
        }

        // Month description
        if (month !== '*') {
            const monthNames = monthVals.map(v => MONTH_NAMES[v - 1]);
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

