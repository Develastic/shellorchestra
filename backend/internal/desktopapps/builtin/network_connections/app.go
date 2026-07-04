// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package network_connections

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:                         "network_connections",
	PluginID:                   "builtin",
	Edition:                    "community",
	Title:                      "Network Connections",
	Description:                "Inspect network adapters and common connection settings through external ShellOrchestra script profiles.",
	Kind:                       "network_connections",
	Icon:                       "network",
	FrontendModule:             "network_connections",
	BackendDriver:              "script_data",
	BackendMode:                contract.ModeData,
	DataCommand:                "network_connections_data",
	ActionCommands:             map[string]string{"set_hostname": "network_connections_action", "set_mtu": "network_connections_action", "set_dns": "network_connections_action"},
	SupportedOS:                []string{"linux", "darwin", "windows"},
	Capabilities:               []string{"network", "script-data", "script-actions"},
	Permissions:                []string{"inspect-network", "configure-network"},
	SandboxPolicy:              "main",
	IntegratedWindow:           true,
	DefaultWidth:               860,
	DefaultHeight:              520,
	DefaultMaximized:           true,
	DataRefreshIntervalSeconds: 15,
}
