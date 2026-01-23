import init, { test_regex } from '/wasm/regex_tool/regex_tool.js';

// Global state to track initialization
let wasmInitialized = false;

const COMMON_REGEXES = [
    { name: "Email", pattern: "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$", sample: "Valid: user@example.com\nInvalid: user@.com @example.com" },
    { name: "Date (ISO)", pattern: "^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$", sample: "2024-05-20\n2024-13-01 (invalid month)" },
    { name: "URL", pattern: "https?:\\/\\/(www\\.)?[-a-zA-Z0-9@:%._\\+~#=]{1,256}\\.[a-zA-Z0-9()]{1,6}\\b([-a-zA-Z0-9()@:%_\\+.~#?&//=]*)", sample: "Visit https://google.com or http://localhost:8080" },
    { name: "IPv4", pattern: "^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$", sample: "192.168.1.1\n999.999.999.999" },
    { name: "Hex Color", pattern: "^#?([a-fA-F0-9]{6}|[a-fA-F0-9]{3})$", sample: "#ff0000\n#0f0\ninvalid" }
];

async function ensureWasm() {
    if (!wasmInitialized) {
        await init();
        wasmInitialized = true;
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function getElements() {
    const root = document.getElementById('regex-tester-root');
    if (!root) return null;

    return {
        root,
        patternInput: document.getElementById('regex-pattern'),
        textInput: document.getElementById('regex-text'),
        resultsContainer: document.getElementById('regex-results'),
        matchCountBadge: document.getElementById('match-count'),
        examplesList: document.getElementById('regex-examples'),
        flags: Array.from(document.querySelectorAll('.regex-flag'))
    };
}

// Logic to run the test
async function runTest() {
    const els = getElements();
    if (!els) return;

    const pattern = els.patternInput.value;
    const text = els.textInput.value;

    // Collect flags
    let flagsStr = "";
    els.flags.forEach(cb => {
        if (cb.checked) flagsStr += cb.value;
    });

    if (!pattern) return;

    const loadingText = els.root.dataset.loading;
    const errorText = els.root.dataset.error;
    const noMatchesText = els.root.dataset.noMatches;

    try {
        await ensureWasm();

        let fullPattern = pattern;
        if (flagsStr) {
            fullPattern = `(?${flagsStr})${pattern}`;
        }

        const result = test_regex(fullPattern, text);

        if (result.error) {
            els.resultsContainer.innerHTML = `<div class="alert alert-danger">${escapeHtml(result.error)}</div>`;
            els.matchCountBadge.textContent = "Error";
            return;
        }

        renderResults(els, text, result.matches, noMatchesText);

    } catch (e) {
        console.error(e);
        els.resultsContainer.innerHTML = `<div class="alert alert-danger">${errorText}: ${e.message}</div>`;
    }
}

function renderResults(els, originalText, matches, noMatchesText) {
    if (!matches || matches.length === 0) {
        els.resultsContainer.innerHTML = `<div class="text-muted">${noMatchesText}</div>`;
        els.matchCountBadge.textContent = "0";
        return;
    }

    els.matchCountBadge.textContent = matches.length;

    let lastIndex = 0;
    let html = "";

    matches.forEach((m, idx) => {
        // Text before match
        html += escapeHtml(originalText.substring(lastIndex, m.start));

        // Match itself
        html += `<span class="regex-match" title="Match ${idx + 1}" style="background-color: rgba(255, 215, 0, 0.25); border-bottom: 2px solid #ffcc00;">`;
        html += escapeHtml(originalText.substring(m.start, m.end));
        html += `</span>`;

        lastIndex = m.end;
    });

    // Remaining text
    html += escapeHtml(originalText.substring(lastIndex));

    const pre = document.createElement('pre');
    pre.className = 'regex-output';
    pre.innerHTML = html;

    els.resultsContainer.innerHTML = '';
    els.resultsContainer.appendChild(pre);

    // Details
    if (matches.length > 0) {
        const details = document.createElement('div');
        details.className = 'match-details';

        const MAX_DETAILS = 50; // Performance limit

        matches.slice(0, MAX_DETAILS).forEach((m, i) => {
            if (m.captures && m.captures.length > 0) {
                const groupDiv = document.createElement('div');
                groupDiv.className = 'match-group-info';
                groupDiv.style.marginBottom = '0.5rem';
                groupDiv.innerHTML = `<strong>Match ${i + 1}:</strong>`;
                const ul = document.createElement('ul');
                m.captures.forEach(c => {
                    const li = document.createElement('li');
                    const name = c.name ? `<strong>${c.name}</strong>` : `Group`;
                    li.innerHTML = `${name}: <code>${escapeHtml(c.text)}</code>`;
                    ul.appendChild(li);
                });
                groupDiv.appendChild(ul);
                details.appendChild(groupDiv);
            }
        });

        if (matches.length > MAX_DETAILS) {
            const more = document.createElement('div');
            more.textContent = `... and ${matches.length - MAX_DETAILS} more matches.`;
            details.appendChild(more);
        }

        if (details.hasChildNodes()) {
            els.resultsContainer.appendChild(document.createElement('hr'));
            els.resultsContainer.appendChild(details);
        }
    }
}

// -----------------------------------------------------------
// Event Delegation Pattern for Blazor SSR / Enhanced Navigation
// -----------------------------------------------------------

function bindDelegatedEvents() {
    if (window.__regexTesterBound) return;
    window.__regexTesterBound = true;

    // Click handler for Examples
    // Click handler for Examples
    document.addEventListener('click', (ev) => {
        const target = ev.target;
        if (!target) return;

        // Example buttons - traverse up in case they clicked inner span/code
        const btn = target.closest('.regex-example-btn');
        if (btn) {
            const idx = parseInt(btn.dataset.index);
            const example = COMMON_REGEXES[idx];
            if (example) {
                const els = getElements();
                if (els) {
                    els.patternInput.value = example.pattern;
                    els.textInput.value = example.sample || "";
                    // Defaults flags
                    els.flags.forEach(f => f.checked = (f.value === 'u')); // Reset tags to Unicode only
                    runTest();
                }
            }
        }
    });

    // Input handlers
    // Use 'input' event for real-time updates (debounced)
    // Use 'change' event for checkboxes
    let debounceTimer;
    document.addEventListener('input', (ev) => {
        const target = ev.target;
        if (!target) return;

        const root = document.getElementById('regex-tester-root');
        if (!root) return; // Only if tool is present

        if (target.id === 'regex-pattern' || target.id === 'regex-text') {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(runTest, 300);
        }
    });

    document.addEventListener('change', (ev) => {
        const target = ev.target;
        if (target.classList.contains('regex-flag')) {
            runTest();
        }
    });
}

// Initialization Logic
function initUI() {
    const els = getElements();
    if (!els) return;

    // Render Examples if empty (idempotent check)
    if (els.examplesList.children.length === 0) {
        COMMON_REGEXES.forEach((ex, idx) => {
            const li = document.createElement('li');

            const btn = document.createElement('button');
            btn.className = 'btn btn-link regex-example-btn';
            btn.type = 'button'; // Explicit type
            btn.dataset.index = idx;

            const nameSpan = document.createElement('span');
            nameSpan.className = 'example-name';
            nameSpan.textContent = ex.name;

            const codeSpan = document.createElement('code');
            codeSpan.className = 'example-pattern';
            codeSpan.textContent = ex.pattern.length > 50 ? ex.pattern.substring(0, 47) + '...' : ex.pattern;

            btn.appendChild(nameSpan);
            btn.appendChild(codeSpan);

            li.appendChild(btn);
            els.examplesList.appendChild(li);
        });
    }

    // Initial Test run if empty
    if (!els.patternInput.value && !els.textInput.value) {
        // Set default example (Email)
        const def = COMMON_REGEXES[0];
        els.patternInput.value = def.pattern;
        els.textInput.value = def.sample;
        runTest();
    }
}

// Run once on load
bindDelegatedEvents();

// Initial check
initUI();

// Observe DOM for navigation changes (Blazor Enhanced Nav)
const observer = new MutationObserver(() => {
    initUI();
});
observer.observe(document.body, { childList: true, subtree: true });
