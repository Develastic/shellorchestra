# ShellOrchestra Desktop Client

Native shell projects for ShellOrchestra desktop packaging.

The desktop client is intentionally split into:

- `ShellOrchestra.Desktop.Core` — platform-neutral instance, command, settings, and service-control abstractions.
- `ShellOrchestra.Desktop.Windows` — Windows tray + WebView2 head.

Packaging modes:

1. **ShellOrchestra Server for Windows** — includes local backend runtime and opens the local service.
2. **ShellOrchestra Desktop Client for Windows** — connects to an existing self-hosted ShellOrchestra URL and does not include backend runtime roles.

The shell does not bypass server authorization, trusted-device rules, request signing, or key-share handling. It is a native container for the same web application.

Windows Server installations create two Windows services:

- `ShellOrchestraSupervisor` runs the local runtime.
- `ShellOrchestraUpdater` applies signed update bundles.

The tray app can show service status, request a supervisor restart, lock server access through the web API, and open the same update status that the browser UI uses. One-click upgrade still belongs to the authenticated web app and the local updater service; the tray shell does not mutate installed files directly.

## Official Windows installer

Users install the Windows edition from the signed ShellOrchestra installer published on the product site. Public source availability is for inspection and security review; it is not a substitute for the official signed installer and updater flow.

See the user-facing instructions at <https://shellorchestra.com/docs/windows-install>.
