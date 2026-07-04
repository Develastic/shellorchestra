// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package mc

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:               "mc",
	PluginID:         "builtin",
	Edition:          "community",
	Title:            "Midnight Commander",
	Description:      "Two-panel terminal file manager. If it is missing, ShellOrchestra can install it through the detected package manager.",
	Kind:             "terminal",
	Icon:             "files",
	FrontendModule:   "terminal_profile",
	BackendDriver:    "terminal",
	BackendMode:      contract.ModeTerminal,
	DetectedApp:      "mc",
	LaunchCommand:    "app_launch_mc",
	InstallCommand:   "app_install_mc",
	SupportedOS:      []string{"linux", "darwin", "windows"},
	Capabilities:     []string{"terminal-profile", "fullscreen-tui"},
	Permissions:      []string{"ssh-session"},
	SandboxPolicy:    "iframe-terminal",
	DefaultWidth:     860,
	DefaultHeight:    480,
	DefaultMaximized: true,
}
