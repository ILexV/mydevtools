namespace MyDevTools.Site.Services;

/// <summary>
/// Provides JS interop access to cryptography WASM.
/// </summary>
public interface ICryptographyInteropService
{
    /// <summary>
    /// Returns the cryptography WASM version string.
    /// </summary>
    ValueTask<string> GetVersionAsync(CancellationToken cancellationToken = default);
}
