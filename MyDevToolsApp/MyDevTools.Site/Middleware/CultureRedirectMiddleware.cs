using MyDevTools.Site.Services;
using System.Globalization;

namespace MyDevTools.Site.Middleware;

/// <summary>
/// Middleware that redirects requests without a culture prefix to the appropriate culture-specific URL.
/// Detects browser language and redirects to /{lang}/{path}.
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
        
        // Skip static files and already localized paths
        if (path.StartsWith("/_") || 
            path.StartsWith("/css") || 
            path.StartsWith("/js") || 
            path.StartsWith("/lib") ||
            path.Contains('.'))
        {
            await _next(context);
            return;
        }

        var cultureFromPath = _localizationService.GetCultureFromPath(path);
        
        if (cultureFromPath == null)
        {
            // Detect browser language
            var browserCulture = GetBrowserCulture(context);
            var targetCulture = _localizationService.IsCultureSupported(browserCulture) 
                ? browserCulture 
                : _localizationService.DefaultCulture;

            var newPath = $"/{targetCulture}{path}";
            context.Response.Redirect(newPath, permanent: false);
            return;
        }

        // Set culture for the request
        var culture = new CultureInfo(cultureFromPath);
        CultureInfo.CurrentCulture = culture;
        CultureInfo.CurrentUICulture = culture;

        await _next(context);
    }

    private string GetBrowserCulture(HttpContext context)
    {
        var acceptLanguageHeader = context.Request.Headers.AcceptLanguage.ToString();
        if (string.IsNullOrEmpty(acceptLanguageHeader))
        {
            return _localizationService.DefaultCulture;
        }

        var languages = acceptLanguageHeader.Split(',')
            .Select(lang => lang.Split(';')[0].Trim())
            .Select(lang => lang.Length > 2 ? lang[..2] : lang);

        foreach (var lang in languages)
        {
            if (_localizationService.IsCultureSupported(lang))
            {
                return lang;
            }
        }

        return _localizationService.DefaultCulture;
    }
}
