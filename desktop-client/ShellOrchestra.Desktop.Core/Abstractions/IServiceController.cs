using ShellOrchestra.Desktop.Core.Models;

namespace ShellOrchestra.Desktop.Core.Abstractions;

public interface IServiceController
{
    Task<ServiceStatus> GetStatusAsync(CancellationToken cancellationToken);
    Task RestartAsync(CancellationToken cancellationToken);
    Task LockServerAccessAsync(CancellationToken cancellationToken);
    string LogsDirectory { get; }
}
