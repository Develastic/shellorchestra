// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package cron_editor

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:               "cron_editor",
	PluginID:         "builtin",
	Edition:          "community",
	Title:            "Cron Editor",
	Description:      "Review and edit user crontabs through external ShellOrchestra script profiles.",
	Kind:             "cron_editor",
	Icon:             "schedule",
	FrontendModule:   "cron_editor",
	BackendDriver:    "script_data",
	BackendMode:      contract.ModeData,
	InstallCommand:   "app_install_cron",
	DataCommand:      "cron_editor_data",
	ActionCommands:   map[string]string{"save": "cron_editor_save"},
	SupportedOS:      []string{"linux", "darwin", "freebsd"},
	Capabilities:     []string{"cron", "script-data", "script-actions"},
	Permissions:      []string{"read-crontab", "write-crontab"},
	SandboxPolicy:    "main",
	IntegratedWindow: true,
	DefaultWidth:     860,
	DefaultHeight:    520,
	DefaultMaximized: true,
}
