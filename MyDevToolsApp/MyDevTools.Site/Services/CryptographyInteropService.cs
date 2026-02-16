using Microsoft.JSInterop;

namespace MyDevTools.Site.Services;

/// <summary>
/// JS interop wrapper for cryptography WASM module.
/// </summary>
public sealed class CryptographyInteropService : ICryptographyInteropService, IAsyncDisposable
{
    private readonly Lazy<Task<IJSObjectReference>> _moduleTask;

    /// <summary>
    /// Initializes a new instance of the <see cref="CryptographyInteropService"/> class.
    /// </summary>
    /// <param name="jsRuntime">JS runtime.</param>
    public CryptographyInteropService(IJSRuntime jsRuntime)
    {
        _moduleTask = new Lazy<Task<IJSObjectReference>>(() =>
            jsRuntime.InvokeAsync<IJSObjectReference>("import", "/wasm/cryptography/cryptography-interop.js").AsTask());
    }

    /// <inheritdoc />
    public async ValueTask<string> GetVersionAsync(CancellationToken cancellationToken = default)
    {
        var module = await _moduleTask.Value.ConfigureAwait(false);
        return await module.InvokeAsync<string>("getVersion", cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async ValueTask DisposeAsync()
    {
        if (!_moduleTask.IsValueCreated)
        {
            return;
        }

        var module = await _moduleTask.Value.ConfigureAwait(false);
        await module.DisposeAsync().ConfigureAwait(false);
    }
}
