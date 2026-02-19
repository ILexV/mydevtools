(function() {
    'use strict';

    // console.log('[CommandPalette] Initializing...');

    // State
    let searchInput = null;
    let tools = [];
    let selectedIndex = -1;
    let filteredTools = [];
    let currentLang = 'en';
    let favoritesTitle = 'Favorites';
    let recentTitle = 'Recent';
    let popularTitle = 'Popular';

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
            const favoritesTitleAttr = modal.getAttribute('data-favorites-title');
            const recentTitleAttr = modal.getAttribute('data-recent-title');
            const popularTitleAttr = modal.getAttribute('data-popular-title');
            
            if (toolsAttr) {
                tools = JSON.parse(toolsAttr);
                // console.log('[CommandPalette] Loaded', tools.length, 'tools from data attribute');
            }
            
            if (langAttr) {
                currentLang = langAttr;
            }
            
            if (favoritesTitleAttr) favoritesTitle = favoritesTitleAttr;
            if (recentTitleAttr) recentTitle = recentTitleAttr;
            if (popularTitleAttr) popularTitle = popularTitleAttr;
        } catch (e) {
            // console.error('[CommandPalette] Error parsing tools data:', e);
        }

        // Setup event listeners
        overlay.addEventListener('click', close);
        searchInput.addEventListener('input', handleSearch);
        searchInput.addEventListener('keydown', handleKeyDown);
        
        // Close button
        const closeBtn = document.getElementById('command-palette-close-btn');
        closeBtn?.addEventListener('click', close);
        
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
        
        // Focus input after animation completes
        searchInput.value = '';
        setTimeout(() => {
            searchInput.focus();
        }, 50);
        
        // Show default tools (favorites, recent, popular)
        if (tools.length > 0) {
            showDefaultTools();
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

    function showDefaultTools() {
        // console.log('[CommandPalette] Showing default tools (favorites, recent, popular)');
        
        // Check if favorites/recent API is available
        const favorites = (window.MyDevToolsFavorites?.getFavorites) ? window.MyDevToolsFavorites.getFavorites() : [];
        const recentItems = (window.MyDevToolsRecent?.getRecent) ? window.MyDevToolsRecent.getRecent() : [];
        const recentSlugs = recentItems.map(r => r.slug);
        
        // Create unique list in order: favorites -> recent -> popular
        const uniqueSlugs = Array.from(new Set([
            ...favorites,
            ...recentSlugs,
            ...popularSlugs
        ]));
        
        // Map to tool objects with metadata (isFavorite, isRecent, isPopular)
        filteredTools = uniqueSlugs
            .map(slug => {
                const tool = tools.find(t => t.slug === slug);
                if (!tool) return null;
                
                // Determine badge type with priority: favorite > recent > popular
                let badgeType = null;
                if (favorites.includes(slug)) {
                    badgeType = 'favorite';
                } else if (recentSlugs.includes(slug)) {
                    badgeType = 'recent';
                } else if (popularSlugs.includes(slug)) {
                    badgeType = 'popular';
                }
                
                return {
                    ...tool,
                    isFavorite: favorites.includes(slug),
                    isRecent: recentSlugs.includes(slug),
                    isPopular: popularSlugs.includes(slug),
                    badgeType: badgeType
                };
            })
            .filter(t => t !== null);
        
        // Fallback if no tools found
        if (filteredTools.length === 0 && tools.length > 0) {
            filteredTools = tools.slice(0, 6).map(t => ({ ...t, badgeType: null }));
        }
        
        selectedIndex = filteredTools.length > 0 ? 0 : -1;
        renderResults(true);
    }

    function handleSearch(e) {
        const query = (e.target.value || '').toLowerCase().trim();
        
        if (!query) {
            showDefaultTools();
            return;
        }

        filteredTools = tools.filter(tool => 
            tool.name.toLowerCase().includes(query) ||
            (tool.description && tool.description.toLowerCase().includes(query)) ||
            (tool.category && tool.category.toLowerCase().includes(query))
        ).map(tool => ({ ...tool, badgeType: null })); // No badges in search results

        selectedIndex = filteredTools.length > 0 ? 0 : -1;
        renderResults(false);
    }

    function renderResults(isDefaultView = false) {
        if (filteredTools.length === 0) {
            list.innerHTML = `
                <div class="p-4 text-center text-base-content/50">
                    No tools found
                </div>
            `;
            return;
        }

        let html = '';
        
        if (isDefaultView) {
            // Group by badge type: Favorites, Recent, Popular
            const favoriteTools = filteredTools.filter(t => t.isFavorite);
            const recentTools = filteredTools.filter(t => t.isRecent && !t.isFavorite);
            const popularTools = filteredTools.filter(t => t.isPopular && !t.isFavorite && !t.isRecent);
            
            let globalIndex = 0;
            
            if (favoriteTools.length > 0) {
                html += `<div class="command-palette-group-title">⭐ ${escapeHtml(favoritesTitle)}</div>`;
                html += renderToolsList(favoriteTools, globalIndex);
                globalIndex += favoriteTools.length;
            }
            
            if (recentTools.length > 0) {
                html += `<div class="command-palette-group-title">🕐 ${escapeHtml(recentTitle)}</div>`;
                html += renderToolsList(recentTools, globalIndex);
                globalIndex += recentTools.length;
            }
            
            if (popularTools.length > 0) {
                html += `<div class="command-palette-group-title">🔥 ${escapeHtml(popularTitle)}</div>`;
                html += renderToolsList(popularTools, globalIndex);
            }
        } else {
            // Search results - group by category
            const grouped = filteredTools.reduce((acc, tool) => {
                const category = tool.category || 'Tools';
                acc[category] = acc[category] || [];
                acc[category].push(tool);
                return acc;
            }, {});

            let globalIndex = 0;
            
            for (const [category, categoryTools] of Object.entries(grouped)) {
                html += `<div class="command-palette-group-title">${escapeHtml(category)}</div>`;
                html += renderToolsList(categoryTools, globalIndex);
                globalIndex += categoryTools.length;
            }
        }

        list.innerHTML = html;
    }

    function renderToolsList(toolsList, startIndex) {
        return toolsList.map((tool, idx) => {
            const index = startIndex + idx;
            const isSelected = index === selectedIndex;
            const url = `/${currentLang}/${escapeHtml(tool.slug)}`;
            
            return `
                <a href="${url}" 
                   class="command-palette-item ${isSelected ? 'selected' : ''}"
                >
                    <div class="command-palette-item-icon"><span>${tool.icon || '🔧'}</span></div>
                    <div class="flex-1 min-w-0">
                        <div class="font-medium truncate">${escapeHtml(tool.name)}</div>
                        <div class="text-sm text-base-content/60 truncate">${escapeHtml(tool.description || '')}</div>
                    </div>
                </a>
            `;
        }).join('');
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

    // Listen for favorites/recent changes
    window.addEventListener('favoritesChanged', () => {
        if (isOpen()) {
            showDefaultTools();
        }
    });

    window.addEventListener('recentChanged', () => {
        if (isOpen()) {
            showDefaultTools();
        }
    });

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
