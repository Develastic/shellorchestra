namespace ShellOrchestra.Desktop.Core.Models;

public enum RuntimeHealth
{
    Unknown,
    Starting,
    Ready,
    Degraded,
    Stopped
}

public sealed record ServiceStatus(RuntimeHealth Health, string Summary, DateTimeOffset UpdatedAt);
