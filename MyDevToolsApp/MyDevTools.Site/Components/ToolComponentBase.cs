using Microsoft.AspNetCore.Components;
using MyDevTools.Site.Services;

namespace MyDevTools.Site.Components;

/// <summary>
/// Base class for tool components with JSON localization support.
/// </summary>
public abstract class ToolComponentBase : ComponentBase
{
    [Inject]
    protected IJsonLocalizationService JsonLocalization { get; set; } = default!;
    
    [Parameter]
    public string Lang { get; set; } = "en";
    
    /// <summary>
    /// Gets the namespace for this tool (e.g., "tools/json-beautifier").
    /// Set in derived classes.
    /// </summary>
    protected virtual string LocalizationNamespace { get; set; } = "";
    
    /// <summary>
    /// Gets a localized string by key.
    /// </summary>
    protected string T(string key)
    {
        return JsonLocalization.Get(Lang, LocalizationNamespace, key);
    }
    
    /// <summary>
    /// Gets all localized strings for this tool.
    /// </summary>
    protected IReadOnlyDictionary<string, string> GetAllTranslations()
    {
        return JsonLocalization.GetAll(Lang, LocalizationNamespace);
    }
    
    /// <summary>
    /// Gets a common localized string by key (from common.json).
    /// </summary>
    protected string TCommon(string key)
    {
        return JsonLocalization.Get(Lang, "common", key);
    }
}
