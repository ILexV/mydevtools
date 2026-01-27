/* global document, window, localStorage */

import init, { test_regex } from '/wasm/regex_tool/regex_tool.js';

(function () {
    let wasmInitialized = false;
    let debounceTimer;
    const STORAGE_KEY = 'mydevtools_regex_saved';
    
    // Track initialized roots to prevent infinite re-init loops with MutationObserver
    const initializedRoots = new WeakSet();

    const COMMON_REGEXES = [
        { name: "Email", pattern: "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}", sample: "test@example.com\ninvalid-email\nuser.name+tag@mail.co.uk" },
        { name: "IPv4 Address", pattern: "\\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\b", sample: "192.168.1.1\n10.0.0.1\n256.0.0.1 (invalid)" },
        { name: "Date (YYYY-MM-DD)", pattern: "\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])", sample: "2023-12-31\n2024-02-29\n2023-13-01 (invalid)" },
        { name: "Hex Color", pattern: "#?([a-fA-F0-9]{6}|[a-fA-F0-9]{3})", sample: "#FFF\n#000000\n#555555" },
        { name: "URL (Simple)", pattern: "https?:\\/\\/[\\w\\-\\.]+(?::\\d+)?(?:\\/[\\w\\-._~:/?#[\\]@!$&'()*+,;=]*)?", sample: "https://www.google.com\nhttp://localhost:8080/api/v1" }
    ];

    async function ensureWasm() {
        if (!wasmInitialized) {
            await init();
            wasmInitialized = true;
        }
    }

    function getElements() {
        const root = document.getElementById('regex-tester-root');
        if (!root) return null;

        return {
            root,
            pattern: document.getElementById('regex-pattern'),
            text: document.getElementById('regex-text'),
            backdrop: document.getElementById('regex-backdrop'),
            results: document.getElementById('regex-results'),
            countBadge: document.getElementById('match-count'),
            examplesBody: document.getElementById('regex-examples-body'),
            savedBody: document.getElementById('regex-saved-body'),
            savedEmpty: document.getElementById('regex-saved-empty'),
            saveBtn: document.getElementById('save-pattern-btn'),
            confirmSaveBtn: document.getElementById('confirm-save-btn'),
            saveNameInput: document.getElementById('save-pattern-name'),
            modal: document.getElementById('save_pattern_modal'),
            flags: Array.from(document.querySelectorAll('.regex-flag'))
        };
    }

    function escapeHtml(text) {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    // --- Highlighting Logic ---
    function updateHighlight(els, text, matches) {
        let html = '';
        let lastIndex = 0;
        
        matches.forEach(m => {
            if (m.start < lastIndex) return; 

            html += escapeHtml(text.substring(lastIndex, m.start));
            html += `<mark class="highlight">${escapeHtml(text.substring(m.start, m.end))}</mark>`;
            lastIndex = m.end;
        });

        html += escapeHtml(text.substring(lastIndex));

        if (text.endsWith('\n')) {
            html += '<br>&nbsp;';
        }

        els.backdrop.innerHTML = html;
    }

    function syncScroll(els) {
        els.backdrop.scrollTop = els.text.scrollTop;
        els.backdrop.scrollLeft = els.text.scrollLeft;
    }

    async function runTest() {
        const els = getElements();
        if (!els) return;

        const pattern = els.pattern.value;
        const text = els.text.value;
        
        let flags = '';
        els.flags.forEach(f => { if (f.checked) flags += f.value; });

        syncScroll(els);

        if (!pattern) {
            els.backdrop.innerHTML = escapeHtml(text);
            els.results.innerHTML = `<div class="text-base-content/50 italic text-sm">${els.root.dataset.noMatches}</div>`;
            els.countBadge.textContent = '0';
            return;
        }

        try {
            await ensureWasm();
            const rustFlags = flags.replace(/[gy]/g, ''); 
            const fullPattern = rustFlags ? `(?${rustFlags})${pattern}` : pattern;

            const result = test_regex(fullPattern, text);

            if (result.error) {
                els.results.innerHTML = `<div class="alert alert-error text-sm py-2"><span>${escapeHtml(result.error)}</span></div>`;
                els.countBadge.textContent = '!';
                els.backdrop.innerHTML = escapeHtml(text); 
                return;
            }

            updateHighlight(els, text, result.matches);
            renderMatchDetails(els, result.matches);

        } catch (err) {
            console.error(err);
            els.results.innerHTML = `<div class="alert alert-error text-sm py-2"><span>WASM Error: ${err.message}</span></div>`;
        }
    }

    function renderMatchDetails(els, matches) {
        els.countBadge.textContent = matches.length;

        if (matches.length === 0) {
            els.results.innerHTML = `<div class="text-base-content/50 italic text-sm">${els.root.dataset.noMatches}</div>`;
            return;
        }

        const renderLimit = 50;
        const visibleMatches = matches.slice(0, renderLimit);
        
        let html = '';
        visibleMatches.forEach((m, idx) => {
            const matchText = m.text || ''; 
            const displayMatch = matchText.length > 100 ? matchText.substring(0, 100) + '...' : matchText;

            let groupsHtml = '';
            if (m.captures && m.captures.length > 0) {
                m.captures.forEach((c) => {
                    const groupName = c.name ? c.name : `Group`;
                    groupsHtml += `
                        <div class="group-row">
                            <span class="group-name text-xs">${escapeHtml(groupName)}:</span>
                            <span class="font-mono text-xs bg-base-300 rounded px-1 break-all">${escapeHtml(c.text)}</span>
                            <span class="text-xs opacity-50 ml-auto">[${c.start}-${c.end}]</span>
                        </div>
                    `;
                });
            }

            html += `
                <div class="match-card">
                    <div class="match-header">
                        <span>Match ${idx + 1}</span>
                        <span class="font-normal opacity-50">[${m.start}-${m.end}]</span>
                    </div>
                    <div class="bg-base-100 p-2 rounded border border-base-300 break-all mb-1">${escapeHtml(displayMatch)}</div>
                    ${groupsHtml}
                </div>
            `;
        });

        if (matches.length > renderLimit) {
            html += `<div class="text-center text-xs opacity-50 mt-2">...and ${matches.length - renderLimit} more matches</div>`;
        }

        els.results.innerHTML = html;
    }

    function getSavedPatterns() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        } catch {
            return [];
        }
    }

    function saveCurrentPattern(els) {
        const name = els.saveNameInput.value.trim();
        if (!name) return;

        const pattern = els.pattern.value;
        const sample = els.text.value;
        const flags = els.flags.filter(f => f.checked).map(f => f.value);

        if (!pattern) return;

        const saved = getSavedPatterns();
        saved.push({ name, pattern, sample, flags });
        localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
        
        // Reset and close
        els.saveNameInput.value = '';
        renderSavedPatterns(els);
        els.modal.close();
    }

    function deletePattern(index) {
        const saved = getSavedPatterns();
        saved.splice(index, 1);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
        const els = getElements();
        if (els) renderSavedPatterns(els);
    }

    function loadPattern(data) {
        const els = getElements();
        if (!els || !data) return;

        els.pattern.value = data.pattern;
        els.text.value = data.sample || '';
        
        // Restore flags if present
        if (data.flags && Array.isArray(data.flags)) {
            els.flags.forEach(f => f.checked = data.flags.includes(f.value));
        }

        runTest();
    }

    function renderSavedPatterns(els) {
        const saved = getSavedPatterns();
        els.savedBody.innerHTML = '';
        
        if (saved.length === 0) {
            els.savedEmpty.classList.remove('hidden');
            return;
        }
        els.savedEmpty.classList.add('hidden');

        saved.forEach((item, idx) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td class="font-bold text-xs">${escapeHtml(item.name)}</td>
                <td><code class="text-[10px] bg-base-200 p-1 rounded opacity-70 truncate block max-w-[150px]">${escapeHtml(item.pattern)}</code></td>
                <td>
                    <div class="join">
                        <button class="btn btn-xs btn-ghost join-item load-saved-btn" data-index="${idx}" title="Load">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" /></svg>
                        </button>
                        <button class="btn btn-xs btn-ghost text-error join-item delete-saved-btn" data-index="${idx}" title="Delete">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
                        </button>
                    </div>
                </td>
            `;
            els.savedBody.appendChild(tr);
        });
    }

    function initUI() {
        const els = getElements();
        // Guard: if root not found or already initialized, skip
        if (!els) return;
        if (initializedRoots.has(els.root)) return;
        
        // Mark as initialized to prevent loop
        initializedRoots.add(els.root);

        // Render Examples Table
        if (els.examplesBody.children.length === 0) {
            COMMON_REGEXES.forEach((ex, idx) => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td class="font-bold text-xs">${escapeHtml(ex.name)}</td>
                    <td><code class="text-[10px] bg-base-200 p-1 rounded opacity-70 truncate block max-w-[150px]">${escapeHtml(ex.pattern)}</code></td>
                    <td>
                        <button class="btn btn-xs btn-ghost load-example-btn" data-index="${idx}" title="Load">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" /></svg>
                        </button>
                    </td>
                `;
                els.examplesBody.appendChild(tr);
            });
        }

        renderSavedPatterns(els);

        // Run initial test if empty
        if (!els.pattern.value && !els.text.value) {
            // Load email example by default but don't save it as user state
        }
    }

    // Event Delegation
    function bindEvents() {
        if (window.__regexTesterBound) return;
        window.__regexTesterBound = true;

        document.addEventListener('click', (ev) => {
            const target = ev.target;
            
            // Save Button (Open Modal)
            const saveBtn = target.closest('#save-pattern-btn');
            if (saveBtn) {
                const els = getElements();
                if (els) els.modal.showModal();
                return;
            }

            // Confirm Save
            const confirmSave = target.closest('#confirm-save-btn');
            if (confirmSave) {
                ev.preventDefault(); // Prevent any default behavior
                const els = getElements();
                if (els) saveCurrentPattern(els);
                return;
            }

            // Load Example
            const loadExBtn = target.closest('.load-example-btn');
            if (loadExBtn) {
                const idx = parseInt(loadExBtn.dataset.index);
                const ex = COMMON_REGEXES[idx];
                if (ex) loadPattern({ pattern: ex.pattern, sample: ex.sample, flags: ['u'] }); // Default flags for examples
                return;
            }

            // Load Saved
            const loadSavedBtn = target.closest('.load-saved-btn');
            if (loadSavedBtn) {
                const idx = parseInt(loadSavedBtn.dataset.index);
                const saved = getSavedPatterns();
                if (saved[idx]) loadPattern(saved[idx]);
                return;
            }

            // Delete Saved
            const delSavedBtn = target.closest('.delete-saved-btn');
            if (delSavedBtn) {
                const idx = parseInt(delSavedBtn.dataset.index);
                if (confirm('Delete this pattern?')) {
                    deletePattern(idx);
                }
                return;
            }
        });

        document.addEventListener('input', (ev) => {
            const target = ev.target;
            if (target.id === 'regex-pattern' || target.id === 'regex-text') {
                const els = getElements();
                if (!els) return;
                
                if (target.id === 'regex-text') syncScroll(els);

                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(runTest, 150);
            }
        });

        document.addEventListener('change', (ev) => {
            if (ev.target.classList.contains('regex-flag')) {
                runTest();
            }
        });

        document.addEventListener('scroll', (ev) => {
            if (ev.target.id === 'regex-text') {
                const els = getElements();
                if (els) syncScroll(els);
            }
        }, { capture: true });
    }

    bindEvents();
    
    // Standard initialization
    document.addEventListener('DOMContentLoaded', initUI);
    document.addEventListener('enhancedload', initUI);

})();
