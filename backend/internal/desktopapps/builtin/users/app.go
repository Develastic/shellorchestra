// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package users

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:                         "users",
	PluginID:                   "builtin",
	Edition:                    "community",
	Title:                      "Users",
	Description:                "Review local users and manage account passwords through external ShellOrchestra script profiles.",
	Kind:                       "users",
	Icon:                       "users",
	FrontendModule:             "users",
	BackendDriver:              "script_data",
	BackendMode:                contract.ModeData,
	DataCommand:                "users_data",
	ActionCommands:             map[string]string{"create": "users_action", "edit": "users_action", "set_password": "users_action", "lock": "users_action", "unlock": "users_action", "set_admin": "users_action", "add_group": "users_action", "remove_group": "users_action", "delete": "users_action", "add_ssh_key": "users_action", "remove_ssh_key": "users_action"},
	SupportedOS:                []string{"linux", "freebsd", "windows"},
	Capabilities:               []string{"users", "passwords", "script-data", "script-actions"},
	Permissions:                []string{"manage-users"},
	SandboxPolicy:              "main",
	IntegratedWindow:           true,
	DefaultWidth:               860,
	DefaultHeight:              520,
	DefaultMaximized:           true,
	DataRefreshIntervalSeconds: 15,
}
