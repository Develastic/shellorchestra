// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"shellorchestra/backend/internal/buildinfo"
	"shellorchestra/backend/internal/internaljson"
	"shellorchestra/backend/internal/releases"
)

type versionCheckCache struct {
	result    releases.CheckResult
	expiresAt time.Time
}

type upgradeStartResponse struct {
	Status        string `json:"status"`
	JobID         string `json:"job_id,omitempty"`
	Message       string `json:"message"`
	TargetVersion string `json:"target_version,omitempty"`
}

type upgradeJobResponse struct {
	ID            string    `json:"id"`
	Status        string    `json:"status"`
	Message       string    `json:"message"`
	Channel       string    `json:"channel"`
	TargetVersion string    `json:"target_version"`
	StartedAt     time.Time `json:"started_at"`
	CompletedAt   time.Time `json:"completed_at,omitempty"`
	Error         string    `json:"error,omitempty"`
	LogTail       string    `json:"log_tail,omitempty"`
}

func (a *App) systemVersionCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	result := a.currentVersionCheck(r.Context(), false)
	writeJSON(w, http.StatusOK, result)
}

func (a *App) systemUpgrade(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	updaterURL := strings.TrimSpace(a.deps.Config.Updates.UpdaterURL)
	if updaterURL == "" {
		writeError(w, http.StatusConflict, "One-click upgrade is not configured for this installation. Use the manual upgrade command shown in System updates.")
		return
	}
	check := a.currentVersionCheck(r.Context(), true)
	if check.Status != "ok" {
		writeError(w, http.StatusConflict, check.Message)
		return
	}
	if !check.UpdateAvailable {
		writeError(w, http.StatusConflict, "This ShellOrchestra installation is already up to date.")
		return
	}
	if !check.OneClickAvailable {
		writeError(w, http.StatusConflict, "The signed release manifest does not contain an artifact compatible with this updater installation.")
		return
	}
	response, err := a.startUpdater(r.Context(), check)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, response)
}

func (a *App) systemUpgradeJob(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	updaterURL := strings.TrimSpace(a.deps.Config.Updates.UpdaterURL)
	if updaterURL == "" {
		writeError(w, http.StatusConflict, "One-click upgrade is not configured for this installation.")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/system/upgrade/jobs/")
	if !safeUpdaterJobID(id) {
		writeError(w, http.StatusBadRequest, "Invalid updater job id.")
		return
	}
	job, err := a.fetchUpdaterJob(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, job)
}

func (a *App) currentVersionCheck(ctx context.Context, force bool) releases.CheckResult {
	now := time.Now().UTC()
	a.versionCheckMu.Lock()
	if !force && !a.versionCheckCache.expiresAt.IsZero() && now.Before(a.versionCheckCache.expiresAt) {
		cached := a.versionCheckCache.result
		a.versionCheckMu.Unlock()
		return cached
	}
	a.versionCheckMu.Unlock()

	cfg := a.deps.Config.Updates
	publicKeys, err := releases.ParseTrustedPublicKeys(append(buildinfo.ReleasePublicKeys(), cfg.ManifestPublicKeys...))
	if err != nil {
		result := releases.CheckResult{
			Status:               "not_configured",
			CurrentVersion:       buildinfo.ProductVersion(),
			CurrentEdition:       buildinfo.ProductEdition(),
			Channel:              firstNonEmptyUpdateValue(strings.TrimSpace(cfg.Channel), "stable"),
			InstallMethod:        firstNonEmptyUpdateValue(strings.TrimSpace(cfg.InstallMethod), "manual"),
			ManualUpgradeCommand: strings.TrimSpace(cfg.ManualUpgradeCommand),
			ManualUpgradeURL:     strings.TrimSpace(cfg.ManualUpgradeURL),
			Message:              "ShellOrchestra release public key configuration is invalid: " + err.Error(),
			CheckedAt:            now,
		}
		a.storeVersionCheck(result, now)
		return result
	}
	rootPublicKeys, err := releases.ParseTrustedPublicKeys(append(buildinfo.ReleaseRootKeys(), cfg.RootPublicKeys...))
	if err != nil {
		result := releases.CheckResult{
			Status:               "not_configured",
			CurrentVersion:       buildinfo.ProductVersion(),
			CurrentEdition:       buildinfo.ProductEdition(),
			Channel:              firstNonEmptyUpdateValue(strings.TrimSpace(cfg.Channel), "stable"),
			InstallMethod:        firstNonEmptyUpdateValue(strings.TrimSpace(cfg.InstallMethod), "manual"),
			ManualUpgradeCommand: strings.TrimSpace(cfg.ManualUpgradeCommand),
			ManualUpgradeURL:     strings.TrimSpace(cfg.ManualUpgradeURL),
			Message:              "ShellOrchestra release root key configuration is invalid: " + err.Error(),
			CheckedAt:            now,
		}
		a.storeVersionCheck(result, now)
		return result
	}
	timeout := time.Duration(cfg.CheckTimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 6 * time.Second
	}
	updaterAvailable := false
	updaterConfigError := ""
	if strings.TrimSpace(cfg.UpdaterURL) != "" {
		if _, err := parseUpdaterEndpoint(cfg.UpdaterURL); err != nil {
			updaterConfigError = err.Error()
		} else {
			updaterAvailable = true
		}
	}
	checkCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	client := &http.Client{Timeout: timeout}
	result := releases.Check(checkCtx, releases.CheckOptions{
		Enabled:              cfg.Enabled,
		CurrentVersion:       buildinfo.ProductVersion(),
		CurrentEdition:       buildinfo.ProductEdition(),
		Channel:              cfg.Channel,
		ManifestURL:          cfg.ManifestURL,
		ManifestMirrorURLs:   cfg.ManifestMirrorURLs,
		KeyringURL:           cfg.KeyringURL,
		KeyringMirrorURLs:    cfg.KeyringMirrorURLs,
		RootPublicKeys:       rootPublicKeys,
		TrustedPublicKeys:    publicKeys,
		InstallMethod:        cfg.InstallMethod,
		UpdaterAvailable:     updaterAvailable,
		ManualUpgradeCommand: cfg.ManualUpgradeCommand,
		ManualUpgradeURL:     cfg.ManualUpgradeURL,
		HTTPClient:           client,
		Now:                  func() time.Time { return now },
	})
	if updaterConfigError != "" && result.Status == "ok" && result.UpdateAvailable {
		result.Message = strings.TrimSpace(result.Message + " One-click upgrade is disabled because updates.updater_url is invalid: " + updaterConfigError)
	}
	a.storeVersionCheck(result, now)
	return result
}

func (a *App) storeVersionCheck(result releases.CheckResult, now time.Time) {
	ttl := time.Duration(a.deps.Config.Updates.CacheTTLSeconds) * time.Second
	if ttl <= 0 {
		ttl = 6 * time.Hour
	}
	a.versionCheckMu.Lock()
	a.versionCheckCache = versionCheckCache{result: result, expiresAt: now.Add(ttl)}
	a.versionCheckMu.Unlock()
}

func (a *App) startUpdater(ctx context.Context, check releases.CheckResult) (upgradeStartResponse, error) {
	endpoint, err := parseUpdaterEndpoint(a.deps.Config.Updates.UpdaterURL)
	if err != nil {
		return upgradeStartResponse{}, err
	}
	payload := map[string]string{
		"channel":         check.Channel,
		"current_version": check.CurrentVersion,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return upgradeStartResponse{}, err
	}
	timeout := time.Duration(a.deps.Config.Updates.CheckTimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 6 * time.Second
	}
	client := updaterHTTPClient(timeout, endpoint.unixSocketPath)
	url := strings.TrimRight(endpoint.baseURL, "/") + "/v1/updates/start"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return upgradeStartResponse{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-ShellOrchestra-Internal-Secret", a.deps.Config.Internal.SharedSecret)
	resp, err := client.Do(req)
	if err != nil {
		return upgradeStartResponse{}, fmt.Errorf("local updater request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		message := strings.TrimSpace(string(data))
		if message == "" {
			message = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		return upgradeStartResponse{}, fmt.Errorf("local updater rejected the upgrade request: %s", message)
	}
	var response upgradeStartResponse
	if err := internaljson.DecodeStrictResponse(resp.Body, 64<<10, &response, "updater start response"); err != nil {
		return upgradeStartResponse{}, err
	}
	if strings.TrimSpace(response.Status) == "" {
		return upgradeStartResponse{}, fmt.Errorf("local updater response did not include status")
	}
	return response, nil
}

func (a *App) fetchUpdaterJob(ctx context.Context, id string) (upgradeJobResponse, error) {
	endpoint, err := parseUpdaterEndpoint(a.deps.Config.Updates.UpdaterURL)
	if err != nil {
		return upgradeJobResponse{}, err
	}
	timeout := time.Duration(a.deps.Config.Updates.CheckTimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 6 * time.Second
	}
	client := updaterHTTPClient(timeout, endpoint.unixSocketPath)
	url := strings.TrimRight(endpoint.baseURL, "/") + "/v1/updates/jobs/" + id
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return upgradeJobResponse{}, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-ShellOrchestra-Internal-Secret", a.deps.Config.Internal.SharedSecret)
	resp, err := client.Do(req)
	if err != nil {
		return upgradeJobResponse{}, fmt.Errorf("local updater job request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		message := strings.TrimSpace(string(data))
		if message == "" {
			message = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		return upgradeJobResponse{}, fmt.Errorf("local updater rejected the job status request: %s", message)
	}
	var response upgradeJobResponse
	if err := internaljson.DecodeStrictResponse(resp.Body, 64<<10, &response, "updater job response"); err != nil {
		return upgradeJobResponse{}, err
	}
	if strings.TrimSpace(response.ID) == "" || strings.TrimSpace(response.Status) == "" {
		return upgradeJobResponse{}, fmt.Errorf("local updater response did not include job id and status")
	}
	return response, nil
}

type updaterEndpoint struct {
	baseURL        string
	unixSocketPath string
}

func parseUpdaterEndpoint(raw string) (updaterEndpoint, error) {
	trimmed := strings.TrimSpace(raw)
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme == "" {
		return updaterEndpoint{}, fmt.Errorf("updates.updater_url must be an absolute http(s) URL or unix socket URL")
	}
	if strings.EqualFold(parsed.Scheme, "unix") {
		if parsed.Host != "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path == "" || !filepath.IsAbs(parsed.Path) || filepath.Clean(parsed.Path) != parsed.Path {
			return updaterEndpoint{}, fmt.Errorf("updates.updater_url unix socket URL must use unix:///absolute/canonical/path.sock")
		}
		return updaterEndpoint{baseURL: "http://shellorchestra-updater.unix", unixSocketPath: parsed.Path}, nil
	}
	if !strings.EqualFold(parsed.Scheme, "http") && !strings.EqualFold(parsed.Scheme, "https") {
		return updaterEndpoint{}, fmt.Errorf("updates.updater_url must use http, https, or unix")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Host == "" {
		return updaterEndpoint{}, fmt.Errorf("updates.updater_url must not include credentials, query, or fragment")
	}
	if !isLoopbackUpdaterHost(parsed.Hostname()) {
		return updaterEndpoint{}, fmt.Errorf("updates.updater_url http(s) origin must point to localhost, 127.0.0.1, or ::1")
	}
	if parsed.EscapedPath() != "" && parsed.EscapedPath() != "/" {
		return updaterEndpoint{}, fmt.Errorf("updates.updater_url must be a service origin without a path")
	}
	parsed.Path = ""
	parsed.RawPath = ""
	return updaterEndpoint{baseURL: parsed.String()}, nil
}

func isLoopbackUpdaterHost(host string) bool {
	normalized := strings.TrimSpace(strings.ToLower(host))
	if normalized == "localhost" {
		return true
	}
	ip := net.ParseIP(normalized)
	return ip != nil && ip.IsLoopback()
}

func updaterHTTPClient(timeout time.Duration, unixSocketPath string) *http.Client {
	if strings.TrimSpace(unixSocketPath) == "" {
		return &http.Client{Timeout: timeout}
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = func(ctx context.Context, network string, address string) (net.Conn, error) {
		dialer := net.Dialer{}
		return dialer.DialContext(ctx, "unix", unixSocketPath)
	}
	return &http.Client{Timeout: timeout, Transport: transport}
}

func firstNonEmptyUpdateValue(value string, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return fallback
}

func safeUpdaterJobID(value string) bool {
	if value == "" || len(value) > 80 {
		return false
	}
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			continue
		}
		return false
	}
	return true
}
