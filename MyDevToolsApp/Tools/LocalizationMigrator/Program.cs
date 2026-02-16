using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace LocalizationMigrator;

class Program
{
    private static readonly string[] SupportedLanguages = ["en", "ru", "es", "de", "pt", "fr", "ja", "ko", "hi", "zh"];
    private static readonly Regex AppStringsPattern = new(@"AppStrings\.([A-Za-z0-9]+)_", RegexOptions.Compiled);
    private static readonly Regex PageRoutePattern = new(@"@page\s+""/\{lang\}/([^""/]+)""", RegexOptions.Compiled);

    static async Task Main(string[] args)
    {
        var options = ParseArguments(args);
        
        Console.WriteLine("=== Localization Migration Tool ===\n");
        
        var siteRoot = options.SiteRoot ?? Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), "..", "..", "MyDevTools.Site"));
        
        if (!Directory.Exists(siteRoot))
        {
            Console.WriteLine($"Error: Site root not found: {siteRoot}");
            return;
        }
        
        Console.WriteLine($"Site root: {siteRoot}\n");
        
        // Scan tools
        Console.WriteLine("Scanning Razor components...");
        var tools = ScanTools(siteRoot);
        Console.WriteLine($"Found {tools.Count} tools with prefixes\n");
        
        foreach (var tool in tools)
        {
            Console.WriteLine($"  - {tool.Prefix} -> /{tool.Slug}/ ({tool.Keys.Count} keys)");
        }
        Console.WriteLine();
        
        // Load resources
        Console.WriteLine("Loading .resx resources...");
        var resources = await LoadResourcesAsync(siteRoot, options.Languages);
        Console.WriteLine($"Loaded resources for {resources.Count} languages\n");
        
        // Generate report
        Console.WriteLine("=== Analysis Report ===\n");
        
        var report = AnalyzeTools(tools, resources);
        PrintReport(report);
        
        if (options.DryRun)
        {
            Console.WriteLine("\n=== Dry Run Mode - No files written ===");
            return;
        }
        
        // Generate JSON files
        Console.WriteLine("\n=== Generating JSON files ===\n");
        await GenerateJsonFilesAsync(siteRoot, tools, resources, options.Overwrite);
        
        Console.WriteLine("\n=== Migration complete! ===");
    }
    
    private static List<ToolInfo> ScanTools(string siteRoot)
    {
        var toolsPath = Path.Combine(siteRoot, "Components", "Tools");
        var tools = new List<ToolInfo>();
        
        if (!Directory.Exists(toolsPath))
        {
            Console.WriteLine($"Warning: Tools directory not found: {toolsPath}");
            return tools;
        }
        
        var razorFiles = Directory.GetFiles(toolsPath, "*.razor", SearchOption.TopDirectoryOnly);
        
        foreach (var file in razorFiles)
        {
            var content = File.ReadAllText(file);
            var fileName = Path.GetFileNameWithoutExtension(file);
            
            // Find prefixes
            var matches = AppStringsPattern.Matches(content);
            var prefixes = matches
                .Select(m => m.Groups[1].Value)
                .Distinct()
                .ToList();
            
            if (!prefixes.Any())
            {
                continue;
            }
            
            // Find slug from @page directive
            var slug = ExtractSlug(content, fileName);
            
            foreach (var prefix in prefixes)
            {
                // Skip common prefixes that aren't tool-specific
                if (IsCommonPrefix(prefix))
                {
                    continue;
                }
                
                var existingTool = tools.FirstOrDefault(t => t.Prefix == prefix);
                if (existingTool != null)
                {
                    existingTool.SourceFiles.Add(file);
                }
                else
                {
                    tools.Add(new ToolInfo
                    {
                        Prefix = prefix,
                        Slug = slug,
                        SourceFiles = new List<string> { file },
                        Keys = new List<string>()
                    });
                }
            }
        }
        
        return tools;
    }
    
    private static string ExtractSlug(string content, string fileName)
    {
        // Try to extract from @page directive
        var match = PageRoutePattern.Match(content);
        if (match.Success)
        {
            return match.Groups[1].Value;
        }
        
        // Fallback: convert PascalCase to kebab-case
        return PascalCaseToKebabCase(fileName);
    }
    
    private static string PascalCaseToKebabCase(string input)
    {
        if (string.IsNullOrEmpty(input))
            return input;
        
        var result = new System.Text.StringBuilder();
        
        for (int i = 0; i < input.Length; i++)
        {
            var c = input[i];
            
            if (char.IsUpper(c))
            {
                if (i > 0 && (char.IsLower(input[i - 1]) || (i + 1 < input.Length && char.IsLower(input[i + 1]))))
                {
                    result.Append('-');
                }
                result.Append(char.ToLower(c));
            }
            else
            {
                result.Append(c);
            }
        }
        
        return result.ToString();
    }
    
    private static bool IsCommonPrefix(string prefix)
    {
        var commonPrefixes = new[] { "Common", "Seo", "Nav", "Footer", "CommandPalette", "ToolLayout" };
        return commonPrefixes.Any(p => prefix.StartsWith(p, StringComparison.OrdinalIgnoreCase));
    }
    
    private static async Task<Dictionary<string, Dictionary<string, string>>> LoadResourcesAsync(string siteRoot, string[]? languages)
    {
        var langs = languages ?? SupportedLanguages;
        var resources = new Dictionary<string, Dictionary<string, string>>();
        var resourcesPath = Path.Combine(siteRoot, "Resources");
        
        foreach (var lang in langs)
        {
            var resxFile = lang == "en" 
                ? Path.Combine(resourcesPath, "AppStrings.resx")
                : Path.Combine(resourcesPath, $"AppStrings.{lang}.resx");
            
            if (!File.Exists(resxFile))
            {
                Console.WriteLine($"  Warning: Resource file not found: {resxFile}");
                continue;
            }
            
            var dict = await ParseResxAsync(resxFile);
            resources[lang] = dict;
            Console.WriteLine($"  Loaded {dict.Count} keys from {Path.GetFileName(resxFile)}");
        }
        
        return resources;
    }
    
    private static async Task<Dictionary<string, string>> ParseResxAsync(string resxPath)
    {
        var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        
        var doc = await XDocument.LoadAsync(File.OpenRead(resxPath), LoadOptions.None, CancellationToken.None);
        
        foreach (var dataElement in doc.Descendants("data"))
        {
            var name = dataElement.Attribute("name")?.Value;
            var value = dataElement.Element("value")?.Value;
            
            if (!string.IsNullOrEmpty(name) && value != null)
            {
                dict[name] = value;
            }
        }
        
        return dict;
    }
    
    private static MigrationReport AnalyzeTools(List<ToolInfo> tools, Dictionary<string, Dictionary<string, string>> resources)
    {
        var report = new MigrationReport
        {
            Tools = tools,
            MissingTranslations = new Dictionary<string, List<MissingTranslation>>(),
            UnusedPrefixes = new List<UnusedPrefix>()
        };
        
        var enResources = resources.GetValueOrDefault("en") ?? new Dictionary<string, string>();
        
        // Analyze each tool
        foreach (var tool in tools)
        {
            var prefix = tool.Prefix;
            var toolKeys = enResources.Keys
                .Where(k => k.StartsWith($"{prefix}_", StringComparison.OrdinalIgnoreCase))
                .ToList();
            
            tool.Keys = toolKeys;
            
            // Check for missing translations in other languages
            foreach (var (lang, langResources) in resources.Where(r => r.Key != "en"))
            {
                if (!report.MissingTranslations.ContainsKey(lang))
                {
                    report.MissingTranslations[lang] = new List<MissingTranslation>();
                }
                
                foreach (var key in toolKeys)
                {
                    if (!langResources.ContainsKey(key))
                    {
                        report.MissingTranslations[lang].Add(new MissingTranslation
                        {
                            Tool = tool.Slug,
                            Key = key,
                            EnglishValue = enResources.GetValueOrDefault(key, "")
                        });
                    }
                }
            }
        }
        
        // Find unused prefixes (keys in resources that don't match any tool)
        var allToolPrefixes = tools.Select(t => t.Prefix).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var usedKeys = new HashSet<string>();
        
        foreach (var tool in tools)
        {
            foreach (var key in tool.Keys)
            {
                usedKeys.Add(key);
            }
        }
        
        foreach (var key in enResources.Keys.Where(k => !IsCommonKey(k)))
        {
            if (!usedKeys.Contains(key))
            {
                var prefix = key.Split('_')[0];
                report.UnusedPrefixes.Add(new UnusedPrefix
                {
                    Key = key,
                    Prefix = prefix,
                    Value = enResources[key]
                });
            }
        }
        
        return report;
    }
    
    private static bool IsCommonKey(string key)
    {
        return key.StartsWith("Common_") || 
               key.StartsWith("Seo_") || 
               key.StartsWith("Nav_") ||
               key.StartsWith("Footer_") ||
               key.StartsWith("CommandPalette_") ||
               key.StartsWith("ToolLayout_");
    }
    
    private static void PrintReport(MigrationReport report)
    {
        Console.WriteLine($"Tools found: {report.Tools.Count}");
        Console.WriteLine($"Total keys across all tools: {report.Tools.Sum(t => t.Keys.Count)}");
        Console.WriteLine();
        
        // Missing translations
        Console.WriteLine("Missing Translations:");
        if (report.MissingTranslations.Any())
        {
            foreach (var (lang, missing) in report.MissingTranslations.Where(m => m.Value.Any()))
            {
                Console.WriteLine($"  {lang}: {missing.Count} missing");
                foreach (var item in missing.Take(5))
                {
                    Console.WriteLine($"    - {item.Key}");
                }
                if (missing.Count > 5)
                {
                    Console.WriteLine($"    ... and {missing.Count - 5} more");
                }
            }
        }
        else
        {
            Console.WriteLine("  None - all translations complete!");
        }
        Console.WriteLine();
        
        // Unused prefixes
        Console.WriteLine($"Unused keys in resources: {report.UnusedPrefixes.Count}");
        if (report.UnusedPrefixes.Any())
        {
            var grouped = report.UnusedPrefixes.GroupBy(u => u.Prefix);
            foreach (var group in grouped.Take(10))
            {
                Console.WriteLine($"  {group.Key}: {group.Count()} keys");
            }
        }
        Console.WriteLine();
        
        // Per-tool summary
        Console.WriteLine("Per-tool key count:");
        foreach (var tool in report.Tools.OrderByDescending(t => t.Keys.Count))
        {
            Console.WriteLine($"  {tool.Prefix,-30} ({tool.Slug,-25}): {tool.Keys.Count,3} keys");
        }
    }
    
    private static async Task GenerateJsonFilesAsync(
        string siteRoot, 
        List<ToolInfo> tools, 
        Dictionary<string, Dictionary<string, string>> resources,
        bool overwrite)
    {
        var i18nPath = Path.Combine(siteRoot, "wwwroot", "i18n");
        
        // Group tools by slug (multiple prefixes can share same slug)
        var toolsBySlug = tools.GroupBy(t => t.Slug.ToLowerInvariant())
            .ToDictionary(g => g.Key, g => g.ToList());
        
        foreach (var (lang, langResources) in resources)
        {
            var langPath = Path.Combine(i18nPath, lang, "tools");
            Directory.CreateDirectory(langPath);
            
            Console.WriteLine($"Processing language: {lang}");
            
            foreach (var (slugSlug, slugTools) in toolsBySlug)
            {
                var jsonPath = Path.Combine(langPath, $"{slugSlug}.json");
                
                if (File.Exists(jsonPath) && !overwrite)
                {
                    Console.WriteLine($"  Skipping {slugSlug}.json (exists, use --overwrite to replace)");
                    continue;
                }
                
                // Merge data from all prefixes for this slug
                var toolData = new Dictionary<string, string>();
                var mergedPrefixes = new List<string>();
                
                foreach (var tool in slugTools)
                {
                    var prefix = tool.Prefix;
                    var prefixKeys = langResources.Keys
                        .Where(k => k.StartsWith($"{prefix}_", StringComparison.OrdinalIgnoreCase))
                        .ToList();
                    
                    foreach (var key in prefixKeys)
                    {
                        var jsonKey = key.Substring(prefix.Length + 1); // Remove "Prefix_"
                        
                        // Handle potential duplicates (last wins, but warn)
                        if (toolData.ContainsKey(jsonKey))
                        {
                            Console.WriteLine($"    Warning: Duplicate key '{jsonKey}' from prefix '{prefix}' overwriting existing value");
                        }
                        
                        toolData[jsonKey] = langResources[key];
                    }
                    
                    if (prefixKeys.Any())
                    {
                        mergedPrefixes.Add($"{prefix}({prefixKeys.Count})");
                    }
                }
                
                if (!toolData.Any())
                {
                    Console.WriteLine($"  Skipping {slugSlug}.json (no keys found)");
                    continue;
                }
                
                // Serialize with nice formatting and preserve UTF-8 characters
                var json = JsonSerializer.Serialize(toolData, new JsonSerializerOptions
                {
                    WriteIndented = true,
                    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                    Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
                });
                
                await File.WriteAllTextAsync(jsonPath, json, new System.Text.UTF8Encoding(false));
                Console.WriteLine($"  Created: {Path.GetRelativePath(siteRoot, jsonPath)} ({toolData.Count} keys from prefixes: {string.Join(", ", mergedPrefixes)})");
            }
        }
    }
    
    private static Options ParseArguments(string[] args)
    {
        var options = new Options();
        
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i].ToLower())
            {
                case "--site-root":
                    if (i + 1 < args.Length) options.SiteRoot = args[++i];
                    break;
                case "--lang":
                    if (i + 1 < args.Length)
                    {
                        options.Languages = args[++i].Split(',');
                    }
                    break;
                case "--dry-run":
                    options.DryRun = true;
                    break;
                case "--overwrite":
                    options.Overwrite = true;
                    break;
                case "--help":
                case "-h":
                    PrintHelp();
                    Environment.Exit(0);
                    break;
            }
        }
        
        return options;
    }
    
    private static void PrintHelp()
    {
        Console.WriteLine("Localization Migration Tool");
        Console.WriteLine();
        Console.WriteLine("Usage: dotnet run [options]");
        Console.WriteLine();
        Console.WriteLine("Options:");
        Console.WriteLine("  --site-root <path>   Path to MyDevTools.Site folder");
        Console.WriteLine("  --lang <langs>       Comma-separated list of languages (default: all 10)");
        Console.WriteLine("  --dry-run            Analyze only, don't write files");
        Console.WriteLine("  --overwrite          Overwrite existing JSON files");
        Console.WriteLine("  --help, -h           Show this help");
        Console.WriteLine();
        Console.WriteLine("Example:");
        Console.WriteLine("  dotnet run --dry-run");
        Console.WriteLine("  dotnet run --lang en,ru --overwrite");
    }
}

public class ToolInfo
{
    public string Prefix { get; set; } = "";
    public string Slug { get; set; } = "";
    public List<string> SourceFiles { get; set; } = new();
    public List<string> Keys { get; set; } = new();
}

public class MissingTranslation
{
    public string Tool { get; set; } = "";
    public string Key { get; set; } = "";
    public string EnglishValue { get; set; } = "";
}

public class UnusedPrefix
{
    public string Key { get; set; } = "";
    public string Prefix { get; set; } = "";
    public string Value { get; set; } = "";
}

public class MigrationReport
{
    public List<ToolInfo> Tools { get; set; } = new();
    public Dictionary<string, List<MissingTranslation>> MissingTranslations { get; set; } = new();
    public List<UnusedPrefix> UnusedPrefixes { get; set; } = new();
}

public class Options
{
    public string? SiteRoot { get; set; }
    public string[]? Languages { get; set; }
    public bool DryRun { get; set; }
    public bool Overwrite { get; set; }
}
