// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package btop

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:               "btop",
	PluginID:         "builtin",
	Edition:          "community",
	Title:            "btop",
	Description:      "Resource monitor with CPU, memory, disk, and network graphs. If it is missing, ShellOrchestra can install it through the detected package manager.",
	Kind:             "terminal",
	Icon:             "monitor",
	FrontendModule:   "terminal_profile",
	BackendDriver:    "terminal",
	BackendMode:      contract.ModeTerminal,
	DetectedApp:      "btop",
	LaunchCommand:    "app_launch_btop",
	InstallCommand:   "app_install_btop",
	SupportedOS:      []string{"linux", "darwin"},
	Capabilities:     []string{"terminal-profile", "fullscreen-tui"},
	Permissions:      []string{"ssh-session"},
	SandboxPolicy:    "iframe-terminal",
	DefaultWidth:     860,
	DefaultHeight:    560,
	DefaultMaximized: true,
}
