// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package connection_watch

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:                         "connection_watch",
	PluginID:                   "builtin",
	Edition:                    "community",
	Title:                      "Connection Watch",
	Description:                "Inspect TCP and UDP connections, including incoming, outgoing, and listening sockets.",
	Kind:                       "connection_watch",
	Icon:                       "connections",
	FrontendModule:             "connection_watch",
	BackendDriver:              "script_data",
	BackendMode:                contract.ModeData,
	DataCommand:                "connection_watch_data",
	SupportedOS:                []string{"linux", "darwin", "freebsd", "windows"},
	Capabilities:               []string{"network", "connections", "script-data", "read-only"},
	Permissions:                []string{"inspect-network"},
	SandboxPolicy:              "main",
	IntegratedWindow:           true,
	DefaultWidth:               920,
	DefaultHeight:              560,
	DefaultMaximized:           true,
	DataRefreshIntervalSeconds: 5,
}
