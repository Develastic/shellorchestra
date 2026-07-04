// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package servertools

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"shellorchestra/backend/internal/config"
	"shellorchestra/backend/internal/internaljson"
	"shellorchestra/backend/internal/internalurl"
)

type BackendStatus struct {
	Enabled            bool            `json:"enabled"`
	TelemetryAvailable bool            `json:"telemetry_available"`
	RestartAllowed     bool            `json:"restart_allowed"`
	Message            string          `json:"message"`
	UpdatedAt          time.Time       `json:"updated_at"`
	Summary            ResourceSummary `json:"summary"`
	Services           []ServiceStatus `json:"services"`
}

type ResourceSummary struct {
	ServiceCount         int     `json:"service_count"`
	RespondingCount      int     `json:"responding_count"`
	CPUUsagePercent      float64 `json:"cpu_usage_percent,omitempty"`
	CPUReadyCount        int     `json:"cpu_ready_count"`
	GoMemoryBytes        uint64  `json:"go_memory_bytes,omitempty"`
	MemoryUsageBytes     int64   `json:"memory_usage_bytes,omitempty"`
	MemoryLimitBytes     int64   `json:"memory_limit_bytes,omitempty"`
	DataDirBytes         int64   `json:"data_dir_bytes,omitempty"`
	DataDirScanTruncated bool    `json:"data_dir_scan_truncated,omitempty"`
}

type ServiceStatus struct {
	Name             string         `json:"name"`
	Role             string         `json:"role,omitempty"`
	Version          string         `json:"version,omitempty"`
	State            string         `json:"state"`
	Status           string         `json:"status,omitempty"`
	StartedAt        *time.Time     `json:"started_at,omitempty"`
	UptimeSeconds    int64          `json:"uptime_seconds,omitempty"`
	GoMemoryBytes    uint64         `json:"go_memory_bytes,omitempty"`
	CPUUsagePercent  float64        `json:"cpu_usage_percent,omitempty"`
	CPUUsageReady    bool           `json:"cpu_usage_ready"`
	MemoryUsageBytes int64          `json:"memory_usage_bytes,omitempty"`
	MemoryLimitBytes int64          `json:"memory_limit_bytes,omitempty"`
	DataDirBytes     int64          `json:"data_dir_bytes,omitempty"`
	DataDirTruncated bool           `json:"data_dir_scan_truncated,omitempty"`
	Details          map[string]any `json:"details,omitempty"`
	Error            string         `json:"error,omitempty"`
	url              string
}

const maxTelemetryResponseBodyBytes = 1 << 20

type TelemetryClient struct {
	cfg      config.AppConfig
	services []ServiceStatus
	client   *http.Client
}

func NewTelemetryClient(cfg config.AppConfig) *TelemetryClient {
	return &TelemetryClient{
		cfg:      cfg,
		services: configuredServices(cfg),
		client:   internalurl.HTTPClient(5*time.Second, ""),
	}
}

func (c *TelemetryClient) Status(ctx context.Context) BackendStatus {
	status := BackendStatus{
		Enabled:        c.cfg.ServerTools.Enabled,
		RestartAllowed: false,
		UpdatedAt:      time.Now().UTC(),
		Summary: ResourceSummary{
			ServiceCount: len(c.services),
		},
		Services: make([]ServiceStatus, 0, len(c.services)),
	}
	if !c.cfg.ServerTools.Enabled {
		status.Message = "Backend service telemetry is disabled by the server configuration."
		return status
	}
	available := 0
	for _, service := range c.services {
		item := service
		item.State = "unreachable"
		item.Status = "Telemetry has not been loaded yet."
		loaded, err := c.serviceStatus(ctx, service)
		if err != nil {
			item.Error = err.Error()
			item.Status = "Service telemetry is unavailable."
			status.Services = append(status.Services, item)
			continue
		}
		loaded.Name = service.Name
		loaded.url = ""
		status.Services = append(status.Services, loaded)
		available++
	}
	status.Summary = summarizeServices(status.Services, available)
	status.TelemetryAvailable = available == len(c.services) && len(c.services) > 0
	if status.TelemetryAvailable {
		status.Message = "Backend service status loaded from ShellOrchestra internal telemetry endpoints."
	} else {
		status.Message = fmt.Sprintf("Backend service telemetry loaded for %d of %d services.", available, len(c.services))
	}
	return status
}

func (c *TelemetryClient) RestartConfiguredServices(ctx context.Context) error {
	return fmt.Errorf("backend restart requires a separate supervisor service; Docker Engine socket access is intentionally not available to the API backend")
}

func (c *TelemetryClient) serviceStatus(ctx context.Context, service ServiceStatus) (ServiceStatus, error) {
	endpoint, err := internalurl.ParseServiceOrUnixSocketURL(service.url, fmt.Sprintf("telemetry URL for %s", service.Name))
	if err != nil {
		return ServiceStatus{}, err
	}
	if endpoint.UnixSocketPath != "" && !strings.EqualFold(strings.TrimSpace(service.Name), "app-runner") {
		return ServiceStatus{}, fmt.Errorf("unix socket telemetry is only allowed for app-runner")
	}
	requestURL := endpoint.URL.ResolveReference(&url.URL{Path: "/internal/service/status"})
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
	if err != nil {
		return ServiceStatus{}, err
	}
	internalSecret := strings.TrimSpace(c.internalSecretForService(service))
	if internalSecret == "" {
		return ServiceStatus{}, fmt.Errorf("internal shared secret is required for telemetry service %s", service.Name)
	}
	req.Header.Set("X-ShellOrchestra-Internal-Secret", internalSecret)
	client := c.client
	if endpoint.UnixSocketPath != "" {
		client = internalurl.HTTPClient(5*time.Second, endpoint.UnixSocketPath)
	}
	resp, err := client.Do(req)
	if err != nil {
		return ServiceStatus{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var payload struct {
			Error string `json:"error"`
		}
		internaljson.DecodeBestEffort(resp.Body, 64<<10, &payload)
		if strings.TrimSpace(payload.Error) == "" {
			payload.Error = resp.Status
		}
		return ServiceStatus{}, fmt.Errorf("%s", payload.Error)
	}
	var out struct {
		Name                   string         `json:"name"`
		Role                   string         `json:"role"`
		Version                string         `json:"version"`
		State                  string         `json:"state"`
		Status                 string         `json:"status"`
		StartedAt              time.Time      `json:"started_at"`
		UptimeSeconds          int64          `json:"uptime_seconds"`
		GoMemoryBytes          uint64         `json:"go_memory_bytes"`
		CgroupCPUUsagePercent  float64        `json:"cgroup_cpu_usage_percent"`
		CgroupCPUUsageReady    bool           `json:"cgroup_cpu_usage_ready"`
		CgroupMemoryUsageBytes int64          `json:"cgroup_memory_usage_bytes"`
		CgroupMemoryLimitBytes int64          `json:"cgroup_memory_limit_bytes"`
		DataDirBytes           int64          `json:"data_dir_bytes"`
		DataDirScanTruncated   bool           `json:"data_dir_scan_truncated"`
		Details                map[string]any `json:"details"`
	}
	if err := internaljson.DecodeStrictResponse(resp.Body, maxTelemetryResponseBodyBytes, &out, "service telemetry response"); err != nil {
		return ServiceStatus{}, err
	}
	if out.Name == "" || out.Role == "" {
		return ServiceStatus{}, fmt.Errorf("service telemetry response is missing service identity")
	}
	startedAt := out.StartedAt
	state := strings.TrimSpace(out.State)
	if state == "" {
		state = "running"
	}
	return ServiceStatus{
		Name:             out.Name,
		Role:             out.Role,
		Version:          out.Version,
		State:            state,
		Status:           out.Status,
		StartedAt:        &startedAt,
		UptimeSeconds:    out.UptimeSeconds,
		GoMemoryBytes:    out.GoMemoryBytes,
		CPUUsagePercent:  out.CgroupCPUUsagePercent,
		CPUUsageReady:    out.CgroupCPUUsageReady,
		MemoryUsageBytes: out.CgroupMemoryUsageBytes,
		MemoryLimitBytes: out.CgroupMemoryLimitBytes,
		DataDirBytes:     out.DataDirBytes,
		DataDirTruncated: out.DataDirScanTruncated,
		Details:          out.Details,
	}, nil
}

func summarizeServices(services []ServiceStatus, responding int) ResourceSummary {
	summary := ResourceSummary{
		ServiceCount:    len(services),
		RespondingCount: responding,
	}
	for _, service := range services {
		if service.CPUUsageReady {
			summary.CPUUsagePercent += service.CPUUsagePercent
			summary.CPUReadyCount++
		}
		summary.GoMemoryBytes += service.GoMemoryBytes
		if service.MemoryUsageBytes > 0 {
			summary.MemoryUsageBytes += service.MemoryUsageBytes
		}
		if service.MemoryLimitBytes > 0 {
			summary.MemoryLimitBytes += service.MemoryLimitBytes
		}
		if service.DataDirBytes > 0 {
			summary.DataDirBytes += service.DataDirBytes
		}
		if service.DataDirTruncated {
			summary.DataDirScanTruncated = true
		}
	}
	return summary
}

func configuredServices(cfg config.AppConfig) []ServiceStatus {
	entries := cfg.ServerTools.ServiceURLs
	if len(entries) == 0 {
		entries = defaultServiceURLs(cfg)
	}
	services := make([]ServiceStatus, 0, len(entries))
	for _, entry := range entries {
		name, rawURL, ok := strings.Cut(entry, "=")
		if !ok {
			name = entry
			rawURL = ""
		}
		name = strings.TrimSpace(name)
		rawURL = strings.TrimSpace(rawURL)
		if name == "" {
			continue
		}
		services = append(services, ServiceStatus{Name: name, State: "configured", url: rawURL})
	}
	return services
}

func defaultServiceURLs(cfg config.AppConfig) []string {
	return []string{
		"security-gateway=http://security-gateway:7171",
		"static-cdn=" + strings.TrimSpace(cfg.Internal.StaticURL),
		"auth-service=" + strings.TrimSpace(cfg.Internal.AuthURL),
		"api-backend=" + strings.TrimSpace(cfg.Internal.APIURL),
		"app-runner=" + strings.TrimSpace(cfg.Internal.AppRunnerURL),
		"ssh-worker=" + strings.TrimSpace(cfg.Internal.WorkerURL),
		"ca-signer=" + strings.TrimSpace(cfg.Internal.SignerURL),
	}
}

func (c *TelemetryClient) internalSecretForService(service ServiceStatus) string {
	if strings.EqualFold(strings.TrimSpace(service.Name), "app-runner") {
		return c.cfg.Internal.AppRunnerSharedSecret
	}
	return c.cfg.Internal.SharedSecret
}
