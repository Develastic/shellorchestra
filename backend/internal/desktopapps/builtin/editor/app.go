// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package editor

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:               "editor",
	PluginID:         "builtin",
	Edition:          "community",
	Title:            "Editor",
	Description:      "Open remote text files in the sandboxed ShellOrchestra code editor.",
	Kind:             "editor",
	Icon:             "edit",
	FrontendModule:   "editor",
	BackendDriver:    "ui",
	BackendMode:      contract.ModeUI,
	SupportedOS:      []string{"linux", "darwin", "freebsd", "windows"},
	Hidden:           true,
	Capabilities:     []string{"code-editor", "sandboxed-editor", "safe-preview", "stream-upload"},
	Permissions:      []string{"read-files", "write-files"},
	SandboxPolicy:    "sandboxed-editor",
	IntegratedWindow: true,
	DefaultWidth:     860,
	DefaultHeight:    520,
	DefaultMaximized: true,
}
