namespace MyDevTools.Site.Services;

/// <summary>
/// Implementation of localization service.
/// </summary>
public class LocalizationService : ILocalizationService
{
    public string[] SupportedCultures { get; } = ["en", "ru", "es"];
    
    public string DefaultCulture { get; } = "en";

    public bool IsCultureSupported(string culture)
    {
        return SupportedCultures.Contains(culture, StringComparer.OrdinalIgnoreCase);
    }

    public string? GetCultureFromPath(string path)
    {
        var segments = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length > 0 && IsCultureSupported(segments[0]))
        {
            return segments[0];
        }
        return null;
    }
}
