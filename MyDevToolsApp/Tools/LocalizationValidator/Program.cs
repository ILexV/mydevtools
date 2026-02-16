using System.Text.Json;
using System.Text.RegularExpressions;

namespace LocalizationValidator;

public class Program
{
    // Supported languages - English is the base language
    private static readonly string[] SupportedLanguages = { "en", "ru", "es", "de", "pt", "zh", "fr", "ja", "ko", "hi" };
    private static readonly string BaseLanguage = "en";
    
    // CLI options
    private static bool _verbose = false;
    private static bool _quiet = false;
    private static string _format = "human"; // "human" or "json"
    private static string[]? _targetLanguages = null;
    private static string _scope = "all"; // "all", "tools", "common", "home"
    private static bool _stats = false;
    
    // Validation results
    private static readonly List<ValidationError> Errors = new();
    private static readonly List<ValidationStats> Stats = new();
    
    public static int Main(string[] args)
    {
        ParseArguments(args);
        
        try
        {
            Console.WriteLine("Localization Validator v1.0");
            Console.WriteLine("==========================");
            Console.WriteLine();
            
            var siteRoot = FindSiteRoot();
            if (string.IsNullOrEmpty(siteRoot))
            {
                PrintError("Could not find MyDevTools.Site directory. Please run from the repository root.");
                return 1;
            }
            
            if (_verbose) Console.WriteLine($"Site root: {siteRoot}");
            
            var i18nPath = Path.Combine(siteRoot, "wwwroot", "i18n");
            var componentsPath = Path.Combine(siteRoot, "Components");
            
            // Phase 1: Validate JSON files structure
            if (!_quiet) Console.WriteLine("Phase 1: Validating JSON file structure...");
            ValidateJsonStructure(i18nPath);
            
            // Phase 2: Cross-language validation
            if (!_quiet) Console.WriteLine("Phase 2: Cross-language key validation...");
            ValidateCrossLanguageKeys(i18nPath);
            
            // Phase 3: Razor file validation
            if (!_quiet) Console.WriteLine("Phase 3: Validating Razor component keys...");
            ValidateRazorComponents(componentsPath, i18nPath);
            
            // Phase 4: Value validation
            if (!_quiet) Console.WriteLine("Phase 4: Validating translation values...");
            ValidateValues(i18nPath);
            
            // Output results
            if (_format == "json")
            {
                OutputJsonResults();
            }
            else
            {
                OutputHumanReadableResults();
            }
            
            if (_stats)
            {
                OutputStats();
            }
            
            return Errors.Count > 0 ? 1 : 0;
        }
        catch (Exception ex)
        {
            PrintError($"Unexpected error: {ex.Message}");
            if (_verbose) Console.WriteLine(ex.StackTrace);
            return 1;
        }
    }
    
    private static void ParseArguments(string[] args)
    {
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--verbose":
                case "-v":
                    _verbose = true;
                    break;
                case "--quiet":
                case "-q":
                    _quiet = true;
                    break;
                case "--format":
                    if (i + 1 < args.Length)
                    {
                        _format = args[++i].ToLowerInvariant();
                        if (_format != "human" && _format != "json")
                        {
                            PrintError($"Invalid format: {_format}. Use 'human' or 'json'.");
                            Environment.Exit(1);
                        }
                    }
                    break;
                case "--lang":
                    if (i + 1 < args.Length)
                    {
                        _targetLanguages = args[++i].Split(',');
                    }
                    break;
                case "--scope":
                    if (i + 1 < args.Length)
                    {
                        _scope = args[++i].ToLowerInvariant();
                        if (_scope != "all" && _scope != "tools" && _scope != "common" && _scope != "home")
                        {
                            PrintError($"Invalid scope: {_scope}. Use 'all', 'tools', 'common', or 'home'.");
                            Environment.Exit(1);
                        }
                    }
                    break;
                case "--stats":
                case "-s":
                    _stats = true;
                    break;
                case "--help":
                case "-h":
                    PrintHelp();
                    Environment.Exit(0);
                    break;
                default:
                    PrintError($"Unknown argument: {args[i]}");
                    Environment.Exit(1);
                    break;
            }
        }
        
        if (_targetLanguages == null)
        {
            _targetLanguages = SupportedLanguages;
        }
    }
    
    private static void PrintHelp()
    {
        Console.WriteLine(@"Localization Validator for MyDevTools

Usage: dotnet run [options]

Options:
  -v, --verbose          Show detailed output
  -q, --quiet            Show only errors
  --format <format>     Output format: 'human' (default) or 'json'
  --lang <langs>         Comma-separated list of languages to check (default: all)
  --scope <scope>        Check scope: 'all' (default), 'tools', 'common', or 'home'
  -s, --stats            Show statistics
  -h, --help             Show this help message

Examples:
  dotnet run --verbose                    # Detailed output
  dotnet run --format json                # JSON output for automation
  dotnet run --lang ru,es,de              # Check specific languages
  dotnet run --scope tools                # Check only tool translations
");
    }
    
    private static string? FindSiteRoot()
    {
        var currentDir = Directory.GetCurrentDirectory();
        var searchDirs = new[] { currentDir, Path.GetDirectoryName(currentDir), Path.GetDirectoryName(Path.GetDirectoryName(currentDir)) };
        
        foreach (var dir in searchDirs.Where(d => d != null))
        {
            var sitePath = Path.Combine(dir!, "MyDevToolsApp", "MyDevTools.Site");
            if (Directory.Exists(sitePath))
            {
                return sitePath;
            }
            
            // Also check if we're already in Tools/LocalizationValidator
            if (dir!.EndsWith("Tools") || dir.EndsWith("LocalizationValidator"))
            {
                sitePath = Path.Combine(dir, "..", "..", "MyDevTools.Site");
                sitePath = Path.GetFullPath(sitePath);
                if (Directory.Exists(sitePath))
                {
                    return sitePath;
                }
            }
        }
        
        return null;
    }
    
    private static void ValidateJsonStructure(string i18nPath)
    {
        var filesChecked = 0;
        
        foreach (var lang in _targetLanguages!)
        {
            var langPath = Path.Combine(i18nPath, lang);
            if (!Directory.Exists(langPath))
            {
                AddError(new ValidationError
                {
                    Type = ErrorType.MissingDirectory,
                    Language = lang,
                    FilePath = langPath,
                    Message = $"Language directory not found: {lang}",
                    Suggestion = $"Create directory: mkdir -p {langPath}"
                });
                continue;
            }
            
            // Check common.json
            if (_scope == "all" || _scope == "common")
            {
                var commonPath = Path.Combine(langPath, "common.json");
                ValidateJsonFile(commonPath, lang, "common", ref filesChecked);
            }
            
            // Check home.json
            if (_scope == "all" || _scope == "home")
            {
                var homePath = Path.Combine(langPath, "home.json");
                ValidateJsonFile(homePath, lang, "home", ref filesChecked);
            }
            
            // Check tool files
            if (_scope == "all" || _scope == "tools")
            {
                var toolsPath = Path.Combine(langPath, "tools");
                if (Directory.Exists(toolsPath))
                {
                    foreach (var file in Directory.GetFiles(toolsPath, "*.json"))
                    {
                        var fileName = Path.GetFileName(file);
                        ValidateJsonFile(file, lang, fileName, ref filesChecked);
                    }
                }
            }
        }
        
        if (!_quiet) Console.WriteLine($"  Validated {filesChecked} JSON files");
    }
    
    private static void ValidateJsonFile(string filePath, string lang, string fileName, ref int filesChecked)
    {
        if (!File.Exists(filePath))
        {
            AddError(new ValidationError
            {
                Type = ErrorType.MissingFile,
                Language = lang,
                FilePath = filePath,
                Message = $"File not found: {lang}/{fileName}",
                Suggestion = lang == BaseLanguage 
                    ? $"Create base file: {filePath}"
                    : $"Copy from base language: cp i18n/{BaseLanguage}/{fileName} i18n/{lang}/{fileName}"
            });
            return;
        }
        
        filesChecked++;
        
        try
        {
            var json = File.ReadAllText(filePath);
            var data = JsonSerializer.Deserialize<Dictionary<string, string>>(json);
            
            if (data == null)
            {
                AddError(new ValidationError
                {
                    Type = ErrorType.InvalidJson,
                    Language = lang,
                    FilePath = filePath,
                    Message = $"Failed to parse JSON: {fileName}",
                    Suggestion = "Check JSON syntax - the file may be malformed"
                });
                return;
            }
            
            // Check for duplicate keys (JSON spec says last wins, but we want to detect this)
            var lines = json.Split('\n');
            var keyPattern = new Regex(@"^\s*""([^""]+)""\s*:");
            var foundKeys = new HashSet<string>();
            var duplicateKeys = new List<string>();
            
            foreach (var line in lines)
            {
                var match = keyPattern.Match(line);
                if (match.Success)
                {
                    var key = match.Groups[1].Value;
                    if (!foundKeys.Add(key))
                    {
                        duplicateKeys.Add(key);
                    }
                }
            }
            
            if (duplicateKeys.Any())
            {
                AddError(new ValidationError
                {
                    Type = ErrorType.DuplicateKeys,
                    Language = lang,
                    FilePath = filePath,
                    Message = $"Duplicate keys found: {string.Join(", ", duplicateKeys)}",
                    Keys = duplicateKeys.ToArray(),
                    Suggestion = $"Remove duplicate keys from {fileName}"
                });
            }
            
            // Store stats
            Stats.Add(new ValidationStats
            {
                Language = lang,
                FileName = fileName,
                KeyCount = data.Count
            });
            
            if (_verbose) Console.WriteLine($"  ✓ {lang}/{fileName} ({data.Count} keys)");
        }
        catch (JsonException ex)
        {
            AddError(new ValidationError
            {
                Type = ErrorType.InvalidJson,
                Language = lang,
                FilePath = filePath,
                Message = $"JSON parse error in {fileName}: {ex.Message}",
                Suggestion = "Fix JSON syntax error"
            });
        }
    }
    
    private static void ValidateCrossLanguageKeys(string i18nPath)
    {
        if (_targetLanguages!.Length == 0) return;
        
        var baseLang = _targetLanguages.Contains(BaseLanguage) ? BaseLanguage : _targetLanguages[0];
        var basePath = Path.Combine(i18nPath, baseLang);
        
        // Get all files from base language as reference
        var referenceFiles = new List<string>();
        
        if (_scope == "all" || _scope == "common")
            referenceFiles.Add(Path.Combine(basePath, "common.json"));
        
        if (_scope == "all" || _scope == "home")
            referenceFiles.Add(Path.Combine(basePath, "home.json"));
        
        if (_scope == "all" || _scope == "tools")
        {
            var toolsPath = Path.Combine(basePath, "tools");
            if (Directory.Exists(toolsPath))
            {
                referenceFiles.AddRange(Directory.GetFiles(toolsPath, "*.json"));
            }
        }
        
        foreach (var baseFile in referenceFiles.Where(File.Exists))
        {
            var fileName = Path.GetFileName(baseFile);
            var relativePath = baseFile.Replace(basePath, "").TrimStart(Path.DirectorySeparatorChar);
            
            var baseJson = File.ReadAllText(baseFile);
            var baseData = JsonSerializer.Deserialize<Dictionary<string, string>>(baseJson);
            if (baseData == null) continue;
            
            var baseKeys = new HashSet<string>(baseData.Keys);
            
            // Check each target language
            foreach (var lang in _targetLanguages.Where(l => l != baseLang))
            {
                var langFile = Path.Combine(i18nPath, lang, relativePath);
                
                if (!File.Exists(langFile))
                {
                    AddError(new ValidationError
                    {
                        Type = ErrorType.MissingFile,
                        Language = lang,
                        FilePath = langFile,
                        ReferenceFile = baseFile,
                        Message = $"Missing file: {lang}/{relativePath}",
                        Suggestion = $"Create file by copying from {baseLang}: cp i18n/{baseLang}/{relativePath} i18n/{lang}/{relativePath}"
                    });
                    continue;
                }
                
                var langJson = File.ReadAllText(langFile);
                var langData = JsonSerializer.Deserialize<Dictionary<string, string>>(langJson);
                if (langData == null) continue;
                
                var langKeys = new HashSet<string>(langData.Keys);
                
                // Find missing keys
                var missingKeys = baseKeys.Except(langKeys).ToList();
                if (missingKeys.Any())
                {
                    AddError(new ValidationError
                    {
                        Type = ErrorType.MissingKeys,
                        Language = lang,
                        FilePath = langFile,
                        ReferenceFile = baseFile,
                        Message = $"Missing {missingKeys.Count} keys in {lang}/{relativePath}",
                        Keys = missingKeys.ToArray(),
                        KeyValues = missingKeys.ToDictionary(
                            k => k,
                            k => baseData.TryGetValue(k, out var v) ? v : ""
                        ),
                        Suggestion = $"Add missing keys to {lang}/{relativePath}"
                    });
                }
                
                // Find extra keys (present in lang but not in base)
                var extraKeys = langKeys.Except(baseKeys).ToList();
                if (extraKeys.Any())
                {
                    AddError(new ValidationError
                    {
                        Type = ErrorType.ExtraKeys,
                        Language = lang,
                        FilePath = langFile,
                        ReferenceFile = baseFile,
                        Message = $"Extra keys in {lang}/{relativePath} not present in {baseLang}",
                        Keys = extraKeys.ToArray(),
                        Suggestion = $"Remove extra keys from {lang}/{relativePath} or add them to {baseLang}/{relativePath}"
                    });
                }
            }
        }
    }
    
    private static void ValidateRazorComponents(string componentsPath, string i18nPath)
    {
        if (!Directory.Exists(componentsPath)) return;
        
        var razorFiles = Directory.GetFiles(componentsPath, "*.razor", SearchOption.AllDirectories);
        
        foreach (var razorFile in razorFiles)
        {
            var content = File.ReadAllText(razorFile);
            
            // Check if this is a ToolComponentBase-derived component
            if (!content.Contains("@inherits ToolComponentBase"))
            {
                continue;
            }
            
            // Extract LocalizationNamespace
            var nsMatch = Regex.Match(content, @"LocalizationNamespace\s*\{[^}]+\}\s*=\s*""([^""]+)""");
            if (!nsMatch.Success)
            {
                // Try alternative pattern
                nsMatch = Regex.Match(content, @"protected\s+override\s+string\s+LocalizationNamespace\s*\{[^}]+\}\s*=\s*""([^""]+)""");
            }
            
            if (!nsMatch.Success)
            {
                if (_verbose) Console.WriteLine($"  ⚠ Skipping {Path.GetFileName(razorFile)} - no LocalizationNamespace found");
                continue;
            }
            
            var localizationNamespace = nsMatch.Groups[1].Value;
            var isTool = localizationNamespace.StartsWith("tools/");
            var isHome = localizationNamespace == "home";
            var isCommon = localizationNamespace == "common";
            
            if (!isTool && !isHome && !isCommon)
            {
                if (_verbose) Console.WriteLine($"  ℹ Unknown namespace '{localizationNamespace}' in {Path.GetFileName(razorFile)}");
                continue;
            }
            
            // Skip if scope doesn't match
            if (_scope == "tools" && !isTool) continue;
            if (_scope == "home" && !isHome) continue;
            if (_scope == "common" && !isCommon) continue;
            
            // Extract T() calls
            var tCalls = Regex.Matches(content, @"@T\(""([^""]+)""\)").Select(m => m.Groups[1].Value).Distinct().ToList();
            
            // Extract TCommon() calls
            var tCommonCalls = Regex.Matches(content, @"@TCommon\(""([^""]+)""\)").Select(m => m.Groups[1].Value).Distinct().ToList();
            
            if (!tCalls.Any() && !tCommonCalls.Any())
            {
                if (_verbose) Console.WriteLine($"  ℹ No localization calls in {Path.GetFileName(razorFile)}");
                continue;
            }
            
            if (_verbose) Console.WriteLine($"  Checking {Path.GetFileName(razorFile)}: {tCalls.Count} T() calls, {tCommonCalls.Count} TCommon() calls");
            
            // Validate T() calls against the appropriate JSON file
            if (tCalls.Any())
            {
                string jsonFileName;
                if (isTool)
                {
                    var slug = localizationNamespace.Replace("tools/", "");
                    jsonFileName = $"{slug}.json";
                }
                else if (isHome)
                {
                    jsonFileName = "home.json";
                }
                else
                {
                    jsonFileName = "common.json";
                }
                
                foreach (var lang in _targetLanguages!)
                {
                    var jsonPath = isTool 
                        ? Path.Combine(i18nPath, lang, "tools", jsonFileName)
                        : Path.Combine(i18nPath, lang, jsonFileName);
                    
                    if (!File.Exists(jsonPath))
                    {
                        AddError(new ValidationError
                        {
                            Type = ErrorType.RazorKeyMissingFile,
                            Language = lang,
                            FilePath = razorFile,
                            JsonFilePath = jsonPath,
                            Message = $"Razor file references keys but JSON file doesn't exist: {lang}/{jsonFileName}",
                            Suggestion = $"Create missing JSON file: {jsonPath}"
                        });
                        continue;
                    }
                    
                    var json = File.ReadAllText(jsonPath);
                    var data = JsonSerializer.Deserialize<Dictionary<string, string>>(json);
                    if (data == null) continue;
                    
                    var missingKeys = tCalls.Where(k => !data.ContainsKey(k)).ToList();
                    if (missingKeys.Any())
                    {
                        AddError(new ValidationError
                        {
                            Type = ErrorType.RazorKeyNotFound,
                            Language = lang,
                            FilePath = razorFile,
                            JsonFilePath = jsonPath,
                            Message = $"Keys used in Razor but not found in {lang}/{jsonFileName}",
                            Keys = missingKeys.ToArray(),
                            Suggestion = $"Add missing keys to {lang}/{jsonFileName}"
                        });
                    }
                }
            }
            
            // Validate TCommon() calls against common.json
            if (tCommonCalls.Any())
            {
                foreach (var lang in _targetLanguages!)
                {
                    var commonPath = Path.Combine(i18nPath, lang, "common.json");
                    
                    if (!File.Exists(commonPath))
                    {
                        AddError(new ValidationError
                        {
                            Type = ErrorType.RazorKeyMissingFile,
                            Language = lang,
                            FilePath = razorFile,
                            JsonFilePath = commonPath,
                            Message = $"Razor file uses TCommon() but common.json doesn't exist for {lang}",
                            Suggestion = $"Create missing file: {commonPath}"
                        });
                        continue;
                    }
                    
                    var json = File.ReadAllText(commonPath);
                    var data = JsonSerializer.Deserialize<Dictionary<string, string>>(json);
                    if (data == null) continue;
                    
                    var missingKeys = tCommonCalls.Where(k => !data.ContainsKey(k)).ToList();
                    if (missingKeys.Any())
                    {
                        AddError(new ValidationError
                        {
                            Type = ErrorType.RazorCommonKeyNotFound,
                            Language = lang,
                            FilePath = razorFile,
                            JsonFilePath = commonPath,
                            Message = $"TCommon() keys not found in {lang}/common.json",
                            Keys = missingKeys.ToArray(),
                            Suggestion = $"Add missing keys to {lang}/common.json"
                        });
                    }
                }
            }
        }
    }
    
    private static void ValidateValues(string i18nPath)
    {
        foreach (var lang in _targetLanguages!)
        {
            var langPath = Path.Combine(i18nPath, lang);
            if (!Directory.Exists(langPath)) continue;
            
            // Check common.json
            if (_scope == "all" || _scope == "common")
            {
                ValidateEmptyValues(Path.Combine(langPath, "common.json"), lang, "common.json");
            }
            
            // Check home.json
            if (_scope == "all" || _scope == "home")
            {
                ValidateEmptyValues(Path.Combine(langPath, "home.json"), lang, "home.json");
            }
            
            // Check tool files
            if (_scope == "all" || _scope == "tools")
            {
                var toolsPath = Path.Combine(langPath, "tools");
                if (Directory.Exists(toolsPath))
                {
                    foreach (var file in Directory.GetFiles(toolsPath, "*.json"))
                    {
                        var fileName = Path.GetFileName(file);
                        ValidateEmptyValues(file, lang, fileName);
                    }
                }
            }
        }
    }
    
    private static void ValidateEmptyValues(string filePath, string lang, string fileName)
    {
        if (!File.Exists(filePath)) return;
        
        try
        {
            var json = File.ReadAllText(filePath);
            var data = JsonSerializer.Deserialize<Dictionary<string, string>>(json);
            if (data == null) return;
            
            var emptyKeys = data
                .Where(kvp => string.IsNullOrWhiteSpace(kvp.Value))
                .Select(kvp => kvp.Key)
                .ToList();
            
            if (emptyKeys.Any())
            {
                AddError(new ValidationError
                {
                    Type = ErrorType.EmptyValue,
                    Language = lang,
                    FilePath = filePath,
                    Message = $"Empty values found in {lang}/{fileName}",
                    Keys = emptyKeys.ToArray(),
                    Suggestion = $"Fill empty values in {lang}/{fileName}"
                });
            }
        }
        catch
        {
            // Already handled in structure validation
        }
    }
    
    private static void AddError(ValidationError error)
    {
        Errors.Add(error);
    }
    
    private static void OutputHumanReadableResults()
    {
        Console.WriteLine();
        Console.WriteLine("Validation Results");
        Console.WriteLine("==================");
        Console.WriteLine();
        
        if (!Errors.Any())
        {
            Console.WriteLine("✅ All checks passed! No issues found.");
            return;
        }
        
        // Group errors by type for better readability
        var groupedErrors = Errors.GroupBy(e => e.Type).OrderBy(g => g.Key.ToString());
        
        foreach (var group in groupedErrors)
        {
            Console.WriteLine($"\n[{group.Key}] {GetErrorTypeDescription(group.Key)}");
            Console.WriteLine(new string('-', 50));
            
            foreach (var error in group)
            {
                Console.WriteLine($"\nFile: {error.FilePath}");
                if (!string.IsNullOrEmpty(error.Language))
                    Console.WriteLine($"Language: {error.Language}");
                Console.WriteLine($"Message: {error.Message}");
                
                if (error.Keys?.Any() == true)
                {
                    Console.WriteLine($"Keys: {string.Join(", ", error.Keys)}");
                }
                
                // Output LLM_FIX block
                Console.WriteLine();
                Console.WriteLine("<LLM_FIX>");
                var llmFix = GenerateLLMFix(error);
                Console.WriteLine(JsonSerializer.Serialize(llmFix, new JsonSerializerOptions { WriteIndented = true }));
                Console.WriteLine("</LLM_FIX>");
            }
        }
        
        Console.WriteLine();
        Console.WriteLine($"❌ Total errors: {Errors.Count}");
    }
    
    private static void OutputJsonResults()
    {
        var result = new
        {
            Status = Errors.Any() ? "error" : "success",
            Summary = new
            {
                TotalErrors = Errors.Count,
                ErrorTypes = Errors.GroupBy(e => e.Type.ToString()).ToDictionary(g => g.Key, g => g.Count()),
                LanguagesChecked = _targetLanguages,
                Scope = _scope
            },
            Errors = Errors.Select(e => new
            {
                Type = e.Type.ToString(),
                Language = e.Language,
                FilePath = e.FilePath,
                Message = e.Message,
                Keys = e.Keys,
                Suggestion = e.Suggestion,
                LLMFix = GenerateLLMFix(e)
            })
        };
        
        Console.WriteLine(JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }));
    }
    
    private static LLMFix GenerateLLMFix(ValidationError error)
    {
        var fix = new LLMFix
        {
            Action = error.Type switch
            {
                ErrorType.MissingFile => "create_file",
                ErrorType.MissingKeys => "add_keys",
                ErrorType.ExtraKeys => "remove_keys",
                ErrorType.EmptyValue => "fill_values",
                ErrorType.RazorKeyNotFound => "add_keys",
                ErrorType.RazorCommonKeyNotFound => "add_keys",
                ErrorType.RazorKeyMissingFile => "create_file",
                ErrorType.DuplicateKeys => "remove_duplicates",
                ErrorType.InvalidJson => "fix_json",
                ErrorType.MissingDirectory => "create_directory",
                _ => "manual_review"
            },
            Target = error.FilePath,
            Instructions = error.Suggestion
        };
        
        if (!string.IsNullOrEmpty(error.ReferenceFile))
        {
            fix.Source = error.ReferenceFile;
        }
        
        if (error.KeyValues?.Any() == true)
        {
            fix.Keys = error.KeyValues;
        }
        else if (error.Keys?.Any() == true)
        {
            fix.Keys = error.Keys.ToDictionary(k => k, k => "");
        }
        
        return fix;
    }
    
    private static void OutputStats()
    {
        Console.WriteLine();
        Console.WriteLine("Statistics");
        Console.WriteLine("==========");
        
        var langStats = Stats.GroupBy(s => s.Language)
            .Select(g => new { Language = g.Key, TotalKeys = g.Sum(s => s.KeyCount), FileCount = g.Count() })
            .OrderBy(s => s.Language);
        
        foreach (var stat in langStats)
        {
            Console.WriteLine($"{stat.Language}: {stat.FileCount} files, {stat.TotalKeys} total keys");
        }
    }
    
    private static string GetErrorTypeDescription(ErrorType type)
    {
        return type switch
        {
            ErrorType.MissingFile => "Missing JSON files",
            ErrorType.MissingKeys => "Missing translation keys",
            ErrorType.ExtraKeys => "Extra keys not in base language",
            ErrorType.EmptyValue => "Empty translation values",
            ErrorType.DuplicateKeys => "Duplicate keys in JSON",
            ErrorType.InvalidJson => "Invalid JSON syntax",
            ErrorType.MissingDirectory => "Missing language directories",
            ErrorType.RazorKeyNotFound => "Keys used in Razor not found in JSON",
            ErrorType.RazorCommonKeyNotFound => "TCommon() keys not found in common.json",
            ErrorType.RazorKeyMissingFile => "Razor references missing JSON file",
            _ => "Unknown error"
        };
    }
    
    private static void PrintError(string message)
    {
        Console.Error.WriteLine($"[ERROR] {message}");
    }
}

public enum ErrorType
{
    MissingFile,
    MissingKeys,
    ExtraKeys,
    EmptyValue,
    DuplicateKeys,
    InvalidJson,
    MissingDirectory,
    RazorKeyNotFound,
    RazorCommonKeyNotFound,
    RazorKeyMissingFile
}

public class ValidationError
{
    public ErrorType Type { get; set; }
    public string? Language { get; set; }
    public string FilePath { get; set; } = "";
    public string? ReferenceFile { get; set; }
    public string? JsonFilePath { get; set; }
    public string Message { get; set; } = "";
    public string[]? Keys { get; set; }
    public Dictionary<string, string>? KeyValues { get; set; }
    public string Suggestion { get; set; } = "";
}

public class ValidationStats
{
    public string Language { get; set; } = "";
    public string FileName { get; set; } = "";
    public int KeyCount { get; set; }
}

public class LLMFix
{
    public string Action { get; set; } = "";
    public string Target { get; set; } = "";
    public string? Source { get; set; }
    public Dictionary<string, string>? Keys { get; set; }
    public string Instructions { get; set; } = "";
}
