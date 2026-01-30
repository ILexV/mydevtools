using Microsoft.AspNetCore.StaticFiles;

namespace MyDevTools.Site.Middleware;

/// <summary>
/// Middleware that serves all static files from memory to reduce disk I/O.
/// Loads all files from wwwroot into memory on startup.
/// Works in conjunction with ResponseCompressionMiddleware for gzip/brotli.
/// </summary>
public class MemoryStaticFileMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<MemoryStaticFileMiddleware> _logger;
    private readonly Dictionary<string, InMemoryFile> _files = new(StringComparer.OrdinalIgnoreCase);
    private readonly FileExtensionContentTypeProvider _contentTypeProvider = new();

    public MemoryStaticFileMiddleware(
        RequestDelegate next,
        IWebHostEnvironment env,
        ILogger<MemoryStaticFileMiddleware> logger)
    {
        _next = next;
        _logger = logger;

        LoadFilesIntoMemory(env.WebRootPath);
    }

    private void LoadFilesIntoMemory(string webRootPath)
    {
        if (!Directory.Exists(webRootPath))
        {
            _logger.LogWarning("WebRootPath {Path} does not exist. No static files loaded.", webRootPath);
            return;
        }

        var files = Directory.GetFiles(webRootPath, "*", SearchOption.AllDirectories);
        long totalBytes = 0;

        foreach (var filePath in files)
        {
            try
            {
                // Create relative path for URL matching (e.g., "/css/app.css")
                var relativePath = filePath.Substring(webRootPath.Length).Replace('\\', '/');
                if (!relativePath.StartsWith('/')) relativePath = "/" + relativePath;

                var content = File.ReadAllBytes(filePath);
                
                if (!_contentTypeProvider.TryGetContentType(filePath, out var contentType))
                {
                    contentType = "application/octet-stream";
                }

                // Generate ETag based on content length and last modified time (simple and fast)
                // Or use MD5 hash for bit-perfect accuracy: 
                // var etag = "\"" + Convert.ToHexString(System.Security.Cryptography.MD5.HashData(content)) + "\"";
                var lastModified = File.GetLastWriteTimeUtc(filePath);
                var etag = $"\"{lastModified.Ticks}-{content.Length}\"";

                _files[relativePath] = new InMemoryFile
                {
                    Content = content,
                    ContentType = contentType,
                    LastModified = lastModified,
                    ETag = etag
                };

                totalBytes += content.Length;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to load file into memory: {Path}", filePath);
            }
        }

        _logger.LogInformation("Loaded {Count} static files into memory. Total size: {Size} MB", 
            _files.Count, (totalBytes / 1024.0 / 1024.0).ToString("F2"));
    }

    public async Task InvokeAsync(HttpContext context)
    {
        // Only handle GET requests
        if (context.Request.Method != HttpMethods.Get)
        {
            await _next(context);
            return;
        }

        var path = context.Request.Path.Value;
        if (string.IsNullOrEmpty(path))
        {
            await _next(context);
            return;
        }

        // Check if file exists in memory
        if (_files.TryGetValue(path, out var file))
        {
            context.Response.ContentType = file.ContentType;
            
            // Add ETag header
            context.Response.Headers.ETag = file.ETag;
            context.Response.Headers.LastModified = file.LastModified.ToString("R");

            // Cache Control: no-cache means "must revalidate with server using ETag before using cached copy"
            // This ensures users always get the latest version immediately
            context.Response.Headers.CacheControl = "no-cache";

            // Check ETag (If-None-Match)
            if (context.Request.Headers.TryGetValue("If-None-Match", out var incomingEtag) && 
                incomingEtag.ToString() == file.ETag)
            {
                context.Response.StatusCode = 304; // Not Modified
                return;
            }

            // Check Last-Modified (If-Modified-Since)
            if (context.Request.Headers.TryGetValue("If-Modified-Since", out var ifModifiedSince) && 
                DateTime.TryParse(ifModifiedSince, out var ifModifiedDate) &&
                ifModifiedDate >= file.LastModified)
            {
                context.Response.StatusCode = 304; // Not Modified
                return;
            }

            await context.Response.Body.WriteAsync(file.Content);
            return;
        }

        await _next(context);
    }

    private class InMemoryFile
    {
        public byte[] Content { get; set; } = Array.Empty<byte>();
        public string ContentType { get; set; } = string.Empty;
        public DateTime LastModified { get; set; }
        public string ETag { get; set; } = string.Empty;
    }
}
