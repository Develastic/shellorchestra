namespace ShellOrchestra.Desktop.Core.Models;

public enum TrayCommandKind
{
    OpenShellOrchestra,
    LockServerAccess,
    ShowServiceStatus,
    OpenLogsFolder,
    RestartLocalService,
    QuitTrayApp
}

public sealed record TrayCommand(TrayCommandKind Kind, string Label, bool RequiresConfirmation = false);
