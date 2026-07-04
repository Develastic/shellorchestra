using System.Diagnostics;
using ShellOrchestra.Desktop.Core.Abstractions;
using ShellOrchestra.Desktop.Core.Models;

namespace ShellOrchestra.Desktop.Windows.Services;

public sealed class WindowsServiceController : IServiceController
{
    private const string SupervisorServiceName = "ShellOrchestraSupervisor";
    private readonly ShellOrchestraApiClient apiClient;

    public WindowsServiceController(ShellOrchestraApiClient apiClient)
    {
        this.apiClient = apiClient;
    }

    public string LogsDirectory => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "ShellOrchestra", "logs");

    public async Task<ServiceStatus> GetStatusAsync(CancellationToken cancellationToken)
    {
        var result = await RunScAsync(new[] { "query", SupervisorServiceName }, cancellationToken).ConfigureAwait(false);
        var health = result.ExitCode == 0 && result.Output.Contains("RUNNING", StringComparison.OrdinalIgnoreCase)
            ? RuntimeHealth.Ready
            : RuntimeHealth.Stopped;
        var summary = result.ExitCode == 0 ? CompactServiceOutput(result.Output) : "ShellOrchestra Supervisor service is not installed or not reachable.";
        return new ServiceStatus(health, summary, DateTimeOffset.UtcNow);
    }

    public async Task RestartAsync(CancellationToken cancellationToken)
    {
        await RunScAsync(new[] { "stop", SupervisorServiceName }, cancellationToken, allowFailure: true).ConfigureAwait(false);
        await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken).ConfigureAwait(false);
        var start = await RunScAsync(new[] { "start", SupervisorServiceName }, cancellationToken).ConfigureAwait(false);
        if (start.ExitCode != 0)
        {
            throw new InvalidOperationException(start.Output);
        }
    }

    public Task LockServerAccessAsync(CancellationToken cancellationToken) => apiClient.LockServerAccessAsync(cancellationToken);

    private static async Task<CommandResult> RunScAsync(string[] arguments, CancellationToken cancellationToken, bool allowFailure = false)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = "sc.exe",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }
        using var process = Process.Start(startInfo) ?? throw new InvalidOperationException("Could not start sc.exe.");
        var stdout = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var stderr = process.StandardError.ReadToEndAsync(cancellationToken);
        await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
        var output = string.Join(Environment.NewLine, new[] { await stdout.ConfigureAwait(false), await stderr.ConfigureAwait(false) }.Where(item => !string.IsNullOrWhiteSpace(item)));
        if (process.ExitCode != 0 && !allowFailure)
        {
            throw new InvalidOperationException(output);
        }
        return new CommandResult(process.ExitCode, output);
    }

    private static string CompactServiceOutput(string output)
    {
        var lines = output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var state = lines.FirstOrDefault(line => line.StartsWith("STATE", StringComparison.OrdinalIgnoreCase));
        return string.IsNullOrWhiteSpace(state) ? "ShellOrchestra Supervisor service status was loaded." : state;
    }

    private sealed record CommandResult(int ExitCode, string Output);
}
