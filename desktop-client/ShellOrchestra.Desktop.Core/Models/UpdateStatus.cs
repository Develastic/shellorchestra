using System.Text.Json.Serialization;

namespace ShellOrchestra.Desktop.Core.Models;

public sealed record UpdateStatus(
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("current_version")] string CurrentVersion,
    [property: JsonPropertyName("current_edition")] string CurrentEdition,
    [property: JsonPropertyName("channel")] string Channel,
    [property: JsonPropertyName("latest_version")] string? LatestVersion,
    [property: JsonPropertyName("update_available")] bool UpdateAvailable,
    [property: JsonPropertyName("critical")] bool Critical,
    [property: JsonPropertyName("one_click_available")] bool OneClickAvailable,
    [property: JsonPropertyName("manual_upgrade_required")] bool ManualUpgradeRequired,
    [property: JsonPropertyName("install_method")] string InstallMethod,
    [property: JsonPropertyName("manual_upgrade_command")] string? ManualUpgradeCommand,
    [property: JsonPropertyName("message")] string Message,
    [property: JsonPropertyName("checked_at")] DateTimeOffset CheckedAt);

public sealed record UpgradeCapability(bool CanUpgradeNow, string OperatorMessage)
{
    public static UpgradeCapability Disabled(string message) => new(false, message);
    public static UpgradeCapability Enabled(string message) => new(true, message);
}
