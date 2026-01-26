using MyDevTools.Site.Services;
using System.Globalization;

namespace MyDevTools.Site.Middleware;

/// <summary>
/// Middleware that redirects requests without a culture prefix to the appropriate culture-specific URL.
/// Detects browser language and redirects to /{lang}/{path}.
/// Also sets the culture for the current request.
/// </summary>
public class CultureRedirectMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILocalizationService _localizationService;

    public CultureRedirectMiddleware(RequestDelegate next, ILocalizationService localizationService)
    {
        _next = next;
        _localizationService = localizationService;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        var path = context.Request.Path.Value ?? "/";
        
        // Skip static files, already localized paths, and error pages
        if (path.StartsWith("/_") || 
            path.StartsWith("/css") || 
            path.StartsWith("/js") || 
            path.StartsWith("/lib") ||
            path.StartsWith("/not-found") ||
            (path.Contains('.') && !path.EndsWith("sitemap.xml"))) // Allow sitemap.xml
        {
            await _next(context);
            return;
        }

        var cultureFromPath = _localizationService.GetCultureFromPath(path);
        
        if (cultureFromPath == null)
        {
            // Detect if this is a bot request
            var isBot = BotDetectionHelper.IsBot(context);
            var defaultCulture = _localizationService.DefaultCulture;

            // For bots, rewrite the path to include default culture WITHOUT redirect
            // This allows bots to access "/" as equivalent to "/en/"
            if (isBot)
            {
                var culture = new CultureInfo(defaultCulture);
                CultureInfo.CurrentCulture = culture;
                CultureInfo.CurrentUICulture = culture;
                context.Items["Culture"] = defaultCulture;
                
                // SEO: Add headers to help search engines understand content negotiation
                context.Response.Headers.Vary = "Accept-Language";
                context.Response.Headers.ContentLanguage = defaultCulture;
                
                // Rewrite the path to include the culture prefix
                var newPath = $"/{defaultCulture}{path}";
                
                // Ensure trailing slash for directory-like paths if root
                if (path == "/" && !newPath.EndsWith('/'))
                {
                    newPath += '/';
                }
                
                context.Request.Path = newPath;
                
                await _next(context);
                return;
            }

            // For regular users, redirect to localized path
            // SEO: Indicate that response varies by language preference
            context.Response.Headers.Vary = "Accept-Language";
            
            var browserCulture = GetBrowserCulture(context);
            var targetCulture = _localizationService.IsCultureSupported(browserCulture) 
                ? browserCulture 
                : defaultCulture;

            // SAFETY CHECK: Prevent redirect loop if path already starts with target culture
            // This handles cases where GetCultureFromPath might have missed it
            if (path.StartsWith($"/{targetCulture}/", StringComparison.OrdinalIgnoreCase) || 
                path.Equals($"/{targetCulture}", StringComparison.OrdinalIgnoreCase))
            {
                context.Items["Culture"] = targetCulture;
                await _next(context);
                return;
            }

            var newPath2 = $"/{targetCulture}{path}";
            // Ensure single slash
            if (newPath2.EndsWith("//")) newPath2 = newPath2.TrimEnd('/');
            
            // Preserve query string
            var queryString = context.Request.QueryString;
            
            context.Response.Redirect(newPath2 + queryString, permanent: false);
            return;
        }

        // Set culture for the request using Items (will be picked up by RequestLocalizationMiddleware)
        context.Items["Culture"] = cultureFromPath;

        await _next(context);
    }

    private string GetBrowserCulture(HttpContext context)
    {
        var acceptLanguageHeader = context.Request.Headers.AcceptLanguage.ToString();
        if (string.IsNullOrEmpty(acceptLanguageHeader))
        {
            return _localizationService.DefaultCulture;
        }

        try 
        {
            var languages = acceptLanguageHeader.Split(',')
                .Select(lang => lang.Split(';')[0].Trim())
                .Select(lang => lang.Length >= 2 ? lang[..2] : lang);

            foreach (var lang in languages)
            {
                if (_localizationService.IsCultureSupported(lang))
                {
                    return lang;
                }
            }
        }
        catch
        {
            // Fallback on any parsing error
        }

        return _localizationService.DefaultCulture;
    }
}

