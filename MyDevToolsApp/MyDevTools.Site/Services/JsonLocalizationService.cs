using System.Collections.Concurrent;
using System.Text.Json;

namespace MyDevTools.Site.Services;

/// <summary>
/// Implementation of JSON localization service with caching and fallback support.
/// </summary>
public class JsonLocalizationService : IJsonLocalizationService
{
    private readonly IWebHostEnvironment _environment;
    private readonly ILogger<JsonLocalizationService> _logger;
    
    // Cache: lang -> namespace -> key -> value
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, IReadOnlyDictionary<string, string>>> _cache = new();
    
    private readonly string[] _supportedLanguages = ["en", "ru", "es", "de", "pt", "fr", "ja", "ko", "hi", "zh"];
    private readonly string _defaultLanguage = "en";
    
    public JsonLocalizationService(
        IWebHostEnvironment environment,
        ILogger<JsonLocalizationService> logger)
    {
        _environment = environment;
        _logger = logger;
    }

    public async Task InitializeAsync()
    {
        _logger.LogInformation("Initializing JSON localization service...");
        var sw = System.Diagnostics.Stopwatch.StartNew();
        
        var i18nPath = Path.Combine(_environment.WebRootPath, "i18n");
        if (!Directory.Exists(i18nPath))
        {
            _logger.LogWarning("Localization directory not found: {Path}", i18nPath);
            return;
        }

        var files = Directory.GetFiles(i18nPath, "*.json", SearchOption.AllDirectories);
        
        // Parallel processing of files
        var tasks = files.Select(async filePath => 
        {
            try 
            {
                var relativePath = Path.GetRelativePath(i18nPath, filePath);
                var parts = relativePath.Split(Path.DirectorySeparatorChar);
                
                if (parts.Length < 2) return; 
                
                var lang = parts[0];
                
                // Construct namespace: join parts after lang with forward slash, remove extension
                // e.g. "en/tools/json-beautifier.json" -> "tools/json-beautifier"
                var relativeNamespacePath = string.Join("/", parts.Skip(1));
                // Remove .json extension
                if (relativeNamespacePath.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
                {
                    relativeNamespacePath = relativeNamespacePath.Substring(0, relativeNamespacePath.Length - 5);
                }
                
                var json = await File.ReadAllTextAsync(filePath);
                var values = JsonSerializer.Deserialize<Dictionary<string, string>>(json);
                
                if (values != null)
                {
                    var readonlyValues = values.AsReadOnly();
                    
                    var langCache = _cache.GetOrAdd(lang, _ => new ConcurrentDictionary<string, IReadOnlyDictionary<string, string>>());
                    langCache[relativeNamespacePath] = readonlyValues;
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to preload localization file: {Path}", filePath);
            }
        });

        await Task.WhenAll(tasks);
        
        sw.Stop();
        _logger.LogInformation("Localization initialized in {Elapsed}ms. Cache size: {Count} languages.", 
            sw.ElapsedMilliseconds, _cache.Count);
    }
    
    public string Get(string lang, string @namespace, string key)
    {
        // Validate language
        if (!_supportedLanguages.Contains(lang))
        {
            lang = _defaultLanguage;
        }
        
        // Try to get from requested language
        var values = LoadNamespace(lang, @namespace);
        if (values.TryGetValue(key, out var value))
        {
            return value;
        }
        
        // Fallback to default language
        if (lang != _defaultLanguage)
        {
            var defaultValues = LoadNamespace(_defaultLanguage, @namespace);
            if (defaultValues.TryGetValue(key, out var defaultValue))
            {
                return defaultValue;
            }
        }
        
        // Return key as fallback
        _logger.LogWarning(
            "Localization key not found: {Lang}/{Namespace}/{Key}", 
            lang, @namespace, key);
        return key;
    }
    
    public IReadOnlyDictionary<string, string> GetAll(string lang, string @namespace)
    {
        // Validate language
        if (!_supportedLanguages.Contains(lang))
        {
            lang = _defaultLanguage;
        }
        
        var values = LoadNamespace(lang, @namespace);
        
        // If not default language, merge with default
        if (lang != _defaultLanguage)
        {
            var defaultValues = LoadNamespace(_defaultLanguage, @namespace);
            var merged = new Dictionary<string, string>(defaultValues);
            
            foreach (var kvp in values)
            {
                merged[kvp.Key] = kvp.Value;
            }
            
            return merged;
        }
        
        return values;
    }
    
    public bool HasNamespace(string lang, string @namespace)
    {
        if (!_supportedLanguages.Contains(lang))
        {
            lang = _defaultLanguage;
        }
        
        var values = LoadNamespace(lang, @namespace);
        return values.Count > 0;
    }
    
    private IReadOnlyDictionary<string, string> LoadNamespace(string lang, string @namespace)
    {
        // Check cache first
        if (_cache.TryGetValue(lang, out var langCache) && 
            langCache.TryGetValue(@namespace, out var cached))
        {
            return cached;
        }
        
        // Load from file
        var filePath = Path.Combine(
            _environment.WebRootPath, 
            "i18n", 
            lang, 
            $"{@namespace}.json");
        
        try
        {
            if (File.Exists(filePath))
            {
                var json = File.ReadAllText(filePath);
                var values = JsonSerializer.Deserialize<Dictionary<string, string>>(json);
                
                if (values != null)
                {
                    var readonlyValues = values.AsReadOnly();
                    
                    // Add to cache
                    var langDict = _cache.GetOrAdd(lang, _ => new ConcurrentDictionary<string, IReadOnlyDictionary<string, string>>());
                    langDict[@namespace] = readonlyValues;
                    
                    return readonlyValues;
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, 
                "Error loading localization file: {FilePath}", 
                filePath);
        }
        
        // Return empty dictionary if file not found or error
        return new Dictionary<string, string>().AsReadOnly();
    }
    
    /// <summary>
    /// Clears the cache for a specific language or all languages.
    /// </summary>
    public void ClearCache(string? lang = null)
    {
        if (lang == null)
        {
            _cache.Clear();
        }
        else
        {
            _cache.TryRemove(lang, out _);
        }
    }
}
