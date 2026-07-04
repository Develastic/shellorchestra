// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package logs

import "shellorchestra/backend/internal/desktopapps/builtin/contract"

var Definition = contract.Definition{
	ID:                         "logs",
	PluginID:                   "builtin",
	Edition:                    "community",
	Title:                      "Logs",
	Description:                "Inspect system logs and service journal entries through bounded external script profiles.",
	Kind:                       "logs",
	Icon:                       "logs",
	FrontendModule:             "logs",
	BackendDriver:              "script_data",
	BackendMode:                contract.ModeData,
	DataCommand:                "logs_data",
	SupportedOS:                []string{"linux", "darwin", "windows"},
	Capabilities:               []string{"logs", "journal", "script-data", "read-only"},
	Permissions:                []string{"inspect-logs"},
	SandboxPolicy:              "main",
	IntegratedWindow:           true,
	DefaultWidth:               920,
	DefaultHeight:              560,
	DefaultMaximized:           true,
	DataRefreshIntervalSeconds: 10,
}
