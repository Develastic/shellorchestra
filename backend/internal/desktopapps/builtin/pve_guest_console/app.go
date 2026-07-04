// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package pve_guest_console

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:               "pve_guest_console",
	PluginID:         "builtin",
	Edition:          "community",
	Title:            "Guest console",
	Description:      "Open a backend-owned Proxmox VE VM or container console from Virtual Machines.",
	Kind:             "terminal",
	Icon:             "terminal",
	FrontendModule:   "terminal_profile",
	BackendDriver:    "terminal",
	BackendMode:      contract.ModeTerminal,
	LaunchCommand:    "app_launch_pve_guest_console",
	SupportedOS:      []string{"linux"},
	Hidden:           true,
	Capabilities:     []string{"terminal-profile", "pve", "guest-console"},
	Permissions:      []string{"ssh-session", "control-pve-guests"},
	SandboxPolicy:    "iframe-terminal",
	DefaultWidth:     900,
	DefaultHeight:    560,
	DefaultMaximized: true,
}
