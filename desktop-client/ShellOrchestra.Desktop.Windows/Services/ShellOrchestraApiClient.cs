using System.Net.Http.Json;
using ShellOrchestra.Desktop.Core.Models;

namespace ShellOrchestra.Desktop.Windows.Services;

public sealed class ShellOrchestraApiClient : IDisposable
{
    private readonly HttpClient client;

    public ShellOrchestraApiClient(Uri baseUri)
    {
        client = new HttpClient { BaseAddress = baseUri, Timeout = TimeSpan.FromSeconds(8) };
    }

    public async Task<UpdateStatus?> GetVersionStatusAsync(CancellationToken cancellationToken)
    {
        using var response = await client.GetAsync("/api/system/version-check", cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode) return null;
        return await response.Content.ReadFromJsonAsync<UpdateStatus>(cancellationToken).ConfigureAwait(false);
    }

    public async Task LockServerAccessAsync(CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/runtime/lock");
        using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
    }

    public void Dispose() => client.Dispose();
}
