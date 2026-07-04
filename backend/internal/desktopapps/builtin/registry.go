// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package builtin

import (
	"fmt"
	"strings"

	"shellorchestra/backend/internal/desktopapps/builtin/btop"
	"shellorchestra/backend/internal/desktopapps/builtin/connection_watch"
	"shellorchestra/backend/internal/desktopapps/builtin/containers"
	"shellorchestra/backend/internal/desktopapps/builtin/contract"
	"shellorchestra/backend/internal/desktopapps/builtin/cron_editor"
	"shellorchestra/backend/internal/desktopapps/builtin/custom_terminal"
	"shellorchestra/backend/internal/desktopapps/builtin/disks"
	"shellorchestra/backend/internal/desktopapps/builtin/document_viewer"
	"shellorchestra/backend/internal/desktopapps/builtin/editor"
	"shellorchestra/backend/internal/desktopapps/builtin/file_manager"
	"shellorchestra/backend/internal/desktopapps/builtin/firewall"
	"shellorchestra/backend/internal/desktopapps/builtin/htop"
	"shellorchestra/backend/internal/desktopapps/builtin/lan_watch"
	"shellorchestra/backend/internal/desktopapps/builtin/logs"
	"shellorchestra/backend/internal/desktopapps/builtin/mc"
	"shellorchestra/backend/internal/desktopapps/builtin/neofetch"
	"shellorchestra/backend/internal/desktopapps/builtin/network_connections"
	"shellorchestra/backend/internal/desktopapps/builtin/package_manager"
	"shellorchestra/backend/internal/desktopapps/builtin/process_monitor"
	"shellorchestra/backend/internal/desktopapps/builtin/pve_guest_console"
	"shellorchestra/backend/internal/desktopapps/builtin/pve_manager"
	"shellorchestra/backend/internal/desktopapps/builtin/services"
	"shellorchestra/backend/internal/desktopapps/builtin/speed_test"
	"shellorchestra/backend/internal/desktopapps/builtin/spreadsheet_viewer"
	"shellorchestra/backend/internal/desktopapps/builtin/ssh_server"
	"shellorchestra/backend/internal/desktopapps/builtin/sudo_editor"
	"shellorchestra/backend/internal/desktopapps/builtin/terminal"
	"shellorchestra/backend/internal/desktopapps/builtin/users"
	"shellorchestra/backend/internal/scripts"
)

var definitions = []contract.Definition{
	terminal.Definition,
	package_manager.Definition,
	process_monitor.Definition,
	file_manager.Definition,
	containers.Definition,
	logs.Definition,
	services.Definition,
	users.Definition,
	connection_watch.Definition,
	cron_editor.Definition,
	firewall.Definition,
	ssh_server.Definition,
	disks.Definition,
	document_viewer.Definition,
	sudo_editor.Definition,
	pve_manager.Definition,
	pve_guest_console.Definition,
	custom_terminal.Definition,
	network_connections.Definition,
	mc.Definition,
	htop.Definition,
	lan_watch.Definition,
	btop.Definition,
	neofetch.Definition,
	speed_test.Definition,
	spreadsheet_viewer.Definition,
	editor.Definition,
}

func Definitions() map[string]contract.Definition {
	out := make(map[string]contract.Definition, len(definitions))
	for _, definition := range definitions {
		normalized := definition.Normalize()
		out[strings.TrimSpace(normalized.ID)] = normalized
	}
	return out
}

func Find(id string) (contract.Definition, bool) {
	for _, definition := range definitions {
		normalized := definition.Normalize()
		if strings.TrimSpace(normalized.ID) == strings.TrimSpace(id) {
			return normalized, true
		}
	}
	return contract.Definition{}, false
}

func Catalog() (scripts.DesktopAppCatalog, error) {
	apps := make([]scripts.DesktopAppProfile, 0, len(definitions))
	seen := map[string]struct{}{}
	for _, rawDefinition := range definitions {
		if err := rawDefinition.Validate(); err != nil {
			return scripts.DesktopAppCatalog{}, err
		}
		definition := rawDefinition.Normalize()
		if _, ok := seen[definition.ID]; ok {
			return scripts.DesktopAppCatalog{}, fmt.Errorf("duplicate internal desktop plugin id %q", definition.ID)
		}
		seen[definition.ID] = struct{}{}
		apps = append(apps, Profile(definition))
	}
	return scripts.DesktopAppCatalog{Apps: apps}, nil
}

func Profile(definition contract.Definition) scripts.DesktopAppProfile {
	definition = definition.Normalize()
	return scripts.NormalizeDesktopAppProfile(scripts.DesktopAppProfile{
		ID:                         definition.ID,
		PluginID:                   definition.PluginID,
		Edition:                    definition.Edition,
		Title:                      definition.Title,
		Description:                definition.Description,
		Kind:                       definition.Kind,
		Icon:                       definition.Icon,
		FrontendModule:             definition.FrontendModule,
		BackendDriver:              definition.BackendDriver,
		DetectedApp:                definition.DetectedApp,
		LaunchCommand:              definition.LaunchCommand,
		InstallCommand:             definition.InstallCommand,
		DataCommand:                definition.DataCommand,
		ActionCommands:             definition.ActionCommands,
		SupportedOS:                definition.SupportedOS,
		RequiresDocker:             definition.RequiresDocker,
		Hidden:                     definition.Hidden,
		Capabilities:               definition.Capabilities,
		Permissions:                definition.Permissions,
		SandboxPolicy:              definition.SandboxPolicy,
		IntegratedWindow:           definition.IntegratedWindow,
		DefaultWidth:               definition.DefaultWidth,
		DefaultHeight:              definition.DefaultHeight,
		DefaultMaximized:           definition.DefaultMaximized,
		DataRefreshIntervalSeconds: definition.DataRefreshIntervalSeconds,
		DataMonitorIntervalSeconds: definition.DataMonitorIntervalSeconds,
		DataMonitorTTLSeconds:      definition.DataMonitorTTLSeconds,
	})
}
