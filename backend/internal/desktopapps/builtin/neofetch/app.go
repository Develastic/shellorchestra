// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package neofetch

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:               "neofetch",
	PluginID:         "builtin",
	Edition:          "community",
	Title:            "neofetch",
	Description:      "System information summary rendered in a terminal. If it is missing, ShellOrchestra can install it through the detected package manager.",
	Kind:             "terminal",
	Icon:             "terminal",
	FrontendModule:   "terminal_profile",
	BackendDriver:    "terminal",
	BackendMode:      contract.ModeTerminal,
	DetectedApp:      "neofetch",
	LaunchCommand:    "app_launch_neofetch",
	InstallCommand:   "app_install_neofetch",
	SupportedOS:      []string{"linux", "darwin"},
	Capabilities:     []string{"terminal-profile"},
	Permissions:      []string{"ssh-session"},
	SandboxPolicy:    "iframe-terminal",
	DefaultWidth:     860,
	DefaultHeight:    480,
	DefaultMaximized: true,
}
