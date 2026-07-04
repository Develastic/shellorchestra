// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package ssh_server

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:                         "ssh_server",
	PluginID:                   "builtin",
	Edition:                    "community",
	Title:                      "SSH Server",
	Description:                "Inspect and safely manage OpenSSH server policy, risky options, trusted user CAs, and Match blocks.",
	Kind:                       "ssh_server",
	Icon:                       "security",
	FrontendModule:             "ssh_server",
	BackendDriver:              "script_data",
	BackendMode:                contract.ModeData,
	DataCommand:                "ssh_server_data",
	ActionCommands:             map[string]string{"validate": "ssh_server_action", "apply": "ssh_server_action", "rollback": "ssh_server_action"},
	SupportedOS:                []string{"linux", "darwin", "freebsd", "windows"},
	Capabilities:               []string{"ssh-server", "script-data", "script-actions", "safe-editor"},
	Permissions:                []string{"inspect-ssh-server", "write-ssh-server"},
	SandboxPolicy:              "main",
	IntegratedWindow:           true,
	DefaultWidth:               920,
	DefaultHeight:              560,
	DefaultMaximized:           true,
	DataRefreshIntervalSeconds: 30,
}
