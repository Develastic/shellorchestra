// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"

	"shellorchestra/backend/internal/domain"
)

var ErrNotFound = errors.New("not found")

type VirtualDesktopRevisionConflict struct {
	Current domain.VirtualDesktopState
}

func (e VirtualDesktopRevisionConflict) Error() string {
	return "virtual desktop changed on another client"
}

type SQLiteStore struct {
	db *sql.DB
}

type TrustedDevice struct {
	ID             string
	Label          string
	Kind           domain.DeviceKind
	ApprovedAt     *time.Time
	CredentialID   string
	PublicKeyB64   string
	SigningKeyB64  string
	EnvelopeKeyB64 string
	SignerEpoch    int
	UserHandleB64  string
	CredentialJSON string
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

type TrustedDeviceOverview struct {
	Device                  TrustedDevice
	LastLoginAt             *time.Time
	LastLoginIP             string
	ActiveSessionCount      int
	LatestKeyShareEpoch     int
	LatestKeyShareUpdatedAt *time.Time
}

type AuthMode string

const (
	AuthModePasskey AuthMode = "passkey"
	AuthModeLANTOTP AuthMode = "lan_totp"
)

type AuthSettings struct {
	Mode                       AuthMode
	PasskeyOrigin              string
	TOTPSecret                 string
	TOTPConfirmedAt            *time.Time
	LANPassphraseVerifierB64   string
	LANPassphraseSaltB64       string
	LANPassphraseKDFName       string
	LANPassphraseKDFParamsJSON string
}

type Authority struct {
	AuthMode                AuthMode
	Label                   string
	PublicKeyOpenSSH        string
	ClassicPublicKeyOpenSSH string
	BackendShareB64         string
	EncryptedSeedB64        string
	KDFSaltB64              string
	NonceB64                string
	KDFName                 string
	KDFParamsJSON           string
	ActiveEpoch             int
}

type SSHUserKey struct {
	ID                string    `json:"id"`
	Label             string    `json:"label"`
	PublicKeyOpenSSH  string    `json:"public_key"`
	PrivateKeyOpenSSH string    `json:"-"`
	CreatedAt         time.Time `json:"created_at"`
	UpdatedAt         time.Time `json:"updated_at"`
}

type WebAuthnChallenge struct {
	ID             string
	Ceremony       string
	DeviceID       string
	Label          string
	Kind           domain.DeviceKind
	EnvelopeKeyB64 string
	SessionJSON    string
	ExpiresAt      time.Time
}

type DeviceRequestState string

const (
	DeviceRequestPending  DeviceRequestState = "pending"
	DeviceRequestApproved DeviceRequestState = "approved"
	DeviceRequestDenied   DeviceRequestState = "denied"
)

type KeyChangeApprovalState string

const (
	KeyChangeApprovalPending  KeyChangeApprovalState = "pending"
	KeyChangeApprovalApproved KeyChangeApprovalState = "approved"
	KeyChangeApprovalConsumed KeyChangeApprovalState = "consumed"
	KeyChangeApprovalDenied   KeyChangeApprovalState = "denied"
)

type DeviceKeyShare struct {
	DeviceID                string
	Epoch                   int
	EncryptedDeviceShareB64 string
	CreatedAt               time.Time
	UpdatedAt               time.Time
}

type DebugDeviceKeyShare struct {
	Epoch                   int
	EncryptedDeviceShareB64 string
	CreatedAt               time.Time
	UpdatedAt               time.Time
}

type PendingDeviceRequest struct {
	ID                       string
	PollTokenHash            string
	Label                    string
	Kind                     domain.DeviceKind
	DeviceID                 string
	CredentialID             string
	PublicKeyB64             string
	UserHandleB64            string
	CredentialJSON           string
	EnvelopePublicKeySPKIB64 string
	VerificationCode         string
	EncryptedDeviceShareB64  string
	State                    DeviceRequestState
	CreatedAt                time.Time
	ExpiresAt                time.Time
	DecidedAt                *time.Time
}

type KeyChangeApproval struct {
	ID                 string
	PollTokenHash      string
	ApprovedByDeviceID string
	VerificationCode   string
	State              KeyChangeApprovalState
	CreatedAt          time.Time
	ExpiresAt          time.Time
	DecidedAt          *time.Time
}
type WallpaperChoice string

const (
	WallpaperGarageEmpty  WallpaperChoice = "garage_empty"
	WallpaperGarageHotrod WallpaperChoice = "garage_hotrod"
	WallpaperCustom       WallpaperChoice = "custom"
)

type UISettings struct {
	WallpaperChoice            WallpaperChoice
	WallpaperDimPercent        int
	WallpaperOverridden        bool
	CustomWallpaperContentType string
	LocaleOverride             string
	TimezoneOverride           string
	TerminalFontSize           int
	TerminalScrollbackLines    int
	TerminalCursorStyle        string
	TerminalKeymapLayout       string
	TerminalSuppressKeyboard   bool
	TerminalTmuxPrefixGuard    bool
	DesktopControlHeightPX     int
	DesktopWindowPaddingPX     int
	DesktopTaskbarPaddingPX    int
	DesktopTaskbarPaddingYPX   int
	DesktopToolbarPaddingXPX   int
	DesktopToolbarPaddingYPX   int
	DesktopToastVisibleMS      int
	DesktopToastFadeMS         int
	UpdatedAt                  time.Time
}

type SSHSecuritySettings struct {
	AllowedSourceAddresses     []string
	CertTTLMinutes             int
	AccessTokenTTLMinutes      int
	LightStatusIntervalSeconds int
	DetectionIntervalSeconds   int
	PeriodicScriptTickSeconds  int
	UpdatedAt                  time.Time
}

type VulnerabilityUpdateMode string

const (
	VulnerabilityUpdateClientProxyManual      VulnerabilityUpdateMode = "client_proxy_manual"
	VulnerabilityUpdateBackendDirectScheduled VulnerabilityUpdateMode = "backend_direct_scheduled"
)

type VulnerabilitySettings struct {
	UpdateMode                   VulnerabilityUpdateMode
	BackendDirectIntervalHours   int
	BackendDirectFullRebuildDays int
	UpdatedAt                    time.Time
}

type BootstrapWindow struct {
	State     string
	StartedAt time.Time
	ExpiresAt time.Time
	Token     string
}

func OpenSQLite(path string) (*SQLiteStore, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	store := &SQLiteStore{db: db}
	if err := store.migrate(context.Background()); err != nil {
		db.Close()
		return nil, err
	}
	return store, nil
}

func (s *SQLiteStore) Close() error { return s.db.Close() }

func (s *SQLiteStore) migrate(ctx context.Context) error {
	statements := []string{
		`PRAGMA foreign_keys = ON`,
		`PRAGMA journal_mode = WAL`,
		`PRAGMA busy_timeout = 5000`,
		`CREATE TABLE IF NOT EXISTS trusted_devices (
			id TEXT PRIMARY KEY,
			label TEXT NOT NULL,
			kind TEXT NOT NULL,
			approved_at TEXT,
			credential_id TEXT NOT NULL UNIQUE,
			public_key_b64 TEXT NOT NULL,
			device_signing_public_key_spki_b64 TEXT NOT NULL DEFAULT '',
			envelope_public_key_spki_b64 TEXT NOT NULL,
			user_handle_b64 TEXT NOT NULL DEFAULT '',
			credential_json TEXT NOT NULL DEFAULT '',
			signer_epoch INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS webauthn_challenges (
			id TEXT PRIMARY KEY,
			ceremony TEXT NOT NULL,
			device_id TEXT NOT NULL,
			label TEXT NOT NULL,
			kind TEXT NOT NULL,
			envelope_public_key_spki_b64 TEXT NOT NULL DEFAULT '',
			session_json TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			consumed_at TEXT,
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS bootstrap_state (
			id TEXT PRIMARY KEY CHECK (id = 'singleton'),
			started_at TEXT NOT NULL,
			token TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE TABLE IF NOT EXISTS auth_sessions (
			id TEXT PRIMARY KEY,
			token_hash TEXT NOT NULL UNIQUE,
			device_id TEXT NOT NULL REFERENCES trusted_devices(id) ON DELETE CASCADE,
			expires_at TEXT NOT NULL,
			revoked_at TEXT,
			csrf_token_hash TEXT NOT NULL,
			client_ip TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS request_nonces (
			nonce TEXT PRIMARY KEY,
			device_id TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS auth_settings (
				id TEXT PRIMARY KEY CHECK (id = 'singleton'),
				mode TEXT NOT NULL,
				passkey_origin TEXT NOT NULL DEFAULT '',
				totp_secret TEXT NOT NULL DEFAULT '',
				totp_confirmed_at TEXT,
				lan_passphrase_verifier_b64 TEXT NOT NULL DEFAULT '',
				lan_passphrase_salt_b64 TEXT NOT NULL DEFAULT '',
				lan_passphrase_kdf_name TEXT NOT NULL DEFAULT '',
				lan_passphrase_kdf_params_json TEXT NOT NULL DEFAULT '',
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
		`CREATE TABLE IF NOT EXISTS ui_settings (
			id TEXT PRIMARY KEY CHECK (id = 'singleton'),
			wallpaper_choice TEXT NOT NULL,
			wallpaper_dim_percent INTEGER NOT NULL,
			wallpaper_overridden INTEGER NOT NULL DEFAULT 0,
			custom_wallpaper_content_type TEXT NOT NULL DEFAULT '',
			locale_override TEXT NOT NULL DEFAULT '',
			timezone_override TEXT NOT NULL DEFAULT '',
			terminal_font_size INTEGER NOT NULL DEFAULT 13,
			terminal_scrollback_lines INTEGER NOT NULL DEFAULT 5000,
			terminal_cursor_style TEXT NOT NULL DEFAULT 'underline',
			terminal_keymap_layout TEXT NOT NULL DEFAULT 'en',
			terminal_suppress_touch_keyboard INTEGER NOT NULL DEFAULT 0,
			terminal_tmux_prefix_guard INTEGER NOT NULL DEFAULT 1,
			desktop_control_height_px INTEGER NOT NULL DEFAULT 40,
			desktop_window_padding_px INTEGER NOT NULL DEFAULT 12,
			desktop_taskbar_padding_px INTEGER NOT NULL DEFAULT 10,
			desktop_taskbar_padding_y_px INTEGER NOT NULL DEFAULT 6,
			desktop_toolbar_padding_x_px INTEGER NOT NULL DEFAULT 12,
			desktop_toolbar_padding_y_px INTEGER NOT NULL DEFAULT 6,
			desktop_toast_visible_ms INTEGER NOT NULL DEFAULT 4000,
			desktop_toast_fade_ms INTEGER NOT NULL DEFAULT 1500,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS ssh_security_settings (
			id TEXT PRIMARY KEY CHECK (id = 'singleton'),
			allowed_source_addresses_json TEXT NOT NULL DEFAULT '[]',
			cert_ttl_minutes INTEGER NOT NULL DEFAULT 10,
			access_token_ttl_minutes INTEGER NOT NULL DEFAULT 60,
			light_status_interval_seconds INTEGER NOT NULL DEFAULT 5,
			detection_interval_seconds INTEGER NOT NULL DEFAULT 1800,
			periodic_script_tick_seconds INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS vulnerability_settings (
			id TEXT PRIMARY KEY CHECK (id = 'singleton'),
			update_mode TEXT NOT NULL DEFAULT 'backend_direct_scheduled',
			backend_direct_interval_hours INTEGER NOT NULL DEFAULT 24,
			backend_direct_full_rebuild_days INTEGER NOT NULL DEFAULT 30,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS key_authority (
				id TEXT PRIMARY KEY CHECK (id = 'singleton'),
				auth_mode TEXT NOT NULL DEFAULT 'passkey',
				label TEXT NOT NULL DEFAULT '',
				public_key_openssh TEXT NOT NULL,
			classic_public_key_openssh TEXT NOT NULL DEFAULT '',
			backend_share_b64 TEXT NOT NULL,
			encrypted_seed_b64 TEXT NOT NULL DEFAULT '',
			kdf_salt_b64 TEXT NOT NULL DEFAULT '',
			nonce_b64 TEXT NOT NULL DEFAULT '',
			kdf_name TEXT NOT NULL DEFAULT '',
			kdf_params_json TEXT NOT NULL DEFAULT '',
			active_epoch INTEGER NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS device_key_shares (
			device_id TEXT NOT NULL REFERENCES trusted_devices(id) ON DELETE CASCADE,
			epoch INTEGER NOT NULL,
			encrypted_device_share_b64 TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (device_id, epoch)
		)`,
		`CREATE TABLE IF NOT EXISTS debug_device_key_shares (
			epoch INTEGER PRIMARY KEY,
			encrypted_device_share_b64 TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS device_authorization_requests (
			id TEXT PRIMARY KEY,
			poll_token_hash TEXT NOT NULL UNIQUE,
			label TEXT NOT NULL,
			kind TEXT NOT NULL,
			device_id TEXT NOT NULL,
			credential_id TEXT NOT NULL,
			public_key_b64 TEXT NOT NULL,
			user_handle_b64 TEXT NOT NULL,
			credential_json TEXT NOT NULL,
			envelope_public_key_spki_b64 TEXT NOT NULL,
			verification_code TEXT NOT NULL,
			encrypted_device_share_b64 TEXT NOT NULL DEFAULT '',
			state TEXT NOT NULL,
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			decided_at TEXT
		)`,
		`CREATE TABLE IF NOT EXISTS key_change_approvals (
			id TEXT PRIMARY KEY,
			poll_token_hash TEXT NOT NULL UNIQUE,
			approved_by_device_id TEXT NOT NULL DEFAULT '',
			verification_code TEXT NOT NULL,
			state TEXT NOT NULL,
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			decided_at TEXT
		)`,
		`CREATE TABLE IF NOT EXISTS servers (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			host TEXT NOT NULL,
			port INTEGER NOT NULL,
			username TEXT NOT NULL,
			connection_mode TEXT NOT NULL DEFAULT 'direct',
			jump_server_id TEXT NOT NULL DEFAULT '',
			auth_method TEXT NOT NULL DEFAULT 'ca',
			ssh_key_id TEXT NOT NULL DEFAULT '',
			shell_hint TEXT NOT NULL,
			os_hint TEXT NOT NULL,
			distro_hint TEXT NOT NULL,
			detected_shell TEXT NOT NULL DEFAULT '',
			detected_os TEXT NOT NULL DEFAULT '',
			detected_distro TEXT NOT NULL DEFAULT '',
			detected_admin_rights TEXT NOT NULL DEFAULT '',
			detected_hostname TEXT NOT NULL DEFAULT '',
			detected_platform TEXT NOT NULL DEFAULT '',
			detected_platform_os TEXT NOT NULL DEFAULT '',
			detected_platform_arch TEXT NOT NULL DEFAULT '',
			detected_kernel_version TEXT NOT NULL DEFAULT '',
			detected_package_manager TEXT NOT NULL DEFAULT '',
			detected_ssh_max_sessions INTEGER NOT NULL DEFAULT 0,
			detected_pve_host INTEGER NOT NULL DEFAULT 0,
			detected_docker_host INTEGER NOT NULL DEFAULT 0,
			detected_apps_json TEXT NOT NULL DEFAULT '{}',
			override_shell TEXT NOT NULL DEFAULT '',
			override_os TEXT NOT NULL DEFAULT '',
			override_distro TEXT NOT NULL DEFAULT '',
			override_admin_rights TEXT NOT NULL DEFAULT '',
			host_key TEXT NOT NULL,
			tags_json TEXT NOT NULL,
			notes TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS ssh_user_keys (
			id TEXT PRIMARY KEY,
			label TEXT NOT NULL,
			public_key_openssh TEXT NOT NULL,
			private_key_openssh TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS server_statuses (
			server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
			state TEXT NOT NULL,
			telemetry_json TEXT NOT NULL,
			last_error TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS ssh_tunnels (
			id TEXT PRIMARY KEY,
			label TEXT NOT NULL UNIQUE,
			kind TEXT NOT NULL,
			server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
			bind_address TEXT NOT NULL,
			bind_port INTEGER NOT NULL,
			destination_host TEXT NOT NULL DEFAULT '',
			destination_port INTEGER NOT NULL DEFAULT 0,
			auto_start INTEGER NOT NULL DEFAULT 0,
			auto_reconnect INTEGER NOT NULL DEFAULT 1,
			pause_on_disconnect INTEGER NOT NULL DEFAULT 1,
			paused INTEGER NOT NULL DEFAULT 0,
			tags_json TEXT NOT NULL DEFAULT '[]',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS virtual_desktop_windows (
			server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
			window_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			title TEXT NOT NULL,
			x INTEGER NOT NULL,
			y INTEGER NOT NULL,
			width INTEGER NOT NULL,
			height INTEGER NOT NULL,
			minimized INTEGER NOT NULL DEFAULT 0,
			maximized INTEGER NOT NULL DEFAULT 0,
			z_index INTEGER NOT NULL DEFAULT 0,
			terminal_session_id TEXT NOT NULL DEFAULT '',
			metadata_json TEXT NOT NULL DEFAULT '{}',
			updated_at TEXT NOT NULL,
			PRIMARY KEY (server_id, window_id)
		)`,
		`CREATE TABLE IF NOT EXISTS virtual_desktop_states (
			server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
			wallpaper TEXT NOT NULL DEFAULT '',
			revision INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS virtual_desktop_wallpapers (
			id TEXT PRIMARY KEY,
			label TEXT NOT NULL,
			content_type TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'upload',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS terminal_sessions (
			id TEXT PRIMARY KEY,
			server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
			title TEXT NOT NULL,
			state TEXT NOT NULL,
			rows INTEGER NOT NULL,
			cols INTEGER NOT NULL,
			window_id TEXT NOT NULL,
			pane_id TEXT NOT NULL,
			bundle_dir TEXT NOT NULL,
			bridge_token TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS script_runs (
			id TEXT PRIMARY KEY,
			server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
			command TEXT NOT NULL,
			variant TEXT NOT NULL,
			state TEXT NOT NULL,
			result_json TEXT NOT NULL,
			error TEXT NOT NULL,
			created_at TEXT NOT NULL,
			finished_at TEXT
		)`,
		`CREATE TABLE IF NOT EXISTS backup_buckets (
			id TEXT PRIMARY KEY,
			label TEXT NOT NULL UNIQUE,
			server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
			root_path TEXT NOT NULL,
			bucket_path TEXT NOT NULL,
			filesystem TEXT NOT NULL DEFAULT '',
			free_bytes INTEGER NOT NULL DEFAULT 0,
			total_bytes INTEGER NOT NULL DEFAULT 0,
			manifest_status TEXT NOT NULL DEFAULT '',
			last_probe_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS backup_tasks (
			id TEXT PRIMARY KEY,
			label TEXT NOT NULL UNIQUE,
			source_server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
			source_path TEXT NOT NULL,
			source_kind TEXT NOT NULL DEFAULT '',
			source_file_count INTEGER NOT NULL DEFAULT 0,
			source_disk_bytes INTEGER NOT NULL DEFAULT 0,
			target_bucket_id TEXT NOT NULL REFERENCES backup_buckets(id) ON DELETE RESTRICT,
			fallback_bucket_id TEXT NOT NULL DEFAULT '',
			exclude_patterns TEXT NOT NULL DEFAULT '',
			compression TEXT NOT NULL DEFAULT 'zstd',
			rotation_json TEXT NOT NULL DEFAULT '{}',
			schedule_json TEXT NOT NULL DEFAULT '{}',
			last_run_id TEXT NOT NULL DEFAULT '',
			last_run_state TEXT NOT NULL DEFAULT '',
			last_success_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS backup_runs (
			id TEXT PRIMARY KEY,
			task_id TEXT NOT NULL REFERENCES backup_tasks(id) ON DELETE CASCADE,
			trigger TEXT NOT NULL,
			state TEXT NOT NULL,
			script_run_id TEXT NOT NULL DEFAULT '',
			log TEXT NOT NULL DEFAULT '',
			error TEXT NOT NULL DEFAULT '',
			archive_name TEXT NOT NULL DEFAULT '',
			archive_bytes INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			started_at TEXT NOT NULL,
			finished_at TEXT
		)`,
		`CREATE TABLE IF NOT EXISTS batch_script_templates (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			description TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 0,
			definition_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS batch_script_runs (
			id TEXT PRIMARY KEY,
			template_id TEXT NOT NULL,
			name_snapshot TEXT NOT NULL,
			requested_by_device_id TEXT NOT NULL,
			requested_by_session_id TEXT NOT NULL,
			trigger TEXT NOT NULL,
			state TEXT NOT NULL,
			target_count INTEGER NOT NULL DEFAULT 0,
			success_count INTEGER NOT NULL DEFAULT 0,
			failed_count INTEGER NOT NULL DEFAULT 0,
			skipped_count INTEGER NOT NULL DEFAULT 0,
			settings_snapshot_json TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL,
			started_at TEXT NOT NULL,
			finished_at TEXT
		)`,
		`CREATE TABLE IF NOT EXISTS batch_script_run_targets (
			run_id TEXT NOT NULL REFERENCES batch_script_runs(id) ON DELETE CASCADE,
			server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
			server_label_snapshot TEXT NOT NULL,
			variant_id TEXT NOT NULL,
			variant_selector_json TEXT NOT NULL DEFAULT '{}',
			state TEXT NOT NULL,
			exit_code INTEGER,
			stdout_preview TEXT NOT NULL DEFAULT '',
			stdout_truncated INTEGER NOT NULL DEFAULT 0,
			stdout_ref TEXT NOT NULL DEFAULT '',
			stdout_bytes INTEGER NOT NULL DEFAULT 0,
			stderr_preview TEXT NOT NULL DEFAULT '',
			stderr_truncated INTEGER NOT NULL DEFAULT 0,
			stderr_ref TEXT NOT NULL DEFAULT '',
			stderr_bytes INTEGER NOT NULL DEFAULT 0,
			error_message TEXT NOT NULL DEFAULT '',
			started_at TEXT,
			finished_at TEXT,
			PRIMARY KEY (run_id, server_id)
		)`,
		`CREATE TABLE IF NOT EXISTS batch_script_schedule_state (
			template_id TEXT PRIMARY KEY REFERENCES batch_script_templates(id) ON DELETE CASCADE,
			next_run_at TEXT,
			last_evaluated_at TEXT,
			last_started_run_id TEXT NOT NULL DEFAULT '',
			last_noop_at TEXT,
			last_noop_reason TEXT NOT NULL DEFAULT '',
			missed_run_count INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL
		)`,
	}
	for _, stmt := range statements {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	if err := s.ensureColumn(ctx, "trusted_devices", "user_handle_b64", `ALTER TABLE trusted_devices ADD COLUMN user_handle_b64 TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "trusted_devices", "credential_json", `ALTER TABLE trusted_devices ADD COLUMN credential_json TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "trusted_devices", "device_signing_public_key_spki_b64", `ALTER TABLE trusted_devices ADD COLUMN device_signing_public_key_spki_b64 TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "bootstrap_state", "token", `ALTER TABLE bootstrap_state ADD COLUMN token TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "webauthn_challenges", "envelope_public_key_spki_b64", `ALTER TABLE webauthn_challenges ADD COLUMN envelope_public_key_spki_b64 TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "auth_settings", "lan_passphrase_verifier_b64", `ALTER TABLE auth_settings ADD COLUMN lan_passphrase_verifier_b64 TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "auth_settings", "lan_passphrase_salt_b64", `ALTER TABLE auth_settings ADD COLUMN lan_passphrase_salt_b64 TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "auth_settings", "lan_passphrase_kdf_name", `ALTER TABLE auth_settings ADD COLUMN lan_passphrase_kdf_name TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "auth_settings", "lan_passphrase_kdf_params_json", `ALTER TABLE auth_settings ADD COLUMN lan_passphrase_kdf_params_json TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "key_authority", "auth_mode", `ALTER TABLE key_authority ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'passkey'`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "key_authority", "label", `ALTER TABLE key_authority ADD COLUMN label TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "key_authority", "classic_public_key_openssh", `ALTER TABLE key_authority ADD COLUMN classic_public_key_openssh TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "key_authority", "encrypted_seed_b64", `ALTER TABLE key_authority ADD COLUMN encrypted_seed_b64 TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "key_authority", "kdf_salt_b64", `ALTER TABLE key_authority ADD COLUMN kdf_salt_b64 TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "key_authority", "nonce_b64", `ALTER TABLE key_authority ADD COLUMN nonce_b64 TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "key_authority", "kdf_name", `ALTER TABLE key_authority ADD COLUMN kdf_name TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "key_authority", "kdf_params_json", `ALTER TABLE key_authority ADD COLUMN kdf_params_json TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "ui_settings", "custom_wallpaper_content_type", `ALTER TABLE ui_settings ADD COLUMN custom_wallpaper_content_type TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "ui_settings", "wallpaper_overridden", `ALTER TABLE ui_settings ADD COLUMN wallpaper_overridden INTEGER NOT NULL DEFAULT 0`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "virtual_desktop_states", "wallpaper", `ALTER TABLE virtual_desktop_states ADD COLUMN wallpaper TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "virtual_desktop_windows", "metadata_json", `ALTER TABLE virtual_desktop_windows ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "ui_settings", "locale_override", `ALTER TABLE ui_settings ADD COLUMN locale_override TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "ui_settings", "timezone_override", `ALTER TABLE ui_settings ADD COLUMN timezone_override TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "ui_settings", "terminal_font_size", `ALTER TABLE ui_settings ADD COLUMN terminal_font_size INTEGER NOT NULL DEFAULT 13`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "ui_settings", "terminal_scrollback_lines", `ALTER TABLE ui_settings ADD COLUMN terminal_scrollback_lines INTEGER NOT NULL DEFAULT 5000`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "ui_settings", "terminal_cursor_style", `ALTER TABLE ui_settings ADD COLUMN terminal_cursor_style TEXT NOT NULL DEFAULT 'underline'`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "ui_settings", "terminal_keymap_layout", `ALTER TABLE ui_settings ADD COLUMN terminal_keymap_layout TEXT NOT NULL DEFAULT 'en'`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "ui_settings", "terminal_suppress_touch_keyboard", `ALTER TABLE ui_settings ADD COLUMN terminal_suppress_touch_keyboard INTEGER NOT NULL DEFAULT 0`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "ui_settings", "terminal_tmux_prefix_guard", `ALTER TABLE ui_settings ADD COLUMN terminal_tmux_prefix_guard INTEGER NOT NULL DEFAULT 1`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "ui_settings", "desktop_control_height_px", `ALTER TABLE ui_settings ADD COLUMN desktop_control_height_px INTEGER NOT NULL DEFAULT 40`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "ui_settings", "desktop_window_padding_px", `ALTER TABLE ui_settings ADD COLUMN desktop_window_padding_px INTEGER NOT NULL DEFAULT 12`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "ui_settings", "desktop_taskbar_padding_px", `ALTER TABLE ui_settings ADD COLUMN desktop_taskbar_padding_px INTEGER NOT NULL DEFAULT 10`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "ui_settings", "desktop_taskbar_padding_y_px", `ALTER TABLE ui_settings ADD COLUMN desktop_taskbar_padding_y_px INTEGER NOT NULL DEFAULT 6`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "ui_settings", "desktop_toolbar_padding_x_px", `ALTER TABLE ui_settings ADD COLUMN desktop_toolbar_padding_x_px INTEGER NOT NULL DEFAULT 12`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "ui_settings", "desktop_toolbar_padding_y_px", `ALTER TABLE ui_settings ADD COLUMN desktop_toolbar_padding_y_px INTEGER NOT NULL DEFAULT 6`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "ui_settings", "desktop_toast_visible_ms", `ALTER TABLE ui_settings ADD COLUMN desktop_toast_visible_ms INTEGER NOT NULL DEFAULT 4000`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "ui_settings", "desktop_toast_fade_ms", `ALTER TABLE ui_settings ADD COLUMN desktop_toast_fade_ms INTEGER NOT NULL DEFAULT 1500`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "terminal_sessions", "bridge_token", `ALTER TABLE terminal_sessions ADD COLUMN bridge_token TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "ssh_security_settings", "cert_ttl_minutes", `ALTER TABLE ssh_security_settings ADD COLUMN cert_ttl_minutes INTEGER NOT NULL DEFAULT 10`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "ssh_security_settings", "access_token_ttl_minutes", `ALTER TABLE ssh_security_settings ADD COLUMN access_token_ttl_minutes INTEGER NOT NULL DEFAULT 60`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "ssh_security_settings", "light_status_interval_seconds", `ALTER TABLE ssh_security_settings ADD COLUMN light_status_interval_seconds INTEGER NOT NULL DEFAULT 5`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "ssh_security_settings", "detection_interval_seconds", `ALTER TABLE ssh_security_settings ADD COLUMN detection_interval_seconds INTEGER NOT NULL DEFAULT 1800`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "ssh_security_settings", "periodic_script_tick_seconds", `ALTER TABLE ssh_security_settings ADD COLUMN periodic_script_tick_seconds INTEGER NOT NULL DEFAULT 1`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "auth_sessions", "client_ip", `ALTER TABLE auth_sessions ADD COLUMN client_ip TEXT NOT NULL DEFAULT ''`); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "vulnerability_settings", "backend_direct_full_rebuild_days", `ALTER TABLE vulnerability_settings ADD COLUMN backend_direct_full_rebuild_days INTEGER NOT NULL DEFAULT 30`); err != nil {
		return err
	}
	for _, column := range []struct {
		name string
		stmt string
	}{
		{"connection_mode", `ALTER TABLE servers ADD COLUMN connection_mode TEXT NOT NULL DEFAULT 'direct'`},
		{"jump_server_id", `ALTER TABLE servers ADD COLUMN jump_server_id TEXT NOT NULL DEFAULT ''`},
		{"auth_method", `ALTER TABLE servers ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'ca'`},
		{"ssh_key_id", `ALTER TABLE servers ADD COLUMN ssh_key_id TEXT NOT NULL DEFAULT ''`},
		{"detected_shell", `ALTER TABLE servers ADD COLUMN detected_shell TEXT NOT NULL DEFAULT ''`},
		{"detected_os", `ALTER TABLE servers ADD COLUMN detected_os TEXT NOT NULL DEFAULT ''`},
		{"detected_distro", `ALTER TABLE servers ADD COLUMN detected_distro TEXT NOT NULL DEFAULT ''`},
		{"detected_admin_rights", `ALTER TABLE servers ADD COLUMN detected_admin_rights TEXT NOT NULL DEFAULT ''`},
		{"detected_hostname", `ALTER TABLE servers ADD COLUMN detected_hostname TEXT NOT NULL DEFAULT ''`},
		{"detected_platform", `ALTER TABLE servers ADD COLUMN detected_platform TEXT NOT NULL DEFAULT ''`},
		{"detected_platform_os", `ALTER TABLE servers ADD COLUMN detected_platform_os TEXT NOT NULL DEFAULT ''`},
		{"detected_platform_arch", `ALTER TABLE servers ADD COLUMN detected_platform_arch TEXT NOT NULL DEFAULT ''`},
		{"detected_kernel_version", `ALTER TABLE servers ADD COLUMN detected_kernel_version TEXT NOT NULL DEFAULT ''`},
		{"detected_package_manager", `ALTER TABLE servers ADD COLUMN detected_package_manager TEXT NOT NULL DEFAULT ''`},
		{"detected_ssh_max_sessions", `ALTER TABLE servers ADD COLUMN detected_ssh_max_sessions INTEGER NOT NULL DEFAULT 0`},
		{"detected_pve_host", `ALTER TABLE servers ADD COLUMN detected_pve_host INTEGER NOT NULL DEFAULT 0`},
		{"detected_docker_host", `ALTER TABLE servers ADD COLUMN detected_docker_host INTEGER NOT NULL DEFAULT 0`},
		{"detected_apps_json", `ALTER TABLE servers ADD COLUMN detected_apps_json TEXT NOT NULL DEFAULT '{}'`},
		{"override_shell", `ALTER TABLE servers ADD COLUMN override_shell TEXT NOT NULL DEFAULT ''`},
		{"override_os", `ALTER TABLE servers ADD COLUMN override_os TEXT NOT NULL DEFAULT ''`},
		{"override_distro", `ALTER TABLE servers ADD COLUMN override_distro TEXT NOT NULL DEFAULT ''`},
		{"override_admin_rights", `ALTER TABLE servers ADD COLUMN override_admin_rights TEXT NOT NULL DEFAULT ''`},
	} {
		if err := s.ensureColumn(ctx, "servers", column.name, column.stmt); err != nil {
			return err
		}
	}
	for _, column := range []struct {
		name string
		stmt string
	}{
		{"stdout_ref", `ALTER TABLE batch_script_run_targets ADD COLUMN stdout_ref TEXT NOT NULL DEFAULT ''`},
		{"stdout_bytes", `ALTER TABLE batch_script_run_targets ADD COLUMN stdout_bytes INTEGER NOT NULL DEFAULT 0`},
		{"stderr_ref", `ALTER TABLE batch_script_run_targets ADD COLUMN stderr_ref TEXT NOT NULL DEFAULT ''`},
		{"stderr_bytes", `ALTER TABLE batch_script_run_targets ADD COLUMN stderr_bytes INTEGER NOT NULL DEFAULT 0`},
	} {
		if err := s.ensureColumn(ctx, "batch_script_run_targets", column.name, column.stmt); err != nil {
			return err
		}
	}
	if err := s.normalizeCredentialIDEncoding(ctx); err != nil {
		return err
	}
	return nil
}

func (s *SQLiteStore) RememberRequestNonce(ctx context.Context, deviceID string, nonce string, ttl time.Duration) error {
	nonce = strings.TrimSpace(nonce)
	if nonce == "" {
		return fmt.Errorf("request nonce is required")
	}
	now := time.Now().UTC()
	_, _ = s.db.ExecContext(ctx, `DELETE FROM request_nonces WHERE expires_at <= ?`, formatTime(now))
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO request_nonces (nonce, device_id, expires_at, created_at)
		VALUES (?, ?, ?, ?)
	`, nonce, deviceID, formatTime(now.Add(ttl)), formatTime(now))
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "constraint") {
			return fmt.Errorf("request nonce was already used")
		}
		return err
	}
	return nil
}

func (s *SQLiteStore) ensureColumn(ctx context.Context, table string, column string, statement string) error {
	rows, err := s.db.QueryContext(ctx, `PRAGMA table_info(`+table+`)`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name string
		var typ string
		var notNull int
		var defaultValue sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &typ, &notNull, &defaultValue, &pk); err != nil {
			return err
		}
		if name == column {
			return rows.Err()
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, statement)
	return err
}

func (s *SQLiteStore) normalizeCredentialIDEncoding(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, `SELECT id, credential_id, credential_json FROM trusted_devices WHERE credential_json != ''`)
	if err != nil {
		return err
	}
	defer rows.Close()

	type update struct {
		deviceID     string
		credentialID string
	}
	var updates []update
	for rows.Next() {
		var deviceID string
		var storedID string
		var credentialJSON string
		if err := rows.Scan(&deviceID, &storedID, &credentialJSON); err != nil {
			return err
		}
		var credential struct {
			ID []byte `json:"id"`
		}
		if err := json.Unmarshal([]byte(credentialJSON), &credential); err != nil {
			return err
		}
		if len(credential.ID) == 0 {
			continue
		}
		canonicalID := base64.StdEncoding.EncodeToString(credential.ID)
		if storedID != canonicalID {
			updates = append(updates, update{deviceID: deviceID, credentialID: canonicalID})
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, item := range updates {
		if _, err := s.db.ExecContext(ctx, `UPDATE trusted_devices SET credential_id = ?, updated_at = ? WHERE id = ?`, item.credentialID, formatTime(time.Now().UTC()), item.deviceID); err != nil {
			return err
		}
	}
	return nil
}

func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func randomBootstrapToken() (string, error) {
	data := make([]byte, 16)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}

func (s *SQLiteStore) BootstrapWindow(ctx context.Context, timeout time.Duration) (BootstrapWindow, error) {
	now := time.Now().UTC()
	row := s.db.QueryRowContext(ctx, `SELECT started_at, token FROM bootstrap_state WHERE id = 'singleton'`)
	var startedRaw string
	var token string
	if err := row.Scan(&startedRaw, &token); err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return BootstrapWindow{}, err
		}
		generatedToken, err := randomBootstrapToken()
		if err != nil {
			return BootstrapWindow{}, err
		}
		startedRaw = formatTime(now)
		token = generatedToken
		if _, err := s.db.ExecContext(ctx, `INSERT INTO bootstrap_state (id, started_at, token) VALUES ('singleton', ?, ?)`, startedRaw, token); err != nil {
			return BootstrapWindow{}, err
		}
	}
	if strings.TrimSpace(token) == "" {
		generatedToken, err := randomBootstrapToken()
		if err != nil {
			return BootstrapWindow{}, err
		}
		token = generatedToken
		if _, err := s.db.ExecContext(ctx, `UPDATE bootstrap_state SET token = ? WHERE id = 'singleton'`, token); err != nil {
			return BootstrapWindow{}, err
		}
	}
	startedAt, err := time.Parse(time.RFC3339, startedRaw)
	if err != nil {
		return BootstrapWindow{}, err
	}
	expiresAt := startedAt.Add(timeout)
	state := "open"
	if now.After(expiresAt) {
		state = "expired"
	}
	return BootstrapWindow{State: state, StartedAt: startedAt, ExpiresAt: expiresAt, Token: token}, nil
}

func (s *SQLiteStore) ValidateBootstrapToken(ctx context.Context, token string, timeout time.Duration) (BootstrapWindow, bool, error) {
	window, err := s.BootstrapWindow(ctx, timeout)
	if err != nil {
		return BootstrapWindow{}, false, err
	}
	if window.State != "open" {
		return window, false, nil
	}
	provided := strings.TrimSpace(token)
	if provided == "" || strings.TrimSpace(window.Token) == "" {
		return window, false, nil
	}
	return window, subtle.ConstantTimeCompare([]byte(provided), []byte(window.Token)) == 1, nil
}

func (s *SQLiteStore) Authenticate(ctx context.Context, accessToken string) (*domain.Principal, string, error) {
	if accessToken == "" {
		return nil, "", ErrNotFound
	}
	row := s.db.QueryRowContext(ctx, `
		SELECT d.id, d.label, d.kind, a.csrf_token_hash, a.expires_at, a.revoked_at, d.approved_at
		FROM auth_sessions a
		JOIN trusted_devices d ON d.id = a.device_id
		WHERE a.token_hash = ?
	`, HashToken(accessToken))
	var principal domain.Principal
	var csrfHash string
	var expiresRaw string
	var revoked sql.NullString
	var approved sql.NullString
	if err := row.Scan(&principal.DeviceID, &principal.Label, &principal.Kind, &csrfHash, &expiresRaw, &revoked, &approved); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, "", ErrNotFound
		}
		return nil, "", err
	}
	expiresAt, err := time.Parse(time.RFC3339, expiresRaw)
	if err != nil {
		return nil, "", err
	}
	if time.Now().After(expiresAt) || revoked.Valid || !approved.Valid {
		return nil, "", ErrNotFound
	}
	return &principal, csrfHash, nil
}

func (s *SQLiteStore) RefreshSession(ctx context.Context, accessToken string, ttl time.Duration) error {
	if strings.TrimSpace(accessToken) == "" {
		return ErrNotFound
	}
	if ttl <= 0 {
		return fmt.Errorf("session idle timeout must be positive")
	}
	now := time.Now().UTC()
	result, err := s.db.ExecContext(ctx, `
		UPDATE auth_sessions
		SET expires_at = ?
		WHERE token_hash = ?
			AND revoked_at IS NULL
			AND expires_at > ?
	`, formatTime(now.Add(ttl)), HashToken(accessToken), formatTime(now))
	if err != nil {
		return err
	}
	updated, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if updated == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *SQLiteStore) CreateSession(ctx context.Context, deviceID string, accessToken string, csrfToken string, ttl time.Duration, clientIP string) error {
	if strings.TrimSpace(deviceID) == "" {
		return fmt.Errorf("device id is required")
	}
	now := time.Now().UTC()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO auth_sessions (id, token_hash, device_id, expires_at, csrf_token_hash, client_ip, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`, uuid.NewString(), HashToken(accessToken), deviceID, formatTime(now.Add(ttl)), HashToken(csrfToken), strings.TrimSpace(clientIP), formatTime(now))
	return err
}

func (s *SQLiteStore) RevokeSession(ctx context.Context, accessToken string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?`, time.Now().UTC().Format(time.RFC3339), HashToken(accessToken))
	return err
}

func (s *SQLiteStore) SaveWebAuthnChallenge(ctx context.Context, challenge WebAuthnChallenge) error {
	if challenge.ID == "" {
		challenge.ID = uuid.NewString()
	}
	if challenge.ExpiresAt.IsZero() {
		return fmt.Errorf("challenge expiry is required")
	}
	now := time.Now().UTC()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO webauthn_challenges (id, ceremony, device_id, label, kind, envelope_public_key_spki_b64, session_json, expires_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, challenge.ID, challenge.Ceremony, challenge.DeviceID, challenge.Label, string(challenge.Kind), challenge.EnvelopeKeyB64, challenge.SessionJSON, formatTime(challenge.ExpiresAt), formatTime(now))
	return err
}

func (s *SQLiteStore) ConsumeWebAuthnChallenge(ctx context.Context, id string, ceremony string) (WebAuthnChallenge, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, ceremony, device_id, label, kind, envelope_public_key_spki_b64, session_json, expires_at
		FROM webauthn_challenges
		WHERE id = ? AND ceremony = ? AND consumed_at IS NULL
	`, id, ceremony)
	var challenge WebAuthnChallenge
	var kindRaw string
	var expiresRaw string
	if err := row.Scan(&challenge.ID, &challenge.Ceremony, &challenge.DeviceID, &challenge.Label, &kindRaw, &challenge.EnvelopeKeyB64, &challenge.SessionJSON, &expiresRaw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return WebAuthnChallenge{}, ErrNotFound
		}
		return WebAuthnChallenge{}, err
	}
	expiresAt, err := time.Parse(time.RFC3339, expiresRaw)
	if err != nil {
		return WebAuthnChallenge{}, err
	}
	if time.Now().UTC().After(expiresAt) {
		return WebAuthnChallenge{}, ErrNotFound
	}
	challenge.Kind = domain.DeviceKind(kindRaw)
	challenge.ExpiresAt = expiresAt
	_, err = s.db.ExecContext(ctx, `UPDATE webauthn_challenges SET consumed_at = ? WHERE id = ?`, formatTime(time.Now().UTC()), id)
	if err != nil {
		return WebAuthnChallenge{}, err
	}
	return challenge, nil
}

func (s *SQLiteStore) SaveTrustedDevice(ctx context.Context, device TrustedDevice) error {
	if device.ID == "" {
		device.ID = uuid.NewString()
	}
	now := time.Now().UTC()
	approvedAt := sql.NullString{}
	if device.ApprovedAt != nil {
		approvedAt.Valid = true
		approvedAt.String = formatTime(*device.ApprovedAt)
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO trusted_devices (
			id, label, kind, approved_at, credential_id, public_key_b64,
			device_signing_public_key_spki_b64, envelope_public_key_spki_b64,
			user_handle_b64, credential_json, signer_epoch, created_at, updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, device.ID, device.Label, string(device.Kind), approvedAt, device.CredentialID, device.PublicKeyB64, device.SigningKeyB64, device.EnvelopeKeyB64, device.UserHandleB64, device.CredentialJSON, device.SignerEpoch, formatTime(now), formatTime(now))
	return err
}

func (s *SQLiteStore) ListTrustedDevices(ctx context.Context) ([]TrustedDevice, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, label, kind, approved_at, credential_id, public_key_b64,
			device_signing_public_key_spki_b64, envelope_public_key_spki_b64,
			signer_epoch, user_handle_b64, credential_json, created_at, updated_at
		FROM trusted_devices
		ORDER BY created_at
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var devices []TrustedDevice
	for rows.Next() {
		device, err := scanTrustedDevice(rows)
		if err != nil {
			return nil, err
		}
		devices = append(devices, device)
	}
	return devices, rows.Err()
}

func (s *SQLiteStore) ListTrustedDeviceOverviews(ctx context.Context) ([]TrustedDeviceOverview, error) {
	now := formatTime(time.Now().UTC())
	rows, err := s.db.QueryContext(ctx, `
		SELECT
			d.id, d.label, d.kind, d.approved_at, d.credential_id, d.public_key_b64,
			d.device_signing_public_key_spki_b64, d.envelope_public_key_spki_b64,
			d.signer_epoch, d.user_handle_b64, d.credential_json, d.created_at, d.updated_at,
			(SELECT MAX(a.created_at) FROM auth_sessions a WHERE a.device_id = d.id) AS last_login_at,
			(SELECT a.client_ip FROM auth_sessions a WHERE a.device_id = d.id ORDER BY a.created_at DESC LIMIT 1) AS last_login_ip,
			(SELECT COUNT(*) FROM auth_sessions a WHERE a.device_id = d.id AND a.revoked_at IS NULL AND a.expires_at > ?) AS active_session_count,
			COALESCE((SELECT MAX(s.epoch) FROM device_key_shares s WHERE s.device_id = d.id), 0) AS latest_key_share_epoch,
			(SELECT s.updated_at FROM device_key_shares s WHERE s.device_id = d.id ORDER BY s.epoch DESC LIMIT 1) AS latest_key_share_updated_at
		FROM trusted_devices d
		WHERE d.approved_at IS NOT NULL
		ORDER BY d.created_at
	`, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var overviews []TrustedDeviceOverview
	for rows.Next() {
		overview, err := scanTrustedDeviceOverview(rows)
		if err != nil {
			return nil, err
		}
		overviews = append(overviews, overview)
	}
	return overviews, rows.Err()
}

func (s *SQLiteStore) FirstApprovedDeviceID(ctx context.Context) (string, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id
		FROM trusted_devices
		WHERE approved_at IS NOT NULL
		ORDER BY created_at
		LIMIT 1
	`)
	var id string
	if err := row.Scan(&id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	return id, nil
}

func (s *SQLiteStore) GetTrustedDeviceByCredentialID(ctx context.Context, credentialID string) (TrustedDevice, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, label, kind, approved_at, credential_id, public_key_b64,
			device_signing_public_key_spki_b64, envelope_public_key_spki_b64,
			signer_epoch, user_handle_b64, credential_json, created_at, updated_at
		FROM trusted_devices
		WHERE credential_id = ?
	`, credentialID)
	return scanTrustedDevice(row)
}

func (s *SQLiteStore) GetTrustedDeviceByUserHandleB64(ctx context.Context, userHandleB64 string) (TrustedDevice, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, label, kind, approved_at, credential_id, public_key_b64,
			device_signing_public_key_spki_b64, envelope_public_key_spki_b64,
			signer_epoch, user_handle_b64, credential_json, created_at, updated_at
		FROM trusted_devices
		WHERE user_handle_b64 = ?
	`, userHandleB64)
	return scanTrustedDevice(row)
}

func (s *SQLiteStore) GetTrustedDeviceByID(ctx context.Context, id string) (TrustedDevice, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, label, kind, approved_at, credential_id, public_key_b64,
			device_signing_public_key_spki_b64, envelope_public_key_spki_b64,
			signer_epoch, user_handle_b64, credential_json, created_at, updated_at
		FROM trusted_devices
		WHERE id = ?
	`, id)
	return scanTrustedDevice(row)
}

func (s *SQLiteStore) UpdateTrustedDeviceCredential(ctx context.Context, deviceID string, credentialJSON string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE trusted_devices SET credential_json = ?, updated_at = ? WHERE id = ?`, credentialJSON, formatTime(time.Now().UTC()), deviceID)
	if err != nil {
		return err
	}
	count, _ := res.RowsAffected()
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *SQLiteStore) UpdateTrustedDeviceSigningKey(ctx context.Context, deviceID string, signingKeyB64 string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE trusted_devices SET device_signing_public_key_spki_b64 = ?, updated_at = ? WHERE id = ? AND approved_at IS NOT NULL`, strings.TrimSpace(signingKeyB64), formatTime(time.Now().UTC()), deviceID)
	if err != nil {
		return err
	}
	count, _ := res.RowsAffected()
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *SQLiteStore) UpdateTrustedDeviceEnvelopeKey(ctx context.Context, deviceID string, envelopeKeyB64 string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE trusted_devices SET envelope_public_key_spki_b64 = ?, updated_at = ? WHERE id = ? AND approved_at IS NOT NULL`, strings.TrimSpace(envelopeKeyB64), formatTime(time.Now().UTC()), deviceID)
	if err != nil {
		return err
	}
	count, _ := res.RowsAffected()
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *SQLiteStore) RevokeTrustedDevice(ctx context.Context, deviceID string) error {
	deviceID = strings.TrimSpace(deviceID)
	if deviceID == "" {
		return fmt.Errorf("device id is required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM request_nonces WHERE device_id = ?`, deviceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM auth_sessions WHERE device_id = ?`, deviceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM device_key_shares WHERE device_id = ?`, deviceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM webauthn_challenges WHERE device_id = ?`, deviceID); err != nil {
		return err
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM trusted_devices WHERE id = ? AND approved_at IS NOT NULL`, deviceID)
	if err != nil {
		return err
	}
	count, _ := res.RowsAffected()
	if count == 0 {
		return ErrNotFound
	}
	return tx.Commit()
}

func (s *SQLiteStore) CreateDeviceRequest(ctx context.Context, request PendingDeviceRequest) error {
	if request.ID == "" {
		request.ID = uuid.NewString()
	}
	if request.State == "" {
		request.State = DeviceRequestPending
	}
	if request.CreatedAt.IsZero() {
		request.CreatedAt = time.Now().UTC()
	}
	if request.ExpiresAt.IsZero() {
		return fmt.Errorf("device request expiry is required")
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO device_authorization_requests (
			id, poll_token_hash, label, kind, device_id, credential_id, public_key_b64,
			user_handle_b64, credential_json, envelope_public_key_spki_b64,
			verification_code, encrypted_device_share_b64, state, created_at, expires_at, decided_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, request.ID, request.PollTokenHash, request.Label, string(request.Kind), request.DeviceID, request.CredentialID, request.PublicKeyB64, request.UserHandleB64, request.CredentialJSON, request.EnvelopePublicKeySPKIB64, request.VerificationCode, request.EncryptedDeviceShareB64, string(request.State), formatTime(request.CreatedAt), formatTime(request.ExpiresAt), nullableTime(request.DecidedAt))
	return err
}

func (s *SQLiteStore) ListPendingDeviceRequests(ctx context.Context) ([]PendingDeviceRequest, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, poll_token_hash, label, kind, device_id, credential_id, public_key_b64,
			user_handle_b64, credential_json, envelope_public_key_spki_b64,
			verification_code, encrypted_device_share_b64, state, created_at, expires_at, decided_at
		FROM device_authorization_requests
		WHERE state = ? AND expires_at > ?
		ORDER BY created_at
	`, string(DeviceRequestPending), formatTime(time.Now().UTC()))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var requests []PendingDeviceRequest
	for rows.Next() {
		request, err := scanDeviceRequest(rows)
		if err != nil {
			return nil, err
		}
		requests = append(requests, request)
	}
	return requests, rows.Err()
}

func (s *SQLiteStore) GetDeviceRequest(ctx context.Context, id string) (PendingDeviceRequest, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, poll_token_hash, label, kind, device_id, credential_id, public_key_b64,
			user_handle_b64, credential_json, envelope_public_key_spki_b64,
			verification_code, encrypted_device_share_b64, state, created_at, expires_at, decided_at
		FROM device_authorization_requests
		WHERE id = ?
	`, id)
	return scanDeviceRequest(row)
}

func (s *SQLiteStore) GetDeviceRequestByPollToken(ctx context.Context, id string, pollToken string) (PendingDeviceRequest, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, poll_token_hash, label, kind, device_id, credential_id, public_key_b64,
			user_handle_b64, credential_json, envelope_public_key_spki_b64,
			verification_code, encrypted_device_share_b64, state, created_at, expires_at, decided_at
		FROM device_authorization_requests
		WHERE id = ? AND poll_token_hash = ?
	`, id, HashToken(pollToken))
	return scanDeviceRequest(row)
}

func (s *SQLiteStore) ApproveDeviceRequest(ctx context.Context, id string, encryptedDeviceShareB64 string, signerEpoch int) (PendingDeviceRequest, error) {
	request, err := s.GetDeviceRequest(ctx, id)
	if err != nil {
		return PendingDeviceRequest{}, err
	}
	if request.State != DeviceRequestPending || time.Now().UTC().After(request.ExpiresAt) {
		return PendingDeviceRequest{}, ErrNotFound
	}
	now := time.Now().UTC()
	approvedAt := now
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PendingDeviceRequest{}, err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `
		INSERT INTO trusted_devices (
			id, label, kind, approved_at, credential_id, public_key_b64,
			device_signing_public_key_spki_b64, envelope_public_key_spki_b64,
			user_handle_b64, credential_json, signer_epoch, created_at, updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, request.DeviceID, request.Label, string(request.Kind), formatTime(approvedAt), request.CredentialID, request.PublicKeyB64, "", request.EnvelopePublicKeySPKIB64, request.UserHandleB64, request.CredentialJSON, signerEpoch, formatTime(now), formatTime(now))
	if err != nil {
		return PendingDeviceRequest{}, err
	}
	_, err = tx.ExecContext(ctx, `
		UPDATE device_authorization_requests
		SET state = ?, encrypted_device_share_b64 = ?, decided_at = ?
		WHERE id = ? AND state = ?
	`, string(DeviceRequestApproved), encryptedDeviceShareB64, formatTime(now), id, string(DeviceRequestPending))
	if err != nil {
		return PendingDeviceRequest{}, err
	}
	if err := tx.Commit(); err != nil {
		return PendingDeviceRequest{}, err
	}
	return s.GetDeviceRequest(ctx, id)
}

func (s *SQLiteStore) DenyDeviceRequest(ctx context.Context, id string) error {
	now := time.Now().UTC()
	res, err := s.db.ExecContext(ctx, `
		UPDATE device_authorization_requests
		SET state = ?, decided_at = ?
		WHERE id = ? AND state = ?
	`, string(DeviceRequestDenied), formatTime(now), id, string(DeviceRequestPending))
	if err != nil {
		return err
	}
	count, _ := res.RowsAffected()
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *SQLiteStore) CreateKeyChangeApproval(ctx context.Context, approval KeyChangeApproval) error {
	if approval.ID == "" {
		approval.ID = uuid.NewString()
	}
	if strings.TrimSpace(approval.PollTokenHash) == "" {
		return fmt.Errorf("approval poll token is required")
	}
	if strings.TrimSpace(approval.VerificationCode) == "" {
		return fmt.Errorf("approval verification code is required")
	}
	if approval.State == "" {
		approval.State = KeyChangeApprovalPending
	}
	if approval.CreatedAt.IsZero() {
		approval.CreatedAt = time.Now().UTC()
	}
	if approval.ExpiresAt.IsZero() {
		return fmt.Errorf("key-change approval expiry is required")
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO key_change_approvals (
			id, poll_token_hash, approved_by_device_id, verification_code,
			state, created_at, expires_at, decided_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, approval.ID, strings.TrimSpace(approval.PollTokenHash), strings.TrimSpace(approval.ApprovedByDeviceID), strings.TrimSpace(approval.VerificationCode), string(approval.State), formatTime(approval.CreatedAt), formatTime(approval.ExpiresAt), nullableTime(approval.DecidedAt))
	return err
}

func (s *SQLiteStore) GetKeyChangeApproval(ctx context.Context, id string) (KeyChangeApproval, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, poll_token_hash, approved_by_device_id, verification_code, state, created_at, expires_at, decided_at
		FROM key_change_approvals
		WHERE id = ?
	`, strings.TrimSpace(id))
	return scanKeyChangeApproval(row)
}

func (s *SQLiteStore) GetKeyChangeApprovalByPollToken(ctx context.Context, id string, pollToken string) (KeyChangeApproval, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, poll_token_hash, approved_by_device_id, verification_code, state, created_at, expires_at, decided_at
		FROM key_change_approvals
		WHERE id = ? AND poll_token_hash = ?
	`, strings.TrimSpace(id), HashToken(strings.TrimSpace(pollToken)))
	return scanKeyChangeApproval(row)
}

func (s *SQLiteStore) ApproveKeyChangeApproval(ctx context.Context, id string, approvedByDeviceID string) (KeyChangeApproval, error) {
	approval, err := s.GetKeyChangeApproval(ctx, id)
	if err != nil {
		return KeyChangeApproval{}, err
	}
	if approval.State != KeyChangeApprovalPending || time.Now().UTC().After(approval.ExpiresAt) {
		return KeyChangeApproval{}, ErrNotFound
	}
	now := time.Now().UTC()
	res, err := s.db.ExecContext(ctx, `
		UPDATE key_change_approvals
		SET state = ?, approved_by_device_id = ?, decided_at = ?
		WHERE id = ? AND state = ? AND expires_at > ?
	`, string(KeyChangeApprovalApproved), strings.TrimSpace(approvedByDeviceID), formatTime(now), approval.ID, string(KeyChangeApprovalPending), formatTime(now))
	if err != nil {
		return KeyChangeApproval{}, err
	}
	count, _ := res.RowsAffected()
	if count == 0 {
		return KeyChangeApproval{}, ErrNotFound
	}
	return s.GetKeyChangeApproval(ctx, approval.ID)
}

func (s *SQLiteStore) ConsumeKeyChangeApproval(ctx context.Context, id string, pollToken string) (KeyChangeApproval, error) {
	approval, err := s.GetKeyChangeApprovalByPollToken(ctx, id, pollToken)
	if err != nil {
		return KeyChangeApproval{}, err
	}
	if approval.State != KeyChangeApprovalApproved || time.Now().UTC().After(approval.ExpiresAt) {
		return KeyChangeApproval{}, ErrNotFound
	}
	now := time.Now().UTC()
	res, err := s.db.ExecContext(ctx, `
		UPDATE key_change_approvals
		SET state = ?, decided_at = ?
		WHERE id = ? AND poll_token_hash = ? AND state = ? AND expires_at > ?
	`, string(KeyChangeApprovalConsumed), formatTime(now), approval.ID, approval.PollTokenHash, string(KeyChangeApprovalApproved), formatTime(now))
	if err != nil {
		return KeyChangeApproval{}, err
	}
	count, _ := res.RowsAffected()
	if count == 0 {
		return KeyChangeApproval{}, ErrNotFound
	}
	approval.State = KeyChangeApprovalConsumed
	approval.DecidedAt = &now
	return approval, nil
}

func (s *SQLiteStore) UpdateTrustedDeviceSignerEpoch(ctx context.Context, deviceID string, signerEpoch int) error {
	res, err := s.db.ExecContext(ctx, `UPDATE trusted_devices SET signer_epoch = ?, updated_at = ? WHERE id = ? AND approved_at IS NOT NULL`, signerEpoch, formatTime(time.Now().UTC()), deviceID)
	if err != nil {
		return err
	}
	count, _ := res.RowsAffected()
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *SQLiteStore) UpsertDeviceKeyShare(ctx context.Context, share DeviceKeyShare) error {
	if strings.TrimSpace(share.DeviceID) == "" {
		return fmt.Errorf("device id is required")
	}
	if share.Epoch <= 0 {
		return fmt.Errorf("key share epoch must be positive")
	}
	if strings.TrimSpace(share.EncryptedDeviceShareB64) == "" {
		return fmt.Errorf("encrypted device share is required")
	}
	now := time.Now().UTC()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO device_key_shares (device_id, epoch, encrypted_device_share_b64, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(device_id, epoch) DO UPDATE SET encrypted_device_share_b64 = excluded.encrypted_device_share_b64, updated_at = excluded.updated_at
	`, share.DeviceID, share.Epoch, strings.TrimSpace(share.EncryptedDeviceShareB64), formatTime(now), formatTime(now))
	if err != nil {
		return err
	}
	return s.UpdateTrustedDeviceSignerEpoch(ctx, share.DeviceID, share.Epoch)
}

func (s *SQLiteStore) GetDeviceKeyShare(ctx context.Context, deviceID string, epoch int) (DeviceKeyShare, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT device_id, epoch, encrypted_device_share_b64, created_at, updated_at
		FROM device_key_shares
		WHERE device_id = ? AND epoch = ?
	`, deviceID, epoch)
	return scanDeviceKeyShare(row)
}

func scanDeviceKeyShare(row serverScanner) (DeviceKeyShare, error) {
	var share DeviceKeyShare
	var createdRaw string
	var updatedRaw string
	if err := row.Scan(&share.DeviceID, &share.Epoch, &share.EncryptedDeviceShareB64, &createdRaw, &updatedRaw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return DeviceKeyShare{}, ErrNotFound
		}
		return DeviceKeyShare{}, err
	}
	createdAt, err := time.Parse(time.RFC3339, createdRaw)
	if err != nil {
		return DeviceKeyShare{}, err
	}
	updatedAt, err := time.Parse(time.RFC3339, updatedRaw)
	if err != nil {
		return DeviceKeyShare{}, err
	}
	share.CreatedAt = createdAt
	share.UpdatedAt = updatedAt
	return share, nil
}

func (s *SQLiteStore) UpsertDebugDeviceKeyShare(ctx context.Context, share DebugDeviceKeyShare) error {
	if share.Epoch <= 0 {
		return fmt.Errorf("debug key share epoch must be positive")
	}
	if strings.TrimSpace(share.EncryptedDeviceShareB64) == "" {
		return fmt.Errorf("encrypted debug device share is required")
	}
	now := time.Now().UTC()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO debug_device_key_shares (epoch, encrypted_device_share_b64, created_at, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(epoch) DO UPDATE SET encrypted_device_share_b64 = excluded.encrypted_device_share_b64, updated_at = excluded.updated_at
	`, share.Epoch, strings.TrimSpace(share.EncryptedDeviceShareB64), formatTime(now), formatTime(now))
	return err
}

func (s *SQLiteStore) GetDebugDeviceKeyShare(ctx context.Context, epoch int) (DebugDeviceKeyShare, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT epoch, encrypted_device_share_b64, created_at, updated_at
		FROM debug_device_key_shares
		WHERE epoch = ?
	`, epoch)
	var share DebugDeviceKeyShare
	var createdRaw string
	var updatedRaw string
	if err := row.Scan(&share.Epoch, &share.EncryptedDeviceShareB64, &createdRaw, &updatedRaw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return DebugDeviceKeyShare{}, ErrNotFound
		}
		return DebugDeviceKeyShare{}, err
	}
	createdAt, err := time.Parse(time.RFC3339, createdRaw)
	if err != nil {
		return DebugDeviceKeyShare{}, err
	}
	updatedAt, err := time.Parse(time.RFC3339, updatedRaw)
	if err != nil {
		return DebugDeviceKeyShare{}, err
	}
	share.CreatedAt = createdAt
	share.UpdatedAt = updatedAt
	return share, nil
}

func DefaultUISettings() UISettings {
	return UISettings{
		WallpaperChoice:          WallpaperGarageEmpty,
		WallpaperDimPercent:      64,
		WallpaperOverridden:      false,
		TerminalFontSize:         13,
		TerminalScrollbackLines:  5000,
		TerminalCursorStyle:      "underline",
		TerminalKeymapLayout:     "en",
		TerminalSuppressKeyboard: false,
		TerminalTmuxPrefixGuard:  true,
		DesktopControlHeightPX:   40,
		DesktopWindowPaddingPX:   12,
		DesktopTaskbarPaddingPX:  10,
		DesktopTaskbarPaddingYPX: 6,
		DesktopToolbarPaddingXPX: 12,
		DesktopToolbarPaddingYPX: 6,
		DesktopToastVisibleMS:    4000,
		DesktopToastFadeMS:       1500,
		UpdatedAt:                time.Now().UTC(),
	}
}

func (s *SQLiteStore) GetUISettings(ctx context.Context) (UISettings, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT wallpaper_choice, wallpaper_dim_percent, wallpaper_overridden, custom_wallpaper_content_type, locale_override, timezone_override,
		terminal_font_size, terminal_scrollback_lines, terminal_cursor_style, terminal_keymap_layout, terminal_suppress_touch_keyboard, terminal_tmux_prefix_guard,
		desktop_control_height_px, desktop_window_padding_px, desktop_taskbar_padding_px, desktop_taskbar_padding_y_px, desktop_toolbar_padding_x_px, desktop_toolbar_padding_y_px,
		desktop_toast_visible_ms, desktop_toast_fade_ms, updated_at
		FROM ui_settings
		WHERE id = 'singleton'
	`)
	var settings UISettings
	var choice string
	var wallpaperOverridden int
	var suppressTouchKeyboard int
	var tmuxPrefixGuard int
	var updatedRaw string
	if err := row.Scan(&choice, &settings.WallpaperDimPercent, &wallpaperOverridden, &settings.CustomWallpaperContentType, &settings.LocaleOverride, &settings.TimezoneOverride, &settings.TerminalFontSize, &settings.TerminalScrollbackLines, &settings.TerminalCursorStyle, &settings.TerminalKeymapLayout, &suppressTouchKeyboard, &tmuxPrefixGuard, &settings.DesktopControlHeightPX, &settings.DesktopWindowPaddingPX, &settings.DesktopTaskbarPaddingPX, &settings.DesktopTaskbarPaddingYPX, &settings.DesktopToolbarPaddingXPX, &settings.DesktopToolbarPaddingYPX, &settings.DesktopToastVisibleMS, &settings.DesktopToastFadeMS, &updatedRaw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			settings = DefaultUISettings()
			if err := s.SaveUISettings(ctx, settings); err != nil {
				return UISettings{}, err
			}
			return settings, nil
		}
		return UISettings{}, err
	}
	settings.WallpaperChoice = WallpaperChoice(choice)
	settings.WallpaperOverridden = wallpaperOverridden != 0
	settings.TerminalSuppressKeyboard = suppressTouchKeyboard != 0
	settings.TerminalTmuxPrefixGuard = tmuxPrefixGuard != 0
	updatedAt, err := time.Parse(time.RFC3339, updatedRaw)
	if err != nil {
		return UISettings{}, err
	}
	settings.UpdatedAt = updatedAt
	settings = normalizeUISettings(settings)
	return settings, nil
}

func (s *SQLiteStore) SaveUISettings(ctx context.Context, settings UISettings) error {
	settings = normalizeUISettings(settings)
	if err := ValidateUISettings(settings); err != nil {
		return err
	}
	now := time.Now().UTC()
	if settings.UpdatedAt.IsZero() {
		settings.UpdatedAt = now
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ui_settings (id, wallpaper_choice, wallpaper_dim_percent, wallpaper_overridden, custom_wallpaper_content_type, locale_override, timezone_override,
		terminal_font_size, terminal_scrollback_lines, terminal_cursor_style, terminal_keymap_layout, terminal_suppress_touch_keyboard, terminal_tmux_prefix_guard, desktop_control_height_px, desktop_window_padding_px, desktop_taskbar_padding_px, desktop_taskbar_padding_y_px, desktop_toolbar_padding_x_px, desktop_toolbar_padding_y_px, desktop_toast_visible_ms, desktop_toast_fade_ms, created_at, updated_at)
		VALUES ('singleton', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			wallpaper_choice = excluded.wallpaper_choice,
			wallpaper_dim_percent = excluded.wallpaper_dim_percent,
			wallpaper_overridden = excluded.wallpaper_overridden,
			custom_wallpaper_content_type = excluded.custom_wallpaper_content_type,
			locale_override = excluded.locale_override,
			timezone_override = excluded.timezone_override,
			terminal_font_size = excluded.terminal_font_size,
			terminal_scrollback_lines = excluded.terminal_scrollback_lines,
			terminal_cursor_style = excluded.terminal_cursor_style,
			terminal_keymap_layout = excluded.terminal_keymap_layout,
			terminal_suppress_touch_keyboard = excluded.terminal_suppress_touch_keyboard,
			terminal_tmux_prefix_guard = excluded.terminal_tmux_prefix_guard,
			desktop_control_height_px = excluded.desktop_control_height_px,
			desktop_window_padding_px = excluded.desktop_window_padding_px,
			desktop_taskbar_padding_px = excluded.desktop_taskbar_padding_px,
			desktop_taskbar_padding_y_px = excluded.desktop_taskbar_padding_y_px,
			desktop_toolbar_padding_x_px = excluded.desktop_toolbar_padding_x_px,
			desktop_toolbar_padding_y_px = excluded.desktop_toolbar_padding_y_px,
			desktop_toast_visible_ms = excluded.desktop_toast_visible_ms,
			desktop_toast_fade_ms = excluded.desktop_toast_fade_ms,
			updated_at = excluded.updated_at
	`, string(settings.WallpaperChoice), settings.WallpaperDimPercent, boolInt(settings.WallpaperOverridden), strings.TrimSpace(settings.CustomWallpaperContentType), strings.TrimSpace(settings.LocaleOverride), strings.TrimSpace(settings.TimezoneOverride), settings.TerminalFontSize, settings.TerminalScrollbackLines, strings.TrimSpace(settings.TerminalCursorStyle), strings.TrimSpace(settings.TerminalKeymapLayout), boolInt(settings.TerminalSuppressKeyboard), boolInt(settings.TerminalTmuxPrefixGuard), settings.DesktopControlHeightPX, settings.DesktopWindowPaddingPX, settings.DesktopTaskbarPaddingPX, settings.DesktopTaskbarPaddingYPX, settings.DesktopToolbarPaddingXPX, settings.DesktopToolbarPaddingYPX, settings.DesktopToastVisibleMS, settings.DesktopToastFadeMS, formatTime(now), formatTime(settings.UpdatedAt))
	return err
}

func ValidateUISettings(settings UISettings) error {
	switch settings.WallpaperChoice {
	case WallpaperGarageEmpty, WallpaperGarageHotrod, WallpaperCustom:
	default:
		return fmt.Errorf("unsupported wallpaper choice %q", settings.WallpaperChoice)
	}
	if settings.WallpaperDimPercent < 0 || settings.WallpaperDimPercent > 95 {
		return fmt.Errorf("wallpaper dim percent must be between 0 and 95")
	}
	if !validLocaleOverride(settings.LocaleOverride) {
		return fmt.Errorf("locale override must be a valid browser locale tag such as en-US or uk-UA")
	}
	if strings.TrimSpace(settings.TimezoneOverride) != "" {
		if _, err := time.LoadLocation(strings.TrimSpace(settings.TimezoneOverride)); err != nil {
			return fmt.Errorf("timezone override must be an IANA timezone such as Europe/Kyiv or America/New_York")
		}
	}
	if settings.TerminalFontSize < 8 || settings.TerminalFontSize > 28 {
		return fmt.Errorf("terminal font size must be between 8 and 28")
	}
	if settings.TerminalScrollbackLines < 200 || settings.TerminalScrollbackLines > 50000 {
		return fmt.Errorf("terminal scrollback must be between 200 and 50000 lines")
	}
	if settings.DesktopControlHeightPX < 32 || settings.DesktopControlHeightPX > 48 {
		return fmt.Errorf("desktop app control height must be between 32 and 48 pixels")
	}
	if settings.DesktopWindowPaddingPX < 0 || settings.DesktopWindowPaddingPX > 24 {
		return fmt.Errorf("desktop app window padding must be between 0 and 24 pixels")
	}
	if settings.DesktopTaskbarPaddingPX < 0 || settings.DesktopTaskbarPaddingPX > 16 {
		return fmt.Errorf("desktop taskbar horizontal padding must be between 0 and 16 pixels")
	}
	if settings.DesktopTaskbarPaddingYPX < 0 || settings.DesktopTaskbarPaddingYPX > 12 {
		return fmt.Errorf("desktop taskbar vertical padding must be between 0 and 12 pixels")
	}
	if settings.DesktopToolbarPaddingXPX < 0 || settings.DesktopToolbarPaddingXPX > 24 {
		return fmt.Errorf("desktop app toolbar horizontal padding must be between 0 and 24 pixels")
	}
	if settings.DesktopToolbarPaddingYPX < 0 || settings.DesktopToolbarPaddingYPX > 16 {
		return fmt.Errorf("desktop app toolbar vertical padding must be between 0 and 16 pixels")
	}
	if settings.DesktopToastVisibleMS < 1000 || settings.DesktopToastVisibleMS > 30000 {
		return fmt.Errorf("desktop toast visible time must be between 1000 and 30000 milliseconds")
	}
	if settings.DesktopToastFadeMS < 250 || settings.DesktopToastFadeMS > 5000 {
		return fmt.Errorf("desktop toast dissolve time must be between 250 and 5000 milliseconds")
	}
	switch strings.TrimSpace(settings.TerminalCursorStyle) {
	case "block", "underline", "bar":
	default:
		return fmt.Errorf("terminal cursor style must be block, underline, or bar")
	}
	switch strings.TrimSpace(settings.TerminalKeymapLayout) {
	case "en", "ru":
	default:
		return fmt.Errorf("terminal keymap layout must be en or ru")
	}
	return nil
}

func normalizeUISettings(settings UISettings) UISettings {
	if settings.TerminalFontSize == 0 {
		settings.TerminalFontSize = 13
	}
	if settings.TerminalScrollbackLines == 0 {
		settings.TerminalScrollbackLines = 5000
	}
	if strings.TrimSpace(settings.TerminalCursorStyle) == "" || strings.TrimSpace(settings.TerminalCursorStyle) == "block" {
		settings.TerminalCursorStyle = "underline"
	}
	if strings.TrimSpace(settings.TerminalKeymapLayout) == "" {
		settings.TerminalKeymapLayout = "en"
	}
	if settings.DesktopControlHeightPX == 0 {
		settings.DesktopControlHeightPX = 40
	}
	if settings.DesktopToastVisibleMS == 0 {
		settings.DesktopToastVisibleMS = 4000
	}
	if settings.DesktopToastFadeMS == 0 {
		settings.DesktopToastFadeMS = 1500
	}
	settings.TerminalCursorStyle = strings.TrimSpace(settings.TerminalCursorStyle)
	settings.TerminalKeymapLayout = strings.TrimSpace(settings.TerminalKeymapLayout)
	return settings
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func validLocaleOverride(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" {
		return true
	}
	if len(value) > 64 {
		return false
	}
	hasLetter := false
	for _, r := range value {
		switch {
		case r >= 'A' && r <= 'Z':
			hasLetter = true
		case r >= 'a' && r <= 'z':
			hasLetter = true
		case r >= '0' && r <= '9':
		case r == '-' || r == '_':
		default:
			return false
		}
	}
	return hasLetter
}

func DefaultSSHSecuritySettings() SSHSecuritySettings {
	return SSHSecuritySettings{
		AllowedSourceAddresses:     []string{},
		CertTTLMinutes:             10,
		AccessTokenTTLMinutes:      60,
		LightStatusIntervalSeconds: 5,
		DetectionIntervalSeconds:   1800,
		PeriodicScriptTickSeconds:  1,
		UpdatedAt:                  time.Now().UTC(),
	}
}

func (s *SQLiteStore) GetSSHSecuritySettings(ctx context.Context) (SSHSecuritySettings, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT allowed_source_addresses_json, cert_ttl_minutes, access_token_ttl_minutes, light_status_interval_seconds, detection_interval_seconds, periodic_script_tick_seconds, updated_at
		FROM ssh_security_settings
		WHERE id = 'singleton'
	`)
	var settings SSHSecuritySettings
	var addressesRaw string
	var updatedRaw string
	if err := row.Scan(
		&addressesRaw,
		&settings.CertTTLMinutes,
		&settings.AccessTokenTTLMinutes,
		&settings.LightStatusIntervalSeconds,
		&settings.DetectionIntervalSeconds,
		&settings.PeriodicScriptTickSeconds,
		&updatedRaw,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			settings = DefaultSSHSecuritySettings()
			if err := s.SaveSSHSecuritySettings(ctx, settings); err != nil {
				return SSHSecuritySettings{}, err
			}
			return settings, nil
		}
		return SSHSecuritySettings{}, err
	}
	if err := json.Unmarshal([]byte(addressesRaw), &settings.AllowedSourceAddresses); err != nil {
		return SSHSecuritySettings{}, err
	}
	updatedAt, err := time.Parse(time.RFC3339, updatedRaw)
	if err != nil {
		return SSHSecuritySettings{}, err
	}
	settings.UpdatedAt = updatedAt
	if settings.AllowedSourceAddresses == nil {
		settings.AllowedSourceAddresses = []string{}
	}
	if settings.CertTTLMinutes <= 0 {
		settings.CertTTLMinutes = 10
	}
	if settings.AccessTokenTTLMinutes <= 0 {
		settings.AccessTokenTTLMinutes = 60
	}
	if settings.LightStatusIntervalSeconds <= 0 {
		settings.LightStatusIntervalSeconds = 5
	}
	if settings.DetectionIntervalSeconds <= 0 {
		settings.DetectionIntervalSeconds = 1800
	}
	if settings.PeriodicScriptTickSeconds <= 0 {
		settings.PeriodicScriptTickSeconds = 1
	}
	return settings, nil
}

func (s *SQLiteStore) SaveSSHSecuritySettings(ctx context.Context, settings SSHSecuritySettings) error {
	if settings.AllowedSourceAddresses == nil {
		settings.AllowedSourceAddresses = []string{}
	}
	if settings.CertTTLMinutes < 1 || settings.CertTTLMinutes > 1440 {
		return fmt.Errorf("SSH certificate TTL must be between 1 and 1440 minutes")
	}
	if settings.AccessTokenTTLMinutes < 1 || settings.AccessTokenTTLMinutes > 1440 {
		return fmt.Errorf("sign-in session timeout must be between 1 and 1440 minutes")
	}
	if settings.LightStatusIntervalSeconds < 2 || settings.LightStatusIntervalSeconds > 3600 {
		return fmt.Errorf("light status interval must be between 2 and 3600 seconds")
	}
	if settings.DetectionIntervalSeconds < 60 || settings.DetectionIntervalSeconds > 86400 {
		return fmt.Errorf("detection interval must be between 60 and 86400 seconds")
	}
	if settings.PeriodicScriptTickSeconds < 1 || settings.PeriodicScriptTickSeconds > 60 {
		return fmt.Errorf("scheduler tick interval must be between 1 and 60 seconds")
	}
	addressesJSON, err := json.Marshal(settings.AllowedSourceAddresses)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	if settings.UpdatedAt.IsZero() {
		settings.UpdatedAt = now
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO ssh_security_settings (
			id,
			allowed_source_addresses_json,
			cert_ttl_minutes,
			access_token_ttl_minutes,
			light_status_interval_seconds,
			detection_interval_seconds,
			periodic_script_tick_seconds,
			created_at,
			updated_at
		)
		VALUES ('singleton', ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			allowed_source_addresses_json = excluded.allowed_source_addresses_json,
			cert_ttl_minutes = excluded.cert_ttl_minutes,
			access_token_ttl_minutes = excluded.access_token_ttl_minutes,
			light_status_interval_seconds = excluded.light_status_interval_seconds,
			detection_interval_seconds = excluded.detection_interval_seconds,
			periodic_script_tick_seconds = excluded.periodic_script_tick_seconds,
			updated_at = excluded.updated_at
	`,
		string(addressesJSON),
		settings.CertTTLMinutes,
		settings.AccessTokenTTLMinutes,
		settings.LightStatusIntervalSeconds,
		settings.DetectionIntervalSeconds,
		settings.PeriodicScriptTickSeconds,
		formatTime(now),
		formatTime(settings.UpdatedAt),
	)
	return err
}

func DefaultVulnerabilitySettings() VulnerabilitySettings {
	return VulnerabilitySettings{
		UpdateMode:                   VulnerabilityUpdateBackendDirectScheduled,
		BackendDirectIntervalHours:   24,
		BackendDirectFullRebuildDays: 30,
		UpdatedAt:                    time.Now().UTC(),
	}
}

func (s *SQLiteStore) GetVulnerabilitySettings(ctx context.Context) (VulnerabilitySettings, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT update_mode, backend_direct_interval_hours, backend_direct_full_rebuild_days, updated_at
		FROM vulnerability_settings
		WHERE id = 'singleton'
	`)
	var settings VulnerabilitySettings
	var modeRaw string
	var updatedRaw string
	if err := row.Scan(&modeRaw, &settings.BackendDirectIntervalHours, &settings.BackendDirectFullRebuildDays, &updatedRaw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			settings = DefaultVulnerabilitySettings()
			if err := s.SaveVulnerabilitySettings(ctx, settings); err != nil {
				return VulnerabilitySettings{}, err
			}
			return settings, nil
		}
		return VulnerabilitySettings{}, err
	}
	settings.UpdateMode = VulnerabilityUpdateMode(strings.TrimSpace(modeRaw))
	updatedAt, err := time.Parse(time.RFC3339, updatedRaw)
	if err != nil {
		return VulnerabilitySettings{}, err
	}
	settings.UpdatedAt = updatedAt
	settings = normalizeVulnerabilitySettings(settings)
	return settings, nil
}

func (s *SQLiteStore) SaveVulnerabilitySettings(ctx context.Context, settings VulnerabilitySettings) error {
	settings = normalizeVulnerabilitySettings(settings)
	if err := ValidateVulnerabilitySettings(settings); err != nil {
		return err
	}
	now := time.Now().UTC()
	if settings.UpdatedAt.IsZero() {
		settings.UpdatedAt = now
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO vulnerability_settings (
			id,
			update_mode,
			backend_direct_interval_hours,
			backend_direct_full_rebuild_days,
			created_at,
			updated_at
		)
		VALUES ('singleton', ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			update_mode = excluded.update_mode,
			backend_direct_interval_hours = excluded.backend_direct_interval_hours,
			backend_direct_full_rebuild_days = excluded.backend_direct_full_rebuild_days,
			updated_at = excluded.updated_at
	`,
		string(settings.UpdateMode),
		settings.BackendDirectIntervalHours,
		settings.BackendDirectFullRebuildDays,
		formatTime(now),
		formatTime(settings.UpdatedAt),
	)
	return err
}

func ValidateVulnerabilitySettings(settings VulnerabilitySettings) error {
	switch settings.UpdateMode {
	case VulnerabilityUpdateClientProxyManual, VulnerabilityUpdateBackendDirectScheduled:
	default:
		return fmt.Errorf("unsupported vulnerability database update mode %q", settings.UpdateMode)
	}
	if settings.BackendDirectIntervalHours < 1 || settings.BackendDirectIntervalHours > 168 {
		return fmt.Errorf("vulnerability database direct update interval must be between 1 and 168 hours")
	}
	if settings.BackendDirectFullRebuildDays < 1 || settings.BackendDirectFullRebuildDays > 365 {
		return fmt.Errorf("vulnerability database full rebuild interval must be between 1 and 365 days")
	}
	return nil
}

func normalizeVulnerabilitySettings(settings VulnerabilitySettings) VulnerabilitySettings {
	if strings.TrimSpace(string(settings.UpdateMode)) == "" {
		settings.UpdateMode = VulnerabilityUpdateBackendDirectScheduled
	}
	if settings.BackendDirectIntervalHours <= 0 {
		settings.BackendDirectIntervalHours = 24
	}
	if settings.BackendDirectFullRebuildDays <= 0 {
		settings.BackendDirectFullRebuildDays = 30
	}
	return settings
}

func (s *SQLiteStore) GetAuthSettings(ctx context.Context) (*AuthSettings, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT mode, passkey_origin, totp_secret, totp_confirmed_at,
			lan_passphrase_verifier_b64, lan_passphrase_salt_b64,
			lan_passphrase_kdf_name, lan_passphrase_kdf_params_json
		FROM auth_settings
		WHERE id = 'singleton'
	`)
	var settings AuthSettings
	var modeRaw string
	var confirmedRaw sql.NullString
	if err := row.Scan(&modeRaw, &settings.PasskeyOrigin, &settings.TOTPSecret, &confirmedRaw, &settings.LANPassphraseVerifierB64, &settings.LANPassphraseSaltB64, &settings.LANPassphraseKDFName, &settings.LANPassphraseKDFParamsJSON); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	settings.Mode = AuthMode(modeRaw)
	if confirmedRaw.Valid {
		confirmedAt, err := time.Parse(time.RFC3339, confirmedRaw.String)
		if err != nil {
			return nil, err
		}
		settings.TOTPConfirmedAt = &confirmedAt
	}
	return &settings, nil
}

func (s *SQLiteStore) SaveAuthSettings(ctx context.Context, settings AuthSettings) error {
	if settings.Mode == "" {
		return fmt.Errorf("auth mode is required")
	}
	now := time.Now().UTC()
	confirmedAt := sql.NullString{}
	if settings.TOTPConfirmedAt != nil {
		confirmedAt.Valid = true
		confirmedAt.String = formatTime(*settings.TOTPConfirmedAt)
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO auth_settings (
			id, mode, passkey_origin, totp_secret, totp_confirmed_at,
			lan_passphrase_verifier_b64, lan_passphrase_salt_b64,
			lan_passphrase_kdf_name, lan_passphrase_kdf_params_json,
			created_at, updated_at
		)
		VALUES ('singleton', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			mode = excluded.mode,
			passkey_origin = excluded.passkey_origin,
			totp_secret = excluded.totp_secret,
			totp_confirmed_at = excluded.totp_confirmed_at,
			lan_passphrase_verifier_b64 = excluded.lan_passphrase_verifier_b64,
			lan_passphrase_salt_b64 = excluded.lan_passphrase_salt_b64,
			lan_passphrase_kdf_name = excluded.lan_passphrase_kdf_name,
			lan_passphrase_kdf_params_json = excluded.lan_passphrase_kdf_params_json,
			updated_at = excluded.updated_at
	`, string(settings.Mode), settings.PasskeyOrigin, settings.TOTPSecret, confirmedAt, settings.LANPassphraseVerifierB64, settings.LANPassphraseSaltB64, settings.LANPassphraseKDFName, settings.LANPassphraseKDFParamsJSON, formatTime(now), formatTime(now))
	return err
}

func (s *SQLiteStore) GetAuthority(ctx context.Context) (*Authority, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT auth_mode, label, public_key_openssh, classic_public_key_openssh, backend_share_b64, encrypted_seed_b64,
			kdf_salt_b64, nonce_b64, kdf_name, kdf_params_json, active_epoch
		FROM key_authority
		WHERE id = 'singleton'
	`)
	var authority Authority
	var modeRaw string
	if err := row.Scan(
		&modeRaw,
		&authority.Label,
		&authority.PublicKeyOpenSSH,
		&authority.ClassicPublicKeyOpenSSH,
		&authority.BackendShareB64,
		&authority.EncryptedSeedB64,
		&authority.KDFSaltB64,
		&authority.NonceB64,
		&authority.KDFName,
		&authority.KDFParamsJSON,
		&authority.ActiveEpoch,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	authority.AuthMode = AuthMode(modeRaw)
	if authority.AuthMode == "" {
		authority.AuthMode = AuthModePasskey
	}
	return &authority, nil
}

func (s *SQLiteStore) SaveAuthority(ctx context.Context, authority Authority) error {
	if authority.AuthMode == "" {
		authority.AuthMode = AuthModePasskey
	}
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := s.db.ExecContext(ctx, `
			INSERT INTO key_authority (
				id, auth_mode, label, public_key_openssh, classic_public_key_openssh, backend_share_b64, encrypted_seed_b64,
				kdf_salt_b64, nonce_b64, kdf_name, kdf_params_json, active_epoch,
				created_at, updated_at
			)
			VALUES ('singleton', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				auth_mode = excluded.auth_mode,
				label = excluded.label,
				public_key_openssh = excluded.public_key_openssh,
			classic_public_key_openssh = excluded.classic_public_key_openssh,
			backend_share_b64 = excluded.backend_share_b64,
			encrypted_seed_b64 = excluded.encrypted_seed_b64,
			kdf_salt_b64 = excluded.kdf_salt_b64,
			nonce_b64 = excluded.nonce_b64,
			kdf_name = excluded.kdf_name,
			kdf_params_json = excluded.kdf_params_json,
			active_epoch = excluded.active_epoch,
			updated_at = excluded.updated_at
	`, string(authority.AuthMode), strings.TrimSpace(authority.Label), authority.PublicKeyOpenSSH, authority.ClassicPublicKeyOpenSSH, authority.BackendShareB64, authority.EncryptedSeedB64, authority.KDFSaltB64, authority.NonceB64, authority.KDFName, authority.KDFParamsJSON, authority.ActiveEpoch, now, now)
	return err
}

func (s *SQLiteStore) ListSSHUserKeys(ctx context.Context) ([]SSHUserKey, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, label, public_key_openssh, private_key_openssh, created_at, updated_at FROM ssh_user_keys ORDER BY label`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var keys []SSHUserKey
	for rows.Next() {
		key, err := scanSSHUserKey(rows)
		if err != nil {
			return nil, err
		}
		keys = append(keys, key)
	}
	return keys, rows.Err()
}

func (s *SQLiteStore) GetSSHUserKey(ctx context.Context, id string) (SSHUserKey, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, label, public_key_openssh, private_key_openssh, created_at, updated_at FROM ssh_user_keys WHERE id = ?`, strings.TrimSpace(id))
	return scanSSHUserKey(row)
}

func (s *SQLiteStore) CreateSSHUserKey(ctx context.Context, label string, publicKeyOpenSSH string, privateKeyOpenSSH string) (SSHUserKey, error) {
	label = strings.TrimSpace(label)
	publicKeyOpenSSH = strings.TrimSpace(publicKeyOpenSSH)
	privateKeyOpenSSH = strings.TrimSpace(privateKeyOpenSSH)
	if label == "" {
		label = "Imported SSH key"
	}
	if publicKeyOpenSSH == "" {
		return SSHUserKey{}, fmt.Errorf("public key is required")
	}
	if privateKeyOpenSSH == "" {
		return SSHUserKey{}, fmt.Errorf("private key is required")
	}
	now := time.Now().UTC()
	key := SSHUserKey{ID: uuid.NewString(), Label: label, PublicKeyOpenSSH: publicKeyOpenSSH, PrivateKeyOpenSSH: privateKeyOpenSSH, CreatedAt: now, UpdatedAt: now}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO ssh_user_keys (id, label, public_key_openssh, private_key_openssh, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`, key.ID, key.Label, key.PublicKeyOpenSSH, key.PrivateKeyOpenSSH, formatTime(key.CreatedAt), formatTime(key.UpdatedAt))
	return key, err
}

func (s *SQLiteStore) ListServers(ctx context.Context) ([]domain.Server, error) {
	rows, err := s.db.QueryContext(ctx, serverSelectColumns+` ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var servers []domain.Server
	for rows.Next() {
		server, err := scanServer(rows)
		if err != nil {
			return nil, err
		}
		servers = append(servers, server)
	}
	return servers, rows.Err()
}

func (s *SQLiteStore) GetServer(ctx context.Context, id string) (domain.Server, error) {
	row := s.db.QueryRowContext(ctx, serverSelectColumns+` WHERE id = ?`, id)
	return scanServer(row)
}

func (s *SQLiteStore) CreateServer(ctx context.Context, input domain.ServerInput) (domain.Server, error) {
	server, err := normalizeServerInput(input)
	if err != nil {
		return domain.Server{}, err
	}
	now := time.Now().UTC()
	server.ID = uuid.NewString()
	server.CreatedAt = now
	server.UpdatedAt = now
	tags, _ := json.Marshal(server.Tags)
	apps, _ := json.Marshal(server.DetectedApps)
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO servers (
			id, name, host, port, username, connection_mode, jump_server_id, auth_method, ssh_key_id,
			shell_hint, os_hint, distro_hint, detected_shell, detected_os, detected_distro, detected_admin_rights,
			detected_hostname, detected_platform, detected_platform_os, detected_platform_arch, detected_kernel_version,
			detected_package_manager, detected_ssh_max_sessions, detected_pve_host, detected_docker_host, detected_apps_json,
			override_shell, override_os, override_distro, override_admin_rights,
			host_key, tags_json, notes, created_at, updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
		server.ID, server.Name, server.Host, server.Port, server.Username, server.ConnectionMode, server.JumpServerID, server.AuthMethod, server.SSHKeyID,
		server.ShellHint, server.OSHint, server.DistroHint, server.DetectedShell, server.DetectedOS, server.DetectedDistro, server.DetectedAdminRights,
		server.DetectedHostname, server.DetectedPlatform, server.DetectedPlatformOS, server.DetectedPlatformArch, server.DetectedKernelVersion,
		server.DetectedPackageManager, nonNegativeInt(server.DetectedSSHMaxSessions), boolInt(server.DetectedPVEHost), boolInt(server.DetectedDockerHost), string(apps),
		server.OverrideShell, server.OverrideOS, server.OverrideDistro, server.OverrideAdminRights,
		server.HostKey, string(tags), server.Notes, formatTime(server.CreatedAt), formatTime(server.UpdatedAt))
	return server, err
}

func (s *SQLiteStore) UpdateServer(ctx context.Context, id string, input domain.ServerInput) (domain.Server, error) {
	server, err := normalizeServerInput(input)
	if err != nil {
		return domain.Server{}, err
	}
	existing, err := s.GetServer(ctx, id)
	if err != nil {
		return domain.Server{}, err
	}
	server.ID = id
	server.CreatedAt = existing.CreatedAt
	if existing.Host == server.Host && existing.Port == server.Port && existing.Username == server.Username && existing.AuthMethod == server.AuthMethod && existing.SSHKeyID == server.SSHKeyID {
		server.DetectedShell = existing.DetectedShell
		server.DetectedOS = existing.DetectedOS
		server.DetectedDistro = existing.DetectedDistro
		server.DetectedAdminRights = existing.DetectedAdminRights
		server.DetectedHostname = existing.DetectedHostname
		server.DetectedPlatform = existing.DetectedPlatform
		server.DetectedPlatformOS = existing.DetectedPlatformOS
		server.DetectedPlatformArch = existing.DetectedPlatformArch
		server.DetectedKernelVersion = existing.DetectedKernelVersion
		server.DetectedPackageManager = existing.DetectedPackageManager
		server.DetectedSSHMaxSessions = existing.DetectedSSHMaxSessions
		server.DetectedPVEHost = existing.DetectedPVEHost
		server.DetectedDockerHost = existing.DetectedDockerHost
		server.DetectedApps = existing.DetectedApps
		server.ShellHint = existing.ShellHint
		server.OSHint = existing.OSHint
		server.DistroHint = existing.DistroHint
	}
	applyServerOverrides(&server)
	server.UpdatedAt = time.Now().UTC()
	tags, _ := json.Marshal(server.Tags)
	apps, _ := json.Marshal(server.DetectedApps)
	_, err = s.db.ExecContext(ctx, `
		UPDATE servers
		SET name = ?, host = ?, port = ?, username = ?, connection_mode = ?, jump_server_id = ?, auth_method = ?, ssh_key_id = ?,
			shell_hint = ?, os_hint = ?, distro_hint = ?, detected_shell = ?, detected_os = ?, detected_distro = ?, detected_admin_rights = ?,
			detected_hostname = ?, detected_platform = ?, detected_platform_os = ?, detected_platform_arch = ?, detected_kernel_version = ?,
			detected_package_manager = ?, detected_ssh_max_sessions = ?, detected_pve_host = ?, detected_docker_host = ?, detected_apps_json = ?,
			override_shell = ?, override_os = ?, override_distro = ?, override_admin_rights = ?,
			host_key = ?, tags_json = ?, notes = ?, updated_at = ?
		WHERE id = ?
	`,
		server.Name, server.Host, server.Port, server.Username, server.ConnectionMode, server.JumpServerID, server.AuthMethod, server.SSHKeyID,
		server.ShellHint, server.OSHint, server.DistroHint, server.DetectedShell, server.DetectedOS, server.DetectedDistro, server.DetectedAdminRights,
		server.DetectedHostname, server.DetectedPlatform, server.DetectedPlatformOS, server.DetectedPlatformArch, server.DetectedKernelVersion,
		server.DetectedPackageManager, nonNegativeInt(server.DetectedSSHMaxSessions), boolInt(server.DetectedPVEHost), boolInt(server.DetectedDockerHost), string(apps),
		server.OverrideShell, server.OverrideOS, server.OverrideDistro, server.OverrideAdminRights,
		server.HostKey, string(tags), server.Notes, formatTime(server.UpdatedAt), id)
	return server, err
}

func (s *SQLiteStore) UpdateServerDetectedFacts(ctx context.Context, id string, facts domain.ServerFacts) error {
	server, err := s.GetServer(ctx, id)
	if err != nil {
		return err
	}
	shell, osName, distro, adminRights := normalizeDetectedFacts(facts.Shell, facts.OS, facts.Distro, facts.AdminRights)
	server.DetectedShell = shell
	server.DetectedOS = osName
	server.DetectedDistro = distro
	server.DetectedAdminRights = adminRights
	server.DetectedHostname = sanitizeDetectedFact(facts.Hostname)
	server.DetectedPlatform = sanitizeDetectedLabel(facts.Platform, 96)
	server.DetectedPlatformOS = sanitizeDetectedFact(facts.PlatformOS)
	server.DetectedPlatformArch = sanitizeDetectedFact(facts.PlatformArch)
	server.DetectedKernelVersion = sanitizeDetectedLabel(facts.KernelVersion, 128)
	server.DetectedPackageManager = sanitizeDetectedFact(facts.PackageManager)
	server.DetectedSSHMaxSessions = nonNegativeInt(facts.SSHMaxSessions)
	server.DetectedPVEHost = facts.IsPVEHost
	server.DetectedDockerHost = facts.IsDockerHost
	server.DetectedApps = normalizeDetectedApps(facts.Apps)
	applyServerOverrides(&server)
	apps, _ := json.Marshal(server.DetectedApps)
	result, err := s.db.ExecContext(ctx, `
		UPDATE servers
		SET shell_hint = ?, os_hint = ?, distro_hint = ?, detected_shell = ?, detected_os = ?, detected_distro = ?, detected_admin_rights = ?,
			detected_hostname = ?, detected_platform = ?, detected_platform_os = ?, detected_platform_arch = ?, detected_kernel_version = ?,
			detected_package_manager = ?, detected_ssh_max_sessions = ?, detected_pve_host = ?, detected_docker_host = ?, detected_apps_json = ?, updated_at = ?
		WHERE id = ?
	`, server.ShellHint, server.OSHint, server.DistroHint, server.DetectedShell, server.DetectedOS, server.DetectedDistro, server.DetectedAdminRights,
		server.DetectedHostname, server.DetectedPlatform, server.DetectedPlatformOS, server.DetectedPlatformArch, server.DetectedKernelVersion,
		server.DetectedPackageManager, nonNegativeInt(server.DetectedSSHMaxSessions), boolInt(server.DetectedPVEHost), boolInt(server.DetectedDockerHost), string(apps), formatTime(time.Now().UTC()), id)
	if err != nil {
		return err
	}
	count, _ := result.RowsAffected()
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *SQLiteStore) MarkServerDetectedApp(ctx context.Context, id string, appName string, installed bool) error {
	server, err := s.GetServer(ctx, id)
	if err != nil {
		return err
	}
	apps := normalizeDetectedApps(server.DetectedApps)
	appName = sanitizeDetectedFact(appName)
	if appName == "" {
		return fmt.Errorf("detected app name is required")
	}
	apps[appName] = installed
	encoded, _ := json.Marshal(apps)
	result, err := s.db.ExecContext(ctx, `UPDATE servers SET detected_apps_json = ?, updated_at = ? WHERE id = ?`, string(encoded), formatTime(time.Now().UTC()), id)
	if err != nil {
		return err
	}
	count, _ := result.RowsAffected()
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *SQLiteStore) UpdateServerHostKey(ctx context.Context, id string, hostKey string) (domain.Server, error) {
	hostKey = strings.TrimSpace(hostKey)
	if hostKey == "" {
		return domain.Server{}, fmt.Errorf("server host key is required")
	}
	server, err := s.GetServer(ctx, id)
	if err != nil {
		return domain.Server{}, err
	}
	server.HostKey = hostKey
	server.UpdatedAt = time.Now().UTC()
	result, err := s.db.ExecContext(ctx, `
		UPDATE servers
		SET host_key = ?, updated_at = ?
		WHERE id = ?
	`, server.HostKey, formatTime(server.UpdatedAt), id)
	if err != nil {
		return domain.Server{}, err
	}
	count, _ := result.RowsAffected()
	if count == 0 {
		return domain.Server{}, ErrNotFound
	}
	return server, nil
}

func (s *SQLiteStore) DeleteServer(ctx context.Context, id string) error {
	result, err := s.db.ExecContext(ctx, `DELETE FROM servers WHERE id = ?`, id)
	if err != nil {
		return err
	}
	count, _ := result.RowsAffected()
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *SQLiteStore) ListStatuses(ctx context.Context) ([]domain.ServerStatus, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT server_id, state, telemetry_json, last_error, updated_at FROM server_statuses ORDER BY updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var statuses []domain.ServerStatus
	for rows.Next() {
		status, err := scanStatus(rows)
		if err != nil {
			return nil, err
		}
		statuses = append(statuses, status)
	}
	return statuses, rows.Err()
}

func (s *SQLiteStore) UpsertStatus(ctx context.Context, status domain.ServerStatus) error {
	if status.UpdatedAt.IsZero() {
		status.UpdatedAt = time.Now().UTC()
	}
	if status.Telemetry == nil {
		status.Telemetry = map[string]any{}
	}
	if status.State != domain.StatusConnected {
		clearVolatileStatusTelemetry(status.Telemetry)
	}
	row := s.db.QueryRowContext(ctx, `SELECT telemetry_json FROM server_statuses WHERE server_id = ?`, status.ServerID)
	var existingRaw string
	if err := row.Scan(&existingRaw); err == nil {
		var existing map[string]any
		if json.Unmarshal([]byte(existingRaw), &existing) == nil {
			for key, value := range existing {
				if _, exists := status.Telemetry[key]; !exists {
					status.Telemetry[key] = value
				}
			}
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	telemetry, _ := json.Marshal(status.Telemetry)
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO server_statuses (server_id, state, telemetry_json, last_error, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(server_id) DO UPDATE SET state = excluded.state, telemetry_json = excluded.telemetry_json, last_error = excluded.last_error, updated_at = excluded.updated_at
	`, status.ServerID, status.State, string(telemetry), status.LastError, formatTime(status.UpdatedAt))
	return err
}

func clearVolatileStatusTelemetry(telemetry map[string]any) {
	for key, value := range map[string]any{
		"cpu_usage_percent":                nil,
		"cpu_metric_source":                "",
		"cpu_usage_history":                nil,
		"cpu_usage_history_connection_key": "",
		"cpu_usage_history_updated_at":     "",
		"cpu_total_jiffies":                nil,
		"cpu_idle_jiffies":                 nil,
		"cpu_sample_interval_seconds":      nil,
		"load1":                            nil,
		"load5":                            nil,
		"load15":                           nil,
		"uptime_sec":                       nil,
		"mem_total_bytes":                  nil,
		"mem_available_bytes":              nil,
		"filesystems":                      nil,
		"last_status_started_at":           "",
		"last_status_finished_at":          "",
		"last_status_result":               "",
		"status_error":                     "",
		"telemetry_error":                  "",
	} {
		telemetry[key] = value
	}
}

func (s *SQLiteStore) ListSSHTunnels(ctx context.Context) ([]domain.SSHTunnelProfile, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, label, kind, server_id, bind_address, bind_port, destination_host, destination_port, auto_start, auto_reconnect, pause_on_disconnect, paused, tags_json, created_at, updated_at FROM ssh_tunnels ORDER BY label ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tunnels := []domain.SSHTunnelProfile{}
	for rows.Next() {
		tunnel, err := scanSSHTunnel(rows)
		if err != nil {
			return nil, err
		}
		tunnels = append(tunnels, tunnel)
	}
	return tunnels, rows.Err()
}

func (s *SQLiteStore) GetSSHTunnel(ctx context.Context, id string) (domain.SSHTunnelProfile, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, label, kind, server_id, bind_address, bind_port, destination_host, destination_port, auto_start, auto_reconnect, pause_on_disconnect, paused, tags_json, created_at, updated_at FROM ssh_tunnels WHERE id = ?`, strings.TrimSpace(id))
	return scanSSHTunnel(row)
}

func (s *SQLiteStore) CreateSSHTunnel(ctx context.Context, input domain.SSHTunnelInput) (domain.SSHTunnelProfile, error) {
	tunnel, err := normalizeSSHTunnelInput(input)
	if err != nil {
		return domain.SSHTunnelProfile{}, err
	}
	now := time.Now().UTC()
	tunnel.ID = uuid.NewString()
	tunnel.CreatedAt = now
	tunnel.UpdatedAt = now
	tagsJSON, _ := json.Marshal(tunnel.Tags)
	err = sqliteWithBusyRetry(ctx, func() error {
		_, err := s.db.ExecContext(ctx, `INSERT INTO ssh_tunnels (id, label, kind, server_id, bind_address, bind_port, destination_host, destination_port, auto_start, auto_reconnect, pause_on_disconnect, paused, tags_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			tunnel.ID, tunnel.Label, tunnel.Kind, tunnel.ServerID, tunnel.BindAddress, tunnel.BindPort, tunnel.DestinationHost, tunnel.DestinationPort, intBoolValue(tunnel.AutoStart), intBoolValue(tunnel.AutoReconnect), intBoolValue(tunnel.PauseOnDisconnect), intBoolValue(tunnel.Paused), string(tagsJSON), formatTime(tunnel.CreatedAt), formatTime(tunnel.UpdatedAt))
		return err
	})
	return tunnel, err
}

func (s *SQLiteStore) UpdateSSHTunnel(ctx context.Context, id string, input domain.SSHTunnelInput) (domain.SSHTunnelProfile, error) {
	var tunnel domain.SSHTunnelProfile
	err := sqliteWithBusyRetry(ctx, func() error {
		existing, err := s.GetSSHTunnel(ctx, id)
		if err != nil {
			return err
		}
		next, err := normalizeSSHTunnelInput(input)
		if err != nil {
			return err
		}
		next.ID = existing.ID
		next.CreatedAt = existing.CreatedAt
		next.UpdatedAt = time.Now().UTC()
		tagsJSON, _ := json.Marshal(next.Tags)
		result, err := s.db.ExecContext(ctx, `UPDATE ssh_tunnels SET label = ?, kind = ?, server_id = ?, bind_address = ?, bind_port = ?, destination_host = ?, destination_port = ?, auto_start = ?, auto_reconnect = ?, pause_on_disconnect = ?, paused = ?, tags_json = ?, updated_at = ? WHERE id = ?`,
			next.Label, next.Kind, next.ServerID, next.BindAddress, next.BindPort, next.DestinationHost, next.DestinationPort, intBoolValue(next.AutoStart), intBoolValue(next.AutoReconnect), intBoolValue(next.PauseOnDisconnect), intBoolValue(next.Paused), string(tagsJSON), formatTime(next.UpdatedAt), next.ID)
		if err != nil {
			return err
		}
		count, _ := result.RowsAffected()
		if count == 0 {
			return ErrNotFound
		}
		tunnel = next
		return nil
	})
	return tunnel, err
}

func (s *SQLiteStore) UpdateSSHTunnelPaused(ctx context.Context, id string, paused bool) (domain.SSHTunnelProfile, error) {
	now := time.Now().UTC()
	var tunnel domain.SSHTunnelProfile
	err := sqliteWithBusyRetry(ctx, func() error {
		result, err := s.db.ExecContext(ctx, `UPDATE ssh_tunnels SET paused = ?, updated_at = ? WHERE id = ?`, intBoolValue(paused), formatTime(now), strings.TrimSpace(id))
		if err != nil {
			return err
		}
		count, _ := result.RowsAffected()
		if count == 0 {
			return ErrNotFound
		}
		tunnel, err = s.GetSSHTunnel(ctx, id)
		return err
	})
	return tunnel, err
}

func (s *SQLiteStore) DeleteSSHTunnel(ctx context.Context, id string) error {
	return sqliteWithBusyRetry(ctx, func() error {
		result, err := s.db.ExecContext(ctx, `DELETE FROM ssh_tunnels WHERE id = ?`, strings.TrimSpace(id))
		if err != nil {
			return err
		}
		count, _ := result.RowsAffected()
		if count == 0 {
			return ErrNotFound
		}
		return nil
	})
}

func (s *SQLiteStore) GetVirtualDesktopState(ctx context.Context, serverID string) (domain.VirtualDesktopState, error) {
	if _, err := s.GetServer(ctx, serverID); err != nil {
		return domain.VirtualDesktopState{}, err
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT window_id, kind, title, x, y, width, height, minimized, maximized, z_index, terminal_session_id, metadata_json, updated_at
		FROM virtual_desktop_windows
		WHERE server_id = ?
		ORDER BY rowid ASC
	`, serverID)
	if err != nil {
		return domain.VirtualDesktopState{}, err
	}
	defer rows.Close()
	state := domain.VirtualDesktopState{ServerID: serverID, Windows: []domain.VirtualDesktopWindow{}, UpdatedAt: time.Now().UTC()}
	var maxWindowUpdatedAt time.Time
	for rows.Next() {
		var window domain.VirtualDesktopWindow
		var minimized int
		var maximized int
		var metadataRaw string
		var updatedRaw string
		if err := rows.Scan(&window.ID, &window.Kind, &window.Title, &window.X, &window.Y, &window.Width, &window.Height, &minimized, &maximized, &window.ZIndex, &window.TerminalSessionID, &metadataRaw, &updatedRaw); err != nil {
			return domain.VirtualDesktopState{}, err
		}
		window.Minimized = intBool(minimized)
		window.Maximized = intBool(maximized)
		window.Metadata = decodeVirtualDesktopWindowMetadata(metadataRaw)
		restoreVirtualDesktopWindowIdentity(&window)
		if updatedAt, err := time.Parse(time.RFC3339, updatedRaw); err == nil && updatedAt.After(maxWindowUpdatedAt) {
			maxWindowUpdatedAt = updatedAt
		}
		state.Windows = append(state.Windows, normalizeVirtualDesktopWindow(window, len(state.Windows)))
	}
	if err := rows.Err(); err != nil {
		return domain.VirtualDesktopState{}, err
	}
	var updatedRaw string
	err = s.db.QueryRowContext(ctx, `SELECT wallpaper, revision, updated_at FROM virtual_desktop_states WHERE server_id = ?`, serverID).Scan(&state.Wallpaper, &state.Revision, &updatedRaw)
	switch {
	case err == nil:
		state.Wallpaper = sanitizeVirtualDesktopWallpaper(state.Wallpaper)
		if updatedAt, parseErr := time.Parse(time.RFC3339, updatedRaw); parseErr == nil {
			state.UpdatedAt = updatedAt
		}
	case errors.Is(err, sql.ErrNoRows):
		if !maxWindowUpdatedAt.IsZero() {
			state.UpdatedAt = maxWindowUpdatedAt
		}
	default:
		return domain.VirtualDesktopState{}, err
	}
	return state, nil
}

func (s *SQLiteStore) SaveVirtualDesktopWindows(ctx context.Context, serverID string, windows []domain.VirtualDesktopWindow, expectedRevision *int64) (domain.VirtualDesktopState, error) {
	return s.SaveVirtualDesktopState(ctx, serverID, windows, nil, expectedRevision)
}

func (s *SQLiteStore) SaveVirtualDesktopState(ctx context.Context, serverID string, windows []domain.VirtualDesktopWindow, wallpaper *string, expectedRevision *int64) (domain.VirtualDesktopState, error) {
	var lastErr error
	for attempt := 0; attempt < sqliteBusyRetryAttempts; attempt++ {
		state, err := s.saveVirtualDesktopStateOnce(ctx, serverID, windows, wallpaper, expectedRevision)
		if err == nil {
			return state, nil
		}
		if !sqliteBusyError(err) {
			return domain.VirtualDesktopState{}, err
		}
		lastErr = err
		timer := time.NewTimer(time.Duration(attempt+1) * 120 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return domain.VirtualDesktopState{}, ctx.Err()
		case <-timer.C:
		}
	}
	return domain.VirtualDesktopState{}, lastErr
}

func (s *SQLiteStore) saveVirtualDesktopStateOnce(ctx context.Context, serverID string, windows []domain.VirtualDesktopWindow, wallpaper *string, expectedRevision *int64) (domain.VirtualDesktopState, error) {
	if _, err := s.GetServer(ctx, serverID); err != nil {
		return domain.VirtualDesktopState{}, err
	}
	now := time.Now().UTC()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.VirtualDesktopState{}, err
	}
	defer tx.Rollback()
	currentRevision, err := virtualDesktopRevisionInTx(ctx, tx, serverID)
	if err != nil {
		return domain.VirtualDesktopState{}, err
	}
	currentWallpaper, err := virtualDesktopWallpaperInTx(ctx, tx, serverID)
	if err != nil {
		return domain.VirtualDesktopState{}, err
	}
	nextWallpaper := currentWallpaper
	if wallpaper != nil {
		nextWallpaper = sanitizeVirtualDesktopWallpaper(*wallpaper)
		if customID, ok := virtualDesktopCustomWallpaperID(nextWallpaper); ok {
			exists, err := virtualDesktopWallpaperExistsInTx(ctx, tx, customID)
			if err != nil {
				return domain.VirtualDesktopState{}, err
			}
			if !exists {
				return domain.VirtualDesktopState{}, fmt.Errorf("custom virtual desktop wallpaper is not available")
			}
		}
	}
	if expectedRevision != nil && *expectedRevision != currentRevision {
		_ = tx.Rollback()
		current, currentErr := s.GetVirtualDesktopState(ctx, serverID)
		if currentErr != nil {
			return domain.VirtualDesktopState{}, currentErr
		}
		return domain.VirtualDesktopState{}, VirtualDesktopRevisionConflict{Current: current}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM virtual_desktop_windows WHERE server_id = ?`, serverID); err != nil {
		return domain.VirtualDesktopState{}, err
	}
	for index, window := range windows {
		normalized := normalizeVirtualDesktopWindow(window, index)
		metadataRaw := encodeVirtualDesktopWindowMetadata(virtualDesktopWindowStoredMetadata(normalized))
		if _, err := tx.ExecContext(ctx, `INSERT INTO virtual_desktop_windows (server_id, window_id, kind, title, x, y, width, height, minimized, maximized, z_index, terminal_session_id, metadata_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			serverID,
			normalized.ID,
			normalized.Kind,
			normalized.Title,
			normalized.X,
			normalized.Y,
			normalized.Width,
			normalized.Height,
			boolInt(normalized.Minimized),
			boolInt(normalized.Maximized),
			normalized.ZIndex,
			normalized.TerminalSessionID,
			metadataRaw,
			formatTime(now),
		); err != nil {
			return domain.VirtualDesktopState{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO virtual_desktop_states (server_id, wallpaper, revision, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(server_id) DO UPDATE SET wallpaper = excluded.wallpaper, revision = excluded.revision, updated_at = excluded.updated_at
	`, serverID, nextWallpaper, currentRevision+1, formatTime(now)); err != nil {
		return domain.VirtualDesktopState{}, err
	}
	if err := tx.Commit(); err != nil {
		return domain.VirtualDesktopState{}, err
	}
	return s.GetVirtualDesktopState(ctx, serverID)
}

const sqliteBusyRetryAttempts = 8

func sqliteWithBusyRetry(ctx context.Context, operation func() error) error {
	var lastErr error
	for attempt := 0; attempt < sqliteBusyRetryAttempts; attempt++ {
		err := operation()
		if err == nil {
			return nil
		}
		if !sqliteBusyError(err) {
			return err
		}
		lastErr = err
		timer := time.NewTimer(sqliteBusyRetryDelay(attempt))
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	return lastErr
}

func sqliteBusyRetryDelay(attempt int) time.Duration {
	return time.Duration(attempt+1) * 150 * time.Millisecond
}

func sqliteBusyError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "sqlite_busy") ||
		strings.Contains(message, "sqlite_locked") ||
		strings.Contains(message, "busy_snapshot") ||
		strings.Contains(message, "database is locked") ||
		strings.Contains(message, "database table is locked") ||
		strings.Contains(message, "database is busy") ||
		strings.Contains(message, "(5)") ||
		strings.Contains(message, "(517)")
}

func virtualDesktopRevisionInTx(ctx context.Context, tx *sql.Tx, serverID string) (int64, error) {
	var revision int64
	err := tx.QueryRowContext(ctx, `SELECT revision FROM virtual_desktop_states WHERE server_id = ?`, serverID).Scan(&revision)
	if err == nil {
		return revision, nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return 0, err
}

func virtualDesktopWallpaperInTx(ctx context.Context, tx *sql.Tx, serverID string) (string, error) {
	var wallpaper string
	err := tx.QueryRowContext(ctx, `SELECT wallpaper FROM virtual_desktop_states WHERE server_id = ?`, serverID).Scan(&wallpaper)
	if err == nil {
		return sanitizeVirtualDesktopWallpaper(wallpaper), nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return "", err
}

func sanitizeVirtualDesktopWallpaper(value string) string {
	trimmed := strings.TrimSpace(value)
	if customID, ok := virtualDesktopCustomWallpaperID(trimmed); ok {
		return "custom:" + customID
	}
	switch trimmed {
	case "", "gradient", "garage_empty", "garage_hotrod":
		return trimmed
	default:
		return ""
	}
}

func virtualDesktopCustomWallpaperID(value string) (string, bool) {
	id, ok := strings.CutPrefix(strings.TrimSpace(value), "custom:")
	if !ok {
		return "", false
	}
	parsed, err := uuid.Parse(strings.TrimSpace(id))
	if err != nil {
		return "", false
	}
	return parsed.String(), true
}

func virtualDesktopWallpaperExistsInTx(ctx context.Context, tx *sql.Tx, id string) (bool, error) {
	var exists int
	err := tx.QueryRowContext(ctx, `SELECT 1 FROM virtual_desktop_wallpapers WHERE id = ?`, id).Scan(&exists)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return false, err
}

func (s *SQLiteStore) ListVirtualDesktopWallpapers(ctx context.Context) ([]domain.VirtualDesktopWallpaper, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, label, content_type, source, created_at, updated_at FROM virtual_desktop_wallpapers ORDER BY updated_at DESC, label ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var wallpapers []domain.VirtualDesktopWallpaper
	for rows.Next() {
		wallpaper, err := scanVirtualDesktopWallpaper(rows)
		if err != nil {
			return nil, err
		}
		wallpapers = append(wallpapers, wallpaper)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return wallpapers, nil
}

func (s *SQLiteStore) GetVirtualDesktopWallpaper(ctx context.Context, id string) (domain.VirtualDesktopWallpaper, error) {
	wallpaper, err := scanVirtualDesktopWallpaper(s.db.QueryRowContext(ctx, `SELECT id, label, content_type, source, created_at, updated_at FROM virtual_desktop_wallpapers WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return domain.VirtualDesktopWallpaper{}, ErrNotFound
	}
	return wallpaper, err
}

func (s *SQLiteStore) CreateVirtualDesktopWallpaper(ctx context.Context, wallpaper domain.VirtualDesktopWallpaper) (domain.VirtualDesktopWallpaper, error) {
	if _, err := uuid.Parse(strings.TrimSpace(wallpaper.ID)); err != nil {
		wallpaper.ID = uuid.NewString()
	} else {
		wallpaper.ID = strings.TrimSpace(wallpaper.ID)
	}
	wallpaper.Label = sanitizeDetectedLabel(wallpaper.Label, 120)
	if wallpaper.Label == "" {
		wallpaper.Label = "Custom wallpaper"
	}
	wallpaper.ContentType = strings.ToLower(strings.TrimSpace(wallpaper.ContentType))
	wallpaper.Source = sanitizeDetectedFact(wallpaper.Source)
	if wallpaper.Source == "" {
		wallpaper.Source = "upload"
	}
	now := time.Now().UTC()
	if wallpaper.CreatedAt.IsZero() {
		wallpaper.CreatedAt = now
	}
	wallpaper.UpdatedAt = now
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO virtual_desktop_wallpapers (id, label, content_type, source, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`, wallpaper.ID, wallpaper.Label, wallpaper.ContentType, wallpaper.Source, formatTime(wallpaper.CreatedAt), formatTime(wallpaper.UpdatedAt))
	if err != nil {
		return domain.VirtualDesktopWallpaper{}, err
	}
	return s.GetVirtualDesktopWallpaper(ctx, wallpaper.ID)
}

func (s *SQLiteStore) DeleteVirtualDesktopWallpaper(ctx context.Context, id string) error {
	normalizedID, ok := virtualDesktopCustomWallpaperID("custom:" + id)
	if !ok {
		return ErrNotFound
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `DELETE FROM virtual_desktop_wallpapers WHERE id = ?`, normalizedID)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `UPDATE virtual_desktop_states SET wallpaper = '', revision = revision + 1, updated_at = ? WHERE wallpaper = ?`, formatTime(time.Now().UTC()), "custom:"+normalizedID); err != nil {
		return err
	}
	return tx.Commit()
}

func normalizeVirtualDesktopWindow(window domain.VirtualDesktopWindow, index int) domain.VirtualDesktopWindow {
	return window.Normalize(index)
}

const (
	virtualDesktopWindowAppIDMetadataKey          = "shellorchestra_app_id"
	virtualDesktopWindowPluginIDMetadataKey       = "shellorchestra_plugin_id"
	virtualDesktopWindowFrontendModuleMetadataKey = "shellorchestra_frontend_module"
)

func virtualDesktopWindowStoredMetadata(window domain.VirtualDesktopWindow) map[string]string {
	metadata := map[string]string{}
	for key, value := range window.Metadata {
		metadata[key] = value
	}
	if strings.TrimSpace(window.AppID) != "" {
		metadata[virtualDesktopWindowAppIDMetadataKey] = strings.TrimSpace(window.AppID)
	}
	if strings.TrimSpace(window.PluginID) != "" {
		metadata[virtualDesktopWindowPluginIDMetadataKey] = strings.TrimSpace(window.PluginID)
	}
	if strings.TrimSpace(window.FrontendModule) != "" {
		metadata[virtualDesktopWindowFrontendModuleMetadataKey] = strings.TrimSpace(window.FrontendModule)
	}
	return metadata
}

func restoreVirtualDesktopWindowIdentity(window *domain.VirtualDesktopWindow) {
	if window == nil || len(window.Metadata) == 0 {
		return
	}
	if window.AppID == "" {
		window.AppID = window.Metadata[virtualDesktopWindowAppIDMetadataKey]
	}
	if window.PluginID == "" {
		window.PluginID = window.Metadata[virtualDesktopWindowPluginIDMetadataKey]
	}
	if window.FrontendModule == "" {
		window.FrontendModule = window.Metadata[virtualDesktopWindowFrontendModuleMetadataKey]
	}
	delete(window.Metadata, virtualDesktopWindowAppIDMetadataKey)
	delete(window.Metadata, virtualDesktopWindowPluginIDMetadataKey)
	delete(window.Metadata, virtualDesktopWindowFrontendModuleMetadataKey)
	if len(window.Metadata) == 0 {
		window.Metadata = nil
	}
}

func encodeVirtualDesktopWindowMetadata(metadata map[string]string) string {
	if len(metadata) == 0 {
		return "{}"
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		return "{}"
	}
	return string(encoded)
}

func decodeVirtualDesktopWindowMetadata(raw string) map[string]string {
	var values map[string]string
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return nil
	}
	return domain.VirtualDesktopWindow{Metadata: values}.Normalize(0).Metadata
}

func (s *SQLiteStore) UpsertTerminalSession(ctx context.Context, session domain.TerminalSession) error {
	session = normalizeTerminalSession(session)
	if session.ID == "" {
		return fmt.Errorf("terminal session id is required")
	}
	if session.ServerID == "" {
		return fmt.Errorf("terminal server id is required")
	}
	if session.CreatedAt.IsZero() {
		session.CreatedAt = time.Now().UTC()
	}
	if session.UpdatedAt.IsZero() {
		session.UpdatedAt = time.Now().UTC()
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO terminal_sessions (id, server_id, title, state, rows, cols, window_id, pane_id, bundle_dir, bridge_token, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			server_id = excluded.server_id,
			title = excluded.title,
			state = excluded.state,
			rows = excluded.rows,
			cols = excluded.cols,
			window_id = excluded.window_id,
			pane_id = excluded.pane_id,
			bundle_dir = excluded.bundle_dir,
			bridge_token = excluded.bridge_token,
			updated_at = excluded.updated_at
	`, session.ID, session.ServerID, session.Title, session.State, session.Rows, session.Cols, session.WindowID, session.PaneID, session.BundleDir, session.BridgeToken, formatTime(session.CreatedAt), formatTime(session.UpdatedAt))
	return err
}

func (s *SQLiteStore) GetTerminalSession(ctx context.Context, id string) (domain.TerminalSession, error) {
	id = sanitizeVirtualDesktopReference(id)
	row := s.db.QueryRowContext(ctx, `SELECT id, server_id, title, state, rows, cols, window_id, pane_id, bundle_dir, bridge_token, created_at, updated_at FROM terminal_sessions WHERE id = ?`, id)
	return scanTerminalSession(row)
}

func (s *SQLiteStore) GetTerminalSessionByBridgeToken(ctx context.Context, token string) (domain.TerminalSession, error) {
	token = sanitizeVirtualDesktopReference(token)
	row := s.db.QueryRowContext(ctx, `SELECT id, server_id, title, state, rows, cols, window_id, pane_id, bundle_dir, bridge_token, created_at, updated_at FROM terminal_sessions WHERE bridge_token = ?`, token)
	return scanTerminalSession(row)
}

func (s *SQLiteStore) DeleteTerminalSession(ctx context.Context, id string) error {
	id = sanitizeVirtualDesktopReference(id)
	result, err := s.db.ExecContext(ctx, `DELETE FROM terminal_sessions WHERE id = ?`, id)
	if err != nil {
		return err
	}
	count, _ := result.RowsAffected()
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *SQLiteStore) DeleteAllTerminalSessions(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM terminal_sessions`)
	return err
}

func (s *SQLiteStore) DeleteTerminalDesktopWindows(ctx context.Context) (int64, error) {
	serverIDs, err := s.virtualDesktopServerIDsForWindowDelete(ctx, `terminal_session_id <> ''`)
	if err != nil {
		return 0, err
	}
	result, err := s.db.ExecContext(ctx, `DELETE FROM virtual_desktop_windows WHERE terminal_session_id <> ''`)
	if err != nil {
		return 0, err
	}
	count, _ := result.RowsAffected()
	if count > 0 {
		if err := s.bumpVirtualDesktopRevisions(ctx, serverIDs); err != nil {
			return count, err
		}
	}
	return count, nil
}

func (s *SQLiteStore) DeleteAllVirtualDesktopWindows(ctx context.Context) (int64, error) {
	serverIDs, err := s.virtualDesktopServerIDsForWindowDelete(ctx, `1 = 1`)
	if err != nil {
		return 0, err
	}
	result, err := s.db.ExecContext(ctx, `DELETE FROM virtual_desktop_windows`)
	if err != nil {
		return 0, err
	}
	count, _ := result.RowsAffected()
	if count > 0 {
		if err := s.bumpVirtualDesktopRevisions(ctx, serverIDs); err != nil {
			return count, err
		}
	}
	return count, nil
}

func (s *SQLiteStore) virtualDesktopServerIDsForWindowDelete(ctx context.Context, whereClause string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT DISTINCT server_id FROM virtual_desktop_windows WHERE `+whereClause)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var serverIDs []string
	for rows.Next() {
		var serverID string
		if err := rows.Scan(&serverID); err != nil {
			return nil, err
		}
		serverID = sanitizeVirtualDesktopReference(serverID)
		if serverID != "" {
			serverIDs = append(serverIDs, serverID)
		}
	}
	return serverIDs, rows.Err()
}

func (s *SQLiteStore) bumpVirtualDesktopRevisions(ctx context.Context, serverIDs []string) error {
	if len(serverIDs) == 0 {
		return nil
	}
	now := formatTime(time.Now().UTC())
	for _, serverID := range serverIDs {
		if _, err := s.db.ExecContext(ctx, `INSERT INTO virtual_desktop_states (server_id, wallpaper, revision, updated_at)
			VALUES (?, '', 1, ?)
			ON CONFLICT(server_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at`, serverID, now); err != nil {
			return err
		}
	}
	return nil
}

func normalizeTerminalSession(session domain.TerminalSession) domain.TerminalSession {
	session.ID = sanitizeVirtualDesktopReference(session.ID)
	session.ServerID = sanitizeVirtualDesktopReference(session.ServerID)
	session.Title = sanitizeDetectedLabel(session.Title, 120)
	if session.Title == "" {
		session.Title = "Terminal"
	}
	session.State = sanitizeDetectedFact(session.State)
	if session.State == "" {
		session.State = "running"
	}
	session.WindowID = sanitizeTerminalTarget(session.WindowID)
	session.PaneID = sanitizeTerminalTarget(session.PaneID)
	session.BridgeToken = sanitizeVirtualDesktopReference(session.BridgeToken)
	session.BundleDir = strings.TrimSpace(session.BundleDir)
	if len(session.BundleDir) > 1024 {
		session.BundleDir = session.BundleDir[:1024]
	}
	if session.Rows < 5 {
		session.Rows = 24
	}
	if session.Cols < 20 {
		session.Cols = 80
	}
	return session
}

func scanTerminalSession(row serverScanner) (domain.TerminalSession, error) {
	var session domain.TerminalSession
	var createdRaw string
	var updatedRaw string
	if err := row.Scan(&session.ID, &session.ServerID, &session.Title, &session.State, &session.Rows, &session.Cols, &session.WindowID, &session.PaneID, &session.BundleDir, &session.BridgeToken, &createdRaw, &updatedRaw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return domain.TerminalSession{}, ErrNotFound
		}
		return domain.TerminalSession{}, err
	}
	session.CreatedAt, _ = time.Parse(time.RFC3339, createdRaw)
	session.UpdatedAt, _ = time.Parse(time.RFC3339, updatedRaw)
	return session, nil
}

func sanitizeVirtualDesktopReference(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 160 {
		value = value[:160]
	}
	var builder strings.Builder
	for _, char := range value {
		switch {
		case char >= 'a' && char <= 'z':
			builder.WriteRune(char)
		case char >= 'A' && char <= 'Z':
			builder.WriteRune(char)
		case char >= '0' && char <= '9':
			builder.WriteRune(char)
		case char == '-' || char == '_' || char == '.':
			builder.WriteRune(char)
		}
	}
	return builder.String()
}

func sanitizeTerminalTarget(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 80 {
		value = value[:80]
	}
	var builder strings.Builder
	for _, char := range value {
		switch {
		case char >= 'a' && char <= 'z':
			builder.WriteRune(char)
		case char >= 'A' && char <= 'Z':
			builder.WriteRune(char)
		case char >= '0' && char <= '9':
			builder.WriteRune(char)
		case char == '-' || char == '_' || char == '.' || char == '@' || char == '%':
			builder.WriteRune(char)
		}
	}
	return builder.String()
}

func (s *SQLiteStore) CreateScriptRun(ctx context.Context, run domain.ScriptRun) (domain.ScriptRun, error) {
	if run.ID == "" {
		run.ID = uuid.NewString()
	}
	if run.CreatedAt.IsZero() {
		run.CreatedAt = time.Now().UTC()
	}
	result, _ := json.Marshal(run.Result)
	finishedAt := ""
	if run.FinishedAt != nil {
		finishedAt = formatTime(*run.FinishedAt)
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO script_runs (id, server_id, command, variant, state, result_json, error, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		run.ID, run.ServerID, run.Command, run.Variant, run.State, string(result), run.Error, formatTime(run.CreatedAt), finishedAt)
	return run, err
}

func (s *SQLiteStore) GetScriptRun(ctx context.Context, id string) (domain.ScriptRun, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, server_id, command, variant, state, result_json, error, created_at, finished_at FROM script_runs WHERE id = ?`, id)
	return scanScriptRun(row)
}

func (s *SQLiteStore) ListBackupBuckets(ctx context.Context) ([]domain.BackupBucket, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, label, server_id, root_path, bucket_path, filesystem, free_bytes, total_bytes, manifest_status, last_probe_at, created_at, updated_at FROM backup_buckets ORDER BY label ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	buckets := []domain.BackupBucket{}
	for rows.Next() {
		bucket, err := scanBackupBucket(rows)
		if err != nil {
			return nil, err
		}
		buckets = append(buckets, bucket)
	}
	return buckets, rows.Err()
}

func (s *SQLiteStore) GetBackupBucket(ctx context.Context, id string) (domain.BackupBucket, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, label, server_id, root_path, bucket_path, filesystem, free_bytes, total_bytes, manifest_status, last_probe_at, created_at, updated_at FROM backup_buckets WHERE id = ?`, strings.TrimSpace(id))
	return scanBackupBucket(row)
}

func (s *SQLiteStore) CreateBackupBucket(ctx context.Context, input domain.BackupBucketInput) (domain.BackupBucket, error) {
	bucket, err := normalizeBackupBucketInput(input)
	if err != nil {
		return domain.BackupBucket{}, err
	}
	now := time.Now().UTC()
	bucket.ID = uuid.NewString()
	bucket.CreatedAt = now
	bucket.UpdatedAt = now
	if bucket.LastProbeAt == nil {
		bucket.LastProbeAt = &now
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO backup_buckets (id, label, server_id, root_path, bucket_path, filesystem, free_bytes, total_bytes, manifest_status, last_probe_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		bucket.ID, bucket.Label, bucket.ServerID, bucket.RootPath, bucket.BucketPath, bucket.Filesystem, bucket.FreeBytes, bucket.TotalBytes, bucket.ManifestStatus, nullableTimeString(bucket.LastProbeAt), formatTime(bucket.CreatedAt), formatTime(bucket.UpdatedAt))
	return bucket, err
}

func (s *SQLiteStore) DeleteBackupBucket(ctx context.Context, id string) error {
	result, err := s.db.ExecContext(ctx, `DELETE FROM backup_buckets WHERE id = ?`, strings.TrimSpace(id))
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err == nil && count == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *SQLiteStore) ListBackupTasks(ctx context.Context) ([]domain.BackupTask, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, label, source_server_id, source_path, source_kind, source_file_count, source_disk_bytes, target_bucket_id, fallback_bucket_id, exclude_patterns, compression, rotation_json, schedule_json, last_run_id, last_run_state, last_success_at, created_at, updated_at FROM backup_tasks ORDER BY label ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tasks := []domain.BackupTask{}
	for rows.Next() {
		task, err := scanBackupTask(rows)
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, task)
	}
	return tasks, rows.Err()
}

func (s *SQLiteStore) GetBackupTask(ctx context.Context, id string) (domain.BackupTask, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, label, source_server_id, source_path, source_kind, source_file_count, source_disk_bytes, target_bucket_id, fallback_bucket_id, exclude_patterns, compression, rotation_json, schedule_json, last_run_id, last_run_state, last_success_at, created_at, updated_at FROM backup_tasks WHERE id = ?`, strings.TrimSpace(id))
	return scanBackupTask(row)
}

func (s *SQLiteStore) CreateBackupTask(ctx context.Context, input domain.BackupTaskInput) (domain.BackupTask, error) {
	task, err := normalizeBackupTaskInput(input)
	if err != nil {
		return domain.BackupTask{}, err
	}
	now := time.Now().UTC()
	task.ID = uuid.NewString()
	task.CreatedAt = now
	task.UpdatedAt = now
	rotationJSON, _ := json.Marshal(task.Rotation)
	scheduleJSON, _ := json.Marshal(task.Schedule)
	_, err = s.db.ExecContext(ctx, `INSERT INTO backup_tasks (id, label, source_server_id, source_path, source_kind, source_file_count, source_disk_bytes, target_bucket_id, fallback_bucket_id, exclude_patterns, compression, rotation_json, schedule_json, last_run_id, last_run_state, last_success_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', NULL, ?, ?)`,
		task.ID, task.Label, task.SourceServerID, task.SourcePath, task.SourceKind, task.SourceFileCount, task.SourceDiskBytes, task.TargetBucketID, task.FallbackBucketID, task.ExcludePatterns, task.Compression, string(rotationJSON), string(scheduleJSON), formatTime(task.CreatedAt), formatTime(task.UpdatedAt))
	return task, err
}

func (s *SQLiteStore) UpdateBackupTask(ctx context.Context, id string, input domain.BackupTaskInput) (domain.BackupTask, error) {
	existing, err := s.GetBackupTask(ctx, id)
	if err != nil {
		return domain.BackupTask{}, err
	}
	task, err := normalizeBackupTaskInput(input)
	if err != nil {
		return domain.BackupTask{}, err
	}
	task.ID = existing.ID
	task.LastRunID = existing.LastRunID
	task.LastRunState = existing.LastRunState
	task.LastSuccessAt = existing.LastSuccessAt
	task.CreatedAt = existing.CreatedAt
	task.UpdatedAt = time.Now().UTC()
	rotationJSON, _ := json.Marshal(task.Rotation)
	scheduleJSON, _ := json.Marshal(task.Schedule)
	result, err := s.db.ExecContext(ctx, `UPDATE backup_tasks SET label = ?, source_server_id = ?, source_path = ?, source_kind = ?, source_file_count = ?, source_disk_bytes = ?, target_bucket_id = ?, fallback_bucket_id = ?, exclude_patterns = ?, compression = ?, rotation_json = ?, schedule_json = ?, updated_at = ? WHERE id = ?`,
		task.Label, task.SourceServerID, task.SourcePath, task.SourceKind, task.SourceFileCount, task.SourceDiskBytes, task.TargetBucketID, task.FallbackBucketID, task.ExcludePatterns, task.Compression, string(rotationJSON), string(scheduleJSON), formatTime(task.UpdatedAt), task.ID)
	if err != nil {
		return domain.BackupTask{}, err
	}
	count, _ := result.RowsAffected()
	if count == 0 {
		return domain.BackupTask{}, ErrNotFound
	}
	return task, nil
}

func (s *SQLiteStore) DeleteBackupTask(ctx context.Context, id string) error {
	result, err := s.db.ExecContext(ctx, `DELETE FROM backup_tasks WHERE id = ?`, strings.TrimSpace(id))
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err == nil && count == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *SQLiteStore) CreateBackupRun(ctx context.Context, run domain.BackupRun) (domain.BackupRun, error) {
	run.TaskID = strings.TrimSpace(run.TaskID)
	if run.TaskID == "" {
		return domain.BackupRun{}, fmt.Errorf("backup task id is required")
	}
	if run.ID == "" {
		run.ID = uuid.NewString()
	}
	if run.Trigger == "" {
		run.Trigger = "manual"
	}
	if run.State == "" {
		run.State = "running"
	}
	now := time.Now().UTC()
	if run.CreatedAt.IsZero() {
		run.CreatedAt = now
	}
	if run.StartedAt.IsZero() {
		run.StartedAt = now
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO backup_runs (id, task_id, trigger, state, script_run_id, log, error, archive_name, archive_bytes, created_at, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		run.ID, run.TaskID, sanitizeDetectedFact(run.Trigger), sanitizeDetectedFact(run.State), strings.TrimSpace(run.ScriptRunID), clampText(run.Log, 1048576), clampText(run.Error, 8192), sanitizeDetectedLabel(run.ArchiveName, 255), nonNegativeInt64(run.ArchiveBytes), formatTime(run.CreatedAt), formatTime(run.StartedAt), nullableTimeString(run.FinishedAt))
	if err != nil {
		return domain.BackupRun{}, err
	}
	_ = s.updateBackupTaskLastRun(ctx, run.TaskID, run.ID, run.State, nil)
	return s.GetBackupRun(ctx, run.ID)
}

func (s *SQLiteStore) GetBackupRun(ctx context.Context, id string) (domain.BackupRun, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, task_id, trigger, state, script_run_id, log, error, archive_name, archive_bytes, created_at, started_at, finished_at FROM backup_runs WHERE id = ?`, strings.TrimSpace(id))
	return scanBackupRun(row)
}

func (s *SQLiteStore) FinishBackupRun(ctx context.Context, run domain.BackupRun) error {
	if run.ID == "" {
		return fmt.Errorf("backup run id is required")
	}
	if run.State == "" {
		run.State = "failed"
	}
	finishedAt := run.FinishedAt
	if finishedAt == nil {
		now := time.Now().UTC()
		finishedAt = &now
	}
	result, err := s.db.ExecContext(ctx, `UPDATE backup_runs SET state = ?, script_run_id = ?, log = ?, error = ?, archive_name = ?, archive_bytes = ?, finished_at = ? WHERE id = ?`,
		sanitizeDetectedFact(run.State), strings.TrimSpace(run.ScriptRunID), clampText(run.Log, 1048576), clampText(run.Error, 8192), sanitizeDetectedLabel(run.ArchiveName, 255), nonNegativeInt64(run.ArchiveBytes), nullableTimeString(finishedAt), strings.TrimSpace(run.ID))
	if err != nil {
		return err
	}
	count, _ := result.RowsAffected()
	if count == 0 {
		return ErrNotFound
	}
	stored, err := s.GetBackupRun(ctx, run.ID)
	if err != nil {
		return err
	}
	var successAt any
	if stored.State == "succeeded" {
		successAt = formatTime(*finishedAt)
	}
	return s.updateBackupTaskLastRun(ctx, stored.TaskID, stored.ID, stored.State, successAt)
}

func (s *SQLiteStore) ListBackupRuns(ctx context.Context, taskID string, limit int) ([]domain.BackupRun, error) {
	if limit <= 0 || limit > 200 {
		limit = 20
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, task_id, trigger, state, script_run_id, log, error, archive_name, archive_bytes, created_at, started_at, finished_at FROM backup_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`, strings.TrimSpace(taskID), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	runs := []domain.BackupRun{}
	for rows.Next() {
		run, err := scanBackupRun(rows)
		if err != nil {
			return nil, err
		}
		runs = append(runs, run)
	}
	return runs, rows.Err()
}

func (s *SQLiteStore) updateBackupTaskLastRun(ctx context.Context, taskID string, runID string, state string, successAt any) error {
	_, err := s.db.ExecContext(ctx, `UPDATE backup_tasks SET last_run_id = ?, last_run_state = ?, last_success_at = COALESCE(?, last_success_at), updated_at = ? WHERE id = ?`,
		strings.TrimSpace(runID), sanitizeDetectedFact(state), successAt, formatTime(time.Now().UTC()), strings.TrimSpace(taskID))
	return err
}

func (s *SQLiteStore) ListBatchScriptTemplates(ctx context.Context) ([]domain.BatchScriptTemplate, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, description, enabled, definition_json, created_at, updated_at FROM batch_script_templates ORDER BY updated_at DESC, name ASC`)
	if err != nil {
		return nil, err
	}
	var templates []domain.BatchScriptTemplate
	for rows.Next() {
		template, err := scanBatchScriptTemplate(rows)
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		templates = append(templates, template)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for index := range templates {
		if err := s.attachBatchScriptScheduleState(ctx, &templates[index]); err != nil {
			return nil, err
		}
	}
	return templates, nil
}

func (s *SQLiteStore) GetBatchScriptTemplate(ctx context.Context, id string) (domain.BatchScriptTemplate, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, name, description, enabled, definition_json, created_at, updated_at FROM batch_script_templates WHERE id = ?`, id)
	template, err := scanBatchScriptTemplate(row)
	if err != nil {
		return domain.BatchScriptTemplate{}, err
	}
	if err := s.attachBatchScriptScheduleState(ctx, &template); err != nil {
		return domain.BatchScriptTemplate{}, err
	}
	return template, nil
}

func (s *SQLiteStore) CreateBatchScriptTemplate(ctx context.Context, input domain.BatchScriptTemplateInput) (domain.BatchScriptTemplate, error) {
	template, err := normalizeBatchScriptTemplateInput(input)
	if err != nil {
		return domain.BatchScriptTemplate{}, err
	}
	now := time.Now().UTC()
	template.ID = uuid.NewString()
	template.CreatedAt = now
	template.UpdatedAt = now
	definition, _ := json.Marshal(template)
	_, err = s.db.ExecContext(ctx, `INSERT INTO batch_script_templates (id, name, description, enabled, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		template.ID, template.Name, template.Description, boolInt(template.Enabled), string(definition), formatTime(template.CreatedAt), formatTime(template.UpdatedAt))
	return template, err
}

func (s *SQLiteStore) UpdateBatchScriptTemplate(ctx context.Context, id string, input domain.BatchScriptTemplateInput) (domain.BatchScriptTemplate, error) {
	existing, err := s.GetBatchScriptTemplate(ctx, id)
	if err != nil {
		return domain.BatchScriptTemplate{}, err
	}
	template, err := normalizeBatchScriptTemplateInput(input)
	if err != nil {
		return domain.BatchScriptTemplate{}, err
	}
	template.ID = existing.ID
	template.CreatedAt = existing.CreatedAt
	template.UpdatedAt = time.Now().UTC()
	definition, _ := json.Marshal(template)
	_, err = s.db.ExecContext(ctx, `UPDATE batch_script_templates SET name = ?, description = ?, enabled = ?, definition_json = ?, updated_at = ? WHERE id = ?`,
		template.Name, template.Description, boolInt(template.Enabled), string(definition), formatTime(template.UpdatedAt), id)
	return template, err
}

func (s *SQLiteStore) DeleteBatchScriptTemplate(ctx context.Context, id string) error {
	result, err := s.db.ExecContext(ctx, `DELETE FROM batch_script_templates WHERE id = ?`, id)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err == nil && count == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *SQLiteStore) GetBatchScriptScheduleState(ctx context.Context, templateID string) (domain.BatchScriptScheduleState, error) {
	row := s.db.QueryRowContext(ctx, `SELECT template_id, next_run_at, last_evaluated_at, last_started_run_id, last_noop_at, last_noop_reason, missed_run_count, updated_at FROM batch_script_schedule_state WHERE template_id = ?`, strings.TrimSpace(templateID))
	return scanBatchScriptScheduleState(row)
}

func (s *SQLiteStore) UpsertBatchScriptScheduleState(ctx context.Context, state domain.BatchScriptScheduleState) error {
	state.TemplateID = strings.TrimSpace(state.TemplateID)
	if state.TemplateID == "" {
		return fmt.Errorf("batch script schedule state template id is required")
	}
	if state.UpdatedAt.IsZero() {
		state.UpdatedAt = time.Now().UTC()
	}
	if state.MissedRunCount < 0 {
		state.MissedRunCount = 0
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO batch_script_schedule_state (template_id, next_run_at, last_evaluated_at, last_started_run_id, last_noop_at, last_noop_reason, missed_run_count, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(template_id) DO UPDATE SET
			next_run_at = excluded.next_run_at,
			last_evaluated_at = excluded.last_evaluated_at,
			last_started_run_id = excluded.last_started_run_id,
			last_noop_at = excluded.last_noop_at,
			last_noop_reason = excluded.last_noop_reason,
			missed_run_count = excluded.missed_run_count,
			updated_at = excluded.updated_at`,
		state.TemplateID,
		nullableTimeString(state.NextRunAt),
		nullableTimeString(state.LastEvaluatedAt),
		state.LastStartedRunID,
		nullableTimeString(state.LastNoopAt),
		state.LastNoopReason,
		state.MissedRunCount,
		formatTime(state.UpdatedAt),
	)
	return err
}

func (s *SQLiteStore) attachBatchScriptScheduleState(ctx context.Context, template *domain.BatchScriptTemplate) error {
	if template == nil || strings.TrimSpace(template.ID) == "" {
		return nil
	}
	state, err := s.GetBatchScriptScheduleState(ctx, template.ID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil
		}
		return err
	}
	template.ScheduleState = &state
	return nil
}

func (s *SQLiteStore) CreateBatchScriptRun(ctx context.Context, run domain.BatchScriptRun, targets []domain.BatchScriptRunTarget) (domain.BatchScriptRun, error) {
	if run.ID == "" {
		run.ID = uuid.NewString()
	}
	now := time.Now().UTC()
	if run.CreatedAt.IsZero() {
		run.CreatedAt = now
	}
	if run.StartedAt.IsZero() {
		run.StartedAt = now
	}
	if run.Trigger == "" {
		run.Trigger = "manual"
	}
	if run.State == "" {
		run.State = domain.BatchScriptRunRunning
	}
	run.TargetCount = len(targets)
	run.SuccessCount = 0
	run.FailedCount = 0
	run.SkippedCount = 0
	for _, target := range targets {
		switch target.State {
		case domain.BatchScriptRunTargetSkipped:
			run.SkippedCount++
		case domain.BatchScriptRunTargetSucceeded:
			run.SuccessCount++
		case domain.BatchScriptRunTargetFailed:
			run.FailedCount++
		}
	}
	settingsJSON, _ := json.Marshal(run.SettingsSnapshot)
	storedTargets := make([]domain.BatchScriptRunTarget, 0, len(targets))
	for _, target := range targets {
		target.RunID = run.ID
		storedTargets = append(storedTargets, target)
	}
	err := sqliteWithBusyRetry(ctx, func() error {
		return s.createBatchScriptRunOnce(ctx, run, storedTargets, string(settingsJSON))
	})
	if err != nil {
		return domain.BatchScriptRun{}, err
	}
	run.Targets = storedTargets
	return run, nil
}

func (s *SQLiteStore) createBatchScriptRunOnce(ctx context.Context, run domain.BatchScriptRun, targets []domain.BatchScriptRunTarget, settingsJSON string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	finishedAt := nullableTimeString(run.FinishedAt)
	if _, err := tx.ExecContext(ctx, `INSERT INTO batch_script_runs (id, template_id, name_snapshot, requested_by_device_id, requested_by_session_id, trigger, state, target_count, success_count, failed_count, skipped_count, settings_snapshot_json, created_at, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		run.ID, run.TemplateID, run.NameSnapshot, run.RequestedByDeviceID, run.RequestedBySessionID, run.Trigger, run.State, run.TargetCount, run.SuccessCount, run.FailedCount, run.SkippedCount, settingsJSON, formatTime(run.CreatedAt), formatTime(run.StartedAt), finishedAt); err != nil {
		return err
	}
	for _, target := range targets {
		selectorJSON, _ := json.Marshal(target.VariantSelectorSnapshot)
		var exitCode any
		if target.ExitCode != nil {
			exitCode = *target.ExitCode
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO batch_script_run_targets (run_id, server_id, server_label_snapshot, variant_id, variant_selector_json, state, exit_code, stdout_preview, stdout_truncated, stdout_ref, stdout_bytes, stderr_preview, stderr_truncated, stderr_ref, stderr_bytes, error_message, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			target.RunID, target.ServerID, target.ServerLabelSnapshot, target.VariantID, string(selectorJSON), target.State, exitCode, target.StdoutPreview, boolInt(target.StdoutTruncated), target.StdoutRef, target.StdoutBytes, target.StderrPreview, boolInt(target.StderrTruncated), target.StderrRef, target.StderrBytes, target.ErrorMessage, nullableTimeString(target.StartedAt), nullableTimeString(target.FinishedAt)); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return nil
}

func (s *SQLiteStore) ListBatchScriptRuns(ctx context.Context, templateID string, limit int) ([]domain.BatchScriptRun, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, template_id, name_snapshot, requested_by_device_id, requested_by_session_id, trigger, state, target_count, success_count, failed_count, skipped_count, settings_snapshot_json, created_at, started_at, finished_at FROM batch_script_runs WHERE template_id = ? ORDER BY created_at DESC LIMIT ?`, templateID, limit)
	if err != nil {
		return nil, err
	}
	runs := []domain.BatchScriptRun{}
	for rows.Next() {
		run, err := scanBatchScriptRun(rows)
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		runs = append(runs, run)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for index := range runs {
		targets, err := s.ListBatchScriptRunTargets(ctx, runs[index].ID)
		if err != nil {
			return nil, err
		}
		runs[index].Targets = targets
	}
	return runs, nil
}

func (s *SQLiteStore) GetBatchScriptRun(ctx context.Context, id string) (domain.BatchScriptRun, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, template_id, name_snapshot, requested_by_device_id, requested_by_session_id, trigger, state, target_count, success_count, failed_count, skipped_count, settings_snapshot_json, created_at, started_at, finished_at FROM batch_script_runs WHERE id = ?`, id)
	run, err := scanBatchScriptRun(row)
	if err != nil {
		return domain.BatchScriptRun{}, err
	}
	targets, err := s.ListBatchScriptRunTargets(ctx, id)
	if err != nil {
		return domain.BatchScriptRun{}, err
	}
	run.Targets = targets
	return run, nil
}

func (s *SQLiteStore) ListBatchScriptRunTargets(ctx context.Context, runID string) ([]domain.BatchScriptRunTarget, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT run_id, server_id, server_label_snapshot, variant_id, variant_selector_json, state, exit_code, stdout_preview, stdout_truncated, stdout_ref, stdout_bytes, stderr_preview, stderr_truncated, stderr_ref, stderr_bytes, error_message, started_at, finished_at FROM batch_script_run_targets WHERE run_id = ? ORDER BY server_label_snapshot ASC`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	targets := []domain.BatchScriptRunTarget{}
	for rows.Next() {
		target, err := scanBatchScriptRunTarget(rows)
		if err != nil {
			return nil, err
		}
		targets = append(targets, target)
	}
	return targets, rows.Err()
}

func (s *SQLiteStore) StartBatchScriptRunTarget(ctx context.Context, runID string, serverID string) error {
	now := time.Now().UTC()
	return sqliteWithBusyRetry(ctx, func() error {
		result, err := s.db.ExecContext(ctx, `UPDATE batch_script_run_targets SET state = ?, started_at = ?, error_message = '' WHERE run_id = ? AND server_id = ?`,
			domain.BatchScriptRunTargetRunning, formatTime(now), runID, serverID)
		if err != nil {
			return err
		}
		count, _ := result.RowsAffected()
		if count == 0 {
			return ErrNotFound
		}
		return nil
	})
}

func (s *SQLiteStore) FinishBatchScriptRunTarget(ctx context.Context, target domain.BatchScriptRunTarget) error {
	if target.FinishedAt == nil {
		now := time.Now().UTC()
		target.FinishedAt = &now
	}
	var exitCode any
	if target.ExitCode != nil {
		exitCode = *target.ExitCode
	}
	return sqliteWithBusyRetry(ctx, func() error {
		result, err := s.db.ExecContext(ctx, `UPDATE batch_script_run_targets SET state = ?, exit_code = ?, stdout_preview = ?, stdout_truncated = ?, stdout_ref = ?, stdout_bytes = ?, stderr_preview = ?, stderr_truncated = ?, stderr_ref = ?, stderr_bytes = ?, error_message = ?, finished_at = ? WHERE run_id = ? AND server_id = ?`,
			target.State, exitCode, target.StdoutPreview, boolInt(target.StdoutTruncated), target.StdoutRef, target.StdoutBytes, target.StderrPreview, boolInt(target.StderrTruncated), target.StderrRef, target.StderrBytes, target.ErrorMessage, formatTime(*target.FinishedAt), target.RunID, target.ServerID)
		if err != nil {
			return err
		}
		count, _ := result.RowsAffected()
		if count == 0 {
			return ErrNotFound
		}
		return s.recomputeBatchScriptRun(ctx, target.RunID)
	})
}

func (s *SQLiteStore) PruneBatchScriptRuns(ctx context.Context, templateID string, retention domain.BatchScriptRetention) ([]string, error) {
	templateID = strings.TrimSpace(templateID)
	if templateID == "" {
		return nil, nil
	}
	retention = normalizeBatchScriptRetention(retention)
	pruneRunIDs := []string{}
	if retention.MaxRuns > 0 {
		rows, err := s.db.QueryContext(ctx, `SELECT id FROM batch_script_runs
			WHERE template_id = ?
			  AND state NOT IN (?, ?)
			  AND id NOT IN (
			    SELECT id FROM batch_script_runs
			    WHERE template_id = ?
			      AND state NOT IN (?, ?)
			    ORDER BY created_at DESC
			    LIMIT ?
			  )
			ORDER BY created_at ASC`,
			templateID,
			domain.BatchScriptRunRunning,
			domain.BatchScriptRunQueued,
			templateID,
			domain.BatchScriptRunRunning,
			domain.BatchScriptRunQueued,
			retention.MaxRuns,
		)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				_ = rows.Close()
				return nil, err
			}
			pruneRunIDs = append(pruneRunIDs, id)
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}
	if retention.DeleteAfterDays > 0 {
		cutoff := time.Now().UTC().Add(-time.Duration(retention.DeleteAfterDays) * 24 * time.Hour)
		rows, err := s.db.QueryContext(ctx, `SELECT id FROM batch_script_runs
			WHERE template_id = ?
			  AND state NOT IN (?, ?)
			  AND created_at < ?
			ORDER BY created_at ASC`,
			templateID,
			domain.BatchScriptRunRunning,
			domain.BatchScriptRunQueued,
			formatTime(cutoff),
		)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				_ = rows.Close()
				return nil, err
			}
			pruneRunIDs = append(pruneRunIDs, id)
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}
	pruneRunIDs = uniqueNonEmptyStrings(pruneRunIDs)
	if len(pruneRunIDs) == 0 {
		return nil, nil
	}
	refs, err := s.batchScriptOutputRefsForRuns(ctx, pruneRunIDs)
	if err != nil {
		return nil, err
	}
	if err := s.deleteBatchScriptRunsByID(ctx, pruneRunIDs); err != nil {
		return nil, err
	}
	return refs, nil
}

func (s *SQLiteStore) batchScriptOutputRefsForRuns(ctx context.Context, runIDs []string) ([]string, error) {
	if len(runIDs) == 0 {
		return nil, nil
	}
	placeholders, args := sqlInClause(runIDs)
	rows, err := s.db.QueryContext(ctx, `SELECT stdout_ref, stderr_ref FROM batch_script_run_targets WHERE run_id IN (`+placeholders+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	refs := []string{}
	for rows.Next() {
		var stdoutRef string
		var stderrRef string
		if err := rows.Scan(&stdoutRef, &stderrRef); err != nil {
			return nil, err
		}
		refs = append(refs, stdoutRef, stderrRef)
	}
	return uniqueNonEmptyStrings(refs), rows.Err()
}

func (s *SQLiteStore) deleteBatchScriptRunsByID(ctx context.Context, runIDs []string) error {
	if len(runIDs) == 0 {
		return nil
	}
	placeholders, args := sqlInClause(runIDs)
	return sqliteWithBusyRetry(ctx, func() error {
		_, err := s.db.ExecContext(ctx, `DELETE FROM batch_script_runs WHERE id IN (`+placeholders+`)`, args...)
		return err
	})
}

func sqlInClause(values []string) (string, []any) {
	placeholders := make([]string, 0, len(values))
	args := make([]any, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		placeholders = append(placeholders, "?")
		args = append(args, value)
	}
	if len(placeholders) == 0 {
		return "NULL", nil
	}
	return strings.Join(placeholders, ","), args
}

func uniqueNonEmptyStrings(values []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func (s *SQLiteStore) recomputeBatchScriptRun(ctx context.Context, runID string) error {
	targets, err := s.ListBatchScriptRunTargets(ctx, runID)
	if err != nil {
		return err
	}
	total := len(targets)
	success := 0
	failed := 0
	skipped := 0
	running := 0
	queued := 0
	for _, target := range targets {
		switch target.State {
		case domain.BatchScriptRunTargetSucceeded:
			success++
		case domain.BatchScriptRunTargetFailed:
			failed++
		case domain.BatchScriptRunTargetSkipped:
			skipped++
		case domain.BatchScriptRunTargetRunning:
			running++
		default:
			queued++
		}
	}
	state := domain.BatchScriptRunRunning
	var finishedAt any
	if running == 0 && queued == 0 {
		now := time.Now().UTC()
		finishedAt = formatTime(now)
		switch {
		case failed == 0:
			state = domain.BatchScriptRunSucceeded
		case success > 0 || skipped > 0:
			state = domain.BatchScriptRunPartial
		default:
			state = domain.BatchScriptRunFailed
		}
	}
	_, err = s.db.ExecContext(ctx, `UPDATE batch_script_runs SET state = ?, target_count = ?, success_count = ?, failed_count = ?, skipped_count = ?, finished_at = COALESCE(?, finished_at) WHERE id = ?`,
		state, total, success, failed, skipped, finishedAt, runID)
	return err
}

type batchScriptTemplateScanner interface {
	Scan(dest ...any) error
}

func scanBatchScriptTemplate(row batchScriptTemplateScanner) (domain.BatchScriptTemplate, error) {
	var template domain.BatchScriptTemplate
	var enabled int
	var raw string
	var createdRaw string
	var updatedRaw string
	if err := row.Scan(&template.ID, &template.Name, &template.Description, &enabled, &raw, &createdRaw, &updatedRaw); err != nil {
		return domain.BatchScriptTemplate{}, err
	}
	if strings.TrimSpace(raw) != "" {
		_ = json.Unmarshal([]byte(raw), &template)
	}
	template.Enabled = intBool(enabled)
	if createdAt, err := time.Parse(time.RFC3339, createdRaw); err == nil {
		template.CreatedAt = createdAt
	}
	if updatedAt, err := time.Parse(time.RFC3339, updatedRaw); err == nil {
		template.UpdatedAt = updatedAt
	}
	return template, nil
}

func scanBatchScriptRun(row serverScanner) (domain.BatchScriptRun, error) {
	var run domain.BatchScriptRun
	var settingsRaw string
	var createdRaw string
	var startedRaw string
	var finishedRaw sql.NullString
	if err := row.Scan(&run.ID, &run.TemplateID, &run.NameSnapshot, &run.RequestedByDeviceID, &run.RequestedBySessionID, &run.Trigger, &run.State, &run.TargetCount, &run.SuccessCount, &run.FailedCount, &run.SkippedCount, &settingsRaw, &createdRaw, &startedRaw, &finishedRaw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return domain.BatchScriptRun{}, ErrNotFound
		}
		return domain.BatchScriptRun{}, err
	}
	_ = json.Unmarshal([]byte(settingsRaw), &run.SettingsSnapshot)
	if run.SettingsSnapshot == nil {
		run.SettingsSnapshot = map[string]any{}
	}
	run.CreatedAt, _ = time.Parse(time.RFC3339, createdRaw)
	run.StartedAt, _ = time.Parse(time.RFC3339, startedRaw)
	if finishedRaw.Valid && finishedRaw.String != "" {
		if finished, err := time.Parse(time.RFC3339, finishedRaw.String); err == nil {
			run.FinishedAt = &finished
		}
	}
	return run, nil
}

func scanBatchScriptScheduleState(row serverScanner) (domain.BatchScriptScheduleState, error) {
	var state domain.BatchScriptScheduleState
	var nextRaw sql.NullString
	var lastEvaluatedRaw sql.NullString
	var lastNoopRaw sql.NullString
	var updatedRaw string
	if err := row.Scan(&state.TemplateID, &nextRaw, &lastEvaluatedRaw, &state.LastStartedRunID, &lastNoopRaw, &state.LastNoopReason, &state.MissedRunCount, &updatedRaw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return domain.BatchScriptScheduleState{}, ErrNotFound
		}
		return domain.BatchScriptScheduleState{}, err
	}
	if nextRaw.Valid && nextRaw.String != "" {
		if value, err := time.Parse(time.RFC3339, nextRaw.String); err == nil {
			state.NextRunAt = &value
		}
	}
	if lastEvaluatedRaw.Valid && lastEvaluatedRaw.String != "" {
		if value, err := time.Parse(time.RFC3339, lastEvaluatedRaw.String); err == nil {
			state.LastEvaluatedAt = &value
		}
	}
	if lastNoopRaw.Valid && lastNoopRaw.String != "" {
		if value, err := time.Parse(time.RFC3339, lastNoopRaw.String); err == nil {
			state.LastNoopAt = &value
		}
	}
	if updated, err := time.Parse(time.RFC3339, updatedRaw); err == nil {
		state.UpdatedAt = updated
	}
	return state, nil
}

func scanBatchScriptRunTarget(row serverScanner) (domain.BatchScriptRunTarget, error) {
	var target domain.BatchScriptRunTarget
	var selectorRaw string
	var exitCode sql.NullInt64
	var stdoutTruncated int
	var stderrTruncated int
	var startedRaw sql.NullString
	var finishedRaw sql.NullString
	if err := row.Scan(&target.RunID, &target.ServerID, &target.ServerLabelSnapshot, &target.VariantID, &selectorRaw, &target.State, &exitCode, &target.StdoutPreview, &stdoutTruncated, &target.StdoutRef, &target.StdoutBytes, &target.StderrPreview, &stderrTruncated, &target.StderrRef, &target.StderrBytes, &target.ErrorMessage, &startedRaw, &finishedRaw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return domain.BatchScriptRunTarget{}, ErrNotFound
		}
		return domain.BatchScriptRunTarget{}, err
	}
	_ = json.Unmarshal([]byte(selectorRaw), &target.VariantSelectorSnapshot)
	if target.VariantSelectorSnapshot == nil {
		target.VariantSelectorSnapshot = map[string]string{}
	}
	if exitCode.Valid {
		code := int(exitCode.Int64)
		target.ExitCode = &code
	}
	target.StdoutTruncated = intBool(stdoutTruncated)
	target.StderrTruncated = intBool(stderrTruncated)
	if startedRaw.Valid && startedRaw.String != "" {
		if started, err := time.Parse(time.RFC3339, startedRaw.String); err == nil {
			target.StartedAt = &started
		}
	}
	if finishedRaw.Valid && finishedRaw.String != "" {
		if finished, err := time.Parse(time.RFC3339, finishedRaw.String); err == nil {
			target.FinishedAt = &finished
		}
	}
	return target, nil
}

func nullableTimeString(value *time.Time) any {
	if value == nil || value.IsZero() {
		return nil
	}
	return formatTime(*value)
}

func normalizeBackupBucketInput(input domain.BackupBucketInput) (domain.BackupBucket, error) {
	label := sanitizeDetectedLabel(input.Label, 160)
	if label == "" {
		return domain.BackupBucket{}, fmt.Errorf("backup bucket label is required")
	}
	serverID := sanitizeVirtualDesktopReference(input.ServerID)
	if serverID == "" {
		return domain.BackupBucket{}, fmt.Errorf("backup bucket server is required")
	}
	rootPath, err := normalizeBackupAbsolutePath(input.RootPath, "backup bucket root path")
	if err != nil {
		return domain.BackupBucket{}, err
	}
	bucketPath, err := normalizeBackupAbsolutePath(input.BucketPath, "backup bucket path")
	if err != nil {
		return domain.BackupBucket{}, err
	}
	manifestStatus := sanitizeDetectedFact(input.ManifestStatus)
	if manifestStatus == "" {
		manifestStatus = "unknown"
	}
	return domain.BackupBucket{
		Label:          label,
		ServerID:       serverID,
		RootPath:       rootPath,
		BucketPath:     bucketPath,
		Filesystem:     sanitizeDetectedLabel(input.Filesystem, 80),
		FreeBytes:      nonNegativeInt64(input.FreeBytes),
		TotalBytes:     nonNegativeInt64(input.TotalBytes),
		ManifestStatus: manifestStatus,
	}, nil
}

func normalizeBackupTaskInput(input domain.BackupTaskInput) (domain.BackupTask, error) {
	label := sanitizeDetectedLabel(input.Label, 180)
	if label == "" {
		return domain.BackupTask{}, fmt.Errorf("backup task label is required")
	}
	sourceServerID := sanitizeVirtualDesktopReference(input.SourceServerID)
	if sourceServerID == "" {
		return domain.BackupTask{}, fmt.Errorf("backup task source server is required")
	}
	sourcePath, err := normalizeBackupAbsolutePath(input.SourcePath, "backup task source path")
	if err != nil {
		return domain.BackupTask{}, err
	}
	sourceKind := sanitizeDetectedFact(input.SourceKind)
	if sourceKind == "" {
		sourceKind = "unknown"
	}
	if sourceKind != "file" && sourceKind != "directory" && sourceKind != "unknown" {
		return domain.BackupTask{}, fmt.Errorf("backup task source kind must be file, directory, or unknown")
	}
	targetBucketID := strings.TrimSpace(input.TargetBucketID)
	if targetBucketID == "" {
		return domain.BackupTask{}, fmt.Errorf("backup task target bucket is required")
	}
	compression := sanitizeDetectedFact(input.Compression)
	if compression == "" {
		compression = "zstd"
	}
	if compression != "zstd" && compression != "gzip" {
		return domain.BackupTask{}, fmt.Errorf("backup compression must be zstd or gzip")
	}
	excludes := clampText(input.ExcludePatterns, 65536)
	return domain.BackupTask{
		Label:            label,
		SourceServerID:   sourceServerID,
		SourcePath:       sourcePath,
		SourceKind:       sourceKind,
		SourceFileCount:  nonNegativeInt64(input.SourceFileCount),
		SourceDiskBytes:  nonNegativeInt64(input.SourceDiskBytes),
		TargetBucketID:   strings.TrimSpace(input.TargetBucketID),
		FallbackBucketID: strings.TrimSpace(input.FallbackBucketID),
		ExcludePatterns:  excludes,
		Compression:      compression,
		Rotation:         normalizeBackupRotation(input.Rotation),
		Schedule:         normalizeBackupSchedule(input.Schedule),
	}, nil
}

func normalizeSSHTunnelInput(input domain.SSHTunnelInput) (domain.SSHTunnelProfile, error) {
	label := sanitizeDetectedLabel(input.Label, 160)
	if label == "" {
		return domain.SSHTunnelProfile{}, fmt.Errorf("SSH tunnel label is required")
	}
	kind := domain.SSHTunnelKind(sanitizeDetectedFact(string(input.Kind)))
	if kind == "" {
		kind = domain.SSHTunnelKindTCPForward
	}
	if kind != domain.SSHTunnelKindTCPForward && kind != domain.SSHTunnelKindSOCKS {
		return domain.SSHTunnelProfile{}, fmt.Errorf("SSH tunnel kind must be tcp_forward or socks")
	}
	serverID := sanitizeVirtualDesktopReference(input.ServerID)
	if serverID == "" {
		return domain.SSHTunnelProfile{}, fmt.Errorf("SSH tunnel through server is required")
	}
	bindAddress := normalizeTunnelHost(input.BindAddress, "bind address")
	if bindAddress == "" {
		return domain.SSHTunnelProfile{}, fmt.Errorf("SSH tunnel bind address is required")
	}
	if input.BindPort < 0 || input.BindPort > 65535 {
		return domain.SSHTunnelProfile{}, fmt.Errorf("SSH tunnel bind port must be 0..65535")
	}
	destinationHost := normalizeTunnelHost(input.DestinationHost, "destination host")
	destinationPort := input.DestinationPort
	if kind == domain.SSHTunnelKindTCPForward {
		if destinationHost == "" {
			return domain.SSHTunnelProfile{}, fmt.Errorf("TCP forward destination host is required")
		}
		if destinationPort <= 0 || destinationPort > 65535 {
			return domain.SSHTunnelProfile{}, fmt.Errorf("TCP forward destination port must be 1..65535")
		}
	} else {
		if destinationHost != "" || destinationPort != 0 {
			return domain.SSHTunnelProfile{}, fmt.Errorf("SOCKS proxy does not accept a destination host or port")
		}
	}
	return domain.SSHTunnelProfile{
		Label:             label,
		Kind:              kind,
		ServerID:          serverID,
		BindAddress:       bindAddress,
		BindPort:          input.BindPort,
		DestinationHost:   destinationHost,
		DestinationPort:   destinationPort,
		AutoStart:         input.AutoStart,
		AutoReconnect:     input.AutoReconnect,
		PauseOnDisconnect: input.PauseOnDisconnect,
		Paused:            input.Paused,
		Tags:              uniqueNonEmptyTrimmed(input.Tags, 32),
	}, nil
}

func normalizeTunnelHost(value string, field string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if len(value) > 253 || strings.ContainsAny(value, "\x00\r\n\t /\\:@?#[]{}'\"`$;&|<>") {
		return ""
	}
	return value
}

func normalizeBackupRotation(rotation domain.BackupRotationPolicy) domain.BackupRotationPolicy {
	if rotation.KeepLatest <= 0 {
		rotation.KeepLatest = 3
	}
	if rotation.KeepWeekly <= 0 {
		rotation.KeepWeekly = 3
	}
	if rotation.KeepMonthly <= 0 {
		rotation.KeepMonthly = 3
	}
	if rotation.KeepLatest > 365 {
		rotation.KeepLatest = 365
	}
	if rotation.KeepWeekly > 260 {
		rotation.KeepWeekly = 260
	}
	if rotation.KeepMonthly > 120 {
		rotation.KeepMonthly = 120
	}
	return rotation
}

func normalizeBackupSchedule(schedule domain.BackupSchedule) domain.BackupSchedule {
	schedule.Kind = sanitizeDetectedFact(schedule.Kind)
	if schedule.Kind == "" {
		schedule.Kind = "manual"
	}
	switch schedule.Kind {
	case "manual":
		schedule.Enabled = false
	case "daily", "weekly", "monthly":
	default:
		schedule.Kind = "manual"
		schedule.Enabled = false
	}
	if schedule.Hour < 0 || schedule.Hour > 23 {
		schedule.Hour = 2
	}
	if schedule.Minute < 0 || schedule.Minute > 59 {
		schedule.Minute = 0
	}
	return schedule
}

func normalizeBackupAbsolutePath(value string, field string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", fmt.Errorf("%s is required", field)
	}
	if len(value) > 2048 {
		return "", fmt.Errorf("%s is too long", field)
	}
	if strings.ContainsRune(value, 0) {
		return "", fmt.Errorf("%s contains an invalid byte", field)
	}
	if strings.HasPrefix(value, "/") || (len(value) >= 3 && value[1] == ':' && (value[2] == '\\' || value[2] == '/')) || strings.HasPrefix(value, `\\`) {
		return value, nil
	}
	return "", fmt.Errorf("%s must be absolute", field)
}

func clampText(value string, maxLen int) string {
	value = strings.TrimSpace(value)
	if maxLen <= 0 || len(value) <= maxLen {
		return value
	}
	return value[:maxLen]
}

func nonNegativeInt64(value int64) int64 {
	if value < 0 {
		return 0
	}
	return value
}

func nonNegativeInt(value int) int {
	if value < 0 {
		return 0
	}
	return value
}

func normalizeBatchScriptTemplateInput(input domain.BatchScriptTemplateInput) (domain.BatchScriptTemplate, error) {
	name := strings.TrimSpace(input.Name)
	if name == "" {
		return domain.BatchScriptTemplate{}, fmt.Errorf("batch script name is required")
	}
	if len([]rune(name)) > 200 {
		return domain.BatchScriptTemplate{}, fmt.Errorf("batch script name must be 200 characters or shorter")
	}
	description := strings.TrimSpace(input.Description)
	timeout := input.DefaultTimeoutSeconds
	if timeout == 0 {
		timeout = 1800
	}
	if timeout < 5 || timeout > 86400 {
		return domain.BatchScriptTemplate{}, fmt.Errorf("default timeout must be between 5 seconds and 24 hours")
	}
	concurrency := input.DefaultConcurrency
	if concurrency == 0 {
		concurrency = 8
	}
	if concurrency < 1 || concurrency > 128 {
		return domain.BatchScriptTemplate{}, fmt.Errorf("default concurrency must be between 1 and 128 targets")
	}
	failurePolicy := input.FailurePolicy
	if failurePolicy == "" {
		failurePolicy = domain.BatchScriptFailureContinue
	}
	switch failurePolicy {
	case domain.BatchScriptFailureContinue, domain.BatchScriptFailureStopOnFirstFailure, domain.BatchScriptFailureStopAfterPercentFailed:
	default:
		return domain.BatchScriptTemplate{}, fmt.Errorf("unknown batch script failure policy")
	}
	selector := normalizeBatchScriptTargetSelector(input.TargetSelector)
	variants, err := normalizeBatchScriptVariants(input.Variants, timeout)
	if err != nil {
		return domain.BatchScriptTemplate{}, err
	}
	schedule := normalizeBatchScriptSchedule(input.Schedule)
	retention := normalizeBatchScriptRetention(input.Retention)
	return domain.BatchScriptTemplate{
		Name:                  name,
		Description:           description,
		Enabled:               input.Enabled,
		TargetSelector:        selector,
		DefaultTimeoutSeconds: timeout,
		DefaultConcurrency:    concurrency,
		FailurePolicy:         failurePolicy,
		PreflightRequired:     input.PreflightRequired,
		Schedule:              schedule,
		Retention:             retention,
		Variants:              variants,
	}, nil
}

// NormalizeBatchScriptTemplateInput applies the same validation and defaults as
// persisted batch-script create/update without writing the template to storage.
func NormalizeBatchScriptTemplateInput(input domain.BatchScriptTemplateInput) (domain.BatchScriptTemplate, error) {
	return normalizeBatchScriptTemplateInput(input)
}

func normalizeBatchScriptTargetSelector(input domain.BatchScriptTargetSelector) domain.BatchScriptTargetSelector {
	status := strings.TrimSpace(input.RequiredStatus)
	if status == "" {
		status = "connected"
	}
	return domain.BatchScriptTargetSelector{
		ServerIDs:             uniqueNonEmptyTrimmed(input.ServerIDs, 500),
		IncludeTags:           uniqueNonEmptyTrimmed(input.IncludeTags, 100),
		ExcludeTags:           uniqueNonEmptyTrimmed(input.ExcludeTags, 100),
		RequiredStatus:        status,
		PlatformFilters:       uniqueNonEmptyTrimmed(input.PlatformFilters, 100),
		DistroFilters:         uniqueNonEmptyTrimmed(input.DistroFilters, 100),
		PackageManagerFilters: uniqueNonEmptyTrimmed(input.PackageManagerFilters, 100),
	}
}

func normalizeBatchScriptSchedule(input domain.BatchScriptSchedule) domain.BatchScriptSchedule {
	interval := input.IntervalSeconds
	if interval < 0 {
		interval = 0
	}
	if interval > 0 && interval < 60 {
		interval = 60
	}
	if interval > 31536000 {
		interval = 31536000
	}
	policy := input.MissedRunPolicy
	if policy == "" {
		policy = domain.BatchScriptMissedRunOnce
	}
	switch policy {
	case domain.BatchScriptMissedRunOnce, domain.BatchScriptMissedRunSkip:
	default:
		policy = domain.BatchScriptMissedRunOnce
	}
	return domain.BatchScriptSchedule{Enabled: input.Enabled && interval > 0, IntervalSeconds: interval, Timezone: strings.TrimSpace(input.Timezone), MissedRunPolicy: policy}
}

func normalizeBatchScriptRetention(input domain.BatchScriptRetention) domain.BatchScriptRetention {
	maxRuns := input.MaxRuns
	if maxRuns == 0 {
		maxRuns = 50
	}
	if maxRuns < 1 {
		maxRuns = 1
	}
	if maxRuns > 500 {
		maxRuns = 500
	}
	maxOutputBytes := input.MaxOutputBytes
	if maxOutputBytes == 0 {
		maxOutputBytes = 256 * 1024
	}
	if maxOutputBytes < 16*1024 {
		maxOutputBytes = 16 * 1024
	}
	if maxOutputBytes > 256*1024*1024 {
		maxOutputBytes = 256 * 1024 * 1024
	}
	deleteAfterDays := input.DeleteAfterDays
	if deleteAfterDays == 0 {
		deleteAfterDays = 30
	}
	if deleteAfterDays < 1 {
		deleteAfterDays = 1
	}
	if deleteAfterDays > 3650 {
		deleteAfterDays = 3650
	}
	return domain.BatchScriptRetention{MaxRuns: maxRuns, MaxOutputBytes: maxOutputBytes, DeleteAfterDays: deleteAfterDays}
}

func normalizeBatchScriptVariants(values []domain.BatchScriptVariant, defaultTimeout int) ([]domain.BatchScriptVariant, error) {
	if len(values) > 64 {
		return nil, fmt.Errorf("a batch script may contain at most 64 variants")
	}
	out := make([]domain.BatchScriptVariant, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		variant := domain.BatchScriptVariant{
			ID:             strings.TrimSpace(value.ID),
			TargetKind:     strings.TrimSpace(value.TargetKind),
			Platform:       strings.TrimSpace(value.Platform),
			Distro:         strings.TrimSpace(value.Distro),
			PackageManager: strings.TrimSpace(value.PackageManager),
			Shell:          strings.TrimSpace(value.Shell),
			ScriptBody:     value.ScriptBody,
			PreflightBody:  value.PreflightBody,
			TimeoutSeconds: value.TimeoutSeconds,
			State:          value.State,
			SyntaxLanguage: strings.TrimSpace(value.SyntaxLanguage),
		}
		if variant.ID == "" {
			variant.ID = uuid.NewString()
		}
		if seen[variant.ID] {
			return nil, fmt.Errorf("batch script variant id is duplicated")
		}
		seen[variant.ID] = true
		if variant.TargetKind == "" {
			variant.TargetKind = "posix"
		}
		if variant.Shell == "" {
			variant.Shell = "posix"
		}
		if !allowedBatchScriptShell(variant.Shell) {
			return nil, fmt.Errorf("unsupported batch script shell %q", variant.Shell)
		}
		if variant.State == "" {
			variant.State = domain.BatchScriptVariantSkip
		}
		if variant.State != domain.BatchScriptVariantSkip && variant.State != domain.BatchScriptVariantReady {
			return nil, fmt.Errorf("unknown batch script variant state")
		}
		if variant.TimeoutSeconds == 0 {
			variant.TimeoutSeconds = defaultTimeout
		}
		if variant.TimeoutSeconds < 5 || variant.TimeoutSeconds > 86400 {
			return nil, fmt.Errorf("variant timeout must be between 5 seconds and 24 hours")
		}
		if variant.State == domain.BatchScriptVariantReady && strings.TrimSpace(variant.ScriptBody) == "" {
			return nil, fmt.Errorf("ready batch script variants require a script body")
		}
		if len(variant.ScriptBody) > 1024*1024 || len(variant.PreflightBody) > 1024*1024 {
			return nil, fmt.Errorf("batch script variant bodies must be 1 MiB or smaller")
		}
		if variant.SyntaxLanguage == "" {
			variant.SyntaxLanguage = syntaxLanguageForBatchShell(variant.Shell)
		}
		out = append(out, variant)
	}
	return out, nil
}

func allowedBatchScriptShell(value string) bool {
	switch value {
	case "posix", "bash", "zsh", "powershell", "cmd_wrapped_powershell":
		return true
	default:
		return false
	}
}

func syntaxLanguageForBatchShell(value string) string {
	switch value {
	case "powershell", "cmd_wrapped_powershell":
		return "powershell"
	default:
		return "shell"
	}
}

func uniqueNonEmptyTrimmed(values []string, limit int) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, value := range values {
		cleaned := strings.TrimSpace(value)
		if cleaned == "" {
			continue
		}
		key := strings.ToLower(cleaned)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, cleaned)
		if len(out) >= limit {
			break
		}
	}
	return out
}

const serverSelectColumns = `SELECT id, name, host, port, username, connection_mode, jump_server_id, auth_method, ssh_key_id,
	shell_hint, os_hint, distro_hint, detected_shell, detected_os, detected_distro, detected_admin_rights,
	detected_hostname, detected_platform, detected_platform_os, detected_platform_arch, detected_kernel_version,
	detected_package_manager, detected_ssh_max_sessions, detected_pve_host, detected_docker_host, detected_apps_json,
	override_shell, override_os, override_distro, override_admin_rights,
	host_key, tags_json, notes, created_at, updated_at FROM servers`

func NormalizeServerInput(input domain.ServerInput) (domain.Server, error) {
	return normalizeServerInput(input)
}

func normalizeServerInput(input domain.ServerInput) (domain.Server, error) {
	name := strings.TrimSpace(input.Name)
	host := strings.TrimSpace(input.Host)
	username := strings.TrimSpace(input.Username)
	if name == "" {
		return domain.Server{}, fmt.Errorf("server name is required")
	}
	if host == "" {
		return domain.Server{}, fmt.Errorf("server host is required")
	}
	if username == "" {
		return domain.Server{}, fmt.Errorf("server username is required")
	}
	if input.Port < 1 || input.Port > 65535 {
		return domain.Server{}, fmt.Errorf("server port must be between 1 and 65535")
	}
	connectionMode := input.ConnectionMode
	if connectionMode == "" {
		connectionMode = domain.ServerConnectionDirect
	}
	if connectionMode != domain.ServerConnectionDirect && connectionMode != domain.ServerConnectionChained {
		return domain.Server{}, fmt.Errorf("server connection mode must be direct or chained")
	}
	jumpServerID := strings.TrimSpace(input.JumpServerID)
	if connectionMode == domain.ServerConnectionDirect {
		jumpServerID = ""
	}
	if connectionMode == domain.ServerConnectionChained && jumpServerID == "" {
		return domain.Server{}, fmt.Errorf("jump server is required for chained connections")
	}
	authMethod := input.AuthMethod
	if authMethod == "" {
		authMethod = domain.ServerAuthCA
	}
	if authMethod != domain.ServerAuthCA && authMethod != domain.ServerAuthClassic && authMethod != domain.ServerAuthCustomKey && authMethod != domain.ServerAuthLocalProtectedKey {
		return domain.Server{}, fmt.Errorf("server authentication method must be ca, classic, custom_key, or local_protected_key")
	}
	sshKeyID := strings.TrimSpace(input.SSHKeyID)
	if authMethod != domain.ServerAuthCustomKey {
		sshKeyID = ""
	}
	if authMethod == domain.ServerAuthCustomKey && sshKeyID == "" {
		return domain.Server{}, fmt.Errorf("SSH key is required when own key authentication is selected")
	}
	detectedShell, detectedOS, detectedDistro, detectedAdmin := normalizeDetectedFacts(input.DetectedShell, input.DetectedOS, input.DetectedDistro, input.DetectedAdminRights)
	overrideShell, overrideOS, overrideDistro, overrideAdmin := normalizeDetectedFacts(input.OverrideShell, input.OverrideOS, input.OverrideDistro, input.OverrideAdminRights)
	server := domain.Server{
		Name: name, Host: host, Port: input.Port, Username: username,
		ConnectionMode: connectionMode, JumpServerID: jumpServerID, AuthMethod: authMethod, SSHKeyID: sshKeyID,
		DetectedShell: detectedShell, DetectedOS: detectedOS, DetectedDistro: detectedDistro, DetectedAdminRights: overrideBlankAdmin(detectedAdmin),
		DetectedHostname:       sanitizeDetectedFact(input.DetectedHostname),
		DetectedPlatform:       sanitizeDetectedLabel(input.DetectedPlatform, 96),
		DetectedPlatformOS:     sanitizeDetectedFact(input.DetectedPlatformOS),
		DetectedPlatformArch:   sanitizeDetectedFact(input.DetectedPlatformArch),
		DetectedKernelVersion:  sanitizeDetectedLabel(input.DetectedKernelVersion, 128),
		DetectedPackageManager: sanitizeDetectedFact(input.DetectedPackageManager),
		DetectedSSHMaxSessions: nonNegativeInt(input.DetectedSSHMaxSessions),
		DetectedPVEHost:        input.DetectedPVEHost,
		DetectedDockerHost:     input.DetectedDockerHost,
		DetectedApps:           normalizeDetectedApps(input.DetectedApps),
		OverrideShell:          overrideBlankShell(overrideShell), OverrideOS: overrideOS, OverrideDistro: overrideDistro, OverrideAdminRights: overrideBlankAdmin(overrideAdmin),
		HostKey: strings.TrimSpace(input.HostKey), Tags: uniqueNonEmptyTrimmed(input.Tags, 64), Notes: input.Notes,
	}
	applyServerOverrides(&server)
	return server, nil
}

func normalizeDetectedFacts(shell string, osName string, distro string, adminRights string) (string, string, string, string) {
	shell = strings.ToLower(strings.TrimSpace(shell))
	switch shell {
	case "", "auto":
		shell = "auto"
	case "sh", "dash", "ash", "ksh":
		shell = "posix"
	case "bash", "zsh", "posix", "powershell":
	case "pwsh":
		shell = "powershell"
	default:
		shell = "posix"
	}
	return shell, sanitizeDetectedFact(osName), sanitizeDetectedFact(distro), normalizeAdminRights(adminRights)
}

func normalizeAdminRights(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	switch value {
	case "passwordless_sudo", "passwordless_doas", "sudo", "doas", "root", "administrator", "admin", "none", "unknown":
		if value == "sudo" {
			return "passwordless_sudo"
		}
		if value == "doas" {
			return "passwordless_doas"
		}
		if value == "admin" {
			return "administrator"
		}
		return value
	case "":
		return ""
	default:
		return "unknown"
	}
}

func overrideBlankShell(value string) string {
	if value == "auto" {
		return ""
	}
	return value
}

func overrideBlankAdmin(value string) string {
	if value == "unknown" {
		return ""
	}
	return value
}

func applyServerOverrides(server *domain.Server) {
	server.ShellHint = server.DetectedShell
	if server.ShellHint == "" {
		server.ShellHint = "auto"
	}
	server.OSHint = server.DetectedOS
	server.DistroHint = server.DetectedDistro
	if server.OverrideShell != "" {
		server.ShellHint = server.OverrideShell
	}
	if server.OverrideOS != "" {
		server.OSHint = server.OverrideOS
	}
	if server.OverrideDistro != "" {
		server.DistroHint = server.OverrideDistro
	}
}

func sanitizeDetectedFact(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var builder strings.Builder
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			builder.WriteRune(r)
		}
		if builder.Len() >= 64 {
			break
		}
	}
	return builder.String()
}

func sanitizeDetectedLabel(value string, maxLen int) string {
	value = strings.TrimSpace(value)
	if maxLen <= 0 {
		maxLen = 64
	}
	var builder strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z':
			builder.WriteRune(r)
		case r >= 'A' && r <= 'Z':
			builder.WriteRune(r)
		case r >= '0' && r <= '9':
			builder.WriteRune(r)
		case strings.ContainsRune(" ._:-+/()", r):
			builder.WriteRune(r)
		}
		if builder.Len() >= maxLen {
			break
		}
	}
	return strings.TrimSpace(builder.String())
}

func normalizeDetectedApps(apps map[string]bool) map[string]bool {
	out := map[string]bool{}
	for name, installed := range apps {
		key := sanitizeDetectedFact(name)
		if key == "" {
			continue
		}
		out[key] = installed
	}
	return out
}

func intBool(value int) bool { return value != 0 }

func intBoolValue(value bool) int {
	if value {
		return 1
	}
	return 0
}

type serverScanner interface{ Scan(dest ...any) error }

func scanServer(row serverScanner) (domain.Server, error) {
	var server domain.Server
	var tagsRaw string
	var createdRaw string
	var updatedRaw string
	var connectionMode string
	var authMethod string
	var pveHost int
	var dockerHost int
	var appsRaw string
	if err := row.Scan(
		&server.ID, &server.Name, &server.Host, &server.Port, &server.Username,
		&connectionMode, &server.JumpServerID, &authMethod, &server.SSHKeyID,
		&server.ShellHint, &server.OSHint, &server.DistroHint, &server.DetectedShell, &server.DetectedOS, &server.DetectedDistro, &server.DetectedAdminRights,
		&server.DetectedHostname, &server.DetectedPlatform, &server.DetectedPlatformOS, &server.DetectedPlatformArch, &server.DetectedKernelVersion,
		&server.DetectedPackageManager, &server.DetectedSSHMaxSessions, &pveHost, &dockerHost, &appsRaw,
		&server.OverrideShell, &server.OverrideOS, &server.OverrideDistro, &server.OverrideAdminRights,
		&server.HostKey, &tagsRaw, &server.Notes, &createdRaw, &updatedRaw,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return domain.Server{}, ErrNotFound
		}
		return domain.Server{}, err
	}
	server.ConnectionMode = domain.ServerConnectionMode(connectionMode)
	if server.ConnectionMode == "" {
		server.ConnectionMode = domain.ServerConnectionDirect
	}
	server.AuthMethod = domain.ServerAuthMethod(authMethod)
	if server.AuthMethod == "" {
		server.AuthMethod = domain.ServerAuthCA
	}
	if server.DetectedShell == "" && server.ShellHint != "" && server.ShellHint != "auto" {
		server.DetectedShell = server.ShellHint
	}
	if server.DetectedOS == "" && server.OSHint != "" {
		server.DetectedOS = server.OSHint
	}
	if server.DetectedDistro == "" && server.DistroHint != "" {
		server.DetectedDistro = server.DistroHint
	}
	server.DetectedPVEHost = intBool(pveHost)
	server.DetectedDockerHost = intBool(dockerHost)
	_ = json.Unmarshal([]byte(appsRaw), &server.DetectedApps)
	if server.DetectedApps == nil {
		server.DetectedApps = map[string]bool{}
	}
	_ = json.Unmarshal([]byte(tagsRaw), &server.Tags)
	server.CreatedAt, _ = time.Parse(time.RFC3339, createdRaw)
	server.UpdatedAt, _ = time.Parse(time.RFC3339, updatedRaw)
	return server, nil
}

func scanScriptRun(row serverScanner) (domain.ScriptRun, error) {
	var run domain.ScriptRun
	var resultRaw string
	var createdRaw string
	var finishedRaw sql.NullString
	if err := row.Scan(&run.ID, &run.ServerID, &run.Command, &run.Variant, &run.State, &resultRaw, &run.Error, &createdRaw, &finishedRaw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return domain.ScriptRun{}, ErrNotFound
		}
		return domain.ScriptRun{}, err
	}
	_ = json.Unmarshal([]byte(resultRaw), &run.Result)
	run.CreatedAt, _ = time.Parse(time.RFC3339, createdRaw)
	if finishedRaw.Valid && finishedRaw.String != "" {
		finished, err := time.Parse(time.RFC3339, finishedRaw.String)
		if err == nil {
			run.FinishedAt = &finished
		}
	}
	return run, nil
}

func scanBackupBucket(row serverScanner) (domain.BackupBucket, error) {
	var bucket domain.BackupBucket
	var lastProbeRaw sql.NullString
	var createdRaw string
	var updatedRaw string
	if err := row.Scan(&bucket.ID, &bucket.Label, &bucket.ServerID, &bucket.RootPath, &bucket.BucketPath, &bucket.Filesystem, &bucket.FreeBytes, &bucket.TotalBytes, &bucket.ManifestStatus, &lastProbeRaw, &createdRaw, &updatedRaw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return domain.BackupBucket{}, ErrNotFound
		}
		return domain.BackupBucket{}, err
	}
	if lastProbeRaw.Valid && lastProbeRaw.String != "" {
		if lastProbeAt, err := time.Parse(time.RFC3339, lastProbeRaw.String); err == nil {
			bucket.LastProbeAt = &lastProbeAt
		}
	}
	bucket.CreatedAt, _ = time.Parse(time.RFC3339, createdRaw)
	bucket.UpdatedAt, _ = time.Parse(time.RFC3339, updatedRaw)
	return bucket, nil
}

func scanBackupTask(row serverScanner) (domain.BackupTask, error) {
	var task domain.BackupTask
	var rotationRaw string
	var scheduleRaw string
	var lastSuccessRaw sql.NullString
	var createdRaw string
	var updatedRaw string
	if err := row.Scan(&task.ID, &task.Label, &task.SourceServerID, &task.SourcePath, &task.SourceKind, &task.SourceFileCount, &task.SourceDiskBytes, &task.TargetBucketID, &task.FallbackBucketID, &task.ExcludePatterns, &task.Compression, &rotationRaw, &scheduleRaw, &task.LastRunID, &task.LastRunState, &lastSuccessRaw, &createdRaw, &updatedRaw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return domain.BackupTask{}, ErrNotFound
		}
		return domain.BackupTask{}, err
	}
	_ = json.Unmarshal([]byte(rotationRaw), &task.Rotation)
	_ = json.Unmarshal([]byte(scheduleRaw), &task.Schedule)
	task.Rotation = normalizeBackupRotation(task.Rotation)
	task.Schedule = normalizeBackupSchedule(task.Schedule)
	if lastSuccessRaw.Valid && lastSuccessRaw.String != "" {
		if lastSuccessAt, err := time.Parse(time.RFC3339, lastSuccessRaw.String); err == nil {
			task.LastSuccessAt = &lastSuccessAt
		}
	}
	task.CreatedAt, _ = time.Parse(time.RFC3339, createdRaw)
	task.UpdatedAt, _ = time.Parse(time.RFC3339, updatedRaw)
	return task, nil
}

func scanBackupRun(row serverScanner) (domain.BackupRun, error) {
	var run domain.BackupRun
	var createdRaw string
	var startedRaw string
	var finishedRaw sql.NullString
	if err := row.Scan(&run.ID, &run.TaskID, &run.Trigger, &run.State, &run.ScriptRunID, &run.Log, &run.Error, &run.ArchiveName, &run.ArchiveBytes, &createdRaw, &startedRaw, &finishedRaw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return domain.BackupRun{}, ErrNotFound
		}
		return domain.BackupRun{}, err
	}
	run.CreatedAt, _ = time.Parse(time.RFC3339, createdRaw)
	run.StartedAt, _ = time.Parse(time.RFC3339, startedRaw)
	if finishedRaw.Valid && finishedRaw.String != "" {
		if finishedAt, err := time.Parse(time.RFC3339, finishedRaw.String); err == nil {
			run.FinishedAt = &finishedAt
		}
	}
	return run, nil
}

func scanSSHUserKey(row serverScanner) (SSHUserKey, error) {
	var key SSHUserKey
	var createdRaw string
	var updatedRaw string
	if err := row.Scan(&key.ID, &key.Label, &key.PublicKeyOpenSSH, &key.PrivateKeyOpenSSH, &createdRaw, &updatedRaw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return SSHUserKey{}, ErrNotFound
		}
		return SSHUserKey{}, err
	}
	key.CreatedAt, _ = time.Parse(time.RFC3339, createdRaw)
	key.UpdatedAt, _ = time.Parse(time.RFC3339, updatedRaw)
	return key, nil
}

func scanStatus(row serverScanner) (domain.ServerStatus, error) {
	var status domain.ServerStatus
	var telemetryRaw string
	var updatedRaw string
	if err := row.Scan(&status.ServerID, &status.State, &telemetryRaw, &status.LastError, &updatedRaw); err != nil {
		return domain.ServerStatus{}, err
	}
	_ = json.Unmarshal([]byte(telemetryRaw), &status.Telemetry)
	status.UpdatedAt, _ = time.Parse(time.RFC3339, updatedRaw)
	return status, nil
}

func scanSSHTunnel(row serverScanner) (domain.SSHTunnelProfile, error) {
	var tunnel domain.SSHTunnelProfile
	var autoStart int
	var autoReconnect int
	var pauseOnDisconnect int
	var paused int
	var tagsRaw string
	var createdRaw string
	var updatedRaw string
	if err := row.Scan(&tunnel.ID, &tunnel.Label, &tunnel.Kind, &tunnel.ServerID, &tunnel.BindAddress, &tunnel.BindPort, &tunnel.DestinationHost, &tunnel.DestinationPort, &autoStart, &autoReconnect, &pauseOnDisconnect, &paused, &tagsRaw, &createdRaw, &updatedRaw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return domain.SSHTunnelProfile{}, ErrNotFound
		}
		return domain.SSHTunnelProfile{}, err
	}
	tunnel.AutoStart = intBool(autoStart)
	tunnel.AutoReconnect = intBool(autoReconnect)
	tunnel.PauseOnDisconnect = intBool(pauseOnDisconnect)
	tunnel.Paused = intBool(paused)
	_ = json.Unmarshal([]byte(tagsRaw), &tunnel.Tags)
	tunnel.CreatedAt, _ = time.Parse(time.RFC3339, createdRaw)
	tunnel.UpdatedAt, _ = time.Parse(time.RFC3339, updatedRaw)
	return tunnel, nil
}

func scanVirtualDesktopWallpaper(row serverScanner) (domain.VirtualDesktopWallpaper, error) {
	var wallpaper domain.VirtualDesktopWallpaper
	var createdRaw string
	var updatedRaw string
	if err := row.Scan(&wallpaper.ID, &wallpaper.Label, &wallpaper.ContentType, &wallpaper.Source, &createdRaw, &updatedRaw); err != nil {
		return domain.VirtualDesktopWallpaper{}, err
	}
	wallpaper.CreatedAt, _ = time.Parse(time.RFC3339, createdRaw)
	wallpaper.UpdatedAt, _ = time.Parse(time.RFC3339, updatedRaw)
	return wallpaper, nil
}

func scanTrustedDevice(row serverScanner) (TrustedDevice, error) {
	var device TrustedDevice
	var kindRaw string
	var approvedRaw sql.NullString
	var createdRaw string
	var updatedRaw string
	if err := row.Scan(
		&device.ID,
		&device.Label,
		&kindRaw,
		&approvedRaw,
		&device.CredentialID,
		&device.PublicKeyB64,
		&device.SigningKeyB64,
		&device.EnvelopeKeyB64,
		&device.SignerEpoch,
		&device.UserHandleB64,
		&device.CredentialJSON,
		&createdRaw,
		&updatedRaw,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return TrustedDevice{}, ErrNotFound
		}
		return TrustedDevice{}, err
	}
	device.Kind = domain.DeviceKind(kindRaw)
	if approvedRaw.Valid {
		approvedAt, err := time.Parse(time.RFC3339, approvedRaw.String)
		if err != nil {
			return TrustedDevice{}, err
		}
		device.ApprovedAt = &approvedAt
	}
	createdAt, err := time.Parse(time.RFC3339, createdRaw)
	if err != nil {
		return TrustedDevice{}, err
	}
	updatedAt, err := time.Parse(time.RFC3339, updatedRaw)
	if err != nil {
		return TrustedDevice{}, err
	}
	device.CreatedAt = createdAt
	device.UpdatedAt = updatedAt
	return device, nil
}

func scanTrustedDeviceOverview(row serverScanner) (TrustedDeviceOverview, error) {
	var overview TrustedDeviceOverview
	var kindRaw string
	var approvedRaw sql.NullString
	var createdRaw string
	var updatedRaw string
	var lastLoginRaw sql.NullString
	var lastLoginIP sql.NullString
	var keyShareUpdatedRaw sql.NullString
	if err := row.Scan(
		&overview.Device.ID,
		&overview.Device.Label,
		&kindRaw,
		&approvedRaw,
		&overview.Device.CredentialID,
		&overview.Device.PublicKeyB64,
		&overview.Device.SigningKeyB64,
		&overview.Device.EnvelopeKeyB64,
		&overview.Device.SignerEpoch,
		&overview.Device.UserHandleB64,
		&overview.Device.CredentialJSON,
		&createdRaw,
		&updatedRaw,
		&lastLoginRaw,
		&lastLoginIP,
		&overview.ActiveSessionCount,
		&overview.LatestKeyShareEpoch,
		&keyShareUpdatedRaw,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return TrustedDeviceOverview{}, ErrNotFound
		}
		return TrustedDeviceOverview{}, err
	}
	overview.Device.Kind = domain.DeviceKind(kindRaw)
	if approvedRaw.Valid {
		approvedAt, err := time.Parse(time.RFC3339, approvedRaw.String)
		if err != nil {
			return TrustedDeviceOverview{}, err
		}
		overview.Device.ApprovedAt = &approvedAt
	}
	createdAt, err := time.Parse(time.RFC3339, createdRaw)
	if err != nil {
		return TrustedDeviceOverview{}, err
	}
	updatedAt, err := time.Parse(time.RFC3339, updatedRaw)
	if err != nil {
		return TrustedDeviceOverview{}, err
	}
	overview.Device.CreatedAt = createdAt
	overview.Device.UpdatedAt = updatedAt
	if lastLoginRaw.Valid {
		lastLoginAt, err := time.Parse(time.RFC3339, lastLoginRaw.String)
		if err != nil {
			return TrustedDeviceOverview{}, err
		}
		overview.LastLoginAt = &lastLoginAt
	}
	if lastLoginIP.Valid {
		overview.LastLoginIP = lastLoginIP.String
	}
	if keyShareUpdatedRaw.Valid {
		keyShareUpdatedAt, err := time.Parse(time.RFC3339, keyShareUpdatedRaw.String)
		if err != nil {
			return TrustedDeviceOverview{}, err
		}
		overview.LatestKeyShareUpdatedAt = &keyShareUpdatedAt
	}
	return overview, nil
}

func scanDeviceRequest(row serverScanner) (PendingDeviceRequest, error) {
	var request PendingDeviceRequest
	var kindRaw string
	var stateRaw string
	var createdRaw string
	var expiresRaw string
	var decidedRaw sql.NullString
	if err := row.Scan(
		&request.ID,
		&request.PollTokenHash,
		&request.Label,
		&kindRaw,
		&request.DeviceID,
		&request.CredentialID,
		&request.PublicKeyB64,
		&request.UserHandleB64,
		&request.CredentialJSON,
		&request.EnvelopePublicKeySPKIB64,
		&request.VerificationCode,
		&request.EncryptedDeviceShareB64,
		&stateRaw,
		&createdRaw,
		&expiresRaw,
		&decidedRaw,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return PendingDeviceRequest{}, ErrNotFound
		}
		return PendingDeviceRequest{}, err
	}
	request.Kind = domain.DeviceKind(kindRaw)
	request.State = DeviceRequestState(stateRaw)
	var err error
	request.CreatedAt, err = time.Parse(time.RFC3339, createdRaw)
	if err != nil {
		return PendingDeviceRequest{}, err
	}
	request.ExpiresAt, err = time.Parse(time.RFC3339, expiresRaw)
	if err != nil {
		return PendingDeviceRequest{}, err
	}
	if decidedRaw.Valid {
		decidedAt, err := time.Parse(time.RFC3339, decidedRaw.String)
		if err != nil {
			return PendingDeviceRequest{}, err
		}
		request.DecidedAt = &decidedAt
	}
	return request, nil
}

func scanKeyChangeApproval(row serverScanner) (KeyChangeApproval, error) {
	var approval KeyChangeApproval
	var stateRaw string
	var createdRaw string
	var expiresRaw string
	var decidedRaw sql.NullString
	if err := row.Scan(
		&approval.ID,
		&approval.PollTokenHash,
		&approval.ApprovedByDeviceID,
		&approval.VerificationCode,
		&stateRaw,
		&createdRaw,
		&expiresRaw,
		&decidedRaw,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return KeyChangeApproval{}, ErrNotFound
		}
		return KeyChangeApproval{}, err
	}
	approval.State = KeyChangeApprovalState(stateRaw)
	var err error
	approval.CreatedAt, err = time.Parse(time.RFC3339, createdRaw)
	if err != nil {
		return KeyChangeApproval{}, err
	}
	approval.ExpiresAt, err = time.Parse(time.RFC3339, expiresRaw)
	if err != nil {
		return KeyChangeApproval{}, err
	}
	if decidedRaw.Valid {
		decidedAt, err := time.Parse(time.RFC3339, decidedRaw.String)
		if err != nil {
			return KeyChangeApproval{}, err
		}
		approval.DecidedAt = &decidedAt
	}
	return approval, nil
}

func formatTime(t time.Time) string { return t.UTC().Format(time.RFC3339) }

func nullableTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return formatTime(*t)
}

func (s *SQLiteStore) CountApprovedDevices(ctx context.Context) (int, error) {
	row := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM trusted_devices WHERE approved_at IS NOT NULL`)
	var count int
	if err := row.Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

func (s *SQLiteStore) UpdateScriptRunResult(ctx context.Context, run domain.ScriptRun) error {
	if run.FinishedAt == nil {
		now := time.Now().UTC()
		run.FinishedAt = &now
	}
	result, _ := json.Marshal(run.Result)
	res, err := s.db.ExecContext(ctx, `UPDATE script_runs SET state = ?, result_json = ?, error = ?, finished_at = ? WHERE id = ?`, run.State, string(result), run.Error, formatTime(*run.FinishedAt), run.ID)
	if err != nil {
		return err
	}
	count, _ := res.RowsAffected()
	if count == 0 {
		return ErrNotFound
	}
	return nil
}
