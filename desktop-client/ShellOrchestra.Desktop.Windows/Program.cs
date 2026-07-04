using ShellOrchestra.Desktop.Core.Models;
using ShellOrchestra.Desktop.Core.Services;
using ShellOrchestra.Desktop.Windows;

if (args.Contains("--self-test", StringComparer.OrdinalIgnoreCase))
{
    var instance = ShellOrchestraInstance.LocalDefault();
    var commands = InstanceValidator.DefaultTrayCommands(instance);
    if (commands.Count == 0)
    {
        Console.Error.WriteLine("ShellOrchestra Desktop self-test failed: no tray commands were generated.");
        Environment.Exit(1);
    }
    var capability = UpdateAdvisor.Capability(new UpdateStatus(
        Status: "ok",
        CurrentVersion: "0.0.1",
        CurrentEdition: "community",
        Channel: "stable",
        LatestVersion: "0.0.2",
        UpdateAvailable: true,
        Critical: false,
        OneClickAvailable: true,
        ManualUpgradeRequired: false,
        InstallMethod: "windows_app",
        ManualUpgradeCommand: "",
        Message: "ShellOrchestra 0.0.2 is available.",
        CheckedAt: DateTimeOffset.UtcNow));
    if (!capability.CanUpgradeNow)
    {
        Console.Error.WriteLine("ShellOrchestra Desktop self-test failed: update advisor did not recognize one-click upgrade capability.");
        Environment.Exit(1);
    }
    Console.WriteLine($"ShellOrchestra Desktop self-test ok: {instance.DisplayName}, commands={commands.Count}.");
    return;
}

ApplicationConfiguration.Initialize();
using var mutex = new Mutex(initiallyOwned: true, name: "ShellOrchestra.Desktop.Windows", createdNew: out var createdNew);
if (!createdNew)
{
    MessageBox.Show("ShellOrchestra Desktop is already running.", "ShellOrchestra", MessageBoxButtons.OK, MessageBoxIcon.Information);
    return;
}
Application.Run(new ShellOrchestraApplicationContext());
