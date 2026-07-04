using ShellOrchestra.Desktop.Core.Models;

namespace ShellOrchestra.Desktop.Core.Abstractions;

public interface ISettingsStore
{
    Task<DesktopClientSettings> LoadAsync(CancellationToken cancellationToken);
    Task SaveAsync(DesktopClientSettings settings, CancellationToken cancellationToken);
}
