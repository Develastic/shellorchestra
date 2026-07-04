using ShellOrchestra.Desktop.Core.Models;

namespace ShellOrchestra.Desktop.Core.Services;

public static class InstanceValidator
{
    public static IReadOnlyList<string> ValidateRemoteInstance(Uri uri)
    {
        var findings = new List<string>();
        if (uri.Scheme != Uri.UriSchemeHttps)
        {
            findings.Add("Remote ShellOrchestra instances must use HTTPS before enrollment.");
        }
        if (uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase) || uri.Host.Equals("127.0.0.1", StringComparison.OrdinalIgnoreCase))
        {
            findings.Add("Use the local runtime mode for localhost instances.");
        }
        return findings;
    }

    public static IReadOnlyList<TrayCommand> DefaultTrayCommands(ShellOrchestraInstance instance) => new[]
    {
        new TrayCommand(TrayCommandKind.OpenShellOrchestra, "Open ShellOrchestra"),
        new TrayCommand(TrayCommandKind.LockServerAccess, "Lock server access"),
        new TrayCommand(TrayCommandKind.ShowServiceStatus, "Show service status"),
        new TrayCommand(TrayCommandKind.OpenLogsFolder, "Open logs folder"),
        new TrayCommand(TrayCommandKind.RestartLocalService, instance.IsLocalRuntime ? "Restart ShellOrchestra service" : "Restart local service unavailable", RequiresConfirmation: true),
        new TrayCommand(TrayCommandKind.QuitTrayApp, "Quit tray app")
    };
}
