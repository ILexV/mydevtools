using MyDevTools.Site.Components;
using MyDevTools.Site.Middleware;
using MyDevTools.Site.Services;
using Microsoft.AspNetCore.Localization;
using Microsoft.AspNetCore.HttpOverrides;
using System.Globalization;
using Microsoft.Extensions.WebEncoders;
using System.Text.Encodings.Web;
using System.Text.Unicode;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container
builder.Services.AddSingleton<HtmlEncoder>(
    HtmlEncoder.Create(allowedRanges: new[] { UnicodeRanges.All }));

builder.Services.Configure<WebEncoderOptions>(options =>
{
    options.TextEncoderSettings = new TextEncoderSettings(UnicodeRanges.All);
});

builder.Services.AddRazorComponents();
builder.Services.AddHttpContextAccessor();

// Configure memory cache with size limit (100 MB)
builder.Services.AddMemoryCache(options =>
{
    options.SizeLimit = 100 * 1024 * 1024; // 100 MB
});

// Add response caching
builder.Services.AddResponseCaching();

// Add response compression (gzip and brotli)
builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<Microsoft.AspNetCore.ResponseCompression.BrotliCompressionProvider>();
    options.Providers.Add<Microsoft.AspNetCore.ResponseCompression.GzipCompressionProvider>();
});

builder.Services.Configure<Microsoft.AspNetCore.ResponseCompression.BrotliCompressionProviderOptions>(options =>
{
    options.Level = System.IO.Compression.CompressionLevel.Fastest;
});

builder.Services.Configure<Microsoft.AspNetCore.ResponseCompression.GzipCompressionProviderOptions>(options =>
{
    options.Level = System.IO.Compression.CompressionLevel.Fastest;
});

// Localization
builder.Services.AddLocalization(options => options.ResourcesPath = "Resources");
builder.Services.AddSingleton<ILocalizationService, LocalizationService>();
builder.Services.AddSingleton<IJsonLocalizationService, JsonLocalizationService>();

// Configure supported cultures
var supportedCultures = new[] { "en", "ru", "es", "de", "pt", "zh", "fr", "ja", "ko", "hi" };
var localizationOptions = new RequestLocalizationOptions
{
    DefaultRequestCulture = new RequestCulture("en"),
    SupportedCultures = supportedCultures.Select(c => new CultureInfo(c)).ToArray(),
    SupportedUICultures = supportedCultures.Select(c => new CultureInfo(c)).ToArray()
};

// Custom culture provider that reads from route
localizationOptions.RequestCultureProviders.Insert(0, new RouteDataRequestCultureProvider());

var app = builder.Build();

// Configure Forwarded Headers for Nginx/Proxy
// This ensures correct scheme (https) and remote IP are used when running behind a reverse proxy
app.UseForwardedHeaders(new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto
});

// Configure the HTTP request pipeline
if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error", createScopeForErrors: true);
    app.UseHsts();
    app.UseHttpsRedirection();
}

app.UseStatusCodePagesWithReExecute("/not-found", createScopeForStatusCodePages: true);

// Sitemap must be served before any response manipulation to avoid conflicts
app.UseMiddleware<SitemapMiddleware>();

// Force charset=utf-8 for text/html responses
app.Use(async (context, next) =>
{
    context.Response.OnStarting(() =>
    {
        if (context.Response.ContentType != null &&
            context.Response.ContentType.StartsWith("text/html", StringComparison.OrdinalIgnoreCase) &&
            !context.Response.ContentType.Contains("charset", StringComparison.OrdinalIgnoreCase))
        {
            context.Response.ContentType += "; charset=utf-8";
        }
        return Task.CompletedTask;
    });
    await next();
});

// Response compression (gzip/brotli) - must be before caching
app.UseResponseCompression();

// Serve static files from memory (reduces disk I/O)
app.UseMiddleware<MemoryStaticFileMiddleware>();

// Response caching middleware (before localization)
app.UseResponseCaching();
app.UseMiddleware<ResponseCachingMiddleware>();

// Handle HEAD requests from bots/crawlers
app.UseMiddleware<HeadRequestMiddleware>();

// Use custom culture redirect middleware
app.UseMiddleware<CultureRedirectMiddleware>();

// Then use request localization
app.UseRequestLocalization(localizationOptions);

app.UseAntiforgery();

app.MapStaticAssets();
app.MapRazorComponents<App>();

// Initialize localization service
var localizationService = app.Services.GetRequiredService<IJsonLocalizationService>();
await localizationService.InitializeAsync();

app.Run();

/// <summary>
/// Custom culture provider that extracts culture from the route path /{lang}/...
/// </summary>
public class RouteDataRequestCultureProvider : RequestCultureProvider
{
    public override Task<ProviderCultureResult?> DetermineProviderCultureResult(HttpContext httpContext)
    {
        var path = httpContext.Request.Path.Value ?? "";
        var segments = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        
        if (segments.Length > 0)
        {
            var possibleCulture = segments[0];
            var supportedCultures = new[] { "en", "ru", "es", "de", "pt", "zh", "fr", "ja", "ko", "hi" };
            
            if (supportedCultures.Contains(possibleCulture, StringComparer.OrdinalIgnoreCase))
            {
                return Task.FromResult<ProviderCultureResult?>(
                    new ProviderCultureResult(possibleCulture, possibleCulture));
            }
        }
        
        return Task.FromResult<ProviderCultureResult?>(null);
    }
}
