import type { APIRoute } from "astro";
import { LOCALES } from "@/registry/locales";
import { TOOLS } from "@/registry/tools";
import { localizedPath } from "@/lib/url";
import { homeLastmod, toolLastmod } from "@/lib/lastmod";

/**
 * Build-time sitemap. Single source = registry × locales (a new tool entry
 * appears here automatically). <loc> is the exact canonical URL (trailing
 * slash, no redirect); <lastmod> is the page's last content change from git.
 * No changefreq/priority: Google and Bing ignore them.
 */
export const GET: APIRoute = ({ site }) => {
  const origin = (site?.toString().replace(/\/$/, "") ?? "") + "/";
  const entries: string[] = [];

  const abs = (p: string) => origin + p.replace(/^\/+/, "");
  const url = (path: string, lastmod: string | undefined) =>
    `\n  <url>\n    <loc>${abs(path)}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ""}\n  </url>`;

  for (const l of LOCALES) {
    entries.push(url(localizedPath(l.code), homeLastmod(l.code)));
    for (const tool of TOOLS) entries.push(url(localizedPath(l.code, tool.slug), toolLastmod(l.code, tool.slug)));
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join("")}\n</urlset>\n`;
  return new Response(xml, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
};
