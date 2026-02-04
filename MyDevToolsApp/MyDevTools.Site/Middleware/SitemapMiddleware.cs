using Microsoft.AspNetCore.Components;
using Microsoft.Extensions.Caching.Memory;
using System.Reflection;
using System.Xml.Linq;

namespace MyDevTools.Site.Middleware;

/// <summary>
/// Middleware that serves the sitemap.xml file.
/// Placed early in the pipeline to avoid redirects/auth/localization issues.
/// </summary>
public class SitemapMiddleware
{
    private readonly RequestDelegate _next;
    private readonly IMemoryCache _cache;

    public SitemapMiddleware(RequestDelegate next, IMemoryCache cache)
    {
        _next = next;
        _cache = cache;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        if (context.Request.Path.Value?.Equals("/sitemap.xml", StringComparison.OrdinalIgnoreCase) == true)
        {
            // Try to get from cache
            if (_cache.TryGetValue("sitemap_xml", out string? cachedSitemap) && !string.IsNullOrEmpty(cachedSitemap))
            {
                context.Response.ContentType = "application/xml";
                await context.Response.WriteAsync(cachedSitemap);
                return;
            }

            // Generate if not cached
            var sitemap = GenerateSitemap(context);

            // Cache for 24 hours
            var cacheEntryOptions = new MemoryCacheEntryOptions()
                .SetAbsoluteExpiration(TimeSpan.FromHours(24))
                .SetSize(sitemap.Length * 2); // Size in bytes (approximate for UTF-16)

            _cache.Set("sitemap_xml", sitemap, cacheEntryOptions);

            context.Response.ContentType = "application/xml";
            await context.Response.WriteAsync(sitemap);
            return;
        }

        await _next(context);
    }

    private static string GenerateSitemap(HttpContext context)
    {
        var baseUrl = $"https://{context.Request.Host}";
        var ns = XNamespace.Get("http://www.sitemaps.org/schemas/sitemap/0.9");
        var supportedCultures = new[] { "en", "ru", "es", "de", "pt", "zh", "fr", "ja", "ko", "hi" };

        var root = new XElement(ns + "urlset");

        // Add root page with highest priority
        root.Add(new XElement(ns + "url",
            new XElement(ns + "loc", baseUrl + "/"),
            new XElement(ns + "changefreq", "daily"),
            new XElement(ns + "priority", "1.0")
        ));

        // Scan for all Components with @page (RouteAttribute)
        var componentTypes = Assembly.GetExecutingAssembly().GetTypes()
            .Where(t => typeof(IComponent).IsAssignableFrom(t) && !t.IsAbstract);

        foreach (var type in componentTypes)
        {
            var routeAttributes = type.GetCustomAttributes<RouteAttribute>();
            foreach (var routeAttr in routeAttributes)
            {
                var template = routeAttr.Template;

                // Only consider routes that follow the /{lang}/ pattern
                // We assume tool pages are defined like "/{lang}/tool-name"
                // Exclude error pages from sitemap
                if (template.Contains("{lang}") && 
                    !template.Contains("not-found", StringComparison.OrdinalIgnoreCase) &&
                    !template.Contains("error", StringComparison.OrdinalIgnoreCase))
                {
                    // Determine if this is the home page
                    bool isHomePage = template == "/{lang}";
                    
                    foreach (var lang in supportedCultures)
                    {
                        var path = template.Replace("{lang}", lang);
                        
                        // Append trailing slash for language root pages to match Canonical/Hreflang
                        if (isHomePage && !path.EndsWith("/"))
                        {
                            path += "/";
                        }

                        var fullUrl = $"{baseUrl}{path}";

                        // Home pages have higher priority and update more frequently
                        var priority = isHomePage ? "0.9" : "0.7";
                        var changefreq = isHomePage ? "daily" : "weekly";

                        root.Add(new XElement(ns + "url",
                            new XElement(ns + "loc", fullUrl),
                            new XElement(ns + "changefreq", changefreq),
                            new XElement(ns + "priority", priority)
                        ));
                    }
                }
            }
        }
        
        return new XDocument(new XDeclaration("1.0", "utf-8", "yes"), root).ToString();
    }
}
