// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package desktopapps

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"shellorchestra/backend/internal/appplan"
	"shellorchestra/backend/internal/domain"
	"shellorchestra/backend/internal/scripts"
)

const (
	maxAppPayloadFields           = 40
	maxAppPayloadValueBytes       = 256 * 1024
	maxCustomShortcutCommandBytes = 4096
)

var appPayloadKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

type ActionEntry struct {
	ActionID        string
	PluginID        string
	AppID           string
	Operation       string
	Action          string
	Command         string
	Driver          string
	Mutating        bool
	RequiresRun     bool
	Capabilities    []string
	Permissions     []string
	SupportedOS     []string
	ManifestAppRole string
	TimeoutSeconds  int
	MaxStdoutBytes  int64
	MaxStderrBytes  int64
	MaxDecodedBytes int64
	StreamPolicy    string
	AuditFields     []string
	RequiresSudo    bool
}

type ActionPlan struct {
	Entry   ActionEntry
	Payload map[string]string
}

func registryEntryFor(profile scripts.DesktopAppProfile, operation string, action string) (ActionEntry, error) {
	if operation == "" || operation != appplan.NormalizedOperation(operation) {
		return ActionEntry{}, fmt.Errorf("desktop app operation must use the exact lower-case token form")
	}
	if action != "" && action != appplan.NormalizedToken(action) {
		return ActionEntry{}, fmt.Errorf("desktop app action must use the exact lower-case token form")
	}
	entry := ActionEntry{
		ActionID:     appplan.ActionID(profile.PluginID, profile.ID, operation, action),
		PluginID:     strings.TrimSpace(profile.PluginID),
		AppID:        strings.TrimSpace(profile.ID),
		Operation:    operation,
		Action:       action,
		Driver:       strings.TrimSpace(profile.BackendDriver),
		Capabilities: append([]string(nil), profile.Capabilities...),
		Permissions:  append([]string(nil), profile.Permissions...),
		SupportedOS:  append([]string(nil), profile.SupportedOS...),
	}
	if entry.PluginID == "" {
		return ActionEntry{}, fmt.Errorf("desktop app profile %q must declare plugin_id", profile.ID)
	}
	if entry.AppID == "" {
		return ActionEntry{}, fmt.Errorf("desktop app profile must declare app_id")
	}
	switch operation {
	case appplan.OperationLaunch:
		entry.Command = strings.TrimSpace(profile.LaunchCommand)
		entry.RequiresRun = true
	case appplan.OperationInstall:
		entry.Command = strings.TrimSpace(profile.InstallCommand)
		entry.Mutating = true
		entry.RequiresRun = true
	case appplan.OperationData:
		entry.Command = strings.TrimSpace(profile.DataCommand)
		entry.RequiresRun = profile.BackendDriver == DriverScriptData
	case appplan.OperationAction:
		if action == "" {
			return ActionEntry{}, fmt.Errorf("desktop app action is required")
		}
		entry.Command = strings.TrimSpace(profile.ActionCommands[action])
		entry.Mutating = true
		entry.RequiresRun = true
	default:
		return ActionEntry{}, fmt.Errorf("unsupported desktop app operation %q", operation)
	}
	if entry.RequiresRun && entry.Command == "" {
		return ActionEntry{}, fmt.Errorf("%s does not define a %s profile for ShellOrchestra", profile.Title, operation)
	}
	if entry.RequiresRun && len(nonEmptyCapabilities(entry.Capabilities)) == 0 {
		return ActionEntry{}, fmt.Errorf("desktop app action %s must declare required capabilities", entry.ActionID)
	}
	if entry.RequiresRun && len(nonEmptyStrings(entry.Permissions)) == 0 {
		return ActionEntry{}, fmt.Errorf("desktop app action %s must declare required permissions", entry.ActionID)
	}
	if entry.RequiresRun && len(nonEmptyStrings(entry.SupportedOS)) == 0 {
		return ActionEntry{}, fmt.Errorf("desktop app action %s must declare supported operating systems", entry.ActionID)
	}
	return entry, nil
}

func validatePlan(profile scripts.DesktopAppProfile, server domain.Server, operation string, action string, plan appplan.Response, backendPayload map[string]string) (ActionPlan, error) {
	entry, err := registryEntryFor(profile, operation, action)
	if err != nil {
		return ActionPlan{}, err
	}
	if err := appplan.ValidateResponse(plan); err != nil {
		return ActionPlan{}, err
	}
	if plan.ActionID != entry.ActionID {
		return ActionPlan{}, fmt.Errorf("app-runner requested %q but backend policy expected %q", plan.ActionID, entry.ActionID)
	}
	payload, err := validatePayload(profile, server, entry, backendPayload)
	if err != nil {
		return ActionPlan{}, err
	}
	entry = classifyPayloadMutation(profile.ID, entry, payload)
	return ActionPlan{Entry: entry, Payload: payload}, nil
}

func validatePayload(profile scripts.DesktopAppProfile, server domain.Server, entry ActionEntry, payload map[string]string) (map[string]string, error) {
	if payload == nil {
		payload = map[string]string{}
	}
	if len(payload) > maxAppPayloadFields {
		return nil, fmt.Errorf("desktop app payload contains too many fields")
	}
	allowed := allowedPayloadKeys(profile.ID, entry.Operation, entry.Action)
	out := make(map[string]string, len(payload)+4)
	for rawKey, value := range payload {
		key := rawKey
		if strings.TrimSpace(rawKey) != rawKey || strings.ToLower(rawKey) != rawKey {
			return nil, fmt.Errorf("desktop app payload field %q must use the exact lower-case token form", rawKey)
		}
		if !appPayloadKeyPattern.MatchString(key) {
			return nil, fmt.Errorf("desktop app payload field %q is not supported", rawKey)
		}
		if _, ok := allowed[key]; !ok {
			return nil, fmt.Errorf("desktop app %s is not allowed to send payload field %q", profile.ID, key)
		}
		if strings.ContainsRune(value, '\x00') {
			return nil, fmt.Errorf("desktop app payload field %q contains a NUL byte", key)
		}
		if len([]byte(value)) > maxAppPayloadValueBytes {
			return nil, fmt.Errorf("desktop app payload field %q is too large", key)
		}
		out[key] = value
	}
	if err := validatePayloadValues(profile.ID, entry.Operation, entry.Action, out, server); err != nil {
		return nil, err
	}
	return out, nil
}

func allowedPayloadKeys(appID string, operation string, action string) map[string]struct{} {
	keys := []string{}
	switch appID {
	case "file_manager":
		keys = []string{"file_manager_action", "file_manager_path", "file_manager_destination_path", "file_manager_new_name", "file_manager_mode", "file_manager_overwrite", "file_manager_source_names_b64", "file_manager_archive_format", "file_manager_max_bytes", "file_manager_offset", "file_manager_max_asset_bytes", "file_manager_hash_max_bytes", "file_manager_output_encoding", "file_manager_known_listing_hash", "file_manager_stream_format", "file_manager_editor_mode", "file_manager_editor_max_bytes", "file_manager_editor_max_line_bytes", "file_manager_search_name_pattern", "file_manager_search_name_mode", "file_manager_search_content", "file_manager_search_content_mode", "file_manager_search_case_sensitive", "file_manager_search_skip_binary", "file_manager_search_stay_filesystem", "file_manager_search_include_hidden", "file_manager_search_max_results", "file_manager_search_max_file_bytes"}
	case "package_manager":
		keys = []string{"package_action", "package_query", "package_limit", "package_manager", "package_name", "dry_run", "package_output_encoding", "package_known_state_token", "package_stream_format"}
	case "process_monitor":
		keys = []string{"process_limit", "process_pid", "process_signal", "process_output_encoding", "process_stream_format"}
	case "services":
		keys = []string{"services_limit", "services_filter", "services_mode", "service_name", "service_action", "services_output_encoding", "services_stream_format"}
	case "users":
		keys = []string{"users_mode", "user_action", "user_name", "user_password", "user_full_name", "user_create_home", "user_admin", "user_remove_home", "user_ssh_key", "user_group", "dry_run", "users_output_encoding", "users_stream_format"}
	case "firewall":
		keys = []string{"firewall_action", "firewall_rule", "firewall_rule_number", "ssh_port", "firewall_output_encoding", "firewall_stream_format"}
	case "cron_editor":
		keys = []string{"cron_mode", "cron_user", "cron_content", "cron_output_encoding", "cron_stream_format"}
	case "sudo_editor":
		keys = []string{"sudo_mode", "sudo_path", "sudo_content", "sudo_output_encoding", "sudo_stream_format"}
	case "ssh_server":
		keys = []string{"ssh_server_action", "ssh_server_path", "ssh_server_content", "ssh_server_expected_hash", "ssh_server_main_config", "ssh_server_backup_path", "ssh_server_output_encoding", "ssh_server_stream_format"}
	case "pve_manager":
		keys = []string{"pve_action", "pve_guest_type", "pve_vmid", "pve_manager_output_encoding", "pve_manager_stream_format"}
	case "pve_guest_console":
		keys = []string{"pve_action", "pve_guest_type", "pve_vmid"}
	case "logs":
		keys = []string{"logs_source", "logs_path", "logs_query", "logs_unit", "logs_priority", "logs_limit", "logs_since", "logs_until", "logs_follow", "logs_cursor", "logs_live_limit", "logs_live_max_bytes", "logs_container_id", "logs_container_engine", "logs_stream_format"}
	case "containers":
		keys = []string{"containers_query", "containers_limit", "containers_known_state_token", "containers_output_encoding", "containers_stream_format", "container_engine", "container_action", "container_id", "container_logs_tail", "container_install_template", "container_install_image", "container_install_name", "container_install_bind_address", "container_install_host_port", "container_install_container_port", "container_install_restart_policy", "container_install_exposure_confirmed", "dry_run"}
	case "lan_watch":
		keys = []string{"lan_watch_limit", "lan_watch_no_probe", "lan_watch_output_encoding", "lan_watch_stream_format"}
	case "network_connections":
		keys = []string{"network_action", "network_interface", "network_hostname", "network_mtu", "network_dns", "dry_run", "network_connections_output_encoding", "network_connections_stream_format"}
	case "speedtest":
		keys = []string{"direction", "streams", "payload_bytes", "payload_mb", "speed_test_mode", "speed_test_job_id"}
	case "custom_terminal":
		keys = []string{"custom_command"}
	case "connection_watch":
		keys = []string{"connection_watch_output_encoding", "connection_watch_stream_format"}
	case "disks":
		keys = []string{"disks_output_encoding", "disks_stream_format"}
	default:
		keys = []string{}
	}
	out := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		out[key] = struct{}{}
	}
	return out
}

func PayloadMutatesServer(appID string, operation string, payload map[string]string) bool {
	entry := classifyPayloadMutation(appID, ActionEntry{Operation: appplan.NormalizedOperation(operation)}, payload)
	return entry.Mutating
}

func classifyPayloadMutation(appID string, entry ActionEntry, payload map[string]string) ActionEntry {
	if appID == "package_manager" && entry.Operation == appplan.OperationAction && boolStringTrue(payload["dry_run"]) {
		entry.Mutating = false
		return entry
	}
	if appID == "network_connections" && entry.Operation == appplan.OperationAction && boolStringTrue(payload["dry_run"]) {
		entry.Mutating = false
		return entry
	}
	if appID == "containers" && entry.Operation == appplan.OperationAction && entry.Action == "logs" {
		entry.Mutating = false
		return entry
	}
	if appID == "containers" && entry.Operation == appplan.OperationAction && boolStringTrue(payload["dry_run"]) {
		entry.Mutating = false
		return entry
	}
	if appID == "ssh_server" && entry.Operation == appplan.OperationAction && entry.Action == "validate" {
		entry.Mutating = false
		return entry
	}
	if entry.Mutating || entry.Operation != appplan.OperationData {
		return entry
	}
	switch appID {
	case "file_manager":
		switch payload["file_manager_action"] {
		case "create_file", "create_directory", "delete", "copy", "move", "rename", "chmod", "compress", "uncompress":
			entry.Mutating = true
		}
	case "sudo_editor":
		if entry.Operation == appplan.OperationData && firstNonEmptyExact(payload["sudo_mode"], "list") == "save" {
			entry.Mutating = true
		}
	}
	return entry
}

func requireMutatingConfirmation(entry ActionEntry, confirmed bool) error {
	if entry.Mutating && !confirmed {
		return fmt.Errorf("ShellOrchestra requires explicit confirmation before running actions that change a managed server")
	}
	return nil
}

func applyScriptManifestPolicy(profile scripts.DesktopAppProfile, entry ActionEntry, command scripts.CommandManifest) (ActionEntry, error) {
	if command.Name != entry.Command {
		return ActionEntry{}, fmt.Errorf("desktop app action %s selected script %q but manifest is %q", entry.ActionID, entry.Command, command.Name)
	}
	if !commandAllowsApp(command, profile.ID) {
		return ActionEntry{}, fmt.Errorf("script command %q is not registered for desktop app %q", command.Name, profile.ID)
	}
	role := command.AppRole
	if role == "" {
		return ActionEntry{}, fmt.Errorf("script command %q does not declare an app_role", command.Name)
	}
	if !manifestRoleAllowed(entry, role) {
		return ActionEntry{}, fmt.Errorf("script command %q has app_role %q but backend policy expected %s", command.Name, role, expectedManifestRoleLabel(entry))
	}
	if command.TimeoutSeconds <= 0 {
		return ActionEntry{}, fmt.Errorf("script command %q must declare timeout_seconds for desktop app execution", command.Name)
	}
	if entry.Mutating && len(nonEmptyAuditFields(command.AuditFields)) == 0 {
		return ActionEntry{}, fmt.Errorf("script command %q must declare audit_fields for mutating desktop app execution", command.Name)
	}
	streamPolicy := command.StreamPolicy
	if !streamPolicyAllowed(entry, streamPolicy) {
		return ActionEntry{}, fmt.Errorf("script command %q has stream_policy %q but backend policy expected %s", command.Name, streamPolicy, expectedStreamPolicyLabel(entry))
	}
	limits := command.EffectiveOutputLimits()
	entry.ManifestAppRole = role
	entry.TimeoutSeconds = command.TimeoutSeconds
	entry.MaxStdoutBytes = limits.MaxStdoutBytes
	entry.MaxStderrBytes = limits.MaxStderrBytes
	entry.MaxDecodedBytes = limits.MaxDecodedBytes
	entry.StreamPolicy = streamPolicy
	entry.AuditFields = append([]string(nil), command.AuditFields...)
	entry.RequiresSudo = command.RequiresSudo
	return entry, nil
}

func nonEmptyAuditFields(fields []string) []string {
	return nonEmptyStrings(fields)
}

func nonEmptyCapabilities(capabilities []string) []string {
	return nonEmptyStrings(capabilities)
}

func nonEmptyStrings(values []string) []string {
	out := make([]string, 0, len(values))
	for _, field := range values {
		if trimmed := strings.TrimSpace(field); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func streamPolicyAllowed(entry ActionEntry, streamPolicy string) bool {
	for _, allowed := range expectedStreamPolicies(entry) {
		if streamPolicy == allowed {
			return true
		}
	}
	return false
}

func expectedStreamPolicyLabel(entry ActionEntry) string {
	return strings.Join(expectedStreamPolicies(entry), " or ")
}

func expectedStreamPolicies(entry ActionEntry) []string {
	switch entry.Operation {
	case appplan.OperationLaunch:
		return []string{"terminal"}
	case appplan.OperationInstall, appplan.OperationAction:
		return []string{"json_action"}
	case appplan.OperationData:
		return []string{"json"}
	default:
		return []string{"json"}
	}
}

func commandAllowsApp(command scripts.CommandManifest, appID string) bool {
	for _, allowed := range command.AppIDs {
		if allowed == appID {
			return true
		}
	}
	return false
}

func manifestRoleAllowed(entry ActionEntry, role string) bool {
	for _, allowed := range expectedManifestRoles(entry) {
		if role == allowed {
			return true
		}
	}
	return false
}

func expectedManifestRoleLabel(entry ActionEntry) string {
	return strings.Join(expectedManifestRoles(entry), " or ")
}

func expectedManifestRoles(entry ActionEntry) []string {
	switch entry.Operation {
	case appplan.OperationLaunch:
		return []string{"launch"}
	case appplan.OperationInstall:
		return []string{"install"}
	case appplan.OperationData:
		return []string{"data"}
	case appplan.OperationAction:
		switch entry.Action {
		case "install":
			return []string{"install"}
		case "remove":
			return []string{"remove"}
		default:
			return []string{"action"}
		}
	default:
		return []string{}
	}
}

func validatePayloadValues(appID string, operation string, action string, payload map[string]string, server domain.Server) error {
	switch appID {
	case "file_manager":
		return validateFileManagerPayload(payload)
	case "package_manager":
		return validatePackagePayload(operation, action, payload)
	case "process_monitor":
		return validateProcessPayload(operation, action, payload)
	case "services":
		return validateServicesPayload(operation, action, payload)
	case "users":
		return validateUsersPayload(operation, action, payload)
	case "firewall":
		return validateFirewallPayload(operation, action, payload, server)
	case "cron_editor":
		return validateCronPayload(operation, action, payload)
	case "sudo_editor":
		return validateSudoEditorPayload(operation, action, payload)
	case "ssh_server":
		return validateSSHServerPayload(operation, action, payload)
	case "pve_manager", "pve_guest_console":
		return validatePVEManagerPayload(operation, action, payload)
	case "logs":
		return validateLogsPayload(payload)
	case "containers":
		return validateContainersPayload(operation, action, payload)
	case "lan_watch":
		return validateLANWatchPayload(payload)
	case "network_connections":
		return validateNetworkConnectionsPayload(operation, action, payload)
	case "connection_watch":
		return validateConnectionWatchPayload(payload)
	case "disks":
		return validateDisksPayload(payload)
	case "speedtest":
		return validateSpeedTestPayload(payload)
	case "custom_terminal":
		return validateCustomTerminalPayload(payload)
	default:
		if len(payload) > 0 {
			return fmt.Errorf("desktop app %s does not accept payload fields", appID)
		}
		return nil
	}
}

func validateCustomTerminalPayload(payload map[string]string) error {
	command := strings.TrimSpace(payload["custom_command"])
	if command == "" {
		return fmt.Errorf("custom_command is required")
	}
	if len([]byte(command)) > maxCustomShortcutCommandBytes {
		return fmt.Errorf("custom_command is too long")
	}
	if strings.ContainsAny(command, "\r\n") {
		return fmt.Errorf("custom_command must be a single command line")
	}
	for _, item := range command {
		if unicode.IsControl(item) && item != '\t' {
			return fmt.Errorf("custom_command contains unsupported control characters")
		}
	}
	payload["custom_command"] = command
	return nil
}

func validateFileManagerPayload(payload map[string]string) error {
	action := payload["file_manager_action"]
	if action == "" {
		action = "locations"
		payload["file_manager_action"] = action
	}
	if err := requireEnum("file_manager_action", action, []string{"locations", "list", "search", "properties", "calculate_size", "create_file", "create_directory", "delete", "copy", "move", "rename", "chmod", "compress", "uncompress"}); err != nil {
		return err
	}
	for _, key := range []string{"file_manager_path", "file_manager_destination_path"} {
		if value, ok := payload[key]; ok {
			if err := validateRemotePath(key, value); err != nil {
				return err
			}
		}
	}
	if value := payload["file_manager_new_name"]; value != "" {
		if err := validateSafeFileNameComponent("file_manager_new_name", value); err != nil {
			return fmt.Errorf("file_manager_new_name must be a single safe path component")
		}
	}
	if value := payload["file_manager_mode"]; value != "" {
		if matched, _ := regexp.MatchString(`^[0-7]{3,4}$`, value); !matched {
			return fmt.Errorf("file_manager_mode must be an octal mode")
		}
	}
	if err := validateBoolString("file_manager_overwrite", payload["file_manager_overwrite"], true); err != nil {
		return err
	}
	if value := payload["file_manager_source_names_b64"]; value != "" {
		if len(value) > 65536 {
			return fmt.Errorf("file_manager_source_names_b64 is too large")
		}
		if matched, _ := regexp.MatchString(`^[A-Za-z0-9+/=_-]+$`, value); !matched {
			return fmt.Errorf("file_manager_source_names_b64 must be base64 text")
		}
	}
	if value := payload["file_manager_archive_format"]; value != "" {
		if err := requireEnum("file_manager_archive_format", value, []string{"auto", "tar.zst", "tar.gz", "zip"}); err != nil {
			return err
		}
	}
	for key, limit := range map[string]int{"file_manager_max_bytes": 64 << 20, "file_manager_offset": 1 << 40, "file_manager_max_asset_bytes": 64 << 20, "file_manager_hash_max_bytes": 1 << 30, "file_manager_editor_max_bytes": 64 << 20, "file_manager_editor_max_line_bytes": 1 << 20} {
		if err := validateIntString(key, payload[key], 0, limit, true); err != nil {
			return err
		}
	}
	if value := payload["file_manager_editor_mode"]; value != "" {
		if err := requireEnum("file_manager_editor_mode", value, []string{"edit", "safe_view"}); err != nil {
			return err
		}
	}
	if value := payload["file_manager_output_encoding"]; value != "" {
		if err := requireEnum("file_manager_output_encoding", value, []string{"auto", "zstd", "gzip"}); err != nil {
			return err
		}
	}
	if value := payload["file_manager_known_listing_hash"]; value != "" {
		if matched, _ := regexp.MatchString(`^[A-Za-z0-9_.:-]{1,160}$`, value); !matched {
			return fmt.Errorf("file_manager_known_listing_hash must be a safe listing hash token")
		}
	}
	if value := payload["file_manager_stream_format"]; value != "" {
		if err := requireEnum("file_manager_stream_format", value, []string{"json", "row_events"}); err != nil {
			return err
		}
	}
	for _, key := range []string{"file_manager_search_name_mode", "file_manager_search_content_mode"} {
		if value := payload[key]; value != "" {
			if err := requireEnum(key, value, []string{"glob", "regex", "literal"}); err != nil {
				return err
			}
		}
	}
	for _, key := range []string{"file_manager_search_case_sensitive", "file_manager_search_skip_binary", "file_manager_search_stay_filesystem", "file_manager_search_include_hidden"} {
		if err := validateBoolString(key, payload[key], true); err != nil {
			return err
		}
	}
	for _, key := range []string{"file_manager_search_name_pattern", "file_manager_search_content"} {
		if value := payload[key]; value != "" {
			if len([]byte(value)) > 4096 {
				return fmt.Errorf("%s is too long", key)
			}
			if strings.ContainsRune(value, '\x00') || containsBidirectionalControl(value) {
				return fmt.Errorf("%s contains unsafe control characters", key)
			}
		}
	}
	if err := validateIntString("file_manager_search_max_results", payload["file_manager_search_max_results"], 1, 10000, true); err != nil {
		return err
	}
	if err := validateIntString("file_manager_search_max_file_bytes", payload["file_manager_search_max_file_bytes"], 1024, 64<<20, true); err != nil {
		return err
	}
	return nil
}

func validatePackagePayload(operation string, action string, payload map[string]string) error {
	if value := payload["package_action"]; value != "" {
		if err := requireEnum("package_action", value, []string{"installed", "search", "upgradable", "security", "info"}); err != nil {
			return err
		}
	}
	if err := validateIntString("package_limit", payload["package_limit"], 1, 100000, true); err != nil {
		return err
	}
	if value := payload["package_manager"]; value != "" {
		if err := requireEnum("package_manager", value, []string{"auto", "apt", "apk", "dnf", "yum", "pacman", "zypper", "brew", "winget"}); err != nil {
			return err
		}
	}
	if action == "install" || action == "remove" {
		if payload["package_name"] == "" {
			return fmt.Errorf("package_name is required")
		}
		if err := validatePackageName(payload["package_name"]); err != nil {
			return err
		}
	}
	if value := payload["package_output_encoding"]; value != "" {
		if err := requireEnum("package_output_encoding", value, []string{"auto", "zstd", "gzip"}); err != nil {
			return err
		}
	}
	if value := payload["package_known_state_token"]; value != "" {
		if matched, _ := regexp.MatchString(`^[A-Za-z0-9_.:-]{1,160}$`, value); !matched {
			return fmt.Errorf("package_known_state_token must be a safe package state token")
		}
	}
	if value := payload["package_stream_format"]; value != "" {
		if err := requireEnum("package_stream_format", value, []string{"json", "row_events"}); err != nil {
			return err
		}
	}
	return validateBoolString("dry_run", payload["dry_run"], true)
}

func validateProcessPayload(operation string, action string, payload map[string]string) error {
	if err := validateIntString("process_limit", payload["process_limit"], 1, 500, true); err != nil {
		return err
	}
	if value := payload["process_output_encoding"]; value != "" {
		if err := requireEnum("process_output_encoding", value, []string{"auto", "zstd", "gzip"}); err != nil {
			return err
		}
	}
	if value := payload["process_stream_format"]; value != "" {
		if err := requireEnum("process_stream_format", value, []string{"json", "row_events"}); err != nil {
			return err
		}
	}
	if action == "kill" {
		if err := validateIntString("process_pid", payload["process_pid"], 2, 1<<31-1, false); err != nil {
			return err
		}
		if err := requireEnum("process_signal", firstNonEmptyExact(payload["process_signal"], "TERM"), []string{"TERM", "KILL", "INT", "HUP"}); err != nil {
			return err
		}
	}
	return nil
}

func validateServicesPayload(operation string, action string, payload map[string]string) error {
	if err := validateIntString("services_limit", payload["services_limit"], 1, 500, true); err != nil {
		return err
	}
	if value := payload["services_mode"]; value != "" {
		if err := requireEnum("services_mode", value, []string{"list", "unit_file", "details", "logs"}); err != nil {
			return err
		}
	}
	if value := payload["services_output_encoding"]; value != "" {
		if err := requireEnum("services_output_encoding", value, []string{"auto", "zstd", "gzip"}); err != nil {
			return err
		}
	}
	if value := payload["services_stream_format"]; value != "" {
		if err := requireEnum("services_stream_format", value, []string{"json", "row_events"}); err != nil {
			return err
		}
	}
	if action != "" {
		if err := requireEnum("service_action", action, []string{"start", "stop", "restart", "reload"}); err != nil {
			return err
		}
		if payload["service_action"] != "" && payload["service_action"] != action {
			return fmt.Errorf("service_action must match the requested action")
		}
	}
	if payload["service_name"] != "" {
		if err := validateServiceName(payload["service_name"]); err != nil {
			return err
		}
	}
	return nil
}

func validateUsersPayload(operation string, action string, payload map[string]string) error {
	if action != "" {
		if err := requireEnum("user_action", action, []string{"create", "edit", "set_password", "lock", "unlock", "set_admin", "add_group", "remove_group", "delete", "add_ssh_key", "remove_ssh_key"}); err != nil {
			return err
		}
		if payload["user_action"] != "" && payload["user_action"] != action {
			return fmt.Errorf("user_action must match the requested action")
		}
	}
	if value := payload["user_name"]; value != "" {
		if matched, _ := regexp.MatchString(`^[A-Za-z_][A-Za-z0-9_.-]{0,63}$`, value); !matched {
			return fmt.Errorf("user_name contains unsupported characters")
		}
	}
	if value := payload["users_mode"]; value != "" {
		if err := requireEnum("users_mode", value, []string{"list", "ssh_keys"}); err != nil {
			return err
		}
	}
	if value := payload["users_output_encoding"]; value != "" {
		if err := requireEnum("users_output_encoding", value, []string{"auto", "zstd", "gzip"}); err != nil {
			return err
		}
	}
	if value := payload["users_stream_format"]; value != "" {
		if err := requireEnum("users_stream_format", value, []string{"json", "row_events"}); err != nil {
			return err
		}
	}
	if value := payload["user_ssh_key"]; value != "" {
		if len([]byte(value)) > 8192 || containsControlCharacter(value) {
			return fmt.Errorf("user_ssh_key must be one supported OpenSSH public key line")
		}
		if !regexp.MustCompile(`^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))\s+`).MatchString(value) {
			return fmt.Errorf("user_ssh_key must be one supported OpenSSH public key line")
		}
	}
	if value := payload["user_group"]; value != "" {
		if matched, _ := regexp.MatchString(`^[A-Za-z_][A-Za-z0-9_.-]{0,63}$`, value); !matched {
			return fmt.Errorf("user_group contains unsupported characters")
		}
	}
	for _, key := range []string{"user_create_home", "user_admin", "user_remove_home"} {
		if err := validateBoolString(key, payload[key], true); err != nil {
			return err
		}
	}
	return validateBoolString("dry_run", payload["dry_run"], true)
}

func validateFirewallPayload(operation string, action string, payload map[string]string, server domain.Server) error {
	if value := payload["firewall_output_encoding"]; value != "" {
		if err := requireEnum("firewall_output_encoding", value, []string{"auto", "zstd", "gzip"}); err != nil {
			return err
		}
	}
	if value := payload["firewall_stream_format"]; value != "" {
		if err := requireEnum("firewall_stream_format", value, []string{"json", "row_events"}); err != nil {
			return err
		}
	}
	if action != "" {
		if err := requireEnum("firewall_action", action, []string{"enable", "disable", "add_rule", "delete_rule"}); err != nil {
			return err
		}
		if payload["firewall_action"] != "" && payload["firewall_action"] != action {
			return fmt.Errorf("firewall_action must match the requested action")
		}
	}
	if err := validateIntString("ssh_port", payload["ssh_port"], 1, 65535, true); err != nil {
		return err
	}
	if value := payload["firewall_rule_number"]; value != "" {
		if strings.EqualFold(firstNonEmpty(server.DetectedOS, server.DetectedPlatformOS), "windows") {
			if len([]byte(value)) > 128 || containsControlCharacter(value) {
				return fmt.Errorf("firewall_rule_number contains unsupported data")
			}
		} else if err := validateIntString("firewall_rule_number", value, 1, 100000, false); err != nil {
			return err
		}
	}
	if value := payload["firewall_rule"]; value != "" {
		if err := validateFirewallRule(value, server); err != nil {
			return err
		}
	}
	return nil
}

func validateCronPayload(operation string, action string, payload map[string]string) error {
	mode := firstNonEmptyExact(payload["cron_mode"], "users")
	if operation == appplan.OperationAction {
		if action != "save" {
			return fmt.Errorf("cron editor action %q is not supported", action)
		}
		if mode == "" {
			mode = "save"
			payload["cron_mode"] = mode
		}
		if mode != "save" {
			return fmt.Errorf("cron editor save action requires cron_mode=save")
		}
		if payload["cron_content"] == "" {
			return fmt.Errorf("cron_content is required")
		}
	} else if mode == "save" || (payload["cron_content"] != "" && mode != "validate") {
		return fmt.Errorf("cron editor data endpoint is read-only; save crontabs through the confirmed action endpoint")
	}
	if err := requireEnum("cron_mode", mode, []string{"users", "read", "validate", "save"}); err != nil {
		return err
	}
	if value := payload["cron_output_encoding"]; value != "" {
		if err := requireEnum("cron_output_encoding", value, []string{"auto", "zstd", "gzip"}); err != nil {
			return err
		}
	}
	if value := payload["cron_stream_format"]; value != "" {
		if err := requireEnum("cron_stream_format", value, []string{"json", "row_events"}); err != nil {
			return err
		}
	}
	if content := payload["cron_content"]; content != "" && len([]byte(content)) > 256*1024 {
		return fmt.Errorf("cron_content is too large")
	}
	if (mode == "read" || mode == "validate" || mode == "save") && payload["cron_user"] == "" {
		return fmt.Errorf("cron_user is required")
	}
	if value := payload["cron_user"]; value != "" {
		if matched, _ := regexp.MatchString(`^[A-Za-z_][A-Za-z0-9_.-]{0,63}$`, value); !matched {
			return fmt.Errorf("cron_user contains unsupported characters")
		}
	}
	return nil
}

func validateSudoEditorPayload(operation string, action string, payload map[string]string) error {
	mode := firstNonEmptyExact(payload["sudo_mode"], "list")
	if value := payload["sudo_output_encoding"]; value != "" {
		if err := requireEnum("sudo_output_encoding", value, []string{"auto", "zstd", "gzip"}); err != nil {
			return err
		}
	}
	if value := payload["sudo_stream_format"]; value != "" {
		if err := requireEnum("sudo_stream_format", value, []string{"json", "row_events"}); err != nil {
			return err
		}
	}
	if operation == appplan.OperationAction {
		if action != "save" {
			return fmt.Errorf("sudo editor action %q is not supported", action)
		}
		if mode == "" {
			mode = "save"
			payload["sudo_mode"] = mode
		}
		if mode != "save" {
			return fmt.Errorf("sudo editor save action requires sudo_mode=save")
		}
		if payload["sudo_content"] == "" {
			return fmt.Errorf("sudo_content is required")
		}
	} else if mode == "save" {
		if payload["sudo_content"] == "" {
			return fmt.Errorf("sudo_content is required")
		}
	} else if payload["sudo_content"] != "" && mode != "validate" {
		return fmt.Errorf("sudo editor data endpoint accepts sudo_content only for validate or confirmed save operations")
	}
	if err := requireEnum("sudo_mode", mode, []string{"list", "read", "validate", "save"}); err != nil {
		return err
	}
	if content := payload["sudo_content"]; content != "" && len([]byte(content)) > 256*1024 {
		return fmt.Errorf("sudo_content is too large")
	}
	if mode == "validate" && payload["sudo_content"] == "" {
		return fmt.Errorf("sudo_content is required")
	}
	if (mode == "read" || mode == "validate" || mode == "save") && payload["sudo_path"] == "" {
		return fmt.Errorf("sudo_path is required")
	}
	if value := payload["sudo_path"]; value != "" {
		if err := validateSudoersPath(value); err != nil {
			return err
		}
	}
	return nil
}

func validateSSHServerPayload(operation string, action string, payload map[string]string) error {
	if value := payload["ssh_server_output_encoding"]; value != "" {
		if err := requireEnum("ssh_server_output_encoding", value, []string{"auto", "zstd", "gzip"}); err != nil {
			return err
		}
	}
	if value := payload["ssh_server_stream_format"]; value != "" {
		if err := requireEnum("ssh_server_stream_format", value, []string{"json", "row_events"}); err != nil {
			return err
		}
	}
	if operation != appplan.OperationAction {
		if len(payload) > 0 {
			return fmt.Errorf("ssh server data endpoint does not accept caller payload")
		}
		return nil
	}
	if err := requireEnum("ssh server action", action, []string{"validate", "apply", "rollback"}); err != nil {
		return err
	}
	mode := firstNonEmptyExact(payload["ssh_server_action"], action)
	if mode == "" {
		mode = action
		payload["ssh_server_action"] = mode
	}
	if mode != action {
		return fmt.Errorf("ssh_server_action must match requested action %q", action)
	}
	if err := requireEnum("ssh_server_action", mode, []string{"validate", "apply", "rollback"}); err != nil {
		return err
	}
	if mode == "rollback" {
		if err := validateOpenSSHConfigPath("ssh_server_path", payload["ssh_server_path"]); err != nil {
			return err
		}
		if err := validateOpenSSHBackupPath(payload["ssh_server_backup_path"]); err != nil {
			return err
		}
		return nil
	}
	if err := validateOpenSSHConfigPath("ssh_server_path", payload["ssh_server_path"]); err != nil {
		return err
	}
	if mainConfig := payload["ssh_server_main_config"]; mainConfig != "" {
		if err := validateOpenSSHConfigPath("ssh_server_main_config", mainConfig); err != nil {
			return err
		}
	}
	content := payload["ssh_server_content"]
	if content == "" {
		return fmt.Errorf("ssh_server_content is required")
	}
	if len([]byte(content)) > 256*1024 {
		return fmt.Errorf("ssh_server_content is too large")
	}
	if hash := payload["ssh_server_expected_hash"]; hash != "" {
		if matched, _ := regexp.MatchString(`^sha256:[a-fA-F0-9]{64}$`, hash); !matched {
			return fmt.Errorf("ssh_server_expected_hash must be sha256:<64 hex chars>")
		}
	} else if mode == "apply" {
		return fmt.Errorf("ssh_server_expected_hash is required before applying OpenSSH config changes")
	}
	return nil
}

func validatePVEManagerPayload(operation string, action string, payload map[string]string) error {
	if operation == appplan.OperationData {
		if value := payload["pve_manager_output_encoding"]; value != "" {
			if err := requireEnum("pve_manager_output_encoding", value, []string{"auto", "zstd", "gzip"}); err != nil {
				return err
			}
		}
		if value := payload["pve_manager_stream_format"]; value != "" {
			if err := requireEnum("pve_manager_stream_format", value, []string{"json", "row_events"}); err != nil {
				return err
			}
		}
		for key, value := range payload {
			if value != "" && key != "pve_manager_output_encoding" && key != "pve_manager_stream_format" {
				return fmt.Errorf("pve manager data endpoint does not accept payload field %q", key)
			}
		}
		return nil
	}
	if operation == appplan.OperationAction {
		if err := requireEnum("pve_action", action, []string{"start", "shutdown", "reboot", "stop"}); err != nil {
			return err
		}
		if payload["pve_action"] != "" && payload["pve_action"] != action {
			return fmt.Errorf("pve_action must match the requested action")
		}
		return validatePVEGuestIdentity(payload)
	}
	if operation == appplan.OperationLaunch {
		return validatePVEGuestIdentity(payload)
	}
	if len(payload) > 0 {
		return fmt.Errorf("pve manager data endpoint does not accept payload fields")
	}
	return nil
}

func validatePVEGuestIdentity(payload map[string]string) error {
	if err := requireEnum("pve_guest_type", payload["pve_guest_type"], []string{"qemu", "vm", "lxc", "ct", "openvz"}); err != nil {
		return err
	}
	if err := validateIntString("pve_vmid", payload["pve_vmid"], 1, 999999999, false); err != nil {
		return err
	}
	return nil
}

func validateLogsPayload(payload map[string]string) error {
	if value := payload["logs_source"]; value != "" {
		if err := requireEnum("logs_source", value, []string{"file", "system", "container"}); err != nil {
			return err
		}
	}
	if err := validateIntString("logs_limit", payload["logs_limit"], 1, 5000, true); err != nil {
		return err
	}
	if err := validateIntString("logs_live_limit", payload["logs_live_limit"], 1, 20000, true); err != nil {
		return err
	}
	if err := validateIntString("logs_live_max_bytes", payload["logs_live_max_bytes"], 4096, 16777216, true); err != nil {
		return err
	}
	if err := validateBoolString("logs_follow", payload["logs_follow"], true); err != nil {
		return err
	}
	if value := payload["logs_path"]; value != "" {
		if err := validateRemotePath("logs_path", value); err != nil {
			return err
		}
	}
	if payload["logs_source"] == "container" {
		if value := payload["logs_container_id"]; value == "" {
			return fmt.Errorf("logs_container_id is required")
		} else if matched, _ := regexp.MatchString(`^[A-Za-z0-9_.:-]{1,128}$`, value); !matched {
			return fmt.Errorf("logs_container_id contains unsupported characters")
		}
		if value := payload["logs_container_engine"]; value != "" {
			if err := requireEnum("logs_container_engine", value, []string{"auto", "docker", "podman"}); err != nil {
				return err
			}
		}
	} else if payload["logs_container_id"] != "" || payload["logs_container_engine"] != "" {
		return fmt.Errorf("container log fields require logs_source=container")
	}
	for _, key := range []string{"logs_query", "logs_unit", "logs_priority"} {
		if len([]byte(payload[key])) > 256 {
			return fmt.Errorf("%s is too large", key)
		}
	}
	for _, key := range []string{"logs_since", "logs_until"} {
		if value := payload[key]; value != "" {
			if len([]byte(value)) > 64 {
				return fmt.Errorf("%s is too large", key)
			}
			if matched, _ := regexp.MatchString(`^[A-Za-z0-9TtZz:+_.,/ -]{1,64}$`, value); !matched {
				return fmt.Errorf("%s contains unsupported characters", key)
			}
		}
	}
	if value := payload["logs_priority"]; value != "" {
		if matched, _ := regexp.MatchString(`^[A-Za-z0-9_.-]{1,40}$`, value); !matched {
			return fmt.Errorf("logs_priority contains unsupported characters")
		}
	}
	if value := payload["logs_unit"]; value != "" {
		if matched, _ := regexp.MatchString(`^[A-Za-z0-9 _./@:-]{1,120}$`, value); !matched {
			return fmt.Errorf("logs_unit contains unsupported characters")
		}
	}
	if value := payload["logs_cursor"]; value != "" {
		if len([]byte(value)) > 512 {
			return fmt.Errorf("logs_cursor is too large")
		}
		if matched, _ := regexp.MatchString(`^[A-Za-z0-9_.:=;,@+-]{1,512}$`, value); !matched {
			return fmt.Errorf("logs_cursor contains unsupported characters")
		}
	}
	if value := payload["logs_stream_format"]; value != "" {
		if err := requireEnum("logs_stream_format", value, []string{"json", "row_events"}); err != nil {
			return err
		}
	}
	return nil
}

func validateContainersPayload(operation string, action string, payload map[string]string) error {
	if err := validateIntString("containers_limit", payload["containers_limit"], 1, 1000, true); err != nil {
		return err
	}
	if value := payload["containers_query"]; value != "" {
		if len([]byte(value)) > 256 || containsControlCharacter(value) {
			return fmt.Errorf("containers_query contains unsupported characters")
		}
	}
	if value := payload["containers_known_state_token"]; value != "" {
		if matched, _ := regexp.MatchString(`^[A-Za-z0-9_.:-]{1,160}$`, value); !matched {
			return fmt.Errorf("containers_known_state_token must be a safe container state token")
		}
	}
	if value := payload["containers_output_encoding"]; value != "" {
		if err := requireEnum("containers_output_encoding", value, []string{"auto", "zstd", "gzip"}); err != nil {
			return err
		}
	}
	if value := payload["containers_stream_format"]; value != "" {
		if err := requireEnum("containers_stream_format", value, []string{"json", "row_events"}); err != nil {
			return err
		}
	}
	if value := payload["container_engine"]; value != "" {
		if err := requireEnum("container_engine", value, []string{"auto", "docker", "podman"}); err != nil {
			return err
		}
	}
	if err := validateBoolString("dry_run", payload["dry_run"], true); err != nil {
		return err
	}
	if err := validateIntString("container_logs_tail", payload["container_logs_tail"], 1, 5000, true); err != nil {
		return err
	}
	if operation != appplan.OperationAction {
		for _, key := range []string{"container_action", "container_id", "container_logs_tail", "dry_run", "container_install_template", "container_install_image", "container_install_name", "container_install_bind_address", "container_install_host_port", "container_install_container_port", "container_install_restart_policy", "container_install_exposure_confirmed"} {
			if payload[key] != "" {
				return fmt.Errorf("container action fields are only accepted through action endpoints")
			}
		}
		return nil
	}
	if err := requireEnum("container_action", action, []string{"start", "stop", "restart", "logs", "install"}); err != nil {
		return err
	}
	if payload["container_action"] != "" && payload["container_action"] != action {
		return fmt.Errorf("container_action must match the requested action")
	}
	if action == "install" {
		return validateContainerInstallPayload(payload)
	}
	if value := payload["container_id"]; value == "" {
		return fmt.Errorf("container_id is required")
	} else if matched, _ := regexp.MatchString(`^[A-Za-z0-9_.:-]{1,128}$`, value); !matched {
		return fmt.Errorf("container_id contains unsupported characters")
	}
	return nil
}

func validateContainerInstallPayload(payload map[string]string) error {
	if payload["container_id"] != "" || payload["container_logs_tail"] != "" {
		return fmt.Errorf("container install does not accept selected-container fields")
	}
	if value := payload["container_install_template"]; value == "" {
		return fmt.Errorf("container_install_template is required")
	} else if err := requireEnum("container_install_template", value, []string{"nginx", "custom"}); err != nil {
		return err
	}
	if value := payload["container_install_image"]; value == "" {
		return fmt.Errorf("container_install_image is required")
	} else if len([]byte(value)) > 256 {
		return fmt.Errorf("container_install_image is too large")
	} else if matched, _ := regexp.MatchString(`^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$`, value); !matched {
		return fmt.Errorf("container_install_image contains unsupported characters")
	}
	if value := payload["container_install_name"]; value == "" {
		return fmt.Errorf("container_install_name is required")
	} else if matched, _ := regexp.MatchString(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`, value); !matched {
		return fmt.Errorf("container_install_name contains unsupported characters")
	}
	if value := payload["container_install_bind_address"]; value == "" {
		return fmt.Errorf("container_install_bind_address is required")
	} else if err := requireEnum("container_install_bind_address", value, []string{"127.0.0.1", "localhost", "0.0.0.0", "::1"}); err != nil {
		return err
	}
	if err := validateIntString("container_install_host_port", payload["container_install_host_port"], 1, 65535, false); err != nil {
		return err
	}
	if err := validateIntString("container_install_container_port", payload["container_install_container_port"], 1, 65535, false); err != nil {
		return err
	}
	if value := payload["container_install_restart_policy"]; value == "" {
		return fmt.Errorf("container_install_restart_policy is required")
	} else if err := requireEnum("container_install_restart_policy", value, []string{"unless-stopped", "no"}); err != nil {
		return err
	}
	if err := validateBoolString("container_install_exposure_confirmed", payload["container_install_exposure_confirmed"], false); err != nil {
		return err
	}
	bindAddress := payload["container_install_bind_address"]
	if bindAddress != "127.0.0.1" && bindAddress != "localhost" && bindAddress != "::1" && !boolStringTrue(payload["container_install_exposure_confirmed"]) {
		return fmt.Errorf("container_install_exposure_confirmed is required before binding outside localhost")
	}
	return nil
}

func validateLANWatchPayload(payload map[string]string) error {
	if value := payload["lan_watch_output_encoding"]; value != "" {
		if err := requireEnum("lan_watch_output_encoding", value, []string{"auto", "zstd", "gzip"}); err != nil {
			return err
		}
	}
	if value := payload["lan_watch_stream_format"]; value != "" {
		if err := requireEnum("lan_watch_stream_format", value, []string{"json", "row_events"}); err != nil {
			return err
		}
	}
	if err := validateIntString("lan_watch_limit", payload["lan_watch_limit"], 1, 512, true); err != nil {
		return err
	}
	return validateBoolString("lan_watch_no_probe", payload["lan_watch_no_probe"], true)
}

func validateNetworkConnectionsPayload(operation string, action string, payload map[string]string) error {
	if value := payload["network_connections_output_encoding"]; value != "" {
		if err := requireEnum("network_connections_output_encoding", value, []string{"auto", "zstd", "gzip"}); err != nil {
			return err
		}
	}
	if value := payload["network_connections_stream_format"]; value != "" {
		if err := requireEnum("network_connections_stream_format", value, []string{"json", "row_events"}); err != nil {
			return err
		}
	}
	if operation != appplan.OperationAction {
		for key, value := range payload {
			if value == "" || key == "network_connections_output_encoding" || key == "network_connections_stream_format" {
				continue
			}
			return fmt.Errorf("network connections data endpoint does not accept %s", key)
		}
		return nil
	}
	if err := requireEnum("network_action", action, []string{"set_hostname", "set_mtu", "set_dns"}); err != nil {
		return err
	}
	if payload["network_action"] != "" && payload["network_action"] != action {
		return fmt.Errorf("network_action must match the requested action")
	}
	if err := validateBoolString("dry_run", payload["dry_run"], true); err != nil {
		return err
	}
	if value := payload["network_interface"]; value != "" {
		if len([]byte(value)) > 128 || containsControlCharacter(value) {
			return fmt.Errorf("network_interface contains unsupported characters")
		}
		if matched, _ := regexp.MatchString(`^[A-Za-z0-9 _.:/-]+$`, value); !matched {
			return fmt.Errorf("network_interface contains unsupported characters")
		}
	}
	if action == "set_hostname" {
		value := payload["network_hostname"]
		if len(value) == 0 || len([]byte(value)) > 253 || strings.HasPrefix(value, ".") || strings.HasSuffix(value, "-") || strings.Contains(value, "..") {
			return fmt.Errorf("network_hostname must be a valid host name")
		}
		if matched, _ := regexp.MatchString(`^[A-Za-z0-9][A-Za-z0-9.-]*$`, value); !matched {
			return fmt.Errorf("network_hostname must be a valid host name")
		}
	}
	if action == "set_mtu" {
		if payload["network_interface"] == "" {
			return fmt.Errorf("network_interface is required")
		}
		if err := validateIntString("network_mtu", payload["network_mtu"], 576, 9000, false); err != nil {
			return err
		}
	}
	if action == "set_dns" {
		if payload["network_interface"] == "" {
			return fmt.Errorf("network_interface is required")
		}
		value := payload["network_dns"]
		if value == "" || len([]byte(value)) > 512 || containsControlCharacter(value) {
			return fmt.Errorf("network_dns must be a comma-separated list of DNS server IP addresses")
		}
		for _, item := range strings.Split(value, ",") {
			item = strings.TrimSpace(item)
			if item == "" {
				return fmt.Errorf("network_dns must be a comma-separated list of DNS server IP addresses")
			}
			if matched, _ := regexp.MatchString(`^[0-9A-Fa-f:.]+$`, item); !matched {
				return fmt.Errorf("network_dns must contain IP addresses only")
			}
		}
	}
	return nil
}

func validateConnectionWatchPayload(payload map[string]string) error {
	if value := payload["connection_watch_output_encoding"]; value != "" {
		if err := requireEnum("connection_watch_output_encoding", value, []string{"auto", "zstd", "gzip"}); err != nil {
			return err
		}
	}
	if value := payload["connection_watch_stream_format"]; value != "" {
		if err := requireEnum("connection_watch_stream_format", value, []string{"json", "row_events"}); err != nil {
			return err
		}
	}
	return nil
}

func validateDisksPayload(payload map[string]string) error {
	if value := payload["disks_output_encoding"]; value != "" {
		if err := requireEnum("disks_output_encoding", value, []string{"auto", "zstd", "gzip"}); err != nil {
			return err
		}
	}
	if value := payload["disks_stream_format"]; value != "" {
		if err := requireEnum("disks_stream_format", value, []string{"json", "row_events"}); err != nil {
			return err
		}
	}
	return nil
}

func validateSpeedTestPayload(payload map[string]string) error {
	if value := payload["speed_test_mode"]; value != "" {
		if err := requireEnum("speed_test_mode", value, []string{"run", "start", "status", "cancel"}); err != nil {
			return err
		}
	}
	if value := payload["speed_test_job_id"]; value != "" {
		if strings.TrimSpace(value) != value {
			return fmt.Errorf("speed_test_job_id must be exact text without surrounding whitespace")
		}
		if len(value) > 160 || containsControlCharacter(value) || containsBidirectionalControl(value) {
			return fmt.Errorf("speed_test_job_id is not safe")
		}
	}
	if value := payload["direction"]; value != "" {
		if err := requireEnum("direction", value, []string{"download", "upload"}); err != nil {
			return err
		}
	}
	if err := validateIntString("streams", payload["streams"], 1, 16, true); err != nil {
		return err
	}
	if err := validateIntString("payload_bytes", payload["payload_bytes"], 1024*1024, 10*1024*1024*1024, true); err != nil {
		return err
	}
	if value := payload["payload_mb"]; value != "" {
		if strings.TrimSpace(value) != value {
			return fmt.Errorf("payload_mb must be exact numeric text without surrounding whitespace")
		}
		parsed, err := strconv.ParseFloat(value, 64)
		if err != nil || parsed < 1 || parsed > 10240 {
			return fmt.Errorf("payload_mb must be between 1 and 10240")
		}
	}
	return nil
}

func validateRemotePath(key string, value string) error {
	if value == "" {
		return fmt.Errorf("%s is required", key)
	}
	if strings.ContainsRune(value, '\x00') {
		return fmt.Errorf("%s contains a NUL byte", key)
	}
	if len([]byte(value)) > 4096 {
		return fmt.Errorf("%s is too long", key)
	}
	return nil
}

func validateSafeFileNameComponent(key string, value string) error {
	if value == "" || value == "." || value == ".." {
		return fmt.Errorf("%s must not be empty or reserved", key)
	}
	if strings.ContainsAny(value, "/\\") {
		return fmt.Errorf("%s must not contain path separators", key)
	}
	if len([]byte(value)) > 255 {
		return fmt.Errorf("%s is too long", key)
	}
	if containsControlCharacter(value) || containsBidirectionalControl(value) {
		return fmt.Errorf("%s contains unsafe control characters", key)
	}
	return nil
}

func containsBidirectionalControl(value string) bool {
	for _, item := range value {
		if (item >= '\u202a' && item <= '\u202e') || (item >= '\u2066' && item <= '\u2069') {
			return true
		}
	}
	return false
}

func validateSudoersPath(value string) error {
	if strings.TrimSpace(value) != value || value == "" {
		return fmt.Errorf("sudo_path must be a non-empty exact path")
	}
	if value == "/etc/sudoers" {
		return nil
	}
	const prefix = "/etc/sudoers.d/"
	if !strings.HasPrefix(value, prefix) {
		return fmt.Errorf("sudo_path must be /etc/sudoers or a file inside /etc/sudoers.d")
	}
	name := strings.TrimPrefix(value, prefix)
	if name == "" || strings.Contains(name, "/") || strings.HasPrefix(name, ".") || len([]byte(name)) > 128 || containsControlCharacter(name) {
		return fmt.Errorf("sudo_path must use a safe sudoers.d file name")
	}
	for _, item := range name {
		if unicode.IsLetter(item) || unicode.IsDigit(item) || item == '_' || item == '-' || item == '.' {
			continue
		}
		return fmt.Errorf("sudo_path must use a safe sudoers.d file name")
	}
	return nil
}

func validateOpenSSHConfigPath(key string, value string) error {
	if strings.TrimSpace(value) != value || value == "" {
		return fmt.Errorf("%s must be a non-empty exact path", key)
	}
	if strings.ContainsRune(value, '\x00') || containsControlCharacter(value) {
		return fmt.Errorf("%s contains unsupported characters", key)
	}
	if len([]byte(value)) > 4096 {
		return fmt.Errorf("%s is too long", key)
	}
	normalized := strings.ReplaceAll(value, "\\", "/")
	normalizedLower := strings.ToLower(normalized)
	allowedExact := []string{
		"/etc/ssh/sshd_config",
		"/usr/local/etc/ssh/sshd_config",
		"/private/etc/ssh/sshd_config",
	}
	for _, candidate := range allowedExact {
		if normalized == candidate {
			return nil
		}
	}
	allowedPrefixes := []string{
		"/etc/ssh/sshd_config.d/",
		"/usr/local/etc/ssh/sshd_config.d/",
		"/private/etc/ssh/sshd_config.d/",
	}
	for _, prefix := range allowedPrefixes {
		if strings.HasPrefix(normalized, prefix) {
			name := strings.TrimPrefix(normalized, prefix)
			if safeOpenSSHConfigFileName(name) {
				return nil
			}
			return fmt.Errorf("%s must be a safe .conf file inside %s", key, prefix)
		}
	}
	if strings.HasSuffix(normalizedLower, "/programdata/ssh/sshd_config") || strings.HasSuffix(normalizedLower, ":/programdata/ssh/sshd_config") {
		return nil
	}
	marker := "/programdata/ssh/sshd_config.d/"
	if index := strings.Index(normalizedLower, marker); index >= 0 {
		name := normalized[index+len(marker):]
		if safeOpenSSHConfigFileName(name) {
			return nil
		}
		return fmt.Errorf("%s must be a safe .conf file inside ProgramData/ssh/sshd_config.d", key)
	}
	return fmt.Errorf("%s must be an OpenSSH server config path", key)
}

func safeOpenSSHConfigFileName(name string) bool {
	if name == "" || strings.Contains(name, "/") || strings.HasPrefix(name, ".") || !strings.HasSuffix(name, ".conf") || len([]byte(name)) > 160 {
		return false
	}
	for _, item := range name {
		if unicode.IsLetter(item) || unicode.IsDigit(item) || item == '_' || item == '-' || item == '.' {
			continue
		}
		return false
	}
	return true
}

func validateOpenSSHBackupPath(value string) error {
	if strings.TrimSpace(value) != value || value == "" {
		return fmt.Errorf("ssh_server_backup_path is required for rollback")
	}
	if strings.ContainsRune(value, '\x00') || containsControlCharacter(value) || len([]byte(value)) > 4096 {
		return fmt.Errorf("ssh_server_backup_path contains unsupported characters")
	}
	normalized := strings.ReplaceAll(value, "\\", "/")
	normalizedLower := strings.ToLower(normalized)
	if strings.Contains(normalized, "/../") || strings.HasSuffix(normalized, "/..") {
		return fmt.Errorf("ssh_server_backup_path must not contain path traversal")
	}
	if strings.HasPrefix(normalized, "/etc/ssh/.shellorchestra-backups/") ||
		strings.HasPrefix(normalized, "/usr/local/etc/ssh/.shellorchestra-backups/") ||
		strings.HasPrefix(normalized, "/private/etc/ssh/.shellorchestra-backups/") ||
		strings.Contains(normalizedLower, "/programdata/ssh/.shellorchestra-backups/") {
		return nil
	}
	return fmt.Errorf("ssh_server_backup_path must point to an OpenSSH ShellOrchestra backup")
}

func validatePackageName(value string) error {
	if len(value) == 0 || len([]byte(value)) > 160 {
		return fmt.Errorf("package_name is required")
	}
	if strings.HasPrefix(value, "-") || strings.ContainsAny(value, "\x00\n\r\t") {
		return fmt.Errorf("package_name contains unsupported characters")
	}
	if matched, _ := regexp.MatchString(`^[A-Za-z0-9][A-Za-z0-9._+:@/-]{0,159}$`, value); !matched {
		return fmt.Errorf("package_name contains unsupported characters")
	}
	return nil
}

func validateServiceName(value string) error {
	if strings.HasPrefix(value, "-") {
		return fmt.Errorf("service_name contains unsupported characters")
	}
	matched, _ := regexp.MatchString(`^[A-Za-z0-9@_.:-]{1,256}$`, value)
	if !matched {
		return fmt.Errorf("service_name contains unsupported characters")
	}
	return nil
}

func validateFirewallRule(value string, server domain.Server) error {
	if strings.TrimSpace(value) != value || containsControlCharacter(value) {
		return fmt.Errorf("firewall_rule contains unsupported characters")
	}
	if strings.EqualFold(firstNonEmpty(server.DetectedOS, server.DetectedPlatformOS), "windows") {
		matches := regexp.MustCompile(`^allow ([0-9]{1,5})/tcp$`).FindStringSubmatch(value)
		if matches == nil {
			return fmt.Errorf("firewall_rule must use allow <port>/tcp for Windows")
		}
		port, err := strconv.Atoi(matches[1])
		if err != nil || port < 1 || port > 65535 {
			return fmt.Errorf("firewall_rule port must be between 1 and 65535")
		}
		return nil
	}
	if len([]byte(value)) > 160 {
		return fmt.Errorf("firewall_rule is too long")
	}
	matched, _ := regexp.MatchString(`^[A-Za-z0-9._:/ -]{1,160}$`, value)
	if !matched {
		return fmt.Errorf("firewall_rule contains unsupported characters")
	}
	tokens := strings.Fields(value)
	if len(tokens) == 0 {
		return fmt.Errorf("firewall_rule is required")
	}
	switch tokens[0] {
	case "allow", "deny", "reject", "limit":
		return nil
	case "route":
		if len(tokens) > 1 {
			switch tokens[1] {
			case "allow", "deny", "reject", "limit":
				return nil
			}
		}
	}
	return fmt.Errorf("firewall_rule must start with a supported UFW action")
}

func containsControlCharacter(value string) bool {
	return strings.ContainsFunc(value, unicode.IsControl)
}

func firstNonEmptyExact(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func validateBoolString(key string, value string, optional bool) error {
	if value == "" && optional {
		return nil
	}
	switch value {
	case "0", "1", "true", "false":
		return nil
	default:
		return fmt.Errorf("%s must be true, false, 0, or 1", key)
	}
}

func boolStringTrue(value string) bool {
	return value == "1" || value == "true"
}

func validateIntString(key string, value string, minimum int, maximum int, optional bool) error {
	if value == "" && optional {
		return nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < minimum || parsed > maximum {
		return fmt.Errorf("%s must be between %d and %d", key, minimum, maximum)
	}
	return nil
}

func requireEnum(key string, value string, allowed []string) error {
	for _, item := range allowed {
		if value == item {
			return nil
		}
	}
	return fmt.Errorf("%s has unsupported value %q", key, value)
}
