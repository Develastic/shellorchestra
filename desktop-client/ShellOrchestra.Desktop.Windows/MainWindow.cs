using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using ShellOrchestra.Desktop.Core.Models;

namespace ShellOrchestra.Desktop.Windows;

public sealed class MainWindow : Form
{
    private readonly ShellOrchestraInstance instance;
    private readonly WebView2 webView = new() { Dock = DockStyle.Fill };

    public MainWindow(ShellOrchestraInstance instance)
    {
        this.instance = instance;
        Text = instance.DisplayName;
        Width = 1320;
        Height = 860;
        MinimumSize = new Size(980, 640);
        Controls.Add(webView);
        Load += async (_, _) => await InitializeWebViewAsync();
    }

    public async Task InvokeApiAsync(string path, HttpMethod method)
    {
        if (webView.CoreWebView2 is null) return;
        var script = $"fetch({System.Text.Json.JsonSerializer.Serialize(path)}, {{ method: {System.Text.Json.JsonSerializer.Serialize(method.Method)}, credentials: 'include' }}).catch(() => null);";
        await webView.CoreWebView2.ExecuteScriptAsync(script);
    }

    private async Task InitializeWebViewAsync()
    {
        var profileRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ShellOrchestra", "WebView2", instance.WebViewProfileName);
        Directory.CreateDirectory(profileRoot);
        var env = await CoreWebView2Environment.CreateAsync(userDataFolder: profileRoot);
        await webView.EnsureCoreWebView2Async(env);
        webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
        webView.CoreWebView2.Settings.IsPasswordAutosaveEnabled = false;
        webView.CoreWebView2.Settings.IsGeneralAutofillEnabled = false;
        webView.CoreWebView2.Navigate(instance.BaseUri.ToString());
    }
}
