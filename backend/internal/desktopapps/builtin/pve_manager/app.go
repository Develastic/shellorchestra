// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package pve_manager

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:                         "pve_manager",
	PluginID:                   "builtin",
	Edition:                    "community",
	Title:                      "Virtual Machines",
	Description:                "Inspect virtual machines and containers through virtualization providers. Current provider: Proxmox VE.",
	Kind:                       "pve_manager",
	Icon:                       "storage",
	FrontendModule:             "pve_manager",
	BackendDriver:              "script_data",
	BackendMode:                contract.ModeData,
	DataCommand:                "pve_manager_data",
	ActionCommands:             map[string]string{"start": "pve_manager_action", "shutdown": "pve_manager_action", "reboot": "pve_manager_action", "stop": "pve_manager_action"},
	SupportedOS:                []string{"linux"},
	Capabilities:               []string{"virtual-machines", "provider-proxmox", "pve", "script-data", "script-actions"},
	Permissions:                []string{"inspect-pve", "control-pve-guests"},
	SandboxPolicy:              "main",
	IntegratedWindow:           true,
	DefaultWidth:               920,
	DefaultHeight:              560,
	DefaultMaximized:           true,
	DataRefreshIntervalSeconds: 5,
	DataMonitorIntervalSeconds: 5,
	DataMonitorTTLSeconds:      120,
}
