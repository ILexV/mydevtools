// @ts-check
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";

const src = fileURLToPath(new URL("./src", import.meta.url));

// GitHub Pages with the custom domain mydevtools.app (public/CNAME) → served from the
// domain root. `base` MUST match the served path; `site` is the origin for canonical/sitemap.
// A single `@` → src alias covers `@/components`, `@/tools`, `@/registry`, etc.
export default defineConfig({
  site: "https://mydevtools.app",
  base: "/",
  output: "static",
  trailingSlash: "always",
  build: {
    // Emit /path/index.html so deep links survive GitHub Pages SPA fallback.
    format: "directory",
  },
  // Dev server: matches the legacy site port so tooling/scripts stay familiar.
  server: {
    host: true,
    port: 3312,
  },
  vite: {
    resolve: {
      alias: {
        "@": src,
      },
    },
  },
});
