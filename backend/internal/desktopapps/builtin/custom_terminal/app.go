// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package custom_terminal

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:               "custom_terminal",
	PluginID:         "builtin",
	Edition:          "community",
	Title:            "Custom terminal shortcut",
	Description:      "Run a browser-local custom shortcut command in a ShellOrchestra terminal session.",
	Kind:             "terminal",
	Icon:             "terminal",
	FrontendModule:   "terminal_profile",
	BackendDriver:    "terminal",
	BackendMode:      contract.ModeTerminal,
	LaunchCommand:    "app_launch_custom_terminal",
	SupportedOS:      []string{"linux", "darwin", "freebsd", "windows"},
	Hidden:           true,
	Capabilities:     []string{"terminal-profile", "custom-shortcuts"},
	Permissions:      []string{"ssh-session"},
	SandboxPolicy:    "iframe-terminal",
	DefaultWidth:     900,
	DefaultHeight:    560,
	DefaultMaximized: true,
}
