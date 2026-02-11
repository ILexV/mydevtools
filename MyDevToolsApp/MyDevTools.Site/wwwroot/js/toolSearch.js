// Tool Search Modal - Pure JavaScript implementation for SSR compatibility
(function() {
    'use strict';
    
    let modal = null;
    let searchInput = null;
    let resultsContainer = null;
    let selectedIndex = 0;
    let filteredTools = [];
    let allTools = [];
    let lang = 'en';
    let strings = {};
    
    // Popular tools slugs for initial display
    const popularSlugs = ['hash-calculator', 'base64-encoder', 'json-beautifier', 'password-generator', 'qr-code-generator'];
    
    function init() {
        // Wait for data to be available
        if (window.searchData) {
            allTools = window.searchData.tools || [];
            lang = window.searchData.lang || 'en';
            strings = window.searchData.strings || {};
        }
        
        // Create modal HTML
        createModal();
        
        // Setup keyboard shortcut
        document.addEventListener('keydown', handleKeyDown);
    }
    
    function createModal() {
        // Remove existing modal if any
        const existing = document.getElementById('tool-search-modal');
        if (existing) existing.remove();
        
        modal = document.createElement('div');
        modal.id = 'tool-search-modal';
        modal.className = 'fixed inset-0 z-50 flex items-start justify-center pt-16 sm:pt-24 px-4 hidden';
        modal.innerHTML = `
            <div class="fixed inset-0 bg-black/50 transition-opacity" id="tool-search-backdrop"></div>
            <div class="relative w-full max-w-2xl bg-base-100 rounded-xl shadow-2xl overflow-hidden" id="tool-search-content">
                <div class="flex items-center gap-3 px-4 py-3 border-b border-base-300">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                    <input type="text" 
                           id="tool-search-input"
                           class="flex-1 bg-transparent text-lg outline-none placeholder:opacity-50 text-base-content"
                           placeholder="${strings.placeholder || 'Search tools...'}"
                           autocomplete="off"
                           autocorrect="off"
                           autocapitalize="off"
                           spellcheck="false" />
                    <kbd class="kbd kbd-sm hidden sm:inline-block">ESC</kbd>
                </div>
                <div id="tool-search-results" class="max-h-[60vh] overflow-y-auto p-2">
                    <!-- Results will be inserted here -->
                </div>
                <div class="px-4 py-2 bg-base-200 text-xs opacity-60 flex items-center justify-between">
                    <div class="flex items-center gap-4">
                        <span class="flex items-center gap-1"><kbd class="kbd kbd-xs">↑</kbd> <kbd class="kbd kbd-xs">↓</kbd> ${strings.navigate || 'to navigate'}</span>
                        <span class="flex items-center gap-1"><kbd class="kbd kbd-xs">↵</kbd> ${strings.select || 'to select'}</span>
                    </div>
                    <span id="tool-search-count">0 ${strings.results || 'results'}</span>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // Get references
        searchInput = document.getElementById('tool-search-input');
        resultsContainer = document.getElementById('tool-search-results');
        
        // Setup event listeners
        document.getElementById('tool-search-backdrop').addEventListener('click', close);
        document.getElementById('tool-search-content').addEventListener('click', (e) => e.stopPropagation());
        searchInput.addEventListener('input', handleInput);
        searchInput.addEventListener('keydown', handleInputKeyDown);
    }
    
    function open() {
        if (!modal) init();
        
        // Refresh data
        if (window.searchData) {
            allTools = window.searchData.tools || [];
            lang = window.searchData.lang || 'en';
            strings = window.searchData.strings || {};
        }
        
        modal.classList.remove('hidden');
        searchInput.value = '';
        searchInput.focus();
        selectedIndex = 0;
        showPopularTools();
    }
    
    function close() {
        if (modal) {
            modal.classList.add('hidden');
        }
    }
    
    function handleKeyDown(e) {
        // Ctrl+K or Cmd+K to open
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
            e.preventDefault();
            open();
        }
        // Escape to close
        else if (e.key === 'Escape') {
            close();
        }
    }
    
    function handleInputKeyDown(e) {
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                selectedIndex = (selectedIndex + 1) % filteredTools.length;
                updateSelection();
                break;
            case 'ArrowUp':
                e.preventDefault();
                selectedIndex = (selectedIndex - 1 + filteredTools.length) % filteredTools.length;
                updateSelection();
                break;
            case 'Enter':
                e.preventDefault();
                if (filteredTools.length > 0 && selectedIndex >= 0) {
                    navigateToTool(filteredTools[selectedIndex].slug);
                }
                break;
            case 'Escape':
                close();
                break;
        }
    }
    
    function handleInput(e) {
        const query = e.target.value.trim().toLowerCase();
        if (!query) {
            showPopularTools();
            return;
        }
        
        filteredTools = allTools.filter(tool => {
            const titleMatch = tool.title.toLowerCase().includes(query);
            const descMatch = tool.description.toLowerCase().includes(query);
            const keywordMatch = tool.keywords.some(k => k.toLowerCase().includes(query));
            return titleMatch || descMatch || keywordMatch;
        });
        
        selectedIndex = 0;
        renderResults();
    }
    
    function showPopularTools() {
        filteredTools = allTools.filter(tool => popularSlugs.includes(tool.slug));
        renderResults(true);
    }
    
    function renderResults(isPopular = false) {
        if (filteredTools.length === 0) {
            resultsContainer.innerHTML = `
                <div class="px-4 py-8 text-center">
                    <div class="opacity-50 mb-2">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-12 w-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                    </div>
                    <p class="opacity-70">${strings.noResults || 'No tools found'}</p>
                </div>
            `;
        } else {
            const title = isPopular ? `<div class="text-xs font-semibold uppercase opacity-50 mb-3 px-2">${strings.popularTools || 'Popular Tools'}</div>` : '';
            resultsContainer.innerHTML = title + filteredTools.map((tool, index) => `
                <a href="/${lang}/${tool.slug}" 
                   class="tool-search-result flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${index === selectedIndex ? 'bg-primary text-primary-content' : 'hover:bg-base-200'}"
                   data-index="${index}"
                   data-slug="${tool.slug}">
                    <span class="text-2xl">${tool.icon}</span>
                    <div class="flex-1 min-w-0">
                        <div class="font-medium truncate">${tool.title}</div>
                        <div class="text-sm opacity-60 truncate">${tool.description}</div>
                    </div>
                </a>
            `).join('');
            
            // Add click handlers
            resultsContainer.querySelectorAll('.tool-search-result').forEach(el => {
                el.addEventListener('click', (e) => {
                    e.preventDefault();
                    navigateToTool(el.dataset.slug);
                });
                el.addEventListener('mouseenter', () => {
                    selectedIndex = parseInt(el.dataset.index);
                    updateSelection();
                });
            });
        }
        
        document.getElementById('tool-search-count').textContent = `${filteredTools.length} ${strings.results || 'results'}`;
    }
    
    function updateSelection() {
        const items = resultsContainer.querySelectorAll('.tool-search-result');
        items.forEach((item, index) => {
            if (index === selectedIndex) {
                item.classList.add('bg-primary', 'text-primary-content');
                item.classList.remove('hover:bg-base-200');
                item.scrollIntoView({ block: 'nearest' });
            } else {
                item.classList.remove('bg-primary', 'text-primary-content');
                item.classList.add('hover:bg-base-200');
            }
        });
    }
    
    function navigateToTool(slug) {
        close();
        window.location.href = `/${lang}/${slug}`;
    }
    
    // Expose API
    window.toolSearchModal = {
        open: open,
        close: close
    };
    
    // Auto-init when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
