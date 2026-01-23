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
                .SetAbsoluteExpiration(TimeSpan.FromHours(24));

            _cache.Set("sitemap_xml", sitemap, cacheEntryOptions);

            context.Response.ContentType = "application/xml";
            await context.Response.WriteAsync(sitemap);
            return;
        }

        await _next(context);
    }

    private static string GenerateSitemap(HttpContext context)
    {
        var baseUrl = $"{context.Request.Scheme}://{context.Request.Host}";
        var ns = XNamespace.Get("http://www.sitemaps.org/schemas/sitemap/0.9");
        var supportedCultures = new[] { "en", "ru", "es" };

        var root = new XElement(ns + "urlset");

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
                if (template.Contains("{lang}"))
                {
                    foreach (var lang in supportedCultures)
                    {
                        var path = template.Replace("{lang}", lang);
                        var fullUrl = $"{baseUrl}{path}";

                        root.Add(new XElement(ns + "url",
                            new XElement(ns + "loc", fullUrl),
                            new XElement(ns + "changefreq", "weekly"),
                            new XElement(ns + "priority", "0.8")
                        ));
                    }
                }
            }
        }
        
        return new XDocument(new XDeclaration("1.0", "utf-8", "yes"), root).ToString();
    }
}
