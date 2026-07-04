// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package speed_test

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:               "speedtest",
	PluginID:         "builtin",
	Edition:          "community",
	Title:            "Test Speed",
	Description:      "Measure multi-stream throughput between the ShellOrchestra backend server and a managed SSH server without installing a remote agent.",
	Kind:             "speed_test",
	Icon:             "speed",
	FrontendModule:   "speed_test",
	BackendDriver:    "speed_test",
	BackendMode:      contract.ModeData,
	SupportedOS:      []string{"linux", "darwin", "windows"},
	Capabilities:     []string{"speed-test", "streaming-telemetry"},
	Permissions:      []string{"network-test"},
	SandboxPolicy:    "main",
	IntegratedWindow: true,
	DefaultWidth:     860,
	DefaultHeight:    390,
	DefaultMaximized: true,
}
