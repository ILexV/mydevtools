namespace MyDevTools.Site.Services;

/// <summary>
/// Service for managing localization and culture information.
/// </summary>
public interface ILocalizationService
{
    /// <summary>
    /// Gets the list of supported cultures.
    /// </summary>
    string[] SupportedCultures { get; }

    /// <summary>
    /// Gets the default culture.
    /// </summary>
    string DefaultCulture { get; }

    /// <summary>
    /// Checks if the culture is supported.
    /// </summary>
    bool IsCultureSupported(string culture);

    /// <summary>
    /// Gets the culture from the request path.
    /// </summary>
    string? GetCultureFromPath(string path);
}
