using MyDevTools.Site.Components;
using MyDevTools.Site.Middleware;
using MyDevTools.Site.Services;
using Microsoft.AspNetCore.Localization;
using System.Globalization;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container
builder.Services.AddRazorComponents();

// Localization
builder.Services.AddLocalization(options => options.ResourcesPath = "Resources");
builder.Services.AddSingleton<ILocalizationService, LocalizationService>();

// Configure supported cultures
var supportedCultures = new[] { "en", "ru", "es" };
var localizationOptions = new RequestLocalizationOptions
{
    DefaultRequestCulture = new RequestCulture("en"),
    SupportedCultures = supportedCultures.Select(c => new CultureInfo(c)).ToArray(),
    SupportedUICultures = supportedCultures.Select(c => new CultureInfo(c)).ToArray()
};

// Custom culture provider that reads from route
localizationOptions.RequestCultureProviders.Insert(0, new RouteDataRequestCultureProvider());

var app = builder.Build();

// Configure the HTTP request pipeline
if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error", createScopeForErrors: true);
    app.UseHsts();
}

app.UseStatusCodePagesWithReExecute("/not-found", createScopeForStatusCodePages: true);
app.UseHttpsRedirection();

// Use custom culture redirect middleware FIRST
app.UseMiddleware<CultureRedirectMiddleware>();

// Then use request localization
app.UseRequestLocalization(localizationOptions);

app.UseAntiforgery();

app.MapStaticAssets();
app.MapRazorComponents<App>();

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
            var supportedCultures = new[] { "en", "ru", "es" };
            
            if (supportedCultures.Contains(possibleCulture, StringComparer.OrdinalIgnoreCase))
            {
                return Task.FromResult<ProviderCultureResult?>(
                    new ProviderCultureResult(possibleCulture, possibleCulture));
            }
        }
        
        return Task.FromResult<ProviderCultureResult?>(null);
    }
}
