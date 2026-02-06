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
    // ==== LLM / AI / Data Crawlers ====
    "GPTBot",
    "ChatGPT-User",
    "OAI-SearchBot",

    "ClaudeBot",
    "Claude-User",
    "Claude-SearchBot",
    "anthropic-ai",      // устаревший, но может ещё встречаться
    "Claude-Web",        // старый UA Anthrop ic

    "Google-Extended",
    "Google-CloudVertexBot",
    "Gemini-Deep-Research",

    "PerplexityBot",
    "Perplexity-User",

    "Applebot-Extended",

    "Amazonbot",

    "Meta-ExternalAgent",
    "Meta-ExternalFetcher",
    "Meta-WebIndexer",

    "CCBot",             // Common Crawl

    "DuckAssistBot",

    "Bytespider",
    "TikTokSpider",

    "MistralAI-User",

    "webzio",
    "webzio-extended",

    "Omgili",
    "Omgilibot",

    "ImagesiftBot",

    "Diffbot",

    "cohere-ai",
    "cohere-training-data-crawler",

    "ICC-Crawler",
    "AI2Bot",
    "AI2Bot-Dolma",

    "DataForSeoBot",

    "AwarioBot",
    "AwarioSmartBot",
    "AwarioRssBot",

    "PanguBot",
    "Kangaroo Bot",
    "Sentibot",

    "Petalbot",
    "VelenPublicWebCrawler",
    "TurnitinBot",
    "Timpibot",

    "Youbot",

    "img2dataset",

    "Meltwater",
    "Seekr",
    "peer39_crawler",

    "Scrapy",
    "Cotoyogi",
    "aiHitBot",
    "Factset_spyderbot",
    "FirecrawlAgent",


    // ==== Основные поисковые и спец‑краулеры ====

    // Google
    "Googlebot",
    "GoogleOther",
    "Google-InspectionTool",

    // Bing / Microsoft
    "bingbot",
    "BingPreview",
    "MSNBot",

    // Яндекс — лучше ещё отдельно проверять просто "Yandex"
    "YandexBot",
    "YandexMobileBot",
    "YandexMetrika",
    "YandexImages",
    "YandexImageResizer",
    "YandexMedia",
    "YandexVideo",
    "YandexVideoParser",
    "YandexTurbo",
    "YandexFavicons",
    "YandexAccessibilityBot",
    "YandexWebmaster",
    "YandexMarket",
    "YandexDirect",
    "YandexDirectDyn",
    "YaDirectFetcher",
    "YandexBlogs",
    "YandexZakladki",
    "YandexCalendar",
    "YandexTracker",
    "YandexVertis",
    "YandexVerticals",
    "YandexAdNet",
    "YandexPartner",
    "YandexSearchShop",
    "YandexSpravBot",
    "YandexUserproxy",
    "YandexRenderResourcesBot",
    "Yandex", // общий токен на все яндекс‑боты

    // Другие поисковые
    "Slurp",           // Yahoo
    "DuckDuckBot",     // DuckDuckGo
    "Baiduspider",     // Baidu
    "Sogou",           // Sogou и его вариации
    "Exabot",          // Exalead

    // Apple
    "Applebot",


    // ==== SEO / аналитика / коммерческие краулеры ====
    "AhrefsBot",
    "SemrushBot",
    "SemrushBot-OCOB",
    "MJ12Bot",         // Majestic
    "Majestic",
    "Rogerbot",        // Moz
    "Swiftbot",        // Swiftype
    "Lumar",           // Lumar (бывший DeepCrawl)
    "DeepCrawl",
    "cognitiveSEO",
    "Oncrawl",


    // ==== Соцсети, превью и мессенджеры ====
    "facebookexternalhit",
    "Facebot",
    "FacebookBot",
    "Facebookbot",

    "Twitterbot",
    "LinkedInBot",
    "Slackbot",
    "Pinterestbot",

    "Applebot",            // дубль в соц/поиске, но не мешает

    "ia_archiver",         // Alexa / Wayback
    "archive.org_bot",


    // ==== Uptime / мониторинг ====
    "Pingdom.com_bot",
    "UptimeRobot",
    "BetterStackBot",
    "cron-job.org",


    // ==== Сканеры безопасности / исследовательские ====
    "CensysInspect",
    "censys.io",
    "Shodan",
    "BitSightBot",


    // ==== Оригинальный список пользователя (для полноты) ====
    "GPTBot",           // OpenAI (дубликат — не критично)
    "ChatGPT-User",     // OpenAI
    "Claude-Web",       // Anthropic (дубликат, оставлен специально)
    "PerplexityBot",    // Perplexity AI
    "Omgilibot",        // Omgili (дубликат)
    
    "Googlebot",        // Google (дубликат)
    "Slurp",            // Yahoo (дубликат)
    "DuckDuckBot",      // DuckDuckGo (дубликат)
    "Baiduspider",      // Baidu (дубликат)
    "YandexBot",        // Yandex (дубликат)
    "Sogou",            // Sogou (дубликат)
    
    "facebookexternalhit",
    "Twitterbot",
    "LinkedInBot",
    "Applebot",
    "ia_archiver",
    "archive.org_bot",
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
