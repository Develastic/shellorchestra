// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package package_manager

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:                         "package_manager",
	PluginID:                   "builtin",
	Edition:                    "community",
	Title:                      "Package Manager",
	Description:                "Review packages, security metadata where available, and package-upgrade workflows through ShellOrchestra external script profiles.",
	Kind:                       "package_manager",
	Icon:                       "packages",
	FrontendModule:             "package_manager",
	BackendDriver:              "script_data",
	BackendMode:                contract.ModeData,
	DataCommand:                "packages_data",
	ActionCommands:             map[string]string{"metadata_update": "packages_metadata_update", "upgrade": "packages_upgrade", "install": "packages_install", "remove": "packages_remove"},
	SupportedOS:                []string{"linux", "darwin", "freebsd", "windows"},
	Capabilities:               []string{"packages", "script-data", "script-actions"},
	Permissions:                []string{"run-package-manager"},
	SandboxPolicy:              "main",
	IntegratedWindow:           true,
	DefaultWidth:               860,
	DefaultHeight:              390,
	DefaultMaximized:           true,
	DataRefreshIntervalSeconds: 30,
}
