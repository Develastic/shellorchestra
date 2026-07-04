using ShellOrchestra.Desktop.Core.Models;
using ShellOrchestra.Desktop.Core.Services;
using ShellOrchestra.Desktop.Windows.Services;

namespace ShellOrchestra.Desktop.Windows;

public sealed class ShellOrchestraApplicationContext : ApplicationContext
{
    private readonly MainWindow window;
    private readonly NotifyIcon tray;
    private readonly ShellOrchestraInstance instance = ShellOrchestraInstance.LocalDefault();
    private readonly ShellOrchestraApiClient apiClient;
    private readonly WindowsServiceController serviceController;

    public ShellOrchestraApplicationContext()
    {
        apiClient = new ShellOrchestraApiClient(instance.BaseUri);
        serviceController = new WindowsServiceController(apiClient);
        window = new MainWindow(instance);
        tray = new NotifyIcon
        {
            Text = "ShellOrchestra",
            Icon = SystemIcons.Application,
            Visible = true,
            ContextMenuStrip = CreateMenu()
        };
        tray.DoubleClick += (_, _) => ShowWindow();
        window.FormClosed += (_, _) => ExitThread();
        ShowWindow();
    }

    private ContextMenuStrip CreateMenu()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open ShellOrchestra", null, (_, _) => ShowWindow());
        menu.Items.Add("Lock server access", null, async (_, _) => await LockServerAccessAsync());
        menu.Items.Add("Show service status", null, async (_, _) => await ShowServiceStatusAsync());
        menu.Items.Add("Check for updates", null, async (_, _) => await ShowUpdateStatusAsync());
        menu.Items.Add("Open logs folder", null, (_, _) => OpenLogsFolder());
        menu.Items.Add("Restart ShellOrchestra service", null, async (_, _) => await ConfirmRestartAsync());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit tray app", null, (_, _) => ExitThread());
        return menu;
    }

    private void ShowWindow()
    {
        if (window.WindowState == FormWindowState.Minimized) window.WindowState = FormWindowState.Normal;
        window.Show();
        window.Activate();
    }

    private void OpenLogsFolder()
    {
        var path = serviceController.LogsDirectory;
        Directory.CreateDirectory(path);
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("explorer.exe", path) { UseShellExecute = true });
    }

    private async Task LockServerAccessAsync()
    {
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            await serviceController.LockServerAccessAsync(cts.Token);
            MessageBox.Show("ShellOrchestra server access was locked.", "ShellOrchestra", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show("ShellOrchestra could not lock server access: " + ex.Message, "ShellOrchestra", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private async Task ShowServiceStatusAsync()
    {
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            var status = await serviceController.GetStatusAsync(cts.Token);
            MessageBox.Show($"{status.Health}\n\n{status.Summary}", "ShellOrchestra service status", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show("ShellOrchestra could not read the Windows service status: " + ex.Message, "ShellOrchestra", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private async Task ShowUpdateStatusAsync()
    {
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var status = await apiClient.GetVersionStatusAsync(cts.Token);
            if (status is null)
            {
                MessageBox.Show("ShellOrchestra could not read update status from the local web app.", "ShellOrchestra updates", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            var capability = UpdateAdvisor.Capability(status);
            MessageBox.Show($"{status.Message}\n\n{capability.OperatorMessage}", "ShellOrchestra updates", MessageBoxButtons.OK, capability.CanUpgradeNow ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
        }
        catch (Exception ex)
        {
            MessageBox.Show("ShellOrchestra could not check updates: " + ex.Message, "ShellOrchestra updates", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private async Task ConfirmRestartAsync()
    {
        var result = MessageBox.Show("Restart the local ShellOrchestra service? Active SSH connections will be interrupted.", "ShellOrchestra", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning);
        if (result != DialogResult.OK) return;
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            await serviceController.RestartAsync(cts.Token);
            MessageBox.Show("ShellOrchestra service restart was requested.", "ShellOrchestra", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show("ShellOrchestra could not restart the service: " + ex.Message, "ShellOrchestra", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            tray.Visible = false;
            tray.Dispose();
            apiClient.Dispose();
            window.Dispose();
        }
        base.Dispose(disposing);
    }
}
