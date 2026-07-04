// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package config

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"shellorchestra/backend/internal/buildinfo"

	"github.com/pelletier/go-toml/v2"
)

type AppConfig struct {
	App         AppSection         `toml:"app"`
	Database    DatabaseSection    `toml:"database"`
	Security    SecuritySection    `toml:"security"`
	Internal    InternalSection    `toml:"internal"`
	Gateway     GatewaySection     `toml:"gateway"`
	SSHCA       SSHCASection       `toml:"ssh_ca"`
	Installer   InstallerSection   `toml:"installer"`
	Updates     UpdatesSection     `toml:"updates"`
	Debug       DebugSection       `toml:"debug"`
	DebugAuth   DebugAuthSection   `toml:"debug_auth"`
	Feedback    FeedbackSection    `toml:"feedback"`
	ServerTools ServerToolsSection `toml:"server_tools"`
	Runtime     RuntimeSection     `toml:"runtime"`
	Scripts     ScriptsSection     `toml:"scripts"`
	SourcePath  string             `toml:"-"`
}

type AppSection struct {
	Name       string `toml:"name"`
	BaseURL    string `toml:"base_url"`
	ListenAddr string `toml:"listen_addr"`
	PublicDir  string `toml:"public_dir"`
}

type DatabaseSection struct {
	Path string `toml:"path"`
}

type SecuritySection struct {
	BootstrapTimeoutMinutes int    `toml:"bootstrap_timeout_minutes"`
	AccessTokenTTLMinutes   int    `toml:"access_token_ttl_minutes"`
	RefreshTokenTTLHours    int    `toml:"refresh_token_ttl_hours"`
	CSRFHeader              string `toml:"csrf_header"`
	AccessCookie            string `toml:"access_cookie"`
	RefreshCookie           string `toml:"refresh_cookie"`
	CSRFCookie              string `toml:"csrf_cookie"`
	SecureCookies           bool   `toml:"secure_cookies"`
}

type InternalSection struct {
	SharedSecret              string `toml:"shared_secret"`
	SharedSecretFile          string `toml:"shared_secret_file"`
	AppRunnerSharedSecret     string `toml:"app_runner_shared_secret"`
	AppRunnerSharedSecretFile string `toml:"app_runner_shared_secret_file"`
	AuthURL                   string `toml:"auth_url"`
	APIURL                    string `toml:"api_url"`
	StaticURL                 string `toml:"static_url"`
	AppRunnerURL              string `toml:"app_runner_url"`
	WorkerURL                 string `toml:"worker_url"`
	SignerURL                 string `toml:"signer_url"`
	SignerSocket              string `toml:"signer_socket"`
	VulnerabilityScannerURL   string `toml:"vulnerability_scanner_url"`
}

type GatewaySection struct {
	ListenAddr                 string `toml:"listen_addr"`
	SignatureMaxAge            int    `toml:"signature_max_age_seconds"`
	PublicAuthRatePerMinute    int    `toml:"public_auth_rate_per_minute"`
	PrivateVerifyRatePerMinute int    `toml:"private_verify_rate_per_minute"`
}

type SSHCASection struct {
	CertTTLMinutes int `toml:"cert_ttl_minutes"`
}

type InstallerSection struct {
	ScriptURL         string `toml:"script_url"`
	ExpectedSHA256URL string `toml:"expected_sha256_url"`
	SourceURL         string `toml:"source_url"`
}

type UpdatesSection struct {
	Enabled              bool     `toml:"enabled"`
	Channel              string   `toml:"channel"`
	ManifestURL          string   `toml:"manifest_url"`
	ManifestMirrorURLs   []string `toml:"manifest_mirror_urls"`
	KeyringURL           string   `toml:"keyring_url"`
	KeyringMirrorURLs    []string `toml:"keyring_mirror_urls"`
	RootPublicKeys       []string `toml:"root_public_keys"`
	ManifestPublicKeys   []string `toml:"manifest_public_keys"`
	CheckTimeoutSeconds  int      `toml:"check_timeout_seconds"`
	CacheTTLSeconds      int      `toml:"cache_ttl_seconds"`
	InstallMethod        string   `toml:"install_method"`
	UpdaterURL           string   `toml:"updater_url"`
	ApplyScript          string   `toml:"apply_script"`
	StagingDir           string   `toml:"staging_dir"`
	ManualUpgradeCommand string   `toml:"manual_upgrade_command"`
	ManualUpgradeURL     string   `toml:"manual_upgrade_url"`
}

type DebugSection struct {
	Enabled bool `toml:"enabled"`
}

type DebugAuthSection struct {
	TokenFile        string   `toml:"token_file"`
	AllowedClientIPs []string `toml:"allowed_client_ips"`
}

type FeedbackSection struct {
	SubmitURL         string `toml:"submit_url"`
	RelayURL          string `toml:"relay_url"`
	Project           string `toml:"project"`
	AllowLocalStorage bool   `toml:"allow_local_storage"`
}

type ServerToolsSection struct {
	Enabled      bool     `toml:"enabled"`
	ServiceURLs  []string `toml:"service_urls"`
	AllowRestart bool     `toml:"allow_restart"`
}

type RuntimeSection struct {
	AutoConnectAfterUnlock     bool   `toml:"auto_connect_after_unlock"`
	ConnectTimeoutSeconds      int    `toml:"connect_timeout_seconds"`
	StatusIntervalSeconds      int    `toml:"status_interval_seconds"`
	LightStatusIntervalSeconds int    `toml:"light_status_interval_seconds"`
	DetectionIntervalSeconds   int    `toml:"detection_interval_seconds"`
	PeriodicScriptTickSeconds  int    `toml:"periodic_script_tick_seconds"`
	KeepAliveIntervalSeconds   int    `toml:"keepalive_interval_seconds"`
	ReconnectIntervalSeconds   int    `toml:"reconnect_interval_seconds"`
	FileUploadMaxBytes         int64  `toml:"file_upload_max_bytes"`
	TmuxBinary                 string `toml:"tmux_binary"`
	TmuxSocketPath             string `toml:"tmux_socket_path"`
	TmuxHistoryLimitLines      int    `toml:"tmux_history_limit_lines"`
	TmuxCaptureLines           int    `toml:"tmux_capture_lines"`
}

type ScriptsSection struct {
	Root                  string `toml:"root"`
	DefaultTimeoutSeconds int    `toml:"default_timeout_seconds"`
}

const (
	DefaultFileUploadMaxBytes int64 = 16 << 30
	MaxConfigFileBytes        int64 = 2 << 20
	MaxSecretFileBytes        int64 = 4096
)

func Load(path string) (AppConfig, error) {
	return LoadForRole(path, "all")
}

func LoadForRole(path string, role string) (AppConfig, error) {
	data, err := readConfigFile(path)
	if err != nil {
		return AppConfig{}, err
	}
	var cfg AppConfig
	if err := toml.Unmarshal(data, &cfg); err != nil {
		return AppConfig{}, err
	}
	if err := cfg.ValidateForRole(filepath.Dir(path), role); err != nil {
		return AppConfig{}, err
	}
	cfg.SourcePath = path
	return cfg, nil
}

func readConfigFile(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, MaxConfigFileBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > MaxConfigFileBytes {
		return nil, fmt.Errorf("config file exceeds %d bytes: %s", MaxConfigFileBytes, path)
	}
	return data, nil
}

func (c *AppConfig) Validate(baseDir string) error {
	return c.validate(baseDir, secretRequirements{shared: true, appRunner: true})
}

func (c *AppConfig) ValidateForRole(baseDir string, role string) error {
	requirements, err := secretRequirementsForRole(role)
	if err != nil {
		return err
	}
	return c.validate(baseDir, requirements)
}

type secretRequirements struct {
	shared    bool
	appRunner bool
	updater   bool
}

func secretRequirementsForRole(role string) (secretRequirements, error) {
	switch strings.TrimSpace(role) {
	case "all":
		return secretRequirements{shared: true, appRunner: true}, nil
	case "api":
		return secretRequirements{shared: true, appRunner: true}, nil
	case "app-runner":
		return secretRequirements{appRunner: true}, nil
	case "static", "gateway", "auth", "worker", "ca-signer", "vulnerability-scanner":
		return secretRequirements{shared: true}, nil
	case "updater":
		return secretRequirements{shared: true, updater: true}, nil
	default:
		return secretRequirements{}, fmt.Errorf("unknown service role %q", role)
	}
}

func (c *AppConfig) validate(baseDir string, requirements secretRequirements) error {
	if c.App.Name == "" {
		c.App.Name = "ShellOrchestra"
	}
	if c.App.ListenAddr == "" {
		return fmt.Errorf("app.listen_addr is required")
	}
	if !requirements.updater {
		if c.App.PublicDir == "" {
			return fmt.Errorf("app.public_dir is required")
		}
		if c.Database.Path == "" {
			return fmt.Errorf("database.path is required")
		}
		if c.Scripts.Root == "" {
			return fmt.Errorf("scripts.root is required")
		}
		if c.Security.BootstrapTimeoutMinutes <= 0 {
			return fmt.Errorf("security.bootstrap_timeout_minutes must be positive")
		}
		if c.Security.AccessTokenTTLMinutes <= 0 {
			return fmt.Errorf("security.access_token_ttl_minutes must be positive")
		}
		if c.Security.RefreshTokenTTLHours <= 0 {
			return fmt.Errorf("security.refresh_token_ttl_hours must be positive")
		}
		if c.Security.CSRFHeader == "" || c.Security.AccessCookie == "" || c.Security.RefreshCookie == "" || c.Security.CSRFCookie == "" {
			return fmt.Errorf("security cookie and CSRF names must be configured")
		}
	}
	if strings.TrimSpace(c.Feedback.SubmitURL) != "" {
		parsedFeedbackURL, err := url.Parse(c.Feedback.SubmitURL)
		if err != nil || parsedFeedbackURL.Scheme != "https" || parsedFeedbackURL.Host == "" {
			return fmt.Errorf("feedback.submit_url must be an absolute https URL")
		}
		if strings.TrimSpace(c.Feedback.Project) == "" {
			return fmt.Errorf("feedback.project is required when feedback.submit_url is set")
		}
	}
	if strings.TrimSpace(c.Feedback.RelayURL) != "" {
		parsedFeedbackRelayURL, err := url.Parse(c.Feedback.RelayURL)
		if err != nil || (parsedFeedbackRelayURL.Scheme != "https" && parsedFeedbackRelayURL.Scheme != "http") || parsedFeedbackRelayURL.Host == "" {
			return fmt.Errorf("feedback.relay_url must be an absolute http or https URL")
		}
		if strings.TrimSpace(c.Feedback.Project) == "" {
			return fmt.Errorf("feedback.project is required when feedback.relay_url is set")
		}
	}
	if requirements.shared && c.Internal.SharedSecretFile != "" {
		c.Internal.SharedSecretFile = absolutize(baseDir, c.Internal.SharedSecretFile)
		secret, err := loadOrCreateInternalSecret(c.Internal.SharedSecretFile)
		if err != nil {
			return err
		}
		c.Internal.SharedSecret = secret
	}
	if requirements.shared && strings.TrimSpace(c.Internal.SharedSecret) == "" {
		return fmt.Errorf("internal.shared_secret_file or internal.shared_secret is required for this service role")
	}
	if requirements.appRunner && c.Internal.AppRunnerSharedSecretFile != "" {
		c.Internal.AppRunnerSharedSecretFile = absolutize(baseDir, c.Internal.AppRunnerSharedSecretFile)
		secret, err := loadOrCreateInternalSecret(c.Internal.AppRunnerSharedSecretFile)
		if err != nil {
			return err
		}
		c.Internal.AppRunnerSharedSecret = secret
	}
	if requirements.appRunner && strings.TrimSpace(c.Internal.AppRunnerSharedSecret) == "" {
		return fmt.Errorf("internal.app_runner_shared_secret_file or internal.app_runner_shared_secret is required for this service role")
	}
	if strings.TrimSpace(c.Internal.AppRunnerURL) == "" {
		c.Internal.AppRunnerURL = "unix:///app/app-runner/app-runner.sock"
	}
	if c.Gateway.ListenAddr == "" {
		c.Gateway.ListenAddr = c.App.ListenAddr
	}
	if c.Gateway.SignatureMaxAge <= 0 {
		c.Gateway.SignatureMaxAge = 120
	}
	if c.Gateway.PublicAuthRatePerMinute <= 0 {
		c.Gateway.PublicAuthRatePerMinute = 600
	}
	if c.Gateway.PrivateVerifyRatePerMinute <= 0 {
		c.Gateway.PrivateVerifyRatePerMinute = 6000
	}
	if c.SSHCA.CertTTLMinutes <= 0 {
		c.SSHCA.CertTTLMinutes = 10
	}
	if strings.TrimSpace(c.Installer.ScriptURL) == "" {
		c.Installer.ScriptURL = "https://inst.shellorchestra.com"
	}
	if strings.TrimSpace(c.Installer.ExpectedSHA256URL) == "" {
		c.Installer.ExpectedSHA256URL = "https://inst.shellorchestra.com/hash"
	}
	if strings.TrimSpace(c.Installer.SourceURL) == "" {
		c.Installer.SourceURL = "https://inst.shellorchestra.com/v1/install-posix.sh"
	}
	if strings.TrimSpace(c.Updates.Channel) == "" {
		c.Updates.Channel = "stable"
	}
	if strings.TrimSpace(c.Updates.ManifestURL) == "" {
		c.Updates.ManifestURL = "https://shellorchestra.com/releases/" + strings.TrimSpace(c.Updates.Channel) + ".json"
	}
	if strings.TrimSpace(c.Updates.KeyringURL) == "" {
		c.Updates.KeyringURL = "https://shellorchestra.com/releases/keyring.json"
	}
	if c.Updates.CheckTimeoutSeconds <= 0 {
		c.Updates.CheckTimeoutSeconds = 6
	}
	if c.Updates.CacheTTLSeconds <= 0 {
		c.Updates.CacheTTLSeconds = 6 * 60 * 60
	}
	if strings.TrimSpace(c.Updates.InstallMethod) == "" {
		c.Updates.InstallMethod = "manual"
	}
	switch strings.TrimSpace(strings.ToLower(c.Updates.InstallMethod)) {
	case "official", "manual", "windows_app", "unknown":
		c.Updates.InstallMethod = strings.TrimSpace(strings.ToLower(c.Updates.InstallMethod))
	default:
		return fmt.Errorf("updates.install_method must be official, manual, windows_app, or unknown")
	}
	if strings.TrimSpace(c.Updates.ManualUpgradeCommand) == "" {
		c.Updates.ManualUpgradeCommand = ""
	}
	if strings.TrimSpace(c.Updates.ManualUpgradeURL) == "" {
		c.Updates.ManualUpgradeURL = "https://shellorchestra.com/docs/docker-install.md"
	}
	if c.Debug.Enabled {
		if !buildinfo.DebugSupported() {
			return fmt.Errorf("[debug].enabled requires a ShellOrchestra binary built with debug support")
		}
		if c.DebugAuth.TokenFile == "" {
			return fmt.Errorf("debug_auth.token_file is required when debug mode is enabled")
		}
		if len(c.DebugAuth.AllowedClientIPs) == 0 {
			return fmt.Errorf("debug_auth.allowed_client_ips must contain at least one IP or CIDR when debug mode is enabled")
		}
	}
	if !requirements.updater && len(c.ServerTools.ServiceURLs) == 0 {
		c.ServerTools.ServiceURLs = []string{
			"security-gateway=http://security-gateway:7171",
			"static-cdn=" + strings.TrimSpace(c.Internal.StaticURL),
			"auth-service=" + strings.TrimSpace(c.Internal.AuthURL),
			"api-backend=" + strings.TrimSpace(c.Internal.APIURL),
			"app-runner=" + strings.TrimSpace(c.Internal.AppRunnerURL),
			"ssh-worker=" + strings.TrimSpace(c.Internal.WorkerURL),
			"ca-signer=" + strings.TrimSpace(c.Internal.SignerURL),
		}
	}
	if !requirements.updater {
		if c.Runtime.ConnectTimeoutSeconds <= 0 {
			return fmt.Errorf("runtime.connect_timeout_seconds must be positive")
		}
		if c.Runtime.LightStatusIntervalSeconds <= 0 {
			c.Runtime.LightStatusIntervalSeconds = 5
		}
		if c.Runtime.StatusIntervalSeconds <= 0 {
			c.Runtime.StatusIntervalSeconds = c.Runtime.LightStatusIntervalSeconds
		}
		if c.Runtime.DetectionIntervalSeconds <= 0 {
			c.Runtime.DetectionIntervalSeconds = 1800
		}
		if c.Runtime.PeriodicScriptTickSeconds <= 0 {
			c.Runtime.PeriodicScriptTickSeconds = 1
		}
		if c.Runtime.KeepAliveIntervalSeconds <= 0 {
			c.Runtime.KeepAliveIntervalSeconds = 30
		}
		if c.Runtime.ReconnectIntervalSeconds <= 0 {
			c.Runtime.ReconnectIntervalSeconds = 10
		}
		if c.Runtime.FileUploadMaxBytes < 0 {
			return fmt.Errorf("runtime.file_upload_max_bytes cannot be negative")
		}
		if c.Runtime.FileUploadMaxBytes == 0 {
			c.Runtime.FileUploadMaxBytes = DefaultFileUploadMaxBytes
		}
		if strings.TrimSpace(c.Runtime.TmuxBinary) == "" {
			c.Runtime.TmuxBinary = "tmux"
		}
		if strings.TrimSpace(c.Runtime.TmuxSocketPath) == "" {
			c.Runtime.TmuxSocketPath = filepath.Join(filepath.Dir(absolutize(baseDir, c.Database.Path)), "tmux", "shellorchestra.sock")
		}
		c.Runtime.TmuxSocketPath = absolutize(baseDir, c.Runtime.TmuxSocketPath)
		if c.Runtime.TmuxHistoryLimitLines <= 0 {
			c.Runtime.TmuxHistoryLimitLines = 10000
		}
		if c.Runtime.TmuxCaptureLines <= 0 {
			c.Runtime.TmuxCaptureLines = 2000
		}
		if c.Scripts.DefaultTimeoutSeconds <= 0 {
			return fmt.Errorf("scripts.default_timeout_seconds must be positive")
		}
		c.App.PublicDir = absolutize(baseDir, c.App.PublicDir)
		c.Database.Path = absolutize(baseDir, c.Database.Path)
	}
	if c.DebugAuth.TokenFile != "" {
		c.DebugAuth.TokenFile = absolutize(baseDir, c.DebugAuth.TokenFile)
	}
	if c.Internal.SignerSocket != "" {
		c.Internal.SignerSocket = absolutize(baseDir, c.Internal.SignerSocket)
	}
	if c.Updates.ApplyScript != "" {
		c.Updates.ApplyScript = absolutize(baseDir, c.Updates.ApplyScript)
	}
	if c.Updates.StagingDir != "" {
		c.Updates.StagingDir = absolutize(baseDir, c.Updates.StagingDir)
	}
	if !requirements.updater {
		c.Scripts.Root = absolutize(baseDir, c.Scripts.Root)
	}
	return nil
}

func loadOrCreateInternalSecret(path string) (string, error) {
	if secret, err := readSecretFile(path); err == nil {
		if secret == "" {
			return "", fmt.Errorf("internal shared secret file is empty: %s", path)
		}
		return secret, nil
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	secretBytes := make([]byte, 32)
	if _, err := rand.Read(secretBytes); err != nil {
		return "", err
	}
	secret := base64.RawURLEncoding.EncodeToString(secretBytes)
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if os.IsExist(err) {
			secret, readErr := readSecretFile(path)
			if readErr != nil {
				return "", readErr
			}
			if secret == "" {
				return "", fmt.Errorf("internal shared secret file is empty: %s", path)
			}
			return secret, nil
		}
		return "", err
	}
	defer file.Close()
	if _, err := file.WriteString(secret + "\n"); err != nil {
		return "", err
	}
	return secret, nil
}

func readSecretFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, MaxSecretFileBytes+1))
	if err != nil {
		return "", err
	}
	if int64(len(data)) > MaxSecretFileBytes {
		return "", fmt.Errorf("secret file exceeds %d bytes: %s", MaxSecretFileBytes, path)
	}
	return strings.TrimSpace(string(data)), nil
}

func absolutize(baseDir string, path string) string {
	if filepath.IsAbs(path) {
		return filepath.Clean(path)
	}
	return filepath.Clean(filepath.Join(baseDir, path))
}
