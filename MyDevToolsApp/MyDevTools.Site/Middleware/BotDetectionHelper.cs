namespace MyDevTools.Site.Middleware;

/// <summary>
/// Helper class to detect search engine bots and LLM crawlers by User-Agent.
/// </summary>
public static class BotDetectionHelper
{
    /// <summary>
    /// List of known bot user agents (case-insensitive matching).
    /// </summary>
    private static readonly string[] KnownBots = new[]
    {
        // LLM Crawlers
        "GPTBot",           // OpenAI
        "ChatGPT-User",     // OpenAI
        "Claude-Web",       // Anthropic
        "PerplexityBot",    // Perplexity AI
        "Omgilibot",        // Omgili
        
        // Traditional Search Engines
        "Googlebot",        // Google
        "bingbot",          // Microsoft Bing
        "Slurp",            // Yahoo
        "DuckDuckBot",      // DuckDuckGo
        "Baiduspider",      // Baidu
        "YandexBot",        // Yandex
        "Sogou",            // Sogou
        
        // Social Media & Others
        "facebookexternalhit",  // Facebook
        "Twitterbot",           // Twitter/X
        "LinkedInBot",          // LinkedIn
        "Applebot",             // Apple
        "ia_archiver",          // Alexa
        "archive.org_bot",      // Internet Archive
    };

    /// <summary>
    /// Determines if the current request is from a known bot.
    /// </summary>
    /// <param name="context">The HTTP context.</param>
    /// <returns>True if the request is from a bot, false otherwise.</returns>
    public static bool IsBot(HttpContext context)
    {
        var userAgent = context.Request.Headers.UserAgent.ToString();
        
        if (string.IsNullOrEmpty(userAgent))
        {
            return false;
        }

        // Check if user agent contains any known bot identifier
        return KnownBots.Any(bot => 
            userAgent.Contains(bot, StringComparison.OrdinalIgnoreCase));
    }
}
