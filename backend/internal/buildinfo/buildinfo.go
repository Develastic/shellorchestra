// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package buildinfo

import "strings"

var (
	DebugSupport              = "false"
	Edition                   = "community"
	Version                   = "0.0.0"
	VersionMajor              = "0"
	VersionMinor              = "0"
	VersionBuild              = "0"
	ReleaseRootPublicKeys     = ""
	ReleaseManifestPublicKeys = ""
)

func DebugSupported() bool {
	value := strings.TrimSpace(strings.ToLower(DebugSupport))
	return value == "1" || value == "true" || value == "yes" || value == "on"
}

func ProductEdition() string {
	value := strings.TrimSpace(strings.ToLower(Edition))
	if value == "" {
		return "community"
	}
	return value
}

func ReleasePublicKeys() []string {
	values := strings.Split(ReleaseManifestPublicKeys, ",")
	return splitCSV(values)
}

func ReleaseRootKeys() []string {
	values := strings.Split(ReleaseRootPublicKeys, ",")
	return splitCSV(values)
}

func splitCSV(values []string) []string {
	keys := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			keys = append(keys, value)
		}
	}
	return keys
}

func ProductVersion() string {
	version := strings.TrimSpace(Version)
	if version != "" && version != "0.0.0" {
		return version
	}
	major := strings.TrimSpace(VersionMajor)
	minor := strings.TrimSpace(VersionMinor)
	build := strings.TrimSpace(VersionBuild)
	if major == "" {
		major = "0"
	}
	if minor == "" {
		minor = "0"
	}
	if build == "" {
		build = "0"
	}
	return major + "." + minor + "." + build
}
