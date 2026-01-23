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
    
    // Whitelist of known valid path patterns
    private static readonly string[] KnownValidPaths = new[]
    {
        "/", "/en", "/en/", "/ru", "/ru/", "/es", "/es/",
        "/sitemap.xml", "/robots.txt"
    };

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
            
            // For bots requesting known valid paths, return 200 OK immediately
            if (isBot && IsKnownValidPath(path))
            {
                context.Response.StatusCode = 200;
                context.Response.Headers.ContentType = "text/html; charset=utf-8";
                return;
            }
            
            // Otherwise, convert HEAD to GET and discard body
            context.Request.Method = HttpMethods.Get;
            
            // Capture the response body stream
            var originalBodyStream = context.Response.Body;
            
            try
            {
                // Use a null stream to discard the body
                using var nullStream = Stream.Null;
                context.Response.Body = nullStream;
                
                await _next(context);
            }
            finally
            {
                // Restore original method and body stream
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
        // Check exact matches
        if (KnownValidPaths.Contains(path, StringComparer.OrdinalIgnoreCase))
        {
            return true;
        }
        
        // Check if path matches pattern /{lang}/tool-name
        var segments = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length >= 1)
        {
            var lang = segments[0];
            // If first segment is a supported language, it's likely a valid path
            if (lang.Equals("en", StringComparison.OrdinalIgnoreCase) ||
                lang.Equals("ru", StringComparison.OrdinalIgnoreCase) ||
                lang.Equals("es", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        
        return false;
    }
}
