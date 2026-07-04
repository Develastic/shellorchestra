// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package worker

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"math"
	"strings"
	"sync"
	"time"

	"shellorchestra/backend/internal/domain"
	"shellorchestra/backend/internal/runtime"
	"shellorchestra/backend/internal/scripts"
)

const (
	periodicJobCriticalDetection = "critical_detection"
	periodicJobDetection         = "detection"
	periodicJobLightStatus       = "light_status"

	failedDetectionRetryInterval = 10 * time.Second

	cpuUsageHistoryLimit                  = 120
	cpuUsageHistoryTelemetryKey           = "cpu_usage_history"
	cpuUsageHistoryConnectionTelemetryKey = "cpu_usage_history_connection_key"
	cpuUsageHistoryUpdatedTelemetryKey    = "cpu_usage_history_updated_at"
)

type PeriodicScriptManager struct {
	server *Server

	mu     sync.Mutex
	cancel context.CancelFunc
	states *periodicServerStates
}

type periodicServerState struct {
	CriticalRunning  bool
	StatusRunning    bool
	DetectionRunning bool

	CriticalRunCount  int
	StatusRunCount    int
	DetectionRunCount int

	LastCriticalAt       time.Time
	LastCriticalOKAt     time.Time
	LastCriticalFailedAt time.Time
	LastCriticalError    string

	LastStatusAt       time.Time
	LastStatusOKAt     time.Time
	LastStatusFailedAt time.Time
	LastStatusError    string

	LastDetectionAt       time.Time
	LastDetectionOKAt     time.Time
	LastDetectionFailedAt time.Time
	LastDetectionError    string
}

type periodicTimings struct {
	LightStatusInterval time.Duration
	DetectionInterval   time.Duration
	SchedulerTick       time.Duration
}

type periodicServerStates struct {
	mu     sync.Mutex
	states map[string]*periodicServerState
}

type periodicServerStateSummary struct {
	ManagedServers    int
	CriticalJobs      int
	StatusJobs        int
	DetectionJobs     int
	CriticalRunCount  int
	StatusRunCount    int
	DetectionRunCount int
}

func newPeriodicServerStates() *periodicServerStates {
	return &periodicServerStates{states: map[string]*periodicServerState{}}
}

func (s *periodicServerStates) Reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.states = map[string]*periodicServerState{}
}

func (s *periodicServerStates) Summary() periodicServerStateSummary {
	s.mu.Lock()
	defer s.mu.Unlock()
	summary := periodicServerStateSummary{ManagedServers: len(s.states)}
	for _, state := range s.states {
		if state.CriticalRunning {
			summary.CriticalJobs++
		}
		if state.StatusRunning {
			summary.StatusJobs++
		}
		if state.DetectionRunning {
			summary.DetectionJobs++
		}
		summary.CriticalRunCount += state.CriticalRunCount
		summary.StatusRunCount += state.StatusRunCount
		summary.DetectionRunCount += state.DetectionRunCount
	}
	return summary
}

func (s *periodicServerStates) CriticalDetectionDue(serverID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.states[serverID]
	if state == nil {
		return true
	}
	if state.CriticalRunning {
		return false
	}
	return state.LastCriticalAt.IsZero() || time.Since(state.LastCriticalAt) >= 30*time.Second
}

func (s *periodicServerStates) DetectionDue(serverID string, interval time.Duration) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.states[serverID]
	if state == nil {
		return true
	}
	if state.DetectionRunning {
		return false
	}
	if state.LastDetectionFailedAt.After(state.LastDetectionOKAt) {
		retryInterval := failedDetectionRetryInterval
		if interval > 0 && interval < retryInterval {
			retryInterval = interval
		}
		return time.Since(state.LastDetectionAt) >= retryInterval
	}
	return state.LastDetectionAt.IsZero() || time.Since(state.LastDetectionAt) >= interval
}

func (s *periodicServerStates) LightStatusDue(serverID string, interval time.Duration) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.states[serverID]
	if state == nil {
		return true
	}
	if state.StatusRunning {
		return false
	}
	return state.LastStatusAt.IsZero() || time.Since(state.LastStatusAt) >= interval
}

func (s *periodicServerStates) BeginJob(serverID string, job string) (*periodicServerState, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.states[serverID]
	if state == nil {
		state = &periodicServerState{}
		s.states[serverID] = state
	}
	now := time.Now().UTC()
	switch job {
	case periodicJobCriticalDetection:
		if state.CriticalRunning {
			return state, false
		}
		state.CriticalRunning = true
		state.LastCriticalAt = now
		state.CriticalRunCount++
	case periodicJobDetection:
		if state.DetectionRunning {
			return state, false
		}
		state.DetectionRunning = true
		state.LastDetectionAt = now
		state.DetectionRunCount++
	case periodicJobLightStatus:
		if state.StatusRunning {
			return state, false
		}
		state.StatusRunning = true
		state.LastStatusAt = now
		state.StatusRunCount++
	}
	return state, true
}

func (s *periodicServerStates) FinishJob(serverID string, job string, state *periodicServerState, at time.Time, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if current := s.states[serverID]; current != nil {
		state = current
	}
	if state == nil {
		return
	}
	switch job {
	case periodicJobCriticalDetection:
		state.CriticalRunning = false
		if err != nil {
			state.LastCriticalFailedAt = at
			state.LastCriticalError = err.Error()
		} else {
			state.LastCriticalOKAt = at
			state.LastCriticalError = ""
		}
	case periodicJobDetection:
		state.DetectionRunning = false
		if err != nil {
			state.LastDetectionFailedAt = at
			state.LastDetectionError = err.Error()
		} else {
			state.LastDetectionOKAt = at
			state.LastDetectionError = ""
		}
	case periodicJobLightStatus:
		state.StatusRunning = false
		if err != nil {
			state.LastStatusFailedAt = at
			state.LastStatusError = err.Error()
		} else {
			state.LastStatusOKAt = at
			state.LastStatusError = ""
		}
	}
}

func (s *periodicServerStates) Prune(servers map[string]domain.Server) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for serverID := range s.states {
		if _, ok := servers[serverID]; !ok {
			delete(s.states, serverID)
		}
	}
}

func NewPeriodicScriptManager(server *Server) *PeriodicScriptManager {
	return &PeriodicScriptManager{server: server, states: newPeriodicServerStates()}
}

func (m *PeriodicScriptManager) Start() {
	m.mu.Lock()
	if m.cancel != nil {
		m.cancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.states.Reset()
	m.mu.Unlock()

	go m.run(ctx)
}

func (m *PeriodicScriptManager) Stop() {
	m.mu.Lock()
	if m.cancel != nil {
		m.cancel()
		m.cancel = nil
	}
	m.mu.Unlock()
}

func (m *PeriodicScriptManager) Snapshot() map[string]any {
	m.mu.Lock()
	running := m.cancel != nil
	m.mu.Unlock()
	timings := m.timings(context.Background())
	summary := m.states.Summary()
	return map[string]any{
		"periodic_script_manager_running": running,
		"managed_servers":                 summary.ManagedServers,
		"light_status_interval_seconds":   int(timings.LightStatusInterval.Seconds()),
		"detection_interval_seconds":      int(timings.DetectionInterval.Seconds()),
		"scheduler_tick_seconds":          int(timings.SchedulerTick.Seconds()),
		"status_runs":                     summary.StatusRunCount,
		"detection_runs":                  summary.DetectionRunCount,
		"critical_detection_runs":         summary.CriticalRunCount,
		"critical_detection_jobs_running": summary.CriticalJobs,
		"status_jobs_running":             summary.StatusJobs,
		"detection_jobs_running":          summary.DetectionJobs,
		"policy":                          "Run heavy detection only on connect and by interval; run lightweight status by interval; skip servers without an active SSH connection.",
	}
}

func (m *PeriodicScriptManager) RunDetectionNow(ctx context.Context, server domain.Server) (map[string]any, error) {
	_, telemetry, err := m.runDetectionNow(ctx, server)
	return telemetry, err
}

func (m *PeriodicScriptManager) RunCriticalDetectionNow(ctx context.Context, server domain.Server) (map[string]any, error) {
	state, ok := m.states.BeginJob(server.ID, periodicJobCriticalDetection)
	if !ok {
		return nil, nil
	}
	startedAt := time.Now().UTC()
	facts, err := m.server.detectCriticalServerFacts(ctx, server)
	finishedAt := time.Now().UTC()
	telemetry := map[string]any{
		"critical_detection_started_at":  startedAt.Format(time.RFC3339),
		"critical_detection_finished_at": finishedAt.Format(time.RFC3339),
	}
	if err != nil {
		telemetry["critical_detection_result"] = "failed"
		telemetry["critical_detection_error"] = err.Error()
		m.states.FinishJob(server.ID, periodicJobCriticalDetection, state, finishedAt, err)
		return telemetry, err
	}
	if saveErr := saveDetectedFacts(ctx, m.server, server, facts); saveErr != nil {
		log.Printf("failed to save critical facts for %s: %v", server.Name, saveErr)
	}
	addFactTelemetry(telemetry, "critical", facts)
	telemetry["critical_detection_result"] = "ok"
	telemetry["critical_detection_error"] = ""
	m.states.FinishJob(server.ID, periodicJobCriticalDetection, state, finishedAt, nil)
	return telemetry, nil
}

func (m *PeriodicScriptManager) run(ctx context.Context) {
	m.reconcile(ctx)
	for {
		timer := time.NewTimer(m.timings(ctx).SchedulerTick)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			m.reconcile(ctx)
		}
	}
}

func (m *PeriodicScriptManager) reconcile(ctx context.Context) {
	servers, err := m.server.store.ListServers(ctx)
	if err != nil {
		log.Printf("periodic script manager failed to list servers: %v", err)
		return
	}
	byID := make(map[string]domain.Server, len(servers))
	for _, server := range servers {
		byID[server.ID] = server
	}
	m.states.Prune(byID)
	timings := m.timings(ctx)
	for _, server := range orderedServers(servers, byID) {
		if ctx.Err() != nil {
			return
		}
		if !m.server.runtime.IsConnected(server.ID) {
			continue
		}
		if !hasCriticalFacts(server) {
			if !m.states.CriticalDetectionDue(server.ID) {
				continue
			}
			go m.runCriticalDetectionForConnectedServer(ctx, server)
			continue
		}
		if m.states.LightStatusDue(server.ID, timings.LightStatusInterval) {
			serverCopy := server
			go m.runLightStatusNow(ctx, serverCopy)
		}
		if m.states.DetectionDue(server.ID, timings.DetectionInterval) {
			serverCopy := server
			go m.runDetectionForConnectedServer(ctx, serverCopy)
		}
	}
}

func (m *PeriodicScriptManager) runCriticalDetectionForConnectedServer(ctx context.Context, server domain.Server) {
	telemetry, err := m.RunCriticalDetectionNow(ctx, server)
	telemetry["periodic_script_manager"] = true
	m.server.connections.EnrichTelemetry(server.ID, telemetry)
	message := ""
	if err != nil {
		message = "Critical detection script failed: " + err.Error()
	}
	m.upsertConnectedStatus(ctx, server.ID, telemetry, message)
}

func (m *PeriodicScriptManager) runDetectionForConnectedServer(ctx context.Context, server domain.Server) {
	facts, _, err := m.runDetectionNow(ctx, server)
	if err == nil {
		_ = serverWithDetectedFacts(server, facts)
	}
}

func (m *PeriodicScriptManager) runDetectionNow(ctx context.Context, server domain.Server) (scripts.TargetFacts, map[string]any, error) {
	state, ok := m.states.BeginJob(server.ID, periodicJobDetection)
	if !ok {
		return scripts.TargetFacts{}, nil, nil
	}
	startedAt := time.Now().UTC()
	facts, err := m.server.detectServerFacts(ctx, server)
	finishedAt := time.Now().UTC()
	timings := m.timings(ctx)
	telemetry := map[string]any{
		"detection_interval_seconds": int(timings.DetectionInterval.Seconds()),
		"last_detection_started_at":  startedAt.Format(time.RFC3339),
		"last_detection_finished_at": finishedAt.Format(time.RFC3339),
	}
	if err != nil {
		telemetry["last_detection_result"] = "failed"
		telemetry["detection_error"] = err.Error()
		m.states.FinishJob(server.ID, periodicJobDetection, state, finishedAt, err)
		telemetry["periodic_script_manager"] = true
		m.server.connections.EnrichTelemetry(server.ID, telemetry)
		m.upsertConnectedStatus(ctx, server.ID, telemetry, "Detection script failed: "+err.Error())
		return scripts.TargetFacts{}, telemetry, err
	}
	if saveErr := saveDetectedFacts(ctx, m.server, server, facts); saveErr != nil {
		log.Printf("failed to save detected facts for %s: %v", server.Name, saveErr)
	}
	telemetry["last_detection_result"] = "ok"
	telemetry["detection_error"] = ""
	telemetry["telemetry_error"] = ""
	addFactTelemetry(telemetry, "detected", facts)
	m.states.FinishJob(server.ID, periodicJobDetection, state, finishedAt, nil)
	telemetry["periodic_script_manager"] = true
	m.server.connections.EnrichTelemetry(server.ID, telemetry)
	m.upsertConnectedStatus(ctx, server.ID, telemetry, "")
	return facts, telemetry, nil
}

func (m *PeriodicScriptManager) runLightStatusNow(ctx context.Context, server domain.Server) {
	state, ok := m.states.BeginJob(server.ID, periodicJobLightStatus)
	if !ok {
		return
	}
	startedAt := time.Now().UTC()
	timings := m.timings(ctx)
	telemetry := map[string]any{
		"light_status_interval_seconds": int(timings.LightStatusInterval.Seconds()),
		"last_status_started_at":        startedAt.Format(time.RFC3339),
	}
	facts := targetFactsForServer(server)
	selected, err := m.server.scripts.Select("status", facts)
	if err != nil {
		m.finishStatusWithError(ctx, server, state, startedAt, telemetry, err)
		return
	}
	telemetry["status_script_variant"] = selected.Variant.ID
	timeout := selected.Timeout + 2*time.Second
	if timeout <= 2*time.Second {
		timeout = time.Duration(m.server.cfg.Scripts.DefaultTimeoutSeconds)*time.Second + 2*time.Second
	}
	statusCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	result, err := m.server.runtime.RunJSON(statusCtx, server.ID, scripts.RemoteCommandForVariant(selected))
	finishedAt := time.Now().UTC()
	telemetry["last_status_finished_at"] = finishedAt.Format(time.RFC3339)
	if err != nil {
		if errors.Is(err, runtime.ErrNotConnected) {
			m.states.FinishJob(server.ID, periodicJobLightStatus, state, finishedAt, err)
			return
		}
		m.finishStatusWithError(ctx, server, state, startedAt, telemetry, err)
		return
	}
	for key, value := range result {
		telemetry[key] = value
	}
	m.server.connections.EnrichTelemetry(server.ID, telemetry)
	m.applyCPUUsageDelta(ctx, server.ID, telemetry)
	m.appendCPUUsageHistoryFromTelemetry(ctx, server.ID, telemetry)
	telemetry["last_status_result"] = "ok"
	telemetry["status_error"] = ""
	telemetry["telemetry_error"] = ""
	telemetry["periodic_script_manager"] = true
	m.states.FinishJob(server.ID, periodicJobLightStatus, state, finishedAt, nil)
	m.upsertConnectedStatus(ctx, server.ID, telemetry, "")
}

func (m *PeriodicScriptManager) finishStatusWithError(ctx context.Context, server domain.Server, state *periodicServerState, startedAt time.Time, telemetry map[string]any, err error) {
	finishedAt := time.Now().UTC()
	telemetry["last_status_finished_at"] = finishedAt.Format(time.RFC3339)
	telemetry["last_status_result"] = "failed"
	telemetry["status_error"] = err.Error()
	telemetry["periodic_script_manager"] = true
	m.server.connections.EnrichTelemetry(server.ID, telemetry)
	m.states.FinishJob(server.ID, periodicJobLightStatus, state, finishedAt, err)
	telemetry["last_status_started_at"] = startedAt.Format(time.RFC3339)
	m.upsertConnectedStatus(ctx, server.ID, telemetry, "Lightweight status script failed: "+err.Error())
}

func (m *PeriodicScriptManager) upsertConnectedStatus(ctx context.Context, serverID string, telemetry map[string]any, message string) {
	saveCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if ctx.Err() == nil {
		saveCtx = ctx
	}
	status := domain.ServerStatus{ServerID: serverID, State: domain.StatusConnected, Telemetry: telemetry, LastError: message, UpdatedAt: time.Now().UTC()}
	if err := m.server.store.UpsertStatus(saveCtx, status); err != nil {
		log.Printf("failed to save periodic status for %s: %v", serverID, err)
	}
}

func (m *PeriodicScriptManager) applyCPUUsageDelta(ctx context.Context, serverID string, telemetry map[string]any) {
	currentTotal, okTotal := telemetryNumber(telemetry, "cpu_total_jiffies")
	currentIdle, okIdle := telemetryNumber(telemetry, "cpu_idle_jiffies")
	if !okTotal || !okIdle {
		return
	}
	telemetry["cpu_usage_percent"] = nil
	telemetry["cpu_metric_source"] = "proc_stat_delta_waiting"
	previous, ok := m.previousStatus(ctx, serverID)
	if !ok {
		return
	}
	previousTotal, okTotal := telemetryNumber(previous.Telemetry, "cpu_total_jiffies")
	previousIdle, okIdle := telemetryNumber(previous.Telemetry, "cpu_idle_jiffies")
	if !okTotal || !okIdle {
		return
	}
	usage, ok := cpuUsageDeltaPercent(currentTotal, currentIdle, previousTotal, previousIdle)
	if !ok {
		telemetry["cpu_metric_source"] = "proc_stat_delta_reset"
		return
	}
	roundedUsage := math.Round(usage*10) / 10
	telemetry["cpu_usage_percent"] = roundedUsage
	telemetry["cpu_metric_source"] = "proc_stat_delta"
	if !previous.UpdatedAt.IsZero() {
		telemetry["cpu_sample_interval_seconds"] = math.Round(time.Since(previous.UpdatedAt).Seconds()*10) / 10
	}
}

func (m *PeriodicScriptManager) appendCPUUsageHistoryFromTelemetry(ctx context.Context, serverID string, telemetry map[string]any) {
	usage, ok := telemetryNumber(telemetry, "cpu_usage_percent")
	if !ok {
		return
	}
	previous, ok := m.previousStatus(ctx, serverID)
	previousTelemetry := map[string]any{}
	if ok {
		previousTelemetry = previous.Telemetry
	}
	appendCPUUsageHistory(telemetry, previousTelemetry, usage)
}

func appendCPUUsageHistory(telemetry map[string]any, previousTelemetry map[string]any, usage float64) {
	connectionKey := telemetryString(telemetry, "last_connected_at")
	previousConnectionKey := telemetryString(previousTelemetry, cpuUsageHistoryConnectionTelemetryKey)
	history := []float64{}
	if connectionKey != "" && previousConnectionKey == connectionKey {
		history = telemetryNumberSlice(previousTelemetry[cpuUsageHistoryTelemetryKey])
	}
	history = append(history, clampCPUPercent(usage))
	if len(history) > cpuUsageHistoryLimit {
		history = history[len(history)-cpuUsageHistoryLimit:]
	}
	telemetry[cpuUsageHistoryTelemetryKey] = history
	telemetry[cpuUsageHistoryConnectionTelemetryKey] = connectionKey
	telemetry[cpuUsageHistoryUpdatedTelemetryKey] = time.Now().UTC().Format(time.RFC3339)
}

func (m *PeriodicScriptManager) previousStatus(ctx context.Context, serverID string) (domain.ServerStatus, bool) {
	readCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if ctx.Err() == nil {
		readCtx = ctx
	}
	statuses, err := m.server.store.ListStatuses(readCtx)
	if err != nil {
		log.Printf("failed to read previous status for %s: %v", serverID, err)
		return domain.ServerStatus{}, false
	}
	for _, status := range statuses {
		if status.ServerID == serverID {
			return status, true
		}
	}
	return domain.ServerStatus{}, false
}

func cpuUsageDeltaPercent(currentTotal float64, currentIdle float64, previousTotal float64, previousIdle float64) (float64, bool) {
	deltaTotal := currentTotal - previousTotal
	deltaIdle := currentIdle - previousIdle
	if deltaTotal <= 0 || deltaIdle < 0 || deltaIdle > deltaTotal {
		return 0, false
	}
	usage := 100 * (deltaTotal - deltaIdle) / deltaTotal
	if usage < 0 {
		usage = 0
	}
	if usage > 100 {
		usage = 100
	}
	return usage, true
}

func telemetryNumber(telemetry map[string]any, key string) (float64, bool) {
	raw, ok := telemetry[key]
	if !ok || raw == nil {
		return 0, false
	}
	switch value := raw.(type) {
	case float64:
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return 0, false
		}
		return value, true
	case float32:
		number := float64(value)
		if math.IsNaN(number) || math.IsInf(number, 0) {
			return 0, false
		}
		return number, true
	case int:
		return float64(value), true
	case int64:
		return float64(value), true
	case json.Number:
		number, err := value.Float64()
		if err != nil || math.IsNaN(number) || math.IsInf(number, 0) {
			return 0, false
		}
		return number, true
	default:
		return 0, false
	}
}

func telemetryString(telemetry map[string]any, key string) string {
	raw, ok := telemetry[key]
	if !ok || raw == nil {
		return ""
	}
	value, ok := raw.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(value)
}

func telemetryNumberSlice(raw any) []float64 {
	switch values := raw.(type) {
	case []float64:
		out := make([]float64, 0, len(values))
		for _, value := range values {
			if math.IsNaN(value) || math.IsInf(value, 0) {
				continue
			}
			out = append(out, clampCPUPercent(value))
		}
		return out
	case []any:
		out := make([]float64, 0, len(values))
		for _, rawValue := range values {
			value, ok := telemetryNumber(map[string]any{"value": rawValue}, "value")
			if !ok {
				continue
			}
			out = append(out, clampCPUPercent(value))
		}
		return out
	default:
		return nil
	}
}

func clampCPUPercent(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 100 {
		return 100
	}
	return math.Round(value*10) / 10
}

func (m *PeriodicScriptManager) timings(ctx context.Context) periodicTimings {
	timings := periodicTimings{
		LightStatusInterval: positiveSeconds(m.server.cfg.Runtime.LightStatusIntervalSeconds, 5),
		DetectionInterval:   positiveSeconds(m.server.cfg.Runtime.DetectionIntervalSeconds, 1800),
		SchedulerTick:       positiveSeconds(m.server.cfg.Runtime.PeriodicScriptTickSeconds, 1),
	}
	settings, err := m.server.store.GetSSHSecuritySettings(ctx)
	if err != nil {
		return timings
	}
	if settings.LightStatusIntervalSeconds > 0 {
		timings.LightStatusInterval = positiveSeconds(settings.LightStatusIntervalSeconds, 5)
	}
	if settings.DetectionIntervalSeconds > 0 {
		timings.DetectionInterval = positiveSeconds(settings.DetectionIntervalSeconds, 1800)
	}
	if settings.PeriodicScriptTickSeconds > 0 {
		timings.SchedulerTick = positiveSeconds(settings.PeriodicScriptTickSeconds, 1)
	}
	return timings
}

func positiveSeconds(value int, fallback int) time.Duration {
	if value <= 0 {
		value = fallback
	}
	return time.Duration(value) * time.Second
}

func targetFactsForServer(server domain.Server) scripts.TargetFacts {
	return scripts.TargetFacts{
		Hostname:       firstNonEmpty(server.DetectedHostname, server.Name),
		Shell:          firstNonEmpty(server.OverrideShell, server.DetectedShell, server.ShellHint),
		OS:             firstNonEmpty(server.OverrideOS, server.DetectedOS, server.OSHint),
		Platform:       server.DetectedPlatform,
		PlatformOS:     server.DetectedPlatformOS,
		PlatformArch:   server.DetectedPlatformArch,
		Distro:         firstNonEmpty(server.OverrideDistro, server.DetectedDistro, server.DistroHint),
		KernelVersion:  server.DetectedKernelVersion,
		PackageManager: server.DetectedPackageManager,
		IsPVEHost:      server.DetectedPVEHost,
		IsDockerHost:   server.DetectedDockerHost,
		Apps:           server.DetectedApps,
		AdminRights: firstNonEmpty(
			server.OverrideAdminRights,
			server.DetectedAdminRights,
		),
	}
}

func hasCriticalFacts(server domain.Server) bool {
	facts := targetFactsForServer(server)
	return strings.TrimSpace(facts.Shell) != "" && strings.TrimSpace(facts.OS) != ""
}

func serverWithDetectedFacts(server domain.Server, facts scripts.TargetFacts) domain.Server {
	server.DetectedShell = firstNonEmpty(facts.Shell, server.DetectedShell)
	server.DetectedOS = firstNonEmpty(facts.OS, server.DetectedOS)
	server.DetectedDistro = firstNonEmpty(facts.Distro, server.DetectedDistro)
	server.DetectedAdminRights = firstNonEmpty(facts.AdminRights, server.DetectedAdminRights)
	server.DetectedHostname = firstNonEmpty(facts.Hostname, server.DetectedHostname)
	server.DetectedPlatform = firstNonEmpty(facts.Platform, server.DetectedPlatform)
	server.DetectedPlatformOS = firstNonEmpty(facts.PlatformOS, server.DetectedPlatformOS)
	server.DetectedPlatformArch = firstNonEmpty(facts.PlatformArch, server.DetectedPlatformArch)
	server.DetectedKernelVersion = firstNonEmpty(facts.KernelVersion, server.DetectedKernelVersion)
	server.DetectedPackageManager = firstNonEmpty(facts.PackageManager, server.DetectedPackageManager)
	if facts.SSHMaxSessions > 0 {
		server.DetectedSSHMaxSessions = facts.SSHMaxSessions
	}
	server.DetectedPVEHost = facts.IsPVEHost || server.DetectedPVEHost
	server.DetectedDockerHost = facts.IsDockerHost || server.DetectedDockerHost
	if len(facts.Apps) > 0 {
		server.DetectedApps = facts.Apps
	}
	return server
}

func saveDetectedFacts(ctx context.Context, server *Server, target domain.Server, facts scripts.TargetFacts) error {
	merged := serverWithDetectedFacts(target, facts)
	return server.store.UpdateServerDetectedFacts(ctx, target.ID, domain.ServerFacts{
		Hostname:       merged.DetectedHostname,
		Shell:          merged.DetectedShell,
		OS:             merged.DetectedOS,
		Platform:       merged.DetectedPlatform,
		PlatformOS:     merged.DetectedPlatformOS,
		PlatformArch:   merged.DetectedPlatformArch,
		Distro:         merged.DetectedDistro,
		AdminRights:    merged.DetectedAdminRights,
		KernelVersion:  merged.DetectedKernelVersion,
		PackageManager: merged.DetectedPackageManager,
		SSHMaxSessions: merged.DetectedSSHMaxSessions,
		IsPVEHost:      merged.DetectedPVEHost,
		IsDockerHost:   merged.DetectedDockerHost,
		Apps:           merged.DetectedApps,
	})
}

func addFactTelemetry(telemetry map[string]any, prefix string, facts scripts.TargetFacts) {
	telemetry[prefix+"_shell"] = facts.Shell
	telemetry[prefix+"_os"] = facts.OS
	telemetry[prefix+"_platform"] = facts.Platform
	telemetry[prefix+"_platform_os"] = facts.PlatformOS
	telemetry[prefix+"_platform_arch"] = facts.PlatformArch
	telemetry[prefix+"_distro"] = facts.Distro
	telemetry[prefix+"_admin_rights"] = facts.AdminRights
	telemetry[prefix+"_hostname"] = facts.Hostname
	telemetry[prefix+"_kernel_version"] = facts.KernelVersion
	telemetry[prefix+"_package_manager"] = facts.PackageManager
	telemetry[prefix+"_ssh_max_sessions"] = facts.SSHMaxSessions
	telemetry[prefix+"_virtualization"] = facts.Virtualization
	telemetry[prefix+"_winget_needs_initialization"] = facts.WingetNeedsInitialization
	telemetry[prefix+"_is_pve_host"] = facts.IsPVEHost
	telemetry[prefix+"_is_docker_host"] = facts.IsDockerHost
	telemetry[prefix+"_is_podman_host"] = facts.IsPodmanHost
	telemetry[prefix+"_apps"] = facts.Apps
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
