(function() {
    'use strict';

    // console.log('[CommandPalette] Initializing...');

    // State
    let searchInput = null;
    let tools = [];
    let selectedIndex = -1;
    let filteredTools = [];
    let currentLang = 'en';

    // Popular tools to show by default
    const popularSlugs = ['hash-calculator', 'base64-encoder', 'json-beautifier', 'password-generator', 'qr-code-generator'];

    // DOM Elements
    let overlay = null;
    let modal = null;
    let list = null;

    function init() {
        // console.log('[CommandPalette] DOM ready, setting up...');
        
        // Find elements
        overlay = document.getElementById('command-palette-overlay');
        modal = document.getElementById('command-palette-modal');
        list = document.getElementById('command-palette-list');
        searchInput = document.getElementById('command-palette-input');
        
        if (!overlay || !modal || !list || !searchInput) {
            // console.log('[CommandPalette] Elements not found, retrying...');
            setTimeout(init, 100);
            return;
        }

        // Load data from data-attributes
        try {
            const toolsAttr = modal.getAttribute('data-tools');
            const langAttr = modal.getAttribute('data-lang');
            
            if (toolsAttr) {
                tools = JSON.parse(toolsAttr);
                // console.log('[CommandPalette] Loaded', tools.length, 'tools from data attribute');
            }
            
            if (langAttr) {
                currentLang = langAttr;
            }
        } catch (e) {
            // console.error('[CommandPalette] Error parsing tools data:', e);
        }

        // Setup event listeners
        overlay.addEventListener('click', close);
        searchInput.addEventListener('input', handleSearch);
        searchInput.addEventListener('keydown', handleKeyDown);
        
        // console.log('[CommandPalette] Initialized');
    }

    function isOpen() {
        return modal?.classList.contains('open');
    }

    function open() {
        // console.log('[CommandPalette] Opening...');
        
        if (!modal) {
            // console.error('[CommandPalette] Cannot open - not initialized');
            return;
        }
        
        overlay.classList.add('open');
        modal.classList.add('open');
        
        // Focus input
        searchInput.value = '';
        searchInput.focus();
        
        // Show popular tools
        if (tools.length > 0) {
            showPopularTools();
        } else {
            list.innerHTML = '<div class="p-4 text-center text-base-content/50">Loading...</div>';
        }
    }

    function close() {
        // console.log('[CommandPalette] Closing...');
        overlay?.classList.remove('open');
        modal?.classList.remove('open');
        selectedIndex = -1;
    }

    function toggle() {
        if (isOpen()) {
            close();
        } else {
            open();
        }
    }

    function showPopularTools() {
        // console.log('[CommandPalette] Showing popular tools');
        filteredTools = tools.filter(tool => popularSlugs.includes(tool.slug));
        if (filteredTools.length === 0 && tools.length > 0) {
            filteredTools = tools.slice(0, 6);
        }
        selectedIndex = filteredTools.length > 0 ? 0 : -1;
        renderResults(true);
    }

    function handleSearch(e) {
        const query = (e.target.value || '').toLowerCase().trim();
        
        if (!query) {
            showPopularTools();
            return;
        }

        filteredTools = tools.filter(tool => 
            tool.name.toLowerCase().includes(query) ||
            (tool.description && tool.description.toLowerCase().includes(query)) ||
            (tool.category && tool.category.toLowerCase().includes(query))
        );

        selectedIndex = filteredTools.length > 0 ? 0 : -1;
        renderResults(false);
    }

    function renderResults(isPopular = false) {
        if (filteredTools.length === 0) {
            list.innerHTML = `
                <div class="p-4 text-center text-base-content/50">
                    No tools found
                </div>
            `;
            return;
        }

        // Group by category
        const grouped = filteredTools.reduce((acc, tool) => {
            const category = tool.category || 'Tools';
            acc[category] = acc[category] || [];
            acc[category].push(tool);
            return acc;
        }, {});

        let html = '';
        
        // Add section title for popular tools
        if (isPopular) {
            html += `<div class="text-xs font-semibold uppercase opacity-50 mb-3 px-2">Popular Tools</div>`;
        }
        
        let globalIndex = 0;
        
        for (const [category, categoryTools] of Object.entries(grouped)) {
            if (!isPopular) {
                html += `<div class="command-palette-group-title">${escapeHtml(category)}</div>`;
            }
            
            categoryTools.forEach(tool => {
                const index = globalIndex++;
                const isSelected = index === selectedIndex;
                const url = `/${currentLang}/${escapeHtml(tool.slug)}`;
                html += `
                    <a href="${url}" 
                       class="command-palette-item ${isSelected ? 'selected' : ''}"
                    >
                        <div class="command-palette-item-icon"><span>${tool.icon || '🔧'}</span></div>
                        <div class="flex-1 min-w-0">
                            <div class="font-medium truncate">${escapeHtml(tool.name)}</div>
                            <div class="text-sm text-base-content/60 truncate">${escapeHtml(tool.description || '')}</div>
                        </div>
                        ${tool.isPopular ? '<span class="badge badge-sm badge-primary">Popular</span>' : ''}
                    </a>
                `;
            });
        }

        list.innerHTML = html;
    }

    function handleKeyDown(e) {
        if (!isOpen()) return;

        switch(e.key) {
            case 'ArrowDown':
                e.preventDefault();
                if (filteredTools.length > 0) {
                    selectedIndex = (selectedIndex + 1) % filteredTools.length;
                    renderResults(false);
                }
                break;
            case 'ArrowUp':
                e.preventDefault();
                if (filteredTools.length > 0) {
                    selectedIndex = (selectedIndex - 1 + filteredTools.length) % filteredTools.length;
                    renderResults(false);
                }
                break;
            case 'Enter':
                e.preventDefault();
                if (selectedIndex >= 0 && filteredTools[selectedIndex]) {
                    navigateTo(filteredTools[selectedIndex].slug);
                }
                break;
            case 'Escape':
                e.preventDefault();
                e.stopPropagation();
                close();
                break;
        }
    }

    function selectIndex(index) {
        selectedIndex = index;
        renderResults(false);
    }

    function navigateTo(slug) {
        // console.log('[CommandPalette] Navigating to:', slug);
        close();
        window.location.href = `/${currentLang}/${slug}`;
    }

    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Global keyboard shortcuts
    function handleGlobalKeyDown(e) {
        // Ctrl+K or Cmd+K
        if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') {
            // console.log('[CommandPalette] Ctrl+K detected');
            e.preventDefault();
            e.stopPropagation();
            toggle();
        }
        // Escape to close when modal is open
        else if (e.key === 'Escape' && isOpen()) {
            // console.log('[CommandPalette] Escape detected');
            e.preventDefault();
            e.stopPropagation();
            close();
        }
    }

    // Initialize
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    document.addEventListener('keydown', handleGlobalKeyDown);

    // Expose API
    window.commandPalette = {
        open: open,
        close: close,
        toggle: toggle,
        selectIndex: selectIndex,
        navigateTo: navigateTo
    };

    // console.log('[CommandPalette] Setup complete');
})();
