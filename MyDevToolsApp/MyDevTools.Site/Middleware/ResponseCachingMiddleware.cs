using Microsoft.Extensions.Caching.Memory;
using System.Text;

namespace MyDevTools.Site.Middleware;

/// <summary>
/// Middleware for caching static tool pages in memory.
/// Since all tool pages are static (no user-specific data), we can cache the entire HTML response.
/// Cache key includes the language to ensure correct localization.
/// 
/// Caching strategy: Cache all pages matching pattern /{lang}/{tool-slug}
/// This automatically includes all tools without maintaining a list.
/// </summary>
public class ResponseCachingMiddleware
{
    private readonly RequestDelegate _next;
    private readonly IMemoryCache _cache;
    private readonly ILogger<ResponseCachingMiddleware> _logger;

    // Cache duration for tool pages (30 minutes)
    private static readonly TimeSpan CacheDuration = TimeSpan.FromMinutes(30);

    // Supported language codes
    private static readonly HashSet<string> SupportedLanguages = new(StringComparer.OrdinalIgnoreCase)
    {
        "en", "ru", "es", "de", "pt", "zh", "fr", "ja", "ko", "hi"
    };

    public ResponseCachingMiddleware(
        RequestDelegate next,
        IMemoryCache cache,
        ILogger<ResponseCachingMiddleware> logger)
    {
        _next = next;
        _cache = cache;
        _logger = logger;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        // Only cache GET requests
        if (context.Request.Method != HttpMethods.Get)
        {
            await _next(context);
            return;
        }

        var path = context.Request.Path.Value ?? "";
        
        // Extract segments from URL
        var segments = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        
        // Allow 1 or 2 segments:
        // 1 segment: /{lang} (Home page)
        // 2 segments: /{lang}/{tool-slug}
        // Root path "/" has 0 segments and is NOT cached
        if (segments.Length < 1 || segments.Length > 2)
        {
            await _next(context);
            return;
        }

        var language = segments[0];
        // If only language is present, it's the home page
        var toolSlug = segments.Length > 1 ? segments[1] : "home";

        // Verify language is supported
        if (!SupportedLanguages.Contains(language))
        {
            await _next(context);
            return;
        }

        // Create cache key including language and tool slug
        var cacheKey = $"page:{language}:{toolSlug}";

        // Try to get from cache
        if (_cache.TryGetValue<CachedResponse>(cacheKey, out var cachedResponse) && cachedResponse != null)
        {
            _logger.LogDebug("Cache HIT for {Path}", path);
            
            // Set headers
            context.Response.ContentType = cachedResponse.ContentType;
            context.Response.StatusCode = cachedResponse.StatusCode;
            
            foreach (var header in cachedResponse.Headers)
            {
                context.Response.Headers[header.Key] = header.Value;
            }

            // Write cached body
            await context.Response.Body.WriteAsync(cachedResponse.Body);
            return;
        }

        // Not in cache - capture the response
        var originalBodyStream = context.Response.Body;

        using var responseBody = new MemoryStream();
        context.Response.Body = responseBody;

        try
        {
            await _next(context);

            // Only cache successful HTML responses
            if (context.Response.StatusCode == 200 && 
                context.Response.ContentType?.Contains("text/html") == true)
            {
                responseBody.Seek(0, SeekOrigin.Begin);
                var body = await new StreamReader(responseBody).ReadToEndAsync();
                var bodyBytes = Encoding.UTF8.GetBytes(body);

                // Cache the response
                var cached = new CachedResponse
                {
                    StatusCode = context.Response.StatusCode,
                    ContentType = context.Response.ContentType,
                    Headers = context.Response.Headers
                        .Where(h => !h.Key.StartsWith("Date", StringComparison.OrdinalIgnoreCase))
                        .ToDictionary(h => h.Key, h => h.Value.ToString()),
                    Body = bodyBytes
                };

                _cache.Set(cacheKey, cached, new MemoryCacheEntryOptions
                {
                    AbsoluteExpirationRelativeToNow = CacheDuration,
                    Size = bodyBytes.Length
                });

                _logger.LogDebug("Cache MISS - Cached {Path} (Size: {Size} bytes)", path, bodyBytes.Length);
            }

            // Copy the response back to the original stream
            responseBody.Seek(0, SeekOrigin.Begin);
            await responseBody.CopyToAsync(originalBodyStream);
        }
        finally
        {
            context.Response.Body = originalBodyStream;
        }
    }

    private class CachedResponse
    {
        public int StatusCode { get; set; }
        public string ContentType { get; set; } = string.Empty;
        public Dictionary<string, string> Headers { get; set; } = new();
        public byte[] Body { get; set; } = Array.Empty<byte>();
    }
}
