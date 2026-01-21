// Favorites management module for MyDevTools
// Handles storing/retrieving favorites from localStorage and UI interactions

(function () {
    'use strict';

    const STORAGE_KEY = 'mydevtools_favorites';
    const initializedRoots = new WeakSet();

    // Get favorites from localStorage
    function getFavorites() {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            return stored ? JSON.parse(stored) : [];
        } catch (e) {
            console.error('Error reading favorites from localStorage:', e);
            return [];
        }
    }

    // Save favorites to localStorage
    function saveFavorites(favorites) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
            // Dispatch custom event for favorites change
            window.dispatchEvent(new CustomEvent('favoritesChanged', { detail: { favorites } }));
        } catch (e) {
            console.error('Error saving favorites to localStorage:', e);
        }
    }

    // Check if a tool is favorited
    function isFavorite(slug) {
        const favorites = getFavorites();
        return favorites.includes(slug);
    }

    // Add a tool to favorites
    function addFavorite(slug) {
        const favorites = getFavorites();
        if (!favorites.includes(slug)) {
            favorites.push(slug);
            saveFavorites(favorites);
        }
    }

    // Remove a tool from favorites
    function removeFavorite(slug) {
        const favorites = getFavorites();
        const index = favorites.indexOf(slug);
        if (index > -1) {
            favorites.splice(index, 1);
            saveFavorites(favorites);
        }
    }

    // Toggle favorite status
    function toggleFavorite(slug) {
        if (isFavorite(slug)) {
            removeFavorite(slug);
        } else {
            addFavorite(slug);
        }
    }

    // Update UI for all favorite buttons
    function updateFavoriteButtons() {
        const buttons = document.querySelectorAll('.favorite-btn');
        buttons.forEach(btn => {
            const slug = btn.dataset.toolSlug;
            if (slug) {
                const favorited = isFavorite(slug);
                btn.classList.toggle('is-favorite', favorited);
                btn.setAttribute('aria-pressed', favorited);
            }
        });
    }

    // Update favorites section visibility and content
    function updateFavoritesSection() {
        const favoritesSection = document.getElementById('favorites-section');
        if (!favoritesSection) return;

        const favorites = getFavorites();
        const favoritesScroll = favoritesSection.querySelector('.favorites-scroll');
        const emptyState = favoritesSection.querySelector('.favorites-empty');

        if (favorites.length === 0) {
            // Show empty state
            if (favoritesScroll) favoritesScroll.style.display = 'none';
            if (emptyState) emptyState.style.display = 'block';
        } else {
            // Show favorites
            if (favoritesScroll) favoritesScroll.style.display = 'flex';
            if (emptyState) emptyState.style.display = 'none';

            // Update favorites list order
            if (favoritesScroll) {
                const compactTools = Array.from(favoritesScroll.querySelectorAll('.favorite-tool-compact'));
                compactTools.forEach(tool => {
                    const slug = tool.dataset.toolSlug;
                    const index = favorites.indexOf(slug);
                    if (index > -1) {
                        tool.style.order = index;
                        tool.style.display = 'flex';
                    } else {
                        tool.style.display = 'none';
                    }
                });
            }
        }
    }

    // Initialize favorites functionality
    function init() {
        const root = document.getElementById('home-page-root');
        if (!root || initializedRoots.has(root)) return;
        initializedRoots.add(root);

        // Update UI on load
        updateFavoriteButtons();
        updateFavoritesSection();

        // Listen for favorites changes
        window.addEventListener('favoritesChanged', () => {
            updateFavoriteButtons();
            updateFavoritesSection();
        });
    }

    // Event delegation for favorite buttons (bind once globally)
    if (!window.__favoritesHandlersBound) {
        window.__favoritesHandlersBound = true;

        document.addEventListener('click', (e) => {
            const btn = e.target.closest('.favorite-btn');
            if (btn) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                const slug = btn.dataset.toolSlug;
                if (slug) {
                    toggleFavorite(slug);
                }
                return false;
            }
        }, true); // Use capture phase
    }

    // Watch for DOM changes (Blazor SSR Enhanced Navigation)
    const observer = new MutationObserver(() => {
        init();
    });

    // Start observing
    if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // Initial load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Expose API for debugging
    window.MyDevToolsFavorites = {
        getFavorites,
        addFavorite,
        removeFavorite,
        toggleFavorite,
        isFavorite
    };
})();
