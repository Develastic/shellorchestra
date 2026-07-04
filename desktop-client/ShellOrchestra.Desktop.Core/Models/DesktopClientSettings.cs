namespace ShellOrchestra.Desktop.Core.Models;

public sealed record DesktopClientSettings(IReadOnlyList<ShellOrchestraInstance> Instances, string ActiveInstanceId)
{
    public static DesktopClientSettings Default => new(new[] { ShellOrchestraInstance.LocalDefault() }, "local");

    public ShellOrchestraInstance ActiveInstance => Instances.FirstOrDefault(item => item.Id == ActiveInstanceId) ?? Instances[0];
}
