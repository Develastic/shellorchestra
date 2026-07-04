// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package domain

import "time"

type DeviceKind string

const (
	DeviceKindPhone   DeviceKind = "phone"
	DeviceKindDesktop DeviceKind = "desktop"
	DeviceKindBrowser DeviceKind = "browser"
)

type Principal struct {
	DeviceID string     `json:"device_id"`
	Label    string     `json:"label"`
	Kind     DeviceKind `json:"kind"`
}

type Server struct {
	ID                     string               `json:"id"`
	Name                   string               `json:"name"`
	Host                   string               `json:"host"`
	Port                   int                  `json:"port"`
	Username               string               `json:"username"`
	ConnectionMode         ServerConnectionMode `json:"connection_mode"`
	JumpServerID           string               `json:"jump_server_id,omitempty"`
	AuthMethod             ServerAuthMethod     `json:"auth_method"`
	SSHKeyID               string               `json:"ssh_key_id,omitempty"`
	ShellHint              string               `json:"shell_hint"`
	OSHint                 string               `json:"os_hint"`
	DistroHint             string               `json:"distro_hint"`
	DetectedShell          string               `json:"detected_shell"`
	DetectedOS             string               `json:"detected_os"`
	DetectedDistro         string               `json:"detected_distro"`
	DetectedAdminRights    string               `json:"detected_admin_rights"`
	DetectedHostname       string               `json:"detected_hostname"`
	DetectedPlatform       string               `json:"detected_platform"`
	DetectedPlatformOS     string               `json:"detected_platform_os"`
	DetectedPlatformArch   string               `json:"detected_platform_arch"`
	DetectedKernelVersion  string               `json:"detected_kernel_version"`
	DetectedPackageManager string               `json:"detected_package_manager"`
	DetectedSSHMaxSessions int                  `json:"detected_ssh_max_sessions"`
	DetectedPVEHost        bool                 `json:"detected_pve_host"`
	DetectedDockerHost     bool                 `json:"detected_docker_host"`
	DetectedApps           map[string]bool      `json:"detected_apps"`
	OverrideShell          string               `json:"override_shell"`
	OverrideOS             string               `json:"override_os"`
	OverrideDistro         string               `json:"override_distro"`
	OverrideAdminRights    string               `json:"override_admin_rights"`
	HostKey                string               `json:"host_key,omitempty"`
	Tags                   []string             `json:"tags"`
	Notes                  string               `json:"notes"`
	CreatedAt              time.Time            `json:"created_at"`
	UpdatedAt              time.Time            `json:"updated_at"`
}

type ServerInput struct {
	Name                   string               `json:"name"`
	Host                   string               `json:"host"`
	Port                   int                  `json:"port"`
	Username               string               `json:"username"`
	ConnectionMode         ServerConnectionMode `json:"connection_mode"`
	JumpServerID           string               `json:"jump_server_id"`
	AuthMethod             ServerAuthMethod     `json:"auth_method"`
	SSHKeyID               string               `json:"ssh_key_id"`
	ShellHint              string               `json:"shell_hint"`
	OSHint                 string               `json:"os_hint"`
	DistroHint             string               `json:"distro_hint"`
	DetectedShell          string               `json:"detected_shell"`
	DetectedOS             string               `json:"detected_os"`
	DetectedDistro         string               `json:"detected_distro"`
	DetectedAdminRights    string               `json:"detected_admin_rights"`
	DetectedHostname       string               `json:"detected_hostname"`
	DetectedPlatform       string               `json:"detected_platform"`
	DetectedPlatformOS     string               `json:"detected_platform_os"`
	DetectedPlatformArch   string               `json:"detected_platform_arch"`
	DetectedKernelVersion  string               `json:"detected_kernel_version"`
	DetectedPackageManager string               `json:"detected_package_manager"`
	DetectedSSHMaxSessions int                  `json:"detected_ssh_max_sessions"`
	DetectedPVEHost        bool                 `json:"detected_pve_host"`
	DetectedDockerHost     bool                 `json:"detected_docker_host"`
	DetectedApps           map[string]bool      `json:"detected_apps"`
	OverrideShell          string               `json:"override_shell"`
	OverrideOS             string               `json:"override_os"`
	OverrideDistro         string               `json:"override_distro"`
	OverrideAdminRights    string               `json:"override_admin_rights"`
	HostKey                string               `json:"host_key"`
	Tags                   []string             `json:"tags"`
	Notes                  string               `json:"notes"`
}

type ServerConnectionMode string

const (
	ServerConnectionDirect  ServerConnectionMode = "direct"
	ServerConnectionChained ServerConnectionMode = "chained"
)

type ServerAuthMethod string

const (
	ServerAuthCA                ServerAuthMethod = "ca"
	ServerAuthClassic           ServerAuthMethod = "classic"
	ServerAuthCustomKey         ServerAuthMethod = "custom_key"
	ServerAuthLocalProtectedKey ServerAuthMethod = "local_protected_key"
)

type ServerFacts struct {
	Hostname       string          `json:"hostname"`
	Shell          string          `json:"shell"`
	OS             string          `json:"os"`
	Platform       string          `json:"platform"`
	PlatformOS     string          `json:"platform_os"`
	PlatformArch   string          `json:"platform_arch"`
	Distro         string          `json:"distro"`
	AdminRights    string          `json:"admin_rights"`
	KernelVersion  string          `json:"kernel_version"`
	PackageManager string          `json:"package_manager"`
	SSHMaxSessions int             `json:"ssh_max_sessions"`
	IsPVEHost      bool            `json:"is_pve_host"`
	IsDockerHost   bool            `json:"is_docker_host"`
	Apps           map[string]bool `json:"apps"`
}

type ServerStatusState string

const (
	StatusLocked          ServerStatusState = "locked"
	StatusDisconnected    ServerStatusState = "disconnected"
	StatusConnecting      ServerStatusState = "connecting"
	StatusConnected       ServerStatusState = "connected"
	StatusRetryingNetwork ServerStatusState = "retrying_network"
	StatusBlockedAuth     ServerStatusState = "blocked_auth"
	StatusBlockedConfig   ServerStatusState = "blocked_config"
	StatusJumpUnavailable ServerStatusState = "jump_unavailable"
	StatusHostKeyRequired ServerStatusState = "host_key_required"
	StatusHostKeyMismatch ServerStatusState = "host_key_mismatch"
	StatusFailed          ServerStatusState = "failed"
)

type ServerStatus struct {
	ServerID  string            `json:"server_id"`
	State     ServerStatusState `json:"state"`
	Telemetry map[string]any    `json:"telemetry"`
	LastError string            `json:"last_error,omitempty"`
	UpdatedAt time.Time         `json:"updated_at"`
}

type SSHTunnelKind string

const (
	SSHTunnelKindTCPForward SSHTunnelKind = "tcp_forward"
	SSHTunnelKindSOCKS      SSHTunnelKind = "socks"
)

type SSHTunnelState string

const (
	SSHTunnelStateStopped      SSHTunnelState = "stopped"
	SSHTunnelStateStarting     SSHTunnelState = "starting"
	SSHTunnelStateRunning      SSHTunnelState = "running"
	SSHTunnelStateReconnecting SSHTunnelState = "reconnecting"
	SSHTunnelStatePaused       SSHTunnelState = "paused"
	SSHTunnelStateFailed       SSHTunnelState = "failed"
)

type SSHTunnelProfile struct {
	ID                string        `json:"id"`
	Label             string        `json:"label"`
	Kind              SSHTunnelKind `json:"kind"`
	ServerID          string        `json:"server_id"`
	BindAddress       string        `json:"bind_address"`
	BindPort          int           `json:"bind_port"`
	DestinationHost   string        `json:"destination_host,omitempty"`
	DestinationPort   int           `json:"destination_port,omitempty"`
	AutoStart         bool          `json:"auto_start"`
	AutoReconnect     bool          `json:"auto_reconnect"`
	PauseOnDisconnect bool          `json:"pause_on_disconnect"`
	Paused            bool          `json:"paused"`
	Tags              []string      `json:"tags"`
	CreatedAt         time.Time     `json:"created_at"`
	UpdatedAt         time.Time     `json:"updated_at"`
}

type SSHTunnelInput struct {
	Label             string        `json:"label"`
	Kind              SSHTunnelKind `json:"kind"`
	ServerID          string        `json:"server_id"`
	BindAddress       string        `json:"bind_address"`
	BindPort          int           `json:"bind_port"`
	DestinationHost   string        `json:"destination_host"`
	DestinationPort   int           `json:"destination_port"`
	AutoStart         bool          `json:"auto_start"`
	AutoReconnect     bool          `json:"auto_reconnect"`
	PauseOnDisconnect bool          `json:"pause_on_disconnect"`
	Paused            bool          `json:"paused"`
	Tags              []string      `json:"tags"`
	ConfirmedExposure bool          `json:"confirmed_exposure"`
}

type SSHTunnelRuntime struct {
	ProfileID    string         `json:"profile_id"`
	State        SSHTunnelState `json:"state"`
	AssignedPort int            `json:"assigned_port"`
	StartedAt    *time.Time     `json:"started_at,omitempty"`
	LastError    string         `json:"last_error,omitempty"`
	BytesIn      uint64         `json:"bytes_in"`
	BytesOut     uint64         `json:"bytes_out"`
	ClientCount  int            `json:"client_count"`
	Active       bool           `json:"active"`
	UpdatedAt    time.Time      `json:"updated_at"`
}

type ScriptCommand struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	AppIDs      []string       `json:"app_ids,omitempty"`
	AppRole     string         `json:"app_role,omitempty"`
	Variants    []string       `json:"variants"`
	Sources     []ScriptSource `json:"sources,omitempty"`
}

type ScriptSource struct {
	Variant         string   `json:"variant"`
	File            string   `json:"file"`
	Shell           string   `json:"shell"`
	OS              []string `json:"os,omitempty"`
	Distro          []string `json:"distro,omitempty"`
	PackageManagers []string `json:"package_managers,omitempty"`
	Source          string   `json:"source,omitempty"`
	SourceError     string   `json:"source_error,omitempty"`
}

type ScriptRunState string

const (
	ScriptRunQueued    ScriptRunState = "queued"
	ScriptRunRunning   ScriptRunState = "running"
	ScriptRunSucceeded ScriptRunState = "succeeded"
	ScriptRunFailed    ScriptRunState = "failed"
)

type ScriptRun struct {
	ID         string         `json:"id"`
	ServerID   string         `json:"server_id"`
	Command    string         `json:"command"`
	Variant    string         `json:"variant,omitempty"`
	State      ScriptRunState `json:"state"`
	Result     map[string]any `json:"result,omitempty"`
	Error      string         `json:"error,omitempty"`
	CreatedAt  time.Time      `json:"created_at"`
	FinishedAt *time.Time     `json:"finished_at,omitempty"`
}

type BackupBucket struct {
	ID             string     `json:"id"`
	Label          string     `json:"label"`
	ServerID       string     `json:"server_id"`
	RootPath       string     `json:"root_path"`
	BucketPath     string     `json:"bucket_path"`
	Filesystem     string     `json:"filesystem"`
	FreeBytes      int64      `json:"free_bytes"`
	TotalBytes     int64      `json:"total_bytes"`
	ManifestStatus string     `json:"manifest_status"`
	LastProbeAt    *time.Time `json:"last_probe_at,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
}

type BackupBucketInput struct {
	Label          string `json:"label"`
	ServerID       string `json:"server_id"`
	RootPath       string `json:"root_path"`
	BucketPath     string `json:"bucket_path"`
	Filesystem     string `json:"filesystem"`
	FreeBytes      int64  `json:"free_bytes"`
	TotalBytes     int64  `json:"total_bytes"`
	ManifestStatus string `json:"manifest_status"`
}

type BackupRotationPolicy struct {
	KeepLatest  int `json:"keep_latest"`
	KeepWeekly  int `json:"keep_weekly"`
	KeepMonthly int `json:"keep_monthly"`
}

type BackupSchedule struct {
	Enabled bool   `json:"enabled"`
	Kind    string `json:"kind"`
	Hour    int    `json:"hour"`
	Minute  int    `json:"minute"`
}

type BackupTask struct {
	ID               string               `json:"id"`
	Label            string               `json:"label"`
	SourceServerID   string               `json:"source_server_id"`
	SourcePath       string               `json:"source_path"`
	SourceKind       string               `json:"source_kind"`
	SourceFileCount  int64                `json:"source_file_count"`
	SourceDiskBytes  int64                `json:"source_disk_bytes"`
	TargetBucketID   string               `json:"target_bucket_id"`
	FallbackBucketID string               `json:"fallback_bucket_id"`
	ExcludePatterns  string               `json:"exclude_patterns"`
	Compression      string               `json:"compression"`
	Rotation         BackupRotationPolicy `json:"rotation"`
	Schedule         BackupSchedule       `json:"schedule"`
	LastRunID        string               `json:"last_run_id"`
	LastRunState     string               `json:"last_run_state"`
	LastSuccessAt    *time.Time           `json:"last_success_at,omitempty"`
	CreatedAt        time.Time            `json:"created_at"`
	UpdatedAt        time.Time            `json:"updated_at"`
}

type BackupTaskInput struct {
	Label            string               `json:"label"`
	SourceServerID   string               `json:"source_server_id"`
	SourcePath       string               `json:"source_path"`
	SourceKind       string               `json:"source_kind"`
	SourceFileCount  int64                `json:"source_file_count"`
	SourceDiskBytes  int64                `json:"source_disk_bytes"`
	TargetBucketID   string               `json:"target_bucket_id"`
	FallbackBucketID string               `json:"fallback_bucket_id"`
	ExcludePatterns  string               `json:"exclude_patterns"`
	Compression      string               `json:"compression"`
	Rotation         BackupRotationPolicy `json:"rotation"`
	Schedule         BackupSchedule       `json:"schedule"`
}

type BackupRun struct {
	ID           string     `json:"id"`
	TaskID       string     `json:"task_id"`
	Trigger      string     `json:"trigger"`
	State        string     `json:"state"`
	ScriptRunID  string     `json:"script_run_id"`
	Log          string     `json:"log"`
	Error        string     `json:"error"`
	ArchiveName  string     `json:"archive_name"`
	ArchiveBytes int64      `json:"archive_bytes"`
	CreatedAt    time.Time  `json:"created_at"`
	StartedAt    time.Time  `json:"started_at"`
	FinishedAt   *time.Time `json:"finished_at,omitempty"`
}

type BatchScriptFailurePolicy string

const (
	BatchScriptFailureContinue               BatchScriptFailurePolicy = "continue"
	BatchScriptFailureStopOnFirstFailure     BatchScriptFailurePolicy = "stop_on_first_failure"
	BatchScriptFailureStopAfterPercentFailed BatchScriptFailurePolicy = "stop_after_percent_failed"
)

type BatchScriptVariantState string

const (
	BatchScriptVariantSkip  BatchScriptVariantState = "skip"
	BatchScriptVariantReady BatchScriptVariantState = "ready"
)

type BatchScriptRunState string

const (
	BatchScriptRunQueued    BatchScriptRunState = "queued"
	BatchScriptRunRunning   BatchScriptRunState = "running"
	BatchScriptRunSucceeded BatchScriptRunState = "succeeded"
	BatchScriptRunPartial   BatchScriptRunState = "partial"
	BatchScriptRunFailed    BatchScriptRunState = "failed"
	BatchScriptRunCancelled BatchScriptRunState = "cancelled"
)

type BatchScriptRunTargetState string

const (
	BatchScriptRunTargetQueued    BatchScriptRunTargetState = "queued"
	BatchScriptRunTargetRunning   BatchScriptRunTargetState = "running"
	BatchScriptRunTargetSkipped   BatchScriptRunTargetState = "skipped"
	BatchScriptRunTargetSucceeded BatchScriptRunTargetState = "succeeded"
	BatchScriptRunTargetFailed    BatchScriptRunTargetState = "failed"
)

type BatchScriptMissedRunPolicy string

const (
	BatchScriptMissedRunOnce BatchScriptMissedRunPolicy = "run_once"
	BatchScriptMissedRunSkip BatchScriptMissedRunPolicy = "skip_missed"
)

type BatchScriptTemplate struct {
	ID                    string                    `json:"id"`
	Name                  string                    `json:"name"`
	Description           string                    `json:"description"`
	Enabled               bool                      `json:"enabled"`
	TargetSelector        BatchScriptTargetSelector `json:"target_selector"`
	DefaultTimeoutSeconds int                       `json:"default_timeout_seconds"`
	DefaultConcurrency    int                       `json:"default_concurrency"`
	FailurePolicy         BatchScriptFailurePolicy  `json:"failure_policy"`
	PreflightRequired     bool                      `json:"preflight_required"`
	Schedule              BatchScriptSchedule       `json:"schedule"`
	ScheduleState         *BatchScriptScheduleState `json:"schedule_state,omitempty"`
	Retention             BatchScriptRetention      `json:"retention"`
	Variants              []BatchScriptVariant      `json:"variants"`
	Example               bool                      `json:"example"`
	CreatedAt             time.Time                 `json:"created_at"`
	UpdatedAt             time.Time                 `json:"updated_at"`
}

type BatchScriptTemplateInput struct {
	Name                  string                    `json:"name"`
	Description           string                    `json:"description"`
	Enabled               bool                      `json:"enabled"`
	TargetSelector        BatchScriptTargetSelector `json:"target_selector"`
	DefaultTimeoutSeconds int                       `json:"default_timeout_seconds"`
	DefaultConcurrency    int                       `json:"default_concurrency"`
	FailurePolicy         BatchScriptFailurePolicy  `json:"failure_policy"`
	PreflightRequired     bool                      `json:"preflight_required"`
	Schedule              BatchScriptSchedule       `json:"schedule"`
	Retention             BatchScriptRetention      `json:"retention"`
	Variants              []BatchScriptVariant      `json:"variants"`
}

type BatchScriptTargetSelector struct {
	ServerIDs             []string `json:"server_ids"`
	IncludeTags           []string `json:"include_tags"`
	ExcludeTags           []string `json:"exclude_tags"`
	RequiredStatus        string   `json:"required_status"`
	PlatformFilters       []string `json:"platform_filters"`
	DistroFilters         []string `json:"distro_filters"`
	PackageManagerFilters []string `json:"package_manager_filters"`
}

type BatchScriptSchedule struct {
	Enabled         bool                       `json:"enabled"`
	IntervalSeconds int                        `json:"interval_seconds"`
	Timezone        string                     `json:"timezone"`
	MissedRunPolicy BatchScriptMissedRunPolicy `json:"missed_run_policy"`
}

type BatchScriptScheduleState struct {
	TemplateID       string     `json:"template_id"`
	NextRunAt        *time.Time `json:"next_run_at,omitempty"`
	LastEvaluatedAt  *time.Time `json:"last_evaluated_at,omitempty"`
	LastStartedRunID string     `json:"last_started_run_id"`
	LastNoopAt       *time.Time `json:"last_noop_at,omitempty"`
	LastNoopReason   string     `json:"last_noop_reason"`
	MissedRunCount   int        `json:"missed_run_count"`
	UpdatedAt        time.Time  `json:"updated_at"`
}

type BatchScriptRetention struct {
	MaxRuns         int `json:"max_runs"`
	MaxOutputBytes  int `json:"max_output_bytes"`
	DeleteAfterDays int `json:"delete_after_days"`
}

type BatchScriptVariant struct {
	ID             string                  `json:"id"`
	TargetKind     string                  `json:"target_kind"`
	Platform       string                  `json:"platform"`
	Distro         string                  `json:"distro"`
	PackageManager string                  `json:"package_manager"`
	Shell          string                  `json:"shell"`
	ScriptBody     string                  `json:"script_body"`
	PreflightBody  string                  `json:"preflight_body"`
	TimeoutSeconds int                     `json:"timeout_seconds"`
	State          BatchScriptVariantState `json:"state"`
	SyntaxLanguage string                  `json:"syntax_language"`
}

type BatchScriptRun struct {
	ID                   string                 `json:"id"`
	TemplateID           string                 `json:"template_id"`
	NameSnapshot         string                 `json:"name_snapshot"`
	RequestedByDeviceID  string                 `json:"requested_by_device_id"`
	RequestedBySessionID string                 `json:"requested_by_session_id"`
	Trigger              string                 `json:"trigger"`
	State                BatchScriptRunState    `json:"state"`
	TargetCount          int                    `json:"target_count"`
	SuccessCount         int                    `json:"success_count"`
	FailedCount          int                    `json:"failed_count"`
	SkippedCount         int                    `json:"skipped_count"`
	SettingsSnapshot     map[string]any         `json:"settings_snapshot"`
	Targets              []BatchScriptRunTarget `json:"targets,omitempty"`
	CreatedAt            time.Time              `json:"created_at"`
	StartedAt            time.Time              `json:"started_at"`
	FinishedAt           *time.Time             `json:"finished_at,omitempty"`
}

type BatchScriptRunTarget struct {
	RunID                   string                    `json:"run_id"`
	ServerID                string                    `json:"server_id"`
	ServerLabelSnapshot     string                    `json:"server_label_snapshot"`
	VariantID               string                    `json:"variant_id"`
	VariantSelectorSnapshot map[string]string         `json:"variant_selector_snapshot"`
	State                   BatchScriptRunTargetState `json:"state"`
	ExitCode                *int                      `json:"exit_code,omitempty"`
	StdoutPreview           string                    `json:"stdout_preview"`
	StdoutTruncated         bool                      `json:"stdout_truncated"`
	StdoutRef               string                    `json:"stdout_ref,omitempty"`
	StdoutBytes             int64                     `json:"stdout_bytes"`
	StderrPreview           string                    `json:"stderr_preview"`
	StderrTruncated         bool                      `json:"stderr_truncated"`
	StderrRef               string                    `json:"stderr_ref,omitempty"`
	StderrBytes             int64                     `json:"stderr_bytes"`
	ErrorMessage            string                    `json:"error_message"`
	StartedAt               *time.Time                `json:"started_at,omitempty"`
	FinishedAt              *time.Time                `json:"finished_at,omitempty"`
}
