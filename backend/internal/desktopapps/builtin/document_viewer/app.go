// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package document_viewer

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:               "document_viewer",
	PluginID:         "builtin",
	Edition:          "community",
	Title:            "Document Viewer",
	Description:      "Open PDFs and office-style documents through ShellOrchestra safe simplified preview.",
	Kind:             "document_viewer",
	Icon:             "document",
	FrontendModule:   "document_viewer",
	BackendDriver:    "ui",
	BackendMode:      contract.ModeUI,
	SupportedOS:      []string{"linux", "darwin", "freebsd", "windows"},
	Hidden:           true,
	Capabilities:     []string{"safe-preview", "document-viewer", "files"},
	Permissions:      []string{"read-files"},
	SandboxPolicy:    "sandboxed-preview",
	IntegratedWindow: true,
	DefaultWidth:     920,
	DefaultHeight:    600,
	DefaultMaximized: true,
}
