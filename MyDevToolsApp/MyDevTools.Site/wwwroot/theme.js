// Theme toggle for SSR (no Blazor interactivity required)
(function () {
    const STORAGE_KEY = "theme";
    const root = document.documentElement;

    function getCookie(name) {
        const value = "; " + document.cookie;
        const parts = value.split("; " + name + "=");
        if (parts.length === 2) {
            return parts.pop().split(";").shift();
        }
        return null;
    }

    function setCookie(name, value) {
        // 1 year
        document.cookie = `${name}=${value}; path=/; max-age=31536000; samesite=lax`;
    }

    function isValidTheme(value) {
        return value === "dark" || value === "light";
    }

    function getStoredTheme() {
        try {
            return localStorage.getItem(STORAGE_KEY);
        } catch {
            return getCookie(STORAGE_KEY);
        }
    }

    function getPreferredTheme() {
        if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
            return "dark";
        }
        return "light";
    }

    function applyTheme(theme) {
        // Avoiding infinite loops where observer triggers change
        if (root.getAttribute("data-theme") === theme) return;

        root.setAttribute("data-theme", theme);

        // Keep existing markup in sync (MainLayout currently renders data-theme on .page)
        const pages = document.querySelectorAll(".page");
        for (const page of pages) {
            page.setAttribute("data-theme", theme);
        }
    }

    function getCurrentTheme() {
        const stored = getStoredTheme();
        if (isValidTheme(stored)) {
            return stored;
        }

        // If no storage, see what's currently rendered (SSR might have set it)
        const attr = root.getAttribute("data-theme");
        if (isValidTheme(attr)) {
            return attr;
        }

        return getPreferredTheme();
    }

    function setTheme(theme) {
        try {
            localStorage.setItem(STORAGE_KEY, theme);
        } catch {
            // ignore
        }

        // Also persist in cookie so server-rendered navigation keeps the theme.
        try {
            setCookie(STORAGE_KEY, theme);
        } catch {
            // ignore
        }
        applyTheme(theme);
    }

    function toggleTheme() {
        // We always base toggle on the stored/calculated preference, 
        // not necessarily just the DOM attribute, to ensure consistency.
        const current = getCurrentTheme();
        const next = current === "dark" ? "light" : "dark";
        setTheme(next);
    }

    // Initial sync
    const initialTheme = getCurrentTheme();
    applyTheme(initialTheme);

    // Blazor Enhanced Navigation can sometimes reset attributes on the <html> tag
    // or parts of the body. We watch for changes and re-apply our preferred theme
    // if it gets messed up.
    let isEnforcing = false;
    const observer = new MutationObserver((mutations) => {
        if (isEnforcing) return;

        const desiredTheme = getCurrentTheme();
        const currentAttr = root.getAttribute("data-theme");

        if (currentAttr !== desiredTheme) {
            isEnforcing = true;
            applyTheme(desiredTheme);
            requestAnimationFrame(() => isEnforcing = false);
        }
    });

    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });

    // Click handler for any theme toggle button
    document.addEventListener("click", function (e) {
        const target = e.target;
        if (!(target instanceof Element)) return;

        const button = target.closest("[data-theme-toggle]");
        if (!button) return;

        e.preventDefault();
        toggleTheme();
    });
})();
