import type { APIRoute } from "astro";
import { LOCALES } from "@/registry/locales";
import { TOOLS } from "@/registry/tools";
import { localizedPath } from "@/lib/url";

/**
 * Build-time sitemap. Single source = registry × locales (Stage 4 Gate 4: a new
 * tool entry appears here automatically). Mirrors the legacy priority/changefreq
 * table: lang homes 0.9/daily, tools 0.7/weekly.
 */
export const GET: APIRoute = ({ site }) => {
  const origin = (site?.toString().replace(/\/$/, "") ?? "") + "/";
  const today = new Date().toISOString().slice(0, 10);
  const entries: string[] = [];

  const abs = (p: string) => origin + p.replace(/^\/+/, "").replace(/\/+$/, "");

  for (const l of LOCALES) {
    entries.push(
      `\n  <url>\n    <loc>${abs(localizedPath(l.code))}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.9</priority>\n  </url>`,
    );
    for (const tool of TOOLS) {
      entries.push(
        `\n  <url>\n    <loc>${abs(localizedPath(l.code, tool.slug))}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>\n  </url>`,
      );
    }
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join("")}\n</urlset>\n`;
  return new Response(xml, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
};
