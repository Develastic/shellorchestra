// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package contract

import (
	"fmt"
	"strings"
	"unicode"
)

type BackendMode string

const (
	ModeTerminal BackendMode = "terminal"
	ModeData     BackendMode = "data"
	ModeAction   BackendMode = "action"
	ModeUI       BackendMode = "ui"
)

type Definition struct {
	ID                         string
	PluginID                   string
	Edition                    string
	Title                      string
	Description                string
	Kind                       string
	Icon                       string
	FrontendModule             string
	BackendDriver              string
	BackendMode                BackendMode
	DetectedApp                string
	LaunchCommand              string
	InstallCommand             string
	DataCommand                string
	ActionCommands             map[string]string
	SupportedOS                []string
	RequiresDocker             bool
	Hidden                     bool
	Capabilities               []string
	Permissions                []string
	SandboxPolicy              string
	IntegratedWindow           bool
	DefaultWidth               int
	DefaultHeight              int
	DefaultMaximized           bool
	DataRefreshIntervalSeconds int
	DataMonitorIntervalSeconds int
	DataMonitorTTLSeconds      int
}

func (d Definition) Normalize() Definition {
	d.ID = token(d.ID)
	d.PluginID = tokenDefault(d.PluginID, "builtin")
	d.Edition = strings.ToLower(tokenDefault(d.Edition, "community"))
	d.Title = label(d.Title)
	d.Description = strings.TrimSpace(d.Description)
	d.Kind = tokenDefault(d.Kind, "terminal")
	d.Icon = tokenDefault(d.Icon, "terminal")
	d.FrontendModule = tokenDefault(d.FrontendModule, d.Kind)
	d.BackendDriver = tokenDefault(d.BackendDriver, inferBackendDriver(d))
	if d.BackendMode == "" {
		d.BackendMode = inferBackendMode(d.BackendDriver)
	}
	d.DetectedApp = token(d.DetectedApp)
	d.LaunchCommand = token(d.LaunchCommand)
	d.InstallCommand = token(d.InstallCommand)
	d.DataCommand = token(d.DataCommand)
	d.ActionCommands = normalizeStringMap(d.ActionCommands)
	d.SupportedOS = normalizeList(d.SupportedOS)
	d.Capabilities = normalizeList(d.Capabilities)
	d.Permissions = normalizeList(d.Permissions)
	d.SandboxPolicy = tokenDefault(d.SandboxPolicy, "main")
	if d.DefaultWidth <= 0 {
		d.DefaultWidth = 640
	}
	if d.DefaultHeight <= 0 {
		d.DefaultHeight = 390
	}
	return d
}

func (d Definition) Validate() error {
	for field, value := range map[string]string{
		"id":              d.ID,
		"plugin_id":       d.PluginID,
		"edition":         d.Edition,
		"kind":            d.Kind,
		"icon":            d.Icon,
		"frontend_module": d.FrontendModule,
		"backend_driver":  d.BackendDriver,
		"sandbox_policy":  d.SandboxPolicy,
	} {
		if err := validateRequiredToken("plugin definition", field, value); err != nil {
			return err
		}
	}
	for field, value := range map[string]string{
		"title":       d.Title,
		"description": d.Description,
	} {
		if err := validateRequiredText(fmt.Sprintf("plugin %q", d.ID), field, value); err != nil {
			return err
		}
	}
	for field, value := range map[string]string{
		"detected_app":    d.DetectedApp,
		"launch_command":  d.LaunchCommand,
		"install_command": d.InstallCommand,
		"data_command":    d.DataCommand,
	} {
		if err := validateOptionalToken(fmt.Sprintf("plugin %q", d.ID), field, value); err != nil {
			return err
		}
	}
	for key, value := range d.ActionCommands {
		if err := validateRequiredToken(fmt.Sprintf("plugin %q", d.ID), "action command key", key); err != nil {
			return err
		}
		if err := validateRequiredToken(fmt.Sprintf("plugin %q", d.ID), "action command value", value); err != nil {
			return err
		}
	}
	if err := validateRequiredTokenList(fmt.Sprintf("plugin %q", d.ID), "capability", d.Capabilities); err != nil {
		return err
	}
	if err := validateRequiredTokenList(fmt.Sprintf("plugin %q", d.ID), "permission", d.Permissions); err != nil {
		return err
	}
	if err := validateRequiredTokenList(fmt.Sprintf("plugin %q", d.ID), "supported operating system", d.SupportedOS); err != nil {
		return err
	}
	if d.DefaultWidth <= 0 || d.DefaultWidth > 4096 {
		return fmt.Errorf("plugin %q default width must be between 1 and 4096", d.ID)
	}
	if d.DefaultHeight <= 0 || d.DefaultHeight > 4096 {
		return fmt.Errorf("plugin %q default height must be between 1 and 4096", d.ID)
	}
	for field, value := range map[string]int{
		"data refresh interval": d.DataRefreshIntervalSeconds,
		"data monitor interval": d.DataMonitorIntervalSeconds,
		"data monitor ttl":      d.DataMonitorTTLSeconds,
	} {
		if value < 0 || value > 86400 {
			return fmt.Errorf("plugin %q %s must be between 0 and 86400 seconds", d.ID, field)
		}
	}
	for _, osName := range d.SupportedOS {
		switch osName {
		case "linux", "darwin", "freebsd", "windows":
		default:
			return fmt.Errorf("plugin %q has unsupported operating system %q", d.ID, osName)
		}
	}
	switch d.Edition {
	case "community", "pro", "business", "enterprise":
	default:
		return fmt.Errorf("plugin %q has unsupported edition %q", d.ID, d.Edition)
	}
	if d.Kind == "terminal" || d.BackendMode == ModeTerminal || d.BackendDriver == "terminal" || d.LaunchCommand != "" {
		if d.SandboxPolicy != "iframe-terminal" {
			return fmt.Errorf("terminal plugin %q must use iframe-terminal sandbox policy", d.ID)
		}
	}
	switch d.BackendMode {
	case "":
		return fmt.Errorf("plugin %q must declare backend mode", d.ID)
	case ModeTerminal:
		if d.LaunchCommand == "" && d.ID != "terminal" {
			return fmt.Errorf("terminal plugin %q must define launch command", d.ID)
		}
	case ModeData:
		if d.BackendDriver != "speed_test" && d.DataCommand == "" {
			return fmt.Errorf("data plugin %q must define data command", d.ID)
		}
	case ModeAction:
		if d.InstallCommand == "" && len(d.ActionCommands) == 0 {
			return fmt.Errorf("action plugin %q must define install command or action commands", d.ID)
		}
	case ModeUI:
	default:
		return fmt.Errorf("plugin %q has unsupported backend mode %q", d.ID, d.BackendMode)
	}
	return nil
}

func validateRequiredToken(label string, field string, value string) error {
	if value == "" {
		return fmt.Errorf("%s %s is required", label, field)
	}
	if strings.TrimSpace(value) != value {
		return fmt.Errorf("%s %s contains unsupported surrounding whitespace", label, field)
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

func validateOptionalToken(label string, field string, value string) error {
	if value == "" {
		return nil
	}
	return validateRequiredToken(label, field, value)
}

func validateRequiredText(label string, field string, value string) error {
	if value == "" {
		return fmt.Errorf("%s %s is required", label, field)
	}
	if strings.TrimSpace(value) != value {
		return fmt.Errorf("%s %s contains unsupported surrounding whitespace", label, field)
	}
	for _, item := range value {
		if unicode.IsControl(item) {
			return fmt.Errorf("%s %s contains unsupported control characters", label, field)
		}
	}
	return nil
}

func validateRequiredTokenList(label string, field string, values []string) error {
	if len(values) == 0 {
		return fmt.Errorf("%s must declare at least one %s", label, field)
	}
	seen := map[string]struct{}{}
	for _, value := range values {
		if err := validateRequiredToken(label, field, value); err != nil {
			return err
		}
		if _, ok := seen[value]; ok {
			return fmt.Errorf("%s %s %q is duplicated", label, field, value)
		}
		seen[value] = struct{}{}
	}
	return nil
}

func inferBackendDriver(d Definition) string {
	if d.Kind == "speed_test" {
		return "speed_test"
	}
	if d.Kind == "terminal" || strings.TrimSpace(d.LaunchCommand) != "" {
		return "terminal"
	}
	if strings.TrimSpace(d.DataCommand) != "" {
		return "script_data"
	}
	if strings.TrimSpace(d.InstallCommand) != "" || len(d.ActionCommands) > 0 {
		return "script_action"
	}
	return "ui"
}

func inferBackendMode(driver string) BackendMode {
	switch strings.TrimSpace(driver) {
	case "terminal":
		return ModeTerminal
	case "script_data", "speed_test":
		return ModeData
	case "script_action":
		return ModeAction
	default:
		return ModeUI
	}
}

func normalizeStringMap(values map[string]string) map[string]string {
	out := map[string]string{}
	for key, value := range values {
		normalizedKey := token(strings.ToLower(key))
		normalizedValue := token(value)
		if normalizedKey != "" && normalizedValue != "" {
			out[normalizedKey] = normalizedValue
		}
	}
	return out
}

func normalizeList(values []string) []string {
	out := make([]string, 0, len(values))
	seen := map[string]struct{}{}
	for _, value := range values {
		normalized := strings.ToLower(token(value))
		if normalized == "" {
			continue
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, normalized)
	}
	return out
}

func tokenDefault(value string, fallback string) string {
	if normalized := token(value); normalized != "" {
		return normalized
	}
	return token(fallback)
}

func token(value string) string {
	return strings.TrimSpace(value)
}

func label(value string) string {
	return strings.Join(strings.Fields(value), " ")
}
