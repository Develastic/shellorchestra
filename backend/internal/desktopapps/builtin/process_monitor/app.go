// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package process_monitor

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:                         "process_monitor",
	PluginID:                   "builtin",
	Edition:                    "community",
	Title:                      "Task Manager",
	Description:                "Inspect process details and request safe process termination through external ShellOrchestra script profiles.",
	Kind:                       "process_monitor",
	Icon:                       "processes",
	FrontendModule:             "process_monitor",
	BackendDriver:              "script_data",
	BackendMode:                contract.ModeData,
	DataCommand:                "process_list",
	ActionCommands:             map[string]string{"kill": "process_kill"},
	SupportedOS:                []string{"linux", "darwin", "freebsd", "windows"},
	Capabilities:               []string{"processes", "script-data", "script-actions"},
	Permissions:                []string{"inspect-processes", "signal-processes"},
	SandboxPolicy:              "main",
	IntegratedWindow:           true,
	DefaultWidth:               640,
	DefaultHeight:              390,
	DefaultMaximized:           true,
	DataRefreshIntervalSeconds: 5,
}
