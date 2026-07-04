namespace ShellOrchestra.Desktop.Core.Models;

public sealed record ShellOrchestraInstance(
    string Id,
    string DisplayName,
    Uri BaseUri,
    bool IsLocalRuntime,
    string WebViewProfileName)
{
    public static ShellOrchestraInstance LocalDefault() => new(
        Id: "local",
        DisplayName: "Local ShellOrchestra",
        BaseUri: new Uri("http://127.0.0.1:7171/"),
        IsLocalRuntime: true,
        WebViewProfileName: "local");
}
