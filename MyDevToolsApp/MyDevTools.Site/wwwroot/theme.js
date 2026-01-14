// Theme toggle for SSR (no Blazor interactivity required)
(function () {
    const STORAGE_KEY = "theme";
    const root = document.documentElement;

    function isValidTheme(value) {
        return value === "dark" || value === "light";
    }

    function getStoredTheme() {
        try {
            return localStorage.getItem(STORAGE_KEY);
        } catch {
            return null;
        }
    }

    function getPreferredTheme() {
        if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
            return "dark";
        }
        return "light";
    }

    function applyTheme(theme) {
        root.setAttribute("data-theme", theme);

        // Keep existing markup in sync (MainLayout currently renders data-theme on .page)
        const pages = document.querySelectorAll(".page");
        for (const page of pages) {
            page.setAttribute("data-theme", theme);
        }
    }

    function getCurrentTheme() {
        const attr = root.getAttribute("data-theme");
        if (isValidTheme(attr)) {
            return attr;
        }

        const stored = getStoredTheme();
        if (isValidTheme(stored)) {
            return stored;
        }

        return getPreferredTheme();
    }

    function setTheme(theme) {
        try {
            localStorage.setItem(STORAGE_KEY, theme);
        } catch {
            // ignore
        }
        applyTheme(theme);
    }

    function toggleTheme() {
        const current = getCurrentTheme();
        const next = current === "dark" ? "light" : "dark";
        setTheme(next);
    }

    // Initial sync
    applyTheme(getCurrentTheme());

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
