// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package containers

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:                         "containers",
	PluginID:                   "builtin",
	Edition:                    "community",
	Title:                      "Containers",
	Description:                "Inspect and control Docker or Podman containers through explicit external script profiles.",
	Kind:                       "containers",
	Icon:                       "docker",
	FrontendModule:             "containers",
	BackendDriver:              "script_data",
	BackendMode:                contract.ModeData,
	DataCommand:                "containers_data",
	ActionCommands:             map[string]string{"start": "containers_action", "stop": "containers_action", "restart": "containers_action", "logs": "containers_logs", "install": "containers_install"},
	SupportedOS:                []string{"linux", "darwin", "windows"},
	Capabilities:               []string{"containers", "script-data", "script-actions"},
	Permissions:                []string{"inspect-containers", "control-containers"},
	SandboxPolicy:              "main",
	IntegratedWindow:           true,
	DefaultWidth:               980,
	DefaultHeight:              600,
	DefaultMaximized:           true,
	DataRefreshIntervalSeconds: 5,
}
