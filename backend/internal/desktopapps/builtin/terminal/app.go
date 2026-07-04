// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package terminal

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:               "terminal",
	PluginID:         "builtin",
	Edition:          "community",
	Title:            "Terminal",
	Description:      "Open an interactive shell over the managed SSH connection.",
	Kind:             "terminal",
	Icon:             "terminal",
	FrontendModule:   "terminal",
	BackendDriver:    "terminal",
	BackendMode:      contract.ModeTerminal,
	SupportedOS:      []string{"linux", "darwin", "freebsd", "windows"},
	Capabilities:     []string{"terminal", "interactive-ssh"},
	Permissions:      []string{"ssh-session"},
	SandboxPolicy:    "iframe-terminal",
	DefaultWidth:     860,
	DefaultHeight:    480,
	DefaultMaximized: true,
}
