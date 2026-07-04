// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package scripts

import (
	"fmt"
	"strings"
	"unicode"

	"github.com/pelletier/go-toml/v2"
)

type DesktopAppCatalog struct {
	Apps []DesktopAppProfile `toml:"apps" json:"apps"`
}

type DesktopAppProfile struct {
	ID                         string            `toml:"id" json:"id"`
	PluginID                   string            `toml:"plugin_id" json:"plugin_id,omitempty"`
	Edition                    string            `toml:"edition" json:"edition,omitempty"`
	Title                      string            `toml:"title" json:"title"`
	Description                string            `toml:"description" json:"description"`
	Kind                       string            `toml:"kind" json:"kind"`
	Icon                       string            `toml:"icon" json:"icon"`
	FrontendModule             string            `toml:"frontend_module" json:"frontend_module,omitempty"`
	BackendDriver              string            `toml:"backend_driver" json:"backend_driver,omitempty"`
	DetectedApp                string            `toml:"detected_app" json:"detected_app,omitempty"`
	LaunchCommand              string            `toml:"launch_command" json:"launch_command,omitempty"`
	InstallCommand             string            `toml:"install_command" json:"install_command,omitempty"`
	DataCommand                string            `toml:"data_command" json:"data_command,omitempty"`
	ActionCommands             map[string]string `toml:"actions" json:"actions,omitempty"`
	SupportedOS                []string          `toml:"supported_os" json:"supported_os,omitempty"`
	RequiresDocker             bool              `toml:"requires_docker" json:"requires_docker,omitempty"`
	Hidden                     bool              `toml:"hidden" json:"hidden,omitempty"`
	Capabilities               []string          `toml:"capabilities" json:"capabilities,omitempty"`
	Permissions                []string          `toml:"permissions" json:"permissions,omitempty"`
	SandboxPolicy              string            `toml:"sandbox_policy" json:"sandbox_policy,omitempty"`
	IntegratedWindow           bool              `toml:"integrated_window" json:"integrated_window,omitempty"`
	DefaultWidth               int               `toml:"default_width" json:"default_width,omitempty"`
	DefaultHeight              int               `toml:"default_height" json:"default_height,omitempty"`
	DefaultMaximized           bool              `toml:"default_maximized" json:"default_maximized,omitempty"`
	DataRefreshIntervalSeconds int               `toml:"data_refresh_interval_seconds" json:"data_refresh_interval_seconds,omitempty"`
	DataMonitorIntervalSeconds int               `toml:"data_monitor_interval_seconds" json:"data_monitor_interval_seconds,omitempty"`
	DataMonitorTTLSeconds      int               `toml:"data_monitor_ttl_seconds" json:"data_monitor_ttl_seconds,omitempty"`
}

type desktopAppCatalogRaw struct {
	Apps []desktopAppProfileRaw `toml:"apps"`
}

type desktopAppProfileRaw struct {
	ID                         string            `toml:"id"`
	PluginID                   string            `toml:"plugin_id"`
	Edition                    string            `toml:"edition"`
	Title                      string            `toml:"title"`
	Description                string            `toml:"description"`
	Kind                       string            `toml:"kind"`
	Icon                       string            `toml:"icon"`
	FrontendModule             string            `toml:"frontend_module"`
	BackendDriver              string            `toml:"backend_driver"`
	DetectedApp                string            `toml:"detected_app"`
	LaunchCommand              string            `toml:"launch_command"`
	InstallCommand             string            `toml:"install_command"`
	DataCommand                string            `toml:"data_command"`
	ActionCommands             map[string]string `toml:"actions"`
	SupportedOS                []string          `toml:"supported_os"`
	Capabilities               []string          `toml:"capabilities"`
	Permissions                []string          `toml:"permissions"`
	SandboxPolicy              string            `toml:"sandbox_policy"`
	IntegratedWindow           *bool             `toml:"integrated_window"`
	DefaultWidth               *int              `toml:"default_width"`
	DefaultHeight              *int              `toml:"default_height"`
	DefaultMaximized           *bool             `toml:"default_maximized"`
	DataRefreshIntervalSeconds *int              `toml:"data_refresh_interval_seconds"`
	DataMonitorIntervalSeconds *int              `toml:"data_monitor_interval_seconds"`
	DataMonitorTTLSeconds      *int              `toml:"data_monitor_ttl_seconds"`
}

func LoadDesktopAppCatalog(path string) (DesktopAppCatalog, error) {
	data, err := readFileLimited(path, MaxDesktopAppCatalogBytes, "desktop app catalog")
	if err != nil {
		return DesktopAppCatalog{}, err
	}
	var rawCatalog desktopAppCatalogRaw
	if err := toml.Unmarshal(data, &rawCatalog); err != nil {
		return DesktopAppCatalog{}, err
	}
	if err := validateRawDesktopAppCatalog(rawCatalog); err != nil {
		return DesktopAppCatalog{}, err
	}
	var catalog DesktopAppCatalog
	if err := toml.Unmarshal(data, &catalog); err != nil {
		return DesktopAppCatalog{}, err
	}
	for index := range catalog.Apps {
		catalog.Apps[index] = NormalizeDesktopAppProfile(catalog.Apps[index])
	}
	return catalog, nil
}

func validateRawDesktopAppCatalog(catalog desktopAppCatalogRaw) error {
	seenIDs := map[string]struct{}{}
	for index, app := range catalog.Apps {
		label := fmt.Sprintf("desktop app catalog entry %d", index+1)
		for field, value := range map[string]string{
			"id":              app.ID,
			"plugin_id":       app.PluginID,
			"edition":         app.Edition,
			"kind":            app.Kind,
			"icon":            app.Icon,
			"frontend_module": app.FrontendModule,
			"backend_driver":  app.BackendDriver,
			"sandbox_policy":  app.SandboxPolicy,
		} {
			if err := validateCatalogToken(label, field, value, true); err != nil {
				return err
			}
		}
		if _, ok := seenIDs[app.ID]; ok {
			return fmt.Errorf("%s id %q is duplicated", label, app.ID)
		}
		seenIDs[app.ID] = struct{}{}
		for field, value := range map[string]string{
			"title":       app.Title,
			"description": app.Description,
		} {
			if err := validateCatalogText(label, field, value, true); err != nil {
				return err
			}
		}
		for field, value := range map[string]string{
			"detected_app":    app.DetectedApp,
			"launch_command":  app.LaunchCommand,
			"install_command": app.InstallCommand,
			"data_command":    app.DataCommand,
		} {
			if err := validateCatalogToken(label, field, value, false); err != nil {
				return err
			}
		}
		if err := validateCatalogTokenList(label, "supported_os", app.SupportedOS); err != nil {
			return err
		}
		if err := validateCatalogTokenList(label, "capabilities", app.Capabilities); err != nil {
			return err
		}
		if err := validateCatalogTokenList(label, "permissions", app.Permissions); err != nil {
			return err
		}
		for key, value := range app.ActionCommands {
			if err := validateCatalogToken(label, "actions key", key, true); err != nil {
				return err
			}
			if err := validateCatalogToken(label, "actions value", value, true); err != nil {
				return err
			}
		}
		if app.IntegratedWindow == nil {
			return fmt.Errorf("%s integrated_window is required", label)
		}
		if err := validateCatalogDimension(label, "default_width", app.DefaultWidth); err != nil {
			return err
		}
		if err := validateCatalogDimension(label, "default_height", app.DefaultHeight); err != nil {
			return err
		}
		if app.DefaultMaximized == nil {
			return fmt.Errorf("%s default_maximized is required", label)
		}
		if err := validateCatalogOptionalSeconds(label, "data_refresh_interval_seconds", app.DataRefreshIntervalSeconds); err != nil {
			return err
		}
		if err := validateCatalogOptionalSeconds(label, "data_monitor_interval_seconds", app.DataMonitorIntervalSeconds); err != nil {
			return err
		}
		if err := validateCatalogOptionalSeconds(label, "data_monitor_ttl_seconds", app.DataMonitorTTLSeconds); err != nil {
			return err
		}
	}
	return nil
}

func validateCatalogTokenList(label string, field string, values []string) error {
	if len(values) == 0 {
		return fmt.Errorf("%s %s is required", label, field)
	}
	for _, value := range values {
		if err := validateCatalogToken(label, field, value, true); err != nil {
			return err
		}
	}
	return nil
}

func validateCatalogText(label string, field string, value string, required bool) error {
	if strings.TrimSpace(value) != value {
		return fmt.Errorf("%s %s contains unsupported surrounding whitespace", label, field)
	}
	if value == "" {
		if required {
			return fmt.Errorf("%s %s is required", label, field)
		}
		return nil
	}
	if containsCatalogControl(value) {
		return fmt.Errorf("%s %s contains unsupported control characters", label, field)
	}
	return nil
}

func validateCatalogToken(label string, field string, value string, required bool) error {
	if err := validateCatalogText(label, field, value, required); err != nil {
		return err
	}
	if value == "" {
		return nil
	}
	if strings.ToLower(value) != value {
		return fmt.Errorf("%s %s must use the exact lower-case token form", label, field)
	}
	for _, item := range value {
		if (item >= 'a' && item <= 'z') || (item >= '0' && item <= '9') || item == '_' || item == '-' || item == '.' {
			continue
		}
		return fmt.Errorf("%s %s contains unsupported token characters", label, field)
	}
	return nil
}

func validateCatalogDimension(label string, field string, value *int) error {
	if value == nil {
		return fmt.Errorf("%s %s is required", label, field)
	}
	if *value <= 0 || *value > 4096 {
		return fmt.Errorf("%s %s must be between 1 and 4096", label, field)
	}
	return nil
}

func validateCatalogOptionalSeconds(label string, field string, value *int) error {
	if value == nil {
		return nil
	}
	if *value < 0 || *value > 86400 {
		return fmt.Errorf("%s %s must be between 0 and 86400 seconds", label, field)
	}
	return nil
}

func containsCatalogControl(value string) bool {
	for _, item := range value {
		if unicode.IsControl(item) {
			return true
		}
	}
	return false
}

func NormalizeDesktopAppProfile(profile DesktopAppProfile) DesktopAppProfile {
	return normalizeDesktopAppProfile(profile)
}

func normalizeDesktopAppProfile(profile DesktopAppProfile) DesktopAppProfile {
	profile.ID = strings.TrimSpace(profile.ID)
	profile.PluginID = strings.TrimSpace(profile.PluginID)
	profile.Edition = strings.ToLower(strings.TrimSpace(profile.Edition))
	profile.Title = strings.TrimSpace(profile.Title)
	profile.Description = strings.TrimSpace(profile.Description)
	profile.Kind = strings.TrimSpace(profile.Kind)
	profile.Icon = strings.TrimSpace(profile.Icon)
	profile.FrontendModule = strings.TrimSpace(profile.FrontendModule)
	profile.BackendDriver = strings.TrimSpace(profile.BackendDriver)
	profile.DetectedApp = strings.TrimSpace(profile.DetectedApp)
	profile.LaunchCommand = strings.TrimSpace(profile.LaunchCommand)
	profile.InstallCommand = strings.TrimSpace(profile.InstallCommand)
	profile.DataCommand = strings.TrimSpace(profile.DataCommand)
	if profile.ActionCommands == nil {
		profile.ActionCommands = map[string]string{}
	}
	for key, value := range profile.ActionCommands {
		normalizedKey := strings.ToLower(strings.TrimSpace(key))
		normalizedValue := strings.TrimSpace(value)
		delete(profile.ActionCommands, key)
		if normalizedKey != "" && normalizedValue != "" {
			profile.ActionCommands[normalizedKey] = normalizedValue
		}
	}
	for index, item := range profile.SupportedOS {
		profile.SupportedOS[index] = strings.ToLower(strings.TrimSpace(item))
	}
	for index, item := range profile.Capabilities {
		profile.Capabilities[index] = strings.ToLower(strings.TrimSpace(item))
	}
	for index, item := range profile.Permissions {
		profile.Permissions[index] = strings.ToLower(strings.TrimSpace(item))
	}
	profile.SandboxPolicy = strings.ToLower(strings.TrimSpace(profile.SandboxPolicy))
	if profile.Kind == "" {
		profile.Kind = "terminal"
	}
	if profile.PluginID == "" {
		profile.PluginID = "builtin"
	}
	if profile.Edition == "" {
		profile.Edition = "community"
	}
	if profile.FrontendModule == "" {
		profile.FrontendModule = profile.Kind
	}
	if profile.BackendDriver == "" {
		profile.BackendDriver = inferDesktopAppBackendDriver(profile)
	}
	if profile.Icon == "" {
		profile.Icon = "terminal"
	}
	if profile.SandboxPolicy == "" {
		profile.SandboxPolicy = "main"
	}
	return profile
}

func (c DesktopAppCatalog) FilterByEdition(edition string) DesktopAppCatalog {
	edition = strings.ToLower(strings.TrimSpace(edition))
	if edition == "" {
		edition = "community"
	}
	filtered := DesktopAppCatalog{Apps: make([]DesktopAppProfile, 0, len(c.Apps))}
	for _, app := range c.Apps {
		if app.AllowedInEdition(edition) {
			filtered.Apps = append(filtered.Apps, app)
		}
	}
	return filtered
}

func (p DesktopAppProfile) AllowedInEdition(edition string) bool {
	appEdition := strings.ToLower(strings.TrimSpace(p.Edition))
	if appEdition == "" || appEdition == "community" {
		return true
	}
	edition = strings.ToLower(strings.TrimSpace(edition))
	return edition == "pro" || edition == "business" || edition == "enterprise"
}

func inferDesktopAppBackendDriver(profile DesktopAppProfile) string {
	if profile.Kind == "speed_test" {
		return "speed_test"
	}
	if profile.Kind == "terminal" || profile.LaunchCommand != "" {
		return "terminal"
	}
	if profile.DataCommand != "" {
		return "script_data"
	}
	if profile.InstallCommand != "" {
		return "script_action"
	}
	return "ui"
}

func (c DesktopAppCatalog) Find(id string) (DesktopAppProfile, bool) {
	id = strings.TrimSpace(id)
	for _, app := range c.Apps {
		if app.ID == id {
			return app, true
		}
	}
	return DesktopAppProfile{}, false
}

func InstalledAppNameFromResult(result map[string]any) string {
	ok, _ := result["ok"].(bool)
	if !ok {
		return ""
	}
	appName, _ := result["app"].(string)
	return strings.TrimSpace(appName)
}
