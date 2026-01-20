using Microsoft.AspNetCore.Components;
using Microsoft.Extensions.Caching.Memory;
using System.Reflection;
using System.Xml.Linq;

namespace MyDevTools.Site.Endpoints;

public static class SitemapEndpoint
{
    public static IEndpointRouteBuilder MapSitemapEndpoint(this IEndpointRouteBuilder app)
    {
        app.MapGet("/sitemap.xml", async (HttpContext context, IMemoryCache cache) =>
        {
            // Try to get from cache
            if (cache.TryGetValue("sitemap_xml", out string? cachedSitemap))
            {
                return Results.Text(cachedSitemap, "application/xml");
            }

            // Generate if not cached
            var sitemap = GenerateSitemap(context);

            // Cache for 24 hours
            var cacheEntryOptions = new MemoryCacheEntryOptions()
                .SetAbsoluteExpiration(TimeSpan.FromHours(24));

            cache.Set("sitemap_xml", sitemap, cacheEntryOptions);

            return Results.Text(sitemap, "application/xml");
        });

        return app;
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
        
        // Also add the root redirector (optional, but good for completeness if we consider "/" important, 
        // though strictly speaking "/" redirects to /{lang}/, so maybe not needed in sitemap proper 
        // if we list all lang variations. Google prefers final URLs.)

        return new XDocument(new XDeclaration("1.0", "utf-8", "yes"), root).ToString();
    }
}
