// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package sudo_editor

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:               "sudo_editor",
	PluginID:         "builtin",
	Edition:          "community",
	Title:            "Edit Sudo",
	Description:      "Review and edit sudoers files after target-side sudoers syntax validation.",
	Kind:             "sudo_editor",
	Icon:             "security",
	FrontendModule:   "sudo_editor",
	BackendDriver:    "script_data",
	BackendMode:      contract.ModeData,
	DataCommand:      "sudo_editor_data",
	ActionCommands:   map[string]string{"save": "sudo_editor_save"},
	SupportedOS:      []string{"linux", "darwin", "freebsd"},
	Capabilities:     []string{"sudoers", "script-data", "script-actions", "safe-editor"},
	Permissions:      []string{"read-sudoers", "write-sudoers"},
	SandboxPolicy:    "sandboxed-editor",
	IntegratedWindow: true,
	DefaultWidth:     860,
	DefaultHeight:    520,
	DefaultMaximized: true,
}
