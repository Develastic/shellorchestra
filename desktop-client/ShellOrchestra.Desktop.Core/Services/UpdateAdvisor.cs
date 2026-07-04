using ShellOrchestra.Desktop.Core.Models;

namespace ShellOrchestra.Desktop.Core.Services;

public static class UpdateAdvisor
{
    public static UpgradeCapability Capability(UpdateStatus status)
    {
        if (!status.UpdateAvailable)
        {
            return UpgradeCapability.Disabled(status.Message.Length == 0 ? "This ShellOrchestra installation is up to date." : status.Message);
        }
        if (status.OneClickAvailable)
        {
            var version = string.IsNullOrWhiteSpace(status.LatestVersion) ? "the latest version" : status.LatestVersion;
            return UpgradeCapability.Enabled($"ShellOrchestra {version} can be installed by the local updater.");
        }
        if (!string.IsNullOrWhiteSpace(status.ManualUpgradeCommand))
        {
            return UpgradeCapability.Disabled("A new ShellOrchestra version is available. Use the manual upgrade instructions shown by the web app.");
        }
        return UpgradeCapability.Disabled("A new ShellOrchestra version is available, but this installation has no configured one-click updater.");
    }
}
