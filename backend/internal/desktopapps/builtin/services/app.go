// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package services

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:                         "services",
	PluginID:                   "builtin",
	Edition:                    "community",
	Title:                      "Services",
	Description:                "Inspect and control system services through external ShellOrchestra script profiles.",
	Kind:                       "services",
	Icon:                       "services",
	FrontendModule:             "services",
	BackendDriver:              "script_data",
	BackendMode:                contract.ModeData,
	DataCommand:                "services_data",
	ActionCommands:             map[string]string{"start": "services_action", "stop": "services_action", "restart": "services_action", "reload": "services_action"},
	SupportedOS:                []string{"linux"},
	Capabilities:               []string{"services", "script-data", "script-actions", "open-editor"},
	Permissions:                []string{"control-services"},
	SandboxPolicy:              "main",
	IntegratedWindow:           true,
	DefaultWidth:               860,
	DefaultHeight:              520,
	DefaultMaximized:           true,
	DataRefreshIntervalSeconds: 10,
}
