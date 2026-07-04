// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package disks

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:               "disks",
	PluginID:         "builtin",
	Edition:          "community",
	Title:            "Disks",
	Description:      "Inspect disks, partitions, filesystems, and mount points in read-only mode through standard platform tools.",
	Kind:             "disks",
	Icon:             "storage",
	FrontendModule:   "disks",
	BackendDriver:    "script_data",
	BackendMode:      contract.ModeData,
	DataCommand:      "disks_data",
	SupportedOS:      []string{"linux", "darwin", "freebsd", "windows"},
	Capabilities:     []string{"disks", "read-only", "script-data"},
	Permissions:      []string{"inspect-disks"},
	SandboxPolicy:    "main",
	IntegratedWindow: true,
	DefaultWidth:     860,
	DefaultHeight:    520,
	DefaultMaximized: true,
}
