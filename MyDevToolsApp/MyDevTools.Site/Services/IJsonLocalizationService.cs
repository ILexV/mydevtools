namespace MyDevTools.Site.Services;

/// <summary>
/// Service for loading and accessing JSON-based localization resources.
/// </summary>
public interface IJsonLocalizationService
{
    /// <summary>
    /// Gets a localized string for the specified namespace and key.
    /// </summary>
    /// <param name="lang">Language code (e.g., "en", "ru")</param>
    /// <param name="namespace">Namespace/path (e.g., "tools/json-beautifier")</param>
    /// <param name="key">Localization key (e.g., "Title")</param>
    /// <returns>Localized string or key if not found</returns>
    string Get(string lang, string @namespace, string key);
    
    /// <summary>
    /// Gets all localized strings for the specified namespace.
    /// </summary>
    /// <param name="lang">Language code</param>
    /// <param name="namespace">Namespace/path</param>
    /// <returns>Dictionary of all keys and values</returns>
    IReadOnlyDictionary<string, string> GetAll(string lang, string @namespace);
    
    /// <summary>
    /// Checks if a localization exists for the specified namespace.
    /// </summary>
    bool HasNamespace(string lang, string @namespace);

    /// <summary>
    /// Initializes the service by preloading all localization files.
    /// </summary>
    Task InitializeAsync();
}
