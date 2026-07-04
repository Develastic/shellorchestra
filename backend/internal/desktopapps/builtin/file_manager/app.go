// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package file_manager

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:               "file_manager",
	PluginID:         "builtin",
	Edition:          "community",
	Title:            "File Manager",
	Description:      "Browse, preview, edit, copy, move, rename, and delete remote files through external ShellOrchestra script profiles.",
	Kind:             "file_manager",
	Icon:             "files",
	FrontendModule:   "file_manager",
	BackendDriver:    "script_data",
	BackendMode:      contract.ModeData,
	DataCommand:      "file_manager_data",
	SupportedOS:      []string{"linux", "darwin", "freebsd", "windows"},
	Capabilities:     []string{"files", "stream-upload", "stream-download", "safe-preview"},
	Permissions:      []string{"read-files", "write-files"},
	SandboxPolicy:    "sandboxed-preview",
	IntegratedWindow: true,
	DefaultWidth:     860,
	DefaultHeight:    520,
	DefaultMaximized: true,
}
