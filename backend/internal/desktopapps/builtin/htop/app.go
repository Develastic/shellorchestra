// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package htop

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:               "htop",
	PluginID:         "builtin",
	Edition:          "community",
	Title:            "htop",
	Description:      "Interactive process monitor. If it is missing, ShellOrchestra can install it through the detected package manager.",
	Kind:             "terminal",
	Icon:             "processes",
	FrontendModule:   "terminal_profile",
	BackendDriver:    "terminal",
	BackendMode:      contract.ModeTerminal,
	DetectedApp:      "htop",
	LaunchCommand:    "app_launch_htop",
	InstallCommand:   "app_install_htop",
	SupportedOS:      []string{"linux", "darwin"},
	Capabilities:     []string{"terminal-profile", "fullscreen-tui"},
	Permissions:      []string{"ssh-session"},
	SandboxPolicy:    "iframe-terminal",
	DefaultWidth:     860,
	DefaultHeight:    480,
	DefaultMaximized: true,
}
