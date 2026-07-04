// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package sshconfig

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

type SourceScanResult struct {
	Sources  []SourceScanSource  `json:"sources"`
	Profiles []SourceScanProfile `json:"profiles"`
}

type SourceScanSource struct {
	ID                string `json:"id"`
	Label             string `json:"label"`
	State             string `json:"state"`
	ProfileCount      int    `json:"profile_count"`
	UnsupportedReason string `json:"unsupported_reason,omitempty"`
	Detail            string `json:"detail,omitempty"`
}

type SourceScanProfile struct {
	Source          string                  `json:"source"`
	SourceProfileID string                  `json:"source_profile_id"`
	LabelProposed   string                  `json:"label_proposed"`
	HostAlias       string                  `json:"host_alias"`
	Hostname        string                  `json:"hostname"`
	Port            int                     `json:"port"`
	User            string                  `json:"user"`
	IdentityRefs    []SourceScanIdentityRef `json:"identity_refs,omitempty"`
	Proxy           map[string]string       `json:"proxy,omitempty"`
	AuthSuggestion  string                  `json:"auth_suggestion"`
	Warnings        []string                `json:"warnings,omitempty"`
	OpenSSHConfig   string                  `json:"open_ssh_config"`
}

type SourceScanIdentityRef struct {
	Provider string `json:"provider"`
	Path     string `json:"path,omitempty"`
	Handle   string `json:"handle,omitempty"`
}

func ScanLocalSources(ctx context.Context, defaultUsername string) SourceScanResult {
	_ = ctx
	defaultUsername = strings.TrimSpace(defaultUsername)
	result := SourceScanResult{}
	for _, source := range openSSHSources() {
		appendOpenSSHFileScan(&result, source.id, source.label, source.path, defaultUsername)
	}
	appendPlatformProfileSources(&result, defaultUsername)
	return result
}

type openSSHSource struct {
	id    string
	label string
	path  string
}

func openSSHSources() []openSSHSource {
	sources := []openSSHSource{}
	if home, err := os.UserHomeDir(); err == nil && strings.TrimSpace(home) != "" {
		sources = append(sources, openSSHSource{id: "openssh_user", label: "OpenSSH user config", path: filepath.Join(home, ".ssh", "config")})
	}
	if runtime.GOOS == "windows" {
		if programData := strings.TrimSpace(os.Getenv("ProgramData")); programData != "" {
			sources = append(sources, openSSHSource{id: "openssh_system", label: "OpenSSH system config", path: filepath.Join(programData, "ssh", "ssh_config")})
		}
	} else {
		sources = append(sources, openSSHSource{id: "openssh_system", label: "OpenSSH system config", path: "/etc/ssh/ssh_config"})
	}
	return sources
}

func appendOpenSSHFileScan(result *SourceScanResult, id string, label string, path string, defaultUsername string) {
	content, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			result.Sources = append(result.Sources, SourceScanSource{ID: id, Label: label, State: "not_found", Detail: path})
			return
		}
		result.Sources = append(result.Sources, SourceScanSource{ID: id, Label: label, State: "error", UnsupportedReason: "ShellOrchestra could not read this config file.", Detail: path})
		return
	}
	profiles, issues := Parse(string(content), defaultUsername)
	source := SourceScanSource{ID: id, Label: label, State: "found", ProfileCount: len(profiles), Detail: path}
	if len(profiles) == 0 {
		source.State = "empty"
	}
	if len(issues) > 0 {
		source.UnsupportedReason = fmt.Sprintf("%d Host block(s) were skipped because they are patterns, duplicates, or missing required fields.", len(issues))
	}
	result.Sources = append(result.Sources, source)
	for _, profile := range profiles {
		result.Profiles = append(result.Profiles, sourceProfileFromSSHConfig(id, profile, "ca", nil))
	}
}

func sourceProfileFromSSHConfig(sourceID string, profile Profile, authSuggestion string, extraWarnings []string) SourceScanProfile {
	identityRefs := make([]SourceScanIdentityRef, 0, len(profile.IdentityFiles))
	for _, identityFile := range profile.IdentityFiles {
		identityRefs = append(identityRefs, SourceScanIdentityRef{Provider: "file", Path: identityFile})
	}
	warnings := append([]string(nil), extraWarnings...)
	if profile.ProxyCommand != "" {
		warnings = append(warnings, "ProxyCommand is imported as text only and will not be executed automatically.")
	}
	proxy := map[string]string{}
	if profile.ProxyJump != "" {
		proxy["kind"] = "jump"
		proxy["jump_host"] = profile.ProxyJump
	}
	if profile.ProxyCommand != "" {
		proxy["proxy_command"] = profile.ProxyCommand
	}
	if len(proxy) == 0 {
		proxy = nil
	}
	return SourceScanProfile{
		Source:          sourceID,
		SourceProfileID: sourceID + ":" + profile.Name,
		LabelProposed:   profile.Name,
		HostAlias:       profile.Name,
		Hostname:        profile.Host,
		Port:            profile.Port,
		User:            profile.Username,
		IdentityRefs:    identityRefs,
		Proxy:           proxy,
		AuthSuggestion:  firstNonEmpty(authSuggestion, "ca"),
		Warnings:        warnings,
		OpenSSHConfig:   profileOpenSSHConfigBlock(profile),
	}
}

func profileOpenSSHConfigBlock(profile Profile) string {
	lines := []string{"Host " + sshConfigValue(profile.Name)}
	if profile.Host != "" && profile.Host != profile.Name {
		lines = append(lines, "  HostName "+sshConfigValue(profile.Host))
	}
	if profile.Username != "" {
		lines = append(lines, "  User "+sshConfigValue(profile.Username))
	}
	if profile.Port > 0 && profile.Port != 22 {
		lines = append(lines, "  Port "+strconv.Itoa(profile.Port))
	}
	for _, identityFile := range profile.IdentityFiles {
		lines = append(lines, "  IdentityFile "+sshConfigValue(identityFile))
	}
	if profile.IdentityAgent != "" {
		lines = append(lines, "  IdentityAgent "+sshConfigValue(profile.IdentityAgent))
	}
	if profile.ProxyJump != "" {
		lines = append(lines, "  ProxyJump "+sshConfigValue(profile.ProxyJump))
	}
	if profile.ProxyCommand != "" {
		lines = append(lines, "  # ProxyCommand was not enabled automatically: "+sanitizeComment(profile.ProxyCommand))
	}
	return strings.Join(lines, "\n")
}

func sshConfigValue(value string) string {
	value = strings.ReplaceAll(strings.TrimSpace(value), "\x00", "")
	value = strings.ReplaceAll(value, "\r", " ")
	value = strings.ReplaceAll(value, "\n", " ")
	if value == "" {
		return `""`
	}
	if strings.ContainsAny(value, " \t#\"'") {
		return `"` + strings.ReplaceAll(value, `"`, `\"`) + `"`
	}
	return value
}

func sanitizeComment(value string) string {
	value = strings.ReplaceAll(value, "\x00", "")
	value = strings.ReplaceAll(value, "\r", " ")
	value = strings.ReplaceAll(value, "\n", " ")
	return strings.TrimSpace(value)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
