// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package firewall

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:                         "firewall",
	PluginID:                   "builtin",
	Edition:                    "community",
	Title:                      "Firewall",
	Description:                "Inspect and control supported firewall backends with SSH-access safety checks. Linux uses UFW, Windows uses NetSecurity, and macOS uses Application Firewall.",
	Kind:                       "firewall",
	Icon:                       "firewall",
	FrontendModule:             "firewall",
	BackendDriver:              "script_data",
	BackendMode:                contract.ModeData,
	InstallCommand:             "app_install_ufw",
	DataCommand:                "firewall_data",
	ActionCommands:             map[string]string{"enable": "firewall_action", "disable": "firewall_action", "add_rule": "firewall_action", "delete_rule": "firewall_action"},
	SupportedOS:                []string{"linux", "darwin", "windows"},
	Capabilities:               []string{"firewall", "script-data", "script-actions"},
	Permissions:                []string{"control-firewall"},
	SandboxPolicy:              "main",
	IntegratedWindow:           true,
	DefaultWidth:               860,
	DefaultHeight:              520,
	DefaultMaximized:           true,
	DataRefreshIntervalSeconds: 15,
}
