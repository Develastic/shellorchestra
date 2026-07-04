// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package scripts

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pelletier/go-toml/v2"

	"shellorchestra/backend/internal/domain"
)

type Catalog struct {
	root           string
	defaultTimeout time.Duration
	commands       map[string]CommandManifest
}

type CommandManifest struct {
	Name            string          `toml:"name"`
	Description     string          `toml:"description"`
	OutputSchema    string          `toml:"output_schema"`
	AppIDs          []string        `toml:"app_ids"`
	AppRole         string          `toml:"app_role"`
	TimeoutSeconds  int             `toml:"timeout_seconds"`
	MaxStdoutBytes  int64           `toml:"max_stdout_bytes"`
	MaxStderrBytes  int64           `toml:"max_stderr_bytes"`
	MaxDecodedBytes int64           `toml:"max_decoded_bytes"`
	StreamPolicy    string          `toml:"stream_policy"`
	AuditFields     []string        `toml:"audit_fields"`
	RequiresSudo    bool            `toml:"requires_sudo"`
	Variants        []ScriptVariant `toml:"variants"`
}

type ScriptVariant struct {
	ID              string   `toml:"id"`
	File            string   `toml:"file"`
	Shell           string   `toml:"shell"`
	OS              []string `toml:"os"`
	Distro          []string `toml:"distro"`
	PackageManagers []string `toml:"package_managers"`
	Default         bool     `toml:"default"`
}

type TargetFacts struct {
	Hostname                  string          `json:"hostname"`
	OS                        string          `json:"os"`
	Platform                  string          `json:"platform"`
	PlatformOS                string          `json:"platform_os"`
	PlatformArch              string          `json:"platform_arch"`
	Distro                    string          `json:"distro"`
	Shell                     string          `json:"shell"`
	AdminRights               string          `json:"admin_rights"`
	KernelVersion             string          `json:"kernel_version"`
	PackageManager            string          `json:"package_manager"`
	SSHMaxSessions            int             `json:"ssh_max_sessions"`
	Virtualization            string          `json:"virtualization"`
	WingetNeedsInitialization bool            `json:"winget_needs_initialization"`
	IsPVEHost                 bool            `json:"is_pve_host"`
	IsDockerHost              bool            `json:"is_docker_host"`
	IsPodmanHost              bool            `json:"is_podman_host"`
	Apps                      map[string]bool `json:"apps"`
}

type SelectedScript struct {
	Command CommandManifest
	Variant ScriptVariant
	Body    string
	Timeout time.Duration
}

const (
	DefaultMaxScriptStdoutBytes  int64 = 8 << 20
	DefaultMaxScriptStderrBytes  int64 = 1 << 20
	DefaultMaxScriptDecodedBytes int64 = 32 << 20
	MaxSourcePreviewBytes        int64 = 256 << 10
	MaxScriptBodyBytes           int64 = 2 << 20
	MaxSystemScriptBodyBytes     int64 = 2 << 20
	MaxCommandManifestBytes      int64 = 128 << 10
	MaxDesktopAppCatalogBytes    int64 = 256 << 10
	MaxScriptCatalogEntries            = 512
	MaxSystemScriptEntries             = 128
)

type OutputLimits struct {
	MaxStdoutBytes  int64
	MaxStderrBytes  int64
	MaxDecodedBytes int64
}

func LoadCatalog(root string, defaultTimeoutSeconds int) (*Catalog, error) {
	entries, truncated, err := readDirEntriesLimited(root, MaxScriptCatalogEntries, "script catalog")
	if err != nil {
		return nil, err
	}
	if truncated {
		return nil, fmt.Errorf("script catalog %s contains more than %d entries", root, MaxScriptCatalogEntries)
	}
	catalog := &Catalog{root: root, defaultTimeout: time.Duration(defaultTimeoutSeconds) * time.Second, commands: map[string]CommandManifest{}}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		manifestPath := filepath.Join(root, entry.Name(), "manifest.toml")
		data, err := readFileLimited(manifestPath, MaxCommandManifestBytes, "command manifest")
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", manifestPath, err)
		}
		var manifest CommandManifest
		if err := toml.Unmarshal(data, &manifest); err != nil {
			return nil, fmt.Errorf("parse %s: %w", manifestPath, err)
		}
		if err := validateRawCommandManifest(manifest, entry.Name(), manifestPath); err != nil {
			return nil, err
		}
		if manifest.Name != entry.Name() {
			return nil, fmt.Errorf("command manifest %s declares name %q but directory is %q", manifestPath, manifest.Name, entry.Name())
		}
		if manifest.OutputSchema == "" {
			return nil, fmt.Errorf("command %s must explicitly declare output_schema", manifest.Name)
		}
		if len(manifest.Variants) == 0 {
			return nil, fmt.Errorf("command %s has no variants", manifest.Name)
		}
		for index := range manifest.Variants {
			if err := validateVariantFile(manifest.Name, manifest.Variants[index].File); err != nil {
				return nil, err
			}
		}
		if err := validateCommandLimits(manifest); err != nil {
			return nil, err
		}
		catalog.commands[manifest.Name] = manifest
	}
	return catalog, nil
}

func SystemScriptsRoot(scriptsRoot string) string {
	return filepath.Join(filepath.Dir(scriptsRoot), "system-scripts")
}

func ReadSystemScriptEntries(scriptsRoot string) ([]os.DirEntry, string) {
	systemRoot := SystemScriptsRoot(scriptsRoot)
	entries, truncated, err := readDirEntriesLimited(systemRoot, MaxSystemScriptEntries, "system scripts")
	if err != nil {
		return nil, "Could not read ShellOrchestra system scripts: " + err.Error()
	}
	if truncated {
		return entries, fmt.Sprintf("ShellOrchestra system script list is truncated at %d entries.", MaxSystemScriptEntries)
	}
	return entries, ""
}

func validateRawCommandManifest(manifest CommandManifest, directoryName string, manifestPath string) error {
	label := fmt.Sprintf("command manifest %s", manifestPath)
	for field, value := range map[string]string{
		"name":          manifest.Name,
		"output_schema": manifest.OutputSchema,
		"app_role":      manifest.AppRole,
		"stream_policy": manifest.StreamPolicy,
	} {
		if err := validateCatalogToken(label, field, value, field != "app_role"); err != nil {
			return err
		}
	}
	if manifest.Name != directoryName {
		return fmt.Errorf("command manifest %s declares name %q but directory is %q", manifestPath, manifest.Name, directoryName)
	}
	if err := validateCatalogText(label, "description", manifest.Description, false); err != nil {
		return err
	}
	for _, appID := range manifest.AppIDs {
		if err := validateCatalogToken(label, "app_ids", appID, true); err != nil {
			return err
		}
	}
	for _, auditField := range manifest.AuditFields {
		if err := validateCatalogToken(label, "audit_fields", auditField, true); err != nil {
			return err
		}
	}
	for index, variant := range manifest.Variants {
		variantLabel := fmt.Sprintf("%s variant %d", label, index+1)
		if err := validateCatalogToken(variantLabel, "id", variant.ID, true); err != nil {
			return err
		}
		if err := validateVariantPathToken(variantLabel, "file", variant.File); err != nil {
			return err
		}
		if err := validateCatalogToken(variantLabel, "shell", variant.Shell, true); err != nil {
			return err
		}
		if err := validateOptionalCatalogTokenList(variantLabel, "os", variant.OS); err != nil {
			return err
		}
		if err := validateOptionalCatalogTokenList(variantLabel, "distro", variant.Distro); err != nil {
			return err
		}
		if err := validateOptionalCatalogTokenList(variantLabel, "package_managers", variant.PackageManagers); err != nil {
			return err
		}
	}
	return nil
}

func validateOptionalCatalogTokenList(label string, field string, values []string) error {
	for _, value := range values {
		if err := validateCatalogToken(label, field, value, true); err != nil {
			return err
		}
	}
	return nil
}

func validateVariantPathToken(label string, field string, value string) error {
	if err := validateCatalogText(label, field, value, true); err != nil {
		return err
	}
	if strings.Contains(value, "\\") {
		return fmt.Errorf("%s %s contains unsupported path separator", label, field)
	}
	for _, item := range value {
		if (item >= 'a' && item <= 'z') || (item >= '0' && item <= '9') || item == '_' || item == '-' || item == '.' || item == '/' {
			continue
		}
		return fmt.Errorf("%s %s contains unsupported path characters", label, field)
	}
	if filepath.Clean(value) != value {
		return fmt.Errorf("%s %s must use the exact normalized relative path", label, field)
	}
	return nil
}

func validateCommandLimits(command CommandManifest) error {
	for label, value := range map[string]int64{
		"max_stdout_bytes":  command.MaxStdoutBytes,
		"max_stderr_bytes":  command.MaxStderrBytes,
		"max_decoded_bytes": command.MaxDecodedBytes,
	} {
		if value <= 0 {
			return fmt.Errorf("command %s must explicitly declare positive %s", command.Name, label)
		}
	}
	if command.StreamPolicy == "" {
		return fmt.Errorf("command %s must explicitly declare stream_policy", command.Name)
	}
	switch command.StreamPolicy {
	case "terminal", "json", "json_action", "binary_upload", "binary_download":
		return nil
	default:
		return fmt.Errorf("command %s has unsupported stream_policy %q", command.Name, command.StreamPolicy)
	}
}

func validateVariantFile(commandName string, file string) error {
	if file == "" {
		return fmt.Errorf("command %s has a variant without a script file", commandName)
	}
	if filepath.IsAbs(file) {
		return fmt.Errorf("command %s variant file %q must be relative", commandName, file)
	}
	cleaned := filepath.Clean(file)
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		return fmt.Errorf("command %s variant file %q escapes the command directory", commandName, file)
	}
	return nil
}

func readScriptBody(path string) (string, error) {
	data, err := readFileLimited(path, MaxScriptBodyBytes, "script body")
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func ReadSystemScript(scriptsRoot string, name string) ([]byte, error) {
	name = strings.TrimSpace(name)
	if err := validateSystemScriptName(name); err != nil {
		return nil, err
	}
	path := filepath.Join(SystemScriptsRoot(scriptsRoot), name)
	return readFileLimited(path, MaxSystemScriptBodyBytes, "system script")
}

func readDirEntriesLimited(root string, maxEntries int, label string) ([]os.DirEntry, bool, error) {
	if maxEntries <= 0 {
		return nil, false, fmt.Errorf("%s entry limit must be positive", label)
	}
	dir, err := os.Open(root)
	if err != nil {
		return nil, false, err
	}
	defer dir.Close()
	entries, err := dir.ReadDir(maxEntries + 1)
	if err != nil && err != io.EOF {
		return nil, false, err
	}
	if len(entries) > maxEntries {
		return entries[:maxEntries], true, nil
	}
	return entries, false, nil
}

func validateSystemScriptName(name string) error {
	if name == "" {
		return fmt.Errorf("system script name is required")
	}
	if filepath.IsAbs(name) || strings.Contains(name, "/") || strings.Contains(name, "\\") {
		return fmt.Errorf("system script %q must be a plain file name", name)
	}
	cleaned := filepath.Clean(name)
	if cleaned == "." || cleaned == ".." || cleaned != name {
		return fmt.Errorf("system script %q must be a plain file name", name)
	}
	return nil
}

func readFileLimited(path string, limit int64, label string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("%s %s exceeds %d bytes", label, path, limit)
	}
	return data, nil
}

func ReadSourcePreview(path string) (string, string) {
	file, err := os.Open(path)
	if err != nil {
		return "", err.Error()
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, MaxSourcePreviewBytes+1))
	if err != nil {
		return "", err.Error()
	}
	if int64(len(data)) > MaxSourcePreviewBytes {
		return string(data[:MaxSourcePreviewBytes]), fmt.Sprintf("Source preview is truncated at %d bytes.", MaxSourcePreviewBytes)
	}
	return string(data), ""
}

func (m CommandManifest) EffectiveOutputLimits() OutputLimits {
	limits := OutputLimits{
		MaxStdoutBytes:  m.MaxStdoutBytes,
		MaxStderrBytes:  m.MaxStderrBytes,
		MaxDecodedBytes: m.MaxDecodedBytes,
	}
	if limits.MaxStdoutBytes <= 0 {
		limits.MaxStdoutBytes = DefaultMaxScriptStdoutBytes
	}
	if limits.MaxStderrBytes <= 0 {
		limits.MaxStderrBytes = DefaultMaxScriptStderrBytes
	}
	if limits.MaxDecodedBytes <= 0 {
		limits.MaxDecodedBytes = DefaultMaxScriptDecodedBytes
	}
	return limits
}

func (c *Catalog) List(includeSources bool) []domain.ScriptCommand {
	out := make([]domain.ScriptCommand, 0, len(c.commands))
	for _, command := range c.commands {
		variants := make([]string, 0, len(command.Variants))
		sources := make([]domain.ScriptSource, 0, len(command.Variants))
		for _, variant := range command.Variants {
			variants = append(variants, variant.ID)
			if includeSources {
				item := domain.ScriptSource{
					Variant:         variant.ID,
					File:            variant.File,
					Shell:           variant.Shell,
					OS:              variant.OS,
					Distro:          variant.Distro,
					PackageManagers: variant.PackageManagers,
				}
				item.Source, item.SourceError = ReadSourcePreview(filepath.Join(c.root, command.Name, variant.File))
				sources = append(sources, item)
			}
		}
		out = append(out, domain.ScriptCommand{Name: command.Name, Description: command.Description, AppIDs: command.AppIDs, AppRole: command.AppRole, Variants: variants, Sources: sources})
	}
	return out
}

func (c *Catalog) Select(commandName string, facts TargetFacts) (SelectedScript, error) {
	command, ok := c.commands[commandName]
	if !ok {
		return SelectedScript{}, fmt.Errorf("script command %q not found", commandName)
	}
	variant, err := selectVariant(command.Variants, facts)
	if err != nil {
		return SelectedScript{}, fmt.Errorf("no supported variant for %s: %w", commandName, err)
	}
	body, err := readScriptBody(filepath.Join(c.root, command.Name, variant.File))
	if err != nil {
		return SelectedScript{}, err
	}
	timeout := c.defaultTimeout
	if command.TimeoutSeconds > 0 {
		timeout = time.Duration(command.TimeoutSeconds) * time.Second
	}
	return SelectedScript{Command: command, Variant: variant, Body: body, Timeout: timeout}, nil
}

// SelectExact loads a script command variant by its immutable manifest identity.
// It is used by ssh-worker internal endpoints so callers cannot provide raw
// script bodies or shell labels over RPC.
func (c *Catalog) SelectExact(commandName string, variantID string) (SelectedScript, error) {
	command, ok := c.commands[commandName]
	if !ok {
		return SelectedScript{}, fmt.Errorf("script command %q not found", commandName)
	}
	for _, variant := range command.Variants {
		if variant.ID != variantID {
			continue
		}
		body, err := readScriptBody(filepath.Join(c.root, command.Name, variant.File))
		if err != nil {
			return SelectedScript{}, err
		}
		timeout := c.defaultTimeout
		if command.TimeoutSeconds > 0 {
			timeout = time.Duration(command.TimeoutSeconds) * time.Second
		}
		return SelectedScript{Command: command, Variant: variant, Body: body, Timeout: timeout}, nil
	}
	return SelectedScript{}, fmt.Errorf("script command %q variant %q not found", commandName, variantID)
}

func selectVariant(variants []ScriptVariant, facts TargetFacts) (ScriptVariant, error) {
	normalizedShell := normalizeShell(facts.Shell)
	factsOS := strings.ToLower(strings.TrimSpace(facts.OS))
	factsDistro := strings.ToLower(strings.TrimSpace(facts.Distro))
	factsPackageManager := strings.ToLower(strings.TrimSpace(facts.PackageManager))
	var defaultVariant *ScriptVariant
	for i := range variants {
		variant := variants[i]
		if variant.Default {
			defaultVariant = &variants[i]
		}
		if !matchesShell(variant.Shell, normalizedShell) || !matchesList(variant.OS, factsOS) || !matchesList(variant.PackageManagers, factsPackageManager) {
			continue
		}
		if len(variant.Distro) > 0 && matchesList(variant.Distro, factsDistro) {
			return variant, nil
		}
	}
	for _, variant := range variants {
		if matchesShell(variant.Shell, normalizedShell) && matchesList(variant.OS, factsOS) && matchesList(variant.PackageManagers, factsPackageManager) && len(variant.Distro) == 0 {
			return variant, nil
		}
	}
	if defaultVariant != nil && matchesShell(defaultVariant.Shell, normalizedShell) {
		return *defaultVariant, nil
	}
	return ScriptVariant{}, fmt.Errorf("target os=%q distro=%q shell=%q package_manager=%q is unsupported", facts.OS, facts.Distro, facts.Shell, facts.PackageManager)
}

func normalizeShell(shell string) string {
	shell = strings.ToLower(strings.TrimSpace(shell))
	if shell == "" || shell == "auto" || shell == "sh" {
		return "posix"
	}
	return shell
}

func matchesShell(variantShell string, targetShell string) bool {
	variantShell = normalizeShell(variantShell)
	if variantShell == targetShell {
		return true
	}
	return variantShell == "posix" && (targetShell == "ash" || targetShell == "bash" || targetShell == "dash" || targetShell == "ksh" || targetShell == "zsh" || targetShell == "posix")
}

func matchesList(values []string, target string) bool {
	if len(values) == 0 {
		return true
	}
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), target) {
			return true
		}
	}
	return false
}
