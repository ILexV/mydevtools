namespace MyDevTools.Site.Middleware;

/// <summary>
/// Middleware to handle HEAD requests by converting them to GET requests
/// and stripping the response body. This is needed for search engine bots
/// and crawlers that use HEAD requests to check page availability.
/// For known valid paths, returns 200 OK immediately for bots.
/// </summary>
public class HeadRequestMiddleware
{
    private readonly RequestDelegate _next;
    
    // Whitelist of supported languages
    private static readonly string[] SupportedLanguages = ["en", "ru", "es", "de", "pt", "zh", "fr", "ja", "ko", "hi"];

    // Whitelist of tool slugs (extracted from Home.razor)
    private static readonly string[] ToolSlugs = 
    [
        "image-converter", "image-compressor", "image-resizer", "color-converter", "markdown-preview",
        "hash-calculator", "password-generator", "uuid-generator", "lorem-ipsum-generator", "base64-encoder",
        "json-beautifier", "text-case-converter", "text-diff-viewer", "aead-file", "openssh-keys", "x509",
        "url-encoder", "xml-beautifier", "hex-encoder", "base32-encoder", "base58-encoder", "date-converter",
        "jwt-decoder", "jwt-encoder", "regex-tester", "qr-code-generator", "hmac-calculator", 
        "yaml-beautifier-validator", "qr-scanner", "pdf-merger", "pdf-compressor", "html-entity-encoder", "unit-converter"
        , "pdf-to-text", "ip-subnet-calculator", "cron-parser", "cron-generator", "word-counter"
    ];


    public HeadRequestMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        var originalMethod = context.Request.Method;

        // If this is a HEAD request
        if (HttpMethods.IsHead(context.Request.Method))
        {
            var path = context.Request.Path.Value ?? "/";
            var isBot = BotDetectionHelper.IsBot(context);

            // For bots/crawlers, if we KNOW the path is valid, return 200 OK immediately
            // This satisfies search engines and avoids heavy processing
            if (isBot && IsKnownValidPath(path))
            {
                context.Response.StatusCode = 200;
                context.Response.Headers.ContentType = "text/html; charset=utf-8";
                return;
            }

            // For all other cases (or non-bot HEAD requests), convert to GET
            // and capture the response without the body
            context.Request.Method = HttpMethods.Get;
            var originalBodyStream = context.Response.Body;
            using var replacementBodyStream = new MemoryStream();
            context.Response.Body = replacementBodyStream;
            
            try
            {
                await _next(context);
            }
            finally
            {
                context.Request.Method = originalMethod;
                context.Response.Body = originalBodyStream;
            }
        }
        else
        {
            await _next(context);
        }
    }

    private static bool IsKnownValidPath(string path)
    {
        if (string.IsNullOrEmpty(path) || path == "/") return true;

        var segments = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        
        // Match /sitemap.xml or /robots.txt
        if (segments.Length == 1 && (segments[0].Equals("sitemap.xml", StringComparison.OrdinalIgnoreCase) || 
                                     segments[0].Equals("robots.txt", StringComparison.OrdinalIgnoreCase)))
        {
            return true;
        }

        if (segments.Length >= 1)
        {
            var lang = segments[0].ToLowerInvariant();
            if (SupportedLanguages.Contains(lang))
            {
                // Path is just /{lang}/
                if (segments.Length == 1) return true;

                // Path is /{lang}/{tool-slug}
                if (segments.Length == 2)
                {
                    var slug = segments[1].ToLowerInvariant();
                    return ToolSlugs.Contains(slug);
                }
            }
        }
        
        return false;
    }
}
