// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package spreadsheet_viewer

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:               "spreadsheet_viewer",
	PluginID:         "builtin",
	Edition:          "community",
	Title:            "Spreadsheet Viewer",
	Description:      "Open spreadsheets through ShellOrchestra safe inert cell extraction and grid preview.",
	Kind:             "spreadsheet_viewer",
	Icon:             "spreadsheet",
	FrontendModule:   "spreadsheet_viewer",
	BackendDriver:    "ui",
	BackendMode:      contract.ModeUI,
	SupportedOS:      []string{"linux", "darwin", "freebsd", "windows"},
	Hidden:           true,
	Capabilities:     []string{"safe-preview", "spreadsheet-viewer", "files"},
	Permissions:      []string{"read-files"},
	SandboxPolicy:    "sandboxed-preview",
	IntegratedWindow: true,
	DefaultWidth:     980,
	DefaultHeight:    620,
	DefaultMaximized: true,
}
