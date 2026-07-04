// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package lan_watch

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:               "lan_watch",
	PluginID:         "builtin",
	Edition:          "community",
	Title:            "LAN Watch",
	Description:      "Discover nearby LAN hosts and read SSH banners without authenticating.",
	Kind:             "lan_watch",
	Icon:             "lan_watch",
	FrontendModule:   "lan_watch",
	BackendDriver:    "script_data",
	BackendMode:      contract.ModeData,
	InstallCommand:   "app_install_lan_probe",
	DataCommand:      "lan_watch_data",
	SupportedOS:      []string{"linux", "darwin", "freebsd", "windows"},
	Capabilities:     []string{"network", "lan-discovery", "script-data", "script-actions", "read-only"},
	Permissions:      []string{"inspect-network", "install-network-tools"},
	SandboxPolicy:    "main",
	IntegratedWindow: true,
	DefaultWidth:     920,
	DefaultHeight:    560,
	DefaultMaximized: true,
}
