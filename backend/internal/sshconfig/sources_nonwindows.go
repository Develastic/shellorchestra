// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

//go:build !windows

package sshconfig

func appendPlatformProfileSources(result *SourceScanResult, defaultUsername string) {
	_ = defaultUsername
	for _, source := range []SourceScanSource{
		{ID: "putty", Label: "PuTTY", State: "windows_only", UnsupportedReason: "Automatic PuTTY registry scan runs in the Windows desktop-server package."},
		{ID: "kitty", Label: "KiTTY", State: "windows_only", UnsupportedReason: "Automatic KiTTY scan runs in the Windows desktop-server package."},
		{ID: "winscp", Label: "WinSCP", State: "windows_only", UnsupportedReason: "Automatic WinSCP site scan runs in the Windows desktop-server package."},
		{ID: "mobaxterm", Label: "MobaXterm", State: "windows_only", UnsupportedReason: "Automatic MobaXterm bookmark scan runs in the Windows desktop-server package."},
		{ID: "mremoteng", Label: "mRemoteNG", State: "windows_only", UnsupportedReason: "Automatic mRemoteNG XML scan runs in the Windows desktop-server package."},
		{ID: "securecrt", Label: "SecureCRT", State: "windows_only", UnsupportedReason: "Automatic SecureCRT session-file scan runs in the Windows desktop-server package."},
		{ID: "xshell", Label: "Xshell", State: "windows_only", UnsupportedReason: "Automatic Xshell session-file scan runs in the Windows desktop-server package."},
		{ID: "bitvise", Label: "Bitvise SSH Client", State: "windows_only", UnsupportedReason: "Automatic Bitvise profile scan runs in the Windows desktop-server package."},
		{ID: "royalts", Label: "Royal TS", State: "windows_only", UnsupportedReason: "Automatic Royal TS document scan runs in the Windows desktop-server package."},
		{ID: "rdm", Label: "Remote Desktop Manager", State: "windows_only", UnsupportedReason: "Automatic Remote Desktop Manager export scan runs in the Windows desktop-server package."},
		{ID: "termius_export", Label: "Termius export", State: "windows_only", UnsupportedReason: "Automatic Termius export scan runs in the Windows desktop-server package when a local export file is available."},
	} {
		result.Sources = append(result.Sources, source)
	}
}
