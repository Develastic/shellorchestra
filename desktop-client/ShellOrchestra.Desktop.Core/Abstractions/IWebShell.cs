using ShellOrchestra.Desktop.Core.Models;

namespace ShellOrchestra.Desktop.Core.Abstractions;

public interface IWebShell
{
    Task OpenAsync(ShellOrchestraInstance instance, CancellationToken cancellationToken);
    Task ShowAsync(CancellationToken cancellationToken);
}
