// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package httpapi

import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"shellorchestra/backend/internal/auditlog"
	"shellorchestra/backend/internal/domain"
)

type sshTunnelRequest struct {
	Label             string               `json:"label"`
	Kind              domain.SSHTunnelKind `json:"kind"`
	ServerID          string               `json:"server_id"`
	BindAddress       string               `json:"bind_address"`
	BindPort          int                  `json:"bind_port"`
	DestinationHost   string               `json:"destination_host"`
	DestinationPort   int                  `json:"destination_port"`
	AutoStart         bool                 `json:"auto_start"`
	AutoReconnect     bool                 `json:"auto_reconnect"`
	PauseOnDisconnect bool                 `json:"pause_on_disconnect"`
	Paused            bool                 `json:"paused"`
	Tags              []string             `json:"tags"`
	ConfirmedExposure bool                 `json:"confirmed_exposure"`
	Start             bool                 `json:"start"`
}

type sshTunnelProbeRequest struct {
	Mode          string `json:"mode"`
	PayloadBytes  int64  `json:"payload_bytes"`
	HTTPHost      string `json:"http_host"`
	HTTPPath      string `json:"http_path"`
	TimeoutMillis int    `json:"timeout_ms"`
}

func (r sshTunnelRequest) input() domain.SSHTunnelInput {
	return domain.SSHTunnelInput{
		Label:             r.Label,
		Kind:              r.Kind,
		ServerID:          r.ServerID,
		BindAddress:       r.BindAddress,
		BindPort:          r.BindPort,
		DestinationHost:   r.DestinationHost,
		DestinationPort:   r.DestinationPort,
		AutoStart:         r.AutoStart,
		AutoReconnect:     r.AutoReconnect,
		PauseOnDisconnect: r.PauseOnDisconnect,
		Paused:            r.Paused,
		Tags:              r.Tags,
		ConfirmedExposure: r.ConfirmedExposure,
	}
}

func (a *App) sshTunnelRuntime() *sshTunnelManager {
	a.sshTunnelsMu.Lock()
	defer a.sshTunnelsMu.Unlock()
	if a.sshTunnelManager == nil {
		a.sshTunnelManager = newSSHTunnelManager(a)
	}
	return a.sshTunnelManager
}

func (a *App) sshTunnels(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.sshTunnelRuntime().startAutoStart(r.Context())
		tunnels, err := a.deps.Store.ListSSHTunnels(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"tunnels": a.sshTunnelRuntime().attachRuntime(tunnels)})
	case http.MethodPost:
		var input sshTunnelRequest
		if !decodeJSON(w, r, &input) {
			return
		}
		if err := validateTunnelExposure(input.input()); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := a.appendSSHTunnelAudit(r.Context(), r, "ssh_tunnel.create.request", "create", "", input.input(), nil); err != nil {
			writeError(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		tunnel, err := a.deps.Store.CreateSSHTunnel(r.Context(), input.input())
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if input.Start {
			tunnel, _ = a.deps.Store.UpdateSSHTunnelPaused(r.Context(), tunnel.ID, false)
			if err := a.sshTunnelRuntime().Start(r.Context(), tunnel.ID); err != nil {
				writeJSON(w, http.StatusCreated, map[string]any{"tunnel": a.sshTunnelRuntime().attachOne(tunnel), "start_error": err.Error()})
				return
			}
		}
		_ = a.appendSSHTunnelAudit(context.WithoutCancel(r.Context()), r, "ssh_tunnel.create.commit", "create", tunnel.ID, input.input(), nil)
		writeJSON(w, http.StatusCreated, map[string]any{"tunnel": a.sshTunnelRuntime().attachOne(tunnel)})
	default:
		methodNotAllowed(w)
	}
}

func (a *App) sshTunnelByID(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/global-apps/ssh-tunnels/")
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	if len(parts) == 0 || strings.TrimSpace(parts[0]) == "" {
		writeError(w, http.StatusNotFound, "SSH tunnel not found.")
		return
	}
	id := strings.TrimSpace(parts[0])
	if len(parts) == 1 {
		a.sshTunnelProfileByID(w, r, id)
		return
	}
	if len(parts) == 2 {
		switch parts[1] {
		case "start":
			a.sshTunnelAction(w, r, id, "start")
			return
		case "pause":
			a.sshTunnelAction(w, r, id, "pause")
			return
		case "restart":
			a.sshTunnelAction(w, r, id, "restart")
			return
		case "probe":
			a.sshTunnelProbe(w, r, id)
			return
		case "debug-break":
			a.sshTunnelDebugBreak(w, r, id)
			return
		}
	}
	writeError(w, http.StatusNotFound, "SSH tunnel route not found.")
}

func (a *App) sshTunnelProfileByID(w http.ResponseWriter, r *http.Request, id string) {
	switch r.Method {
	case http.MethodGet:
		tunnel, err := a.deps.Store.GetSSHTunnel(r.Context(), id)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"tunnel": a.sshTunnelRuntime().attachOne(tunnel)})
	case http.MethodPut, http.MethodPatch:
		var input sshTunnelRequest
		if !decodeJSON(w, r, &input) {
			return
		}
		if err := validateTunnelExposure(input.input()); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := a.appendSSHTunnelAudit(r.Context(), r, "ssh_tunnel.update.request", "update", id, input.input(), nil); err != nil {
			writeError(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		a.sshTunnelRuntime().Stop(id, domain.SSHTunnelStateStopped, "Tunnel profile was updated.")
		tunnel, err := a.deps.Store.UpdateSSHTunnel(r.Context(), id, input.input())
		if err != nil {
			writeStoreError(w, err)
			return
		}
		if input.Start {
			tunnel, _ = a.deps.Store.UpdateSSHTunnelPaused(r.Context(), tunnel.ID, false)
			_ = a.sshTunnelRuntime().Start(r.Context(), tunnel.ID)
		}
		_ = a.appendSSHTunnelAudit(context.WithoutCancel(r.Context()), r, "ssh_tunnel.update.commit", "update", tunnel.ID, input.input(), nil)
		writeJSON(w, http.StatusOK, map[string]any{"tunnel": a.sshTunnelRuntime().attachOne(tunnel)})
	case http.MethodDelete:
		if err := a.appendSSHTunnelAudit(r.Context(), r, "ssh_tunnel.delete.request", "delete", id, domain.SSHTunnelInput{}, nil); err != nil {
			writeError(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		a.sshTunnelRuntime().Stop(id, domain.SSHTunnelStateStopped, "Tunnel was deleted.")
		if err := a.deps.Store.DeleteSSHTunnel(r.Context(), id); err != nil {
			writeStoreError(w, err)
			return
		}
		_ = a.appendSSHTunnelAudit(context.WithoutCancel(r.Context()), r, "ssh_tunnel.delete.commit", "delete", id, domain.SSHTunnelInput{}, nil)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		methodNotAllowed(w)
	}
}

func (a *App) sshTunnelAction(w http.ResponseWriter, r *http.Request, id string, action string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if err := a.appendSSHTunnelAudit(r.Context(), r, "ssh_tunnel."+action+".request", action, id, domain.SSHTunnelInput{}, nil); err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	var err error
	switch action {
	case "start":
		_, _ = a.deps.Store.UpdateSSHTunnelPaused(r.Context(), id, false)
		err = a.sshTunnelRuntime().Start(r.Context(), id)
	case "pause":
		_, _ = a.deps.Store.UpdateSSHTunnelPaused(r.Context(), id, true)
		a.sshTunnelRuntime().Stop(id, domain.SSHTunnelStatePaused, "Tunnel was paused.")
	case "restart":
		a.sshTunnelRuntime().Stop(id, domain.SSHTunnelStateReconnecting, "Tunnel is restarting.")
		_, _ = a.deps.Store.UpdateSSHTunnelPaused(r.Context(), id, false)
		err = a.sshTunnelRuntime().Start(r.Context(), id)
	}
	if err != nil {
		_ = a.appendSSHTunnelAudit(context.WithoutCancel(r.Context()), r, "ssh_tunnel."+action+".failed", action, id, domain.SSHTunnelInput{}, err)
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	_ = a.appendSSHTunnelAudit(context.WithoutCancel(r.Context()), r, "ssh_tunnel."+action+".commit", action, id, domain.SSHTunnelInput{}, nil)
	tunnel, getErr := a.deps.Store.GetSSHTunnel(r.Context(), id)
	if getErr != nil {
		writeStoreError(w, getErr)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tunnel": a.sshTunnelRuntime().attachOne(tunnel)})
}

func (a *App) sshTunnelProbe(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var input sshTunnelProbeRequest
	if !decodeJSON(w, r, &input) {
		return
	}
	result, err := a.sshTunnelRuntime().Probe(r.Context(), id, input)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *App) sshTunnelDebugBreak(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !a.requireDebugEndpointAccess(w, r, "Debug SSH tunnel break") {
		return
	}
	if err := a.sshTunnelRuntime().DebugBreak(id); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func validateTunnelExposure(input domain.SSHTunnelInput) error {
	if input.BindAddress == "127.0.0.1" || input.BindAddress == "localhost" || input.BindAddress == "::1" {
		return nil
	}
	if !input.ConfirmedExposure {
		return fmt.Errorf("binding SSH tunnel to %s can expose it on the backend host network; confirm exposure before saving", input.BindAddress)
	}
	return nil
}

func (a *App) ensureTunnelServer(ctx context.Context, server domain.Server) error {
	if a.deps.Worker != nil {
		return a.deps.Worker.EnsureServerConnection(ctx, server)
	}
	if a.deps.Runtime == nil {
		return fmt.Errorf("SSH runtime is not configured")
	}
	status, err := a.deps.Runtime.Connect(ctx, server)
	if err != nil {
		return err
	}
	if status.State != domain.StatusConnected {
		if strings.TrimSpace(status.LastError) != "" {
			return fmt.Errorf("%s", status.LastError)
		}
		return fmt.Errorf("managed SSH connection is not connected")
	}
	return nil
}

func (a *App) dialTunnelThroughServer(ctx context.Context, server domain.Server, network string, address string) (net.Conn, error) {
	if a.deps.Worker != nil {
		return a.deps.Worker.DialThroughServer(ctx, server.ID, network, address)
	}
	if a.deps.Runtime == nil {
		return nil, fmt.Errorf("SSH runtime is not configured")
	}
	return a.deps.Runtime.DialThroughServer(ctx, server, network, address)
}

func (a *App) appendSSHTunnelAudit(ctx context.Context, r *http.Request, eventType string, operation string, tunnelID string, input domain.SSHTunnelInput, opErr error) error {
	if a.deps.Audit == nil {
		return fmt.Errorf("audit log is not configured")
	}
	principal, _ := r.Context().Value(principalKey{}).(*domain.Principal)
	metadata := map[string]string{
		"tunnel_id":             strings.TrimSpace(tunnelID),
		"kind":                  string(input.Kind),
		"server_id":             strings.TrimSpace(input.ServerID),
		"bind_address":          strings.TrimSpace(input.BindAddress),
		"bind_port":             strconv.Itoa(input.BindPort),
		"destination_host":      strings.TrimSpace(input.DestinationHost),
		"destination_port":      strconv.Itoa(input.DestinationPort),
		"auto_start":            strconv.FormatBool(input.AutoStart),
		"auto_reconnect":        strconv.FormatBool(input.AutoReconnect),
		"pause_on_disconnect":   strconv.FormatBool(input.PauseOnDisconnect),
		"confirmed_exposure":    strconv.FormatBool(input.ConfirmedExposure),
		"error_message_logged":  "false",
		"operator_facing_label": strings.TrimSpace(input.Label),
	}
	if opErr != nil {
		metadata["error"] = opErr.Error()
	}
	_, err := a.deps.Audit.Append(ctx, auditlog.EventInput{
		Type:          eventType,
		ActorDeviceID: principalDeviceID(principal),
		ActorLabel:    principalLabel(principal),
		ClientIP:      sessionClientIP(r),
		ServerID:      strings.TrimSpace(input.ServerID),
		Operation:     operation,
		Path:          "global-apps/ssh-tunnels/" + strings.TrimSpace(tunnelID),
		RequestID:     r.Header.Get("X-ShellOrchestra-Nonce"),
		Metadata:      metadata,
	})
	return err
}

type sshTunnelManager struct {
	app           *App
	mu            sync.Mutex
	runtimes      map[string]*sshTunnelRuntime
	autoOnce      sync.Once
	reconnectOnce sync.Once
}

type sshTunnelRuntime struct {
	profileID    string
	state        domain.SSHTunnelState
	listener     net.Listener
	cancel       context.CancelFunc
	assignedPort int
	startedAt    time.Time
	lastError    string
	bytesIn      atomic.Uint64
	bytesOut     atomic.Uint64
	clientCount  atomic.Int64
	updatedAt    time.Time
}

type countedConn struct {
	net.Conn
	readBytes  *atomic.Uint64
	writeBytes *atomic.Uint64
}

func newSSHTunnelManager(app *App) *sshTunnelManager {
	return &sshTunnelManager{app: app, runtimes: map[string]*sshTunnelRuntime{}}
}

func (m *sshTunnelManager) startAutoStart(ctx context.Context) {
	m.autoOnce.Do(func() {
		profiles, err := m.app.deps.Store.ListSSHTunnels(ctx)
		if err != nil {
			log.Printf("SSH tunnel autostart list failed: %v", err)
			return
		}
		for _, profile := range profiles {
			if profile.AutoStart && !profile.Paused {
				go func(id string) { _ = m.Start(context.Background(), id) }(profile.ID)
			}
		}
	})
	m.reconnectOnce.Do(func() {
		go m.reconnectLoop(context.Background())
	})
}

func (m *sshTunnelManager) attachRuntime(tunnels []domain.SSHTunnelProfile) []map[string]any {
	out := make([]map[string]any, 0, len(tunnels))
	for _, tunnel := range tunnels {
		out = append(out, m.attachOne(tunnel))
	}
	return out
}

func (m *sshTunnelManager) attachOne(tunnel domain.SSHTunnelProfile) map[string]any {
	runtime := m.snapshot(tunnel.ID)
	return map[string]any{"profile": tunnel, "runtime": runtime}
}

func (m *sshTunnelManager) snapshot(profileID string) domain.SSHTunnelRuntime {
	m.mu.Lock()
	defer m.mu.Unlock()
	rt := m.runtimes[profileID]
	if rt == nil {
		return domain.SSHTunnelRuntime{ProfileID: profileID, State: domain.SSHTunnelStateStopped, UpdatedAt: time.Now().UTC()}
	}
	var started *time.Time
	if !rt.startedAt.IsZero() {
		value := rt.startedAt
		started = &value
	}
	return domain.SSHTunnelRuntime{
		ProfileID:    profileID,
		State:        rt.state,
		AssignedPort: rt.assignedPort,
		StartedAt:    started,
		LastError:    rt.lastError,
		BytesIn:      rt.bytesIn.Load(),
		BytesOut:     rt.bytesOut.Load(),
		ClientCount:  int(rt.clientCount.Load()),
		Active:       rt.listener != nil,
		UpdatedAt:    rt.updatedAt,
	}
}

func (m *sshTunnelManager) Start(ctx context.Context, profileID string) error {
	profile, err := m.app.deps.Store.GetSSHTunnel(ctx, profileID)
	if err != nil {
		return err
	}
	if profile.Paused {
		return fmt.Errorf("SSH tunnel is paused")
	}
	if err := m.probeProfile(ctx, profile); err != nil {
		m.setFailure(profile.ID, err)
		return err
	}
	m.mu.Lock()
	if existing := m.runtimes[profile.ID]; existing != nil && existing.listener != nil {
		m.mu.Unlock()
		return nil
	}
	runtimeCtx, cancel := context.WithCancel(context.Background())
	rt := &sshTunnelRuntime{profileID: profile.ID, state: domain.SSHTunnelStateStarting, cancel: cancel, updatedAt: time.Now().UTC()}
	m.runtimes[profile.ID] = rt
	m.mu.Unlock()

	listener, err := net.Listen("tcp", net.JoinHostPort(profile.BindAddress, strconv.Itoa(profile.BindPort)))
	if err != nil {
		cancel()
		m.setFailure(profile.ID, err)
		return err
	}
	assigned := profile.BindPort
	if tcpAddr, ok := listener.Addr().(*net.TCPAddr); ok {
		assigned = tcpAddr.Port
	}
	m.mu.Lock()
	rt.listener = listener
	rt.assignedPort = assigned
	rt.startedAt = time.Now().UTC()
	rt.state = domain.SSHTunnelStateRunning
	rt.lastError = ""
	rt.updatedAt = time.Now().UTC()
	m.mu.Unlock()
	go m.acceptLoop(runtimeCtx, profile, rt)
	return nil
}

func (m *sshTunnelManager) Probe(ctx context.Context, profileID string, input sshTunnelProbeRequest) (map[string]any, error) {
	profile, err := m.app.deps.Store.GetSSHTunnel(ctx, profileID)
	if err != nil {
		return nil, err
	}
	runtime := m.snapshot(profile.ID)
	if runtime.State != domain.SSHTunnelStateRunning || runtime.AssignedPort <= 0 {
		return nil, fmt.Errorf("SSH tunnel is not running")
	}
	mode := strings.TrimSpace(input.Mode)
	if mode == "" {
		mode = "tcp_connect"
	}
	timeout := probeTimeout(input.TimeoutMillis)
	started := time.Now()
	dialer := net.Dialer{Timeout: timeout}
	conn, err := dialer.DialContext(ctx, "tcp", tunnelProbeAddress(profile, runtime.AssignedPort))
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))
	result := map[string]any{
		"ok":            true,
		"mode":          mode,
		"profile_id":    profile.ID,
		"assigned_port": runtime.AssignedPort,
	}
	switch mode {
	case "tcp_connect":
		// Successful dial is the probe.
	case "ssh_banner":
		banner, err := readTunnelProbeLine(conn, 256)
		if err != nil {
			return nil, err
		}
		if !strings.HasPrefix(banner, "SSH-") {
			return nil, fmt.Errorf("unexpected SSH banner: %q", banner)
		}
		result["banner"] = banner
		result["bytes_read"] = len(banner)
	case "echo_payload":
		bytesWritten, bytesRead, err := probeEchoPayload(conn, input.PayloadBytes)
		if err != nil {
			return nil, err
		}
		result["bytes_written"] = bytesWritten
		result["bytes_read"] = bytesRead
	case "https_debug_payload":
		bytesRead, statusLine, err := m.probeHTTPSDebugPayload(ctx, conn, input)
		if err != nil {
			return nil, err
		}
		result["bytes_read"] = bytesRead
		result["status_line"] = statusLine
	default:
		return nil, fmt.Errorf("unsupported SSH tunnel probe mode %q", mode)
	}
	result["elapsed_ms"] = time.Since(started).Milliseconds()
	return result, nil
}

func (m *sshTunnelManager) DebugBreak(profileID string) error {
	m.mu.Lock()
	rt := m.runtimes[profileID]
	if rt == nil || rt.listener == nil {
		m.mu.Unlock()
		return fmt.Errorf("SSH tunnel is not running")
	}
	listener := rt.listener
	cancel := rt.cancel
	rt.listener = nil
	rt.cancel = nil
	rt.state = domain.SSHTunnelStateFailed
	rt.lastError = "Tunnel listener was interrupted by debug test."
	rt.updatedAt = time.Now().UTC()
	m.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	_ = listener.Close()
	return nil
}

func (m *sshTunnelManager) reconnectLoop(ctx context.Context) {
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.reconnectDesiredTunnels(ctx)
		}
	}
}

func (m *sshTunnelManager) reconnectDesiredTunnels(ctx context.Context) {
	profiles, err := m.app.deps.Store.ListSSHTunnels(ctx)
	if err != nil {
		log.Printf("SSH tunnel reconnect list failed: %v", err)
		return
	}
	for _, profile := range profiles {
		if !profile.AutoReconnect || profile.Paused {
			continue
		}
		if !profile.AutoStart && !m.runtimeLooksDesired(profile.ID) {
			continue
		}
		runtime := m.snapshot(profile.ID)
		if runtime.Active && runtime.State == domain.SSHTunnelStateRunning {
			continue
		}
		go func(id string) {
			if err := m.Start(context.Background(), id); err != nil {
				log.Printf("SSH tunnel reconnect failed for %s: %v", id, err)
			}
		}(profile.ID)
	}
}

func (m *sshTunnelManager) runtimeLooksDesired(profileID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	rt := m.runtimes[profileID]
	if rt == nil {
		return false
	}
	return rt.state == domain.SSHTunnelStateRunning ||
		rt.state == domain.SSHTunnelStateReconnecting ||
		rt.state == domain.SSHTunnelStateFailed ||
		!rt.startedAt.IsZero()
}

func (m *sshTunnelManager) probeProfile(ctx context.Context, profile domain.SSHTunnelProfile) error {
	server, err := m.app.deps.Store.GetServer(ctx, profile.ServerID)
	if err != nil {
		return err
	}
	probeCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if err := m.app.ensureTunnelServer(probeCtx, server); err != nil {
		return err
	}
	if profile.Kind != domain.SSHTunnelKindTCPForward {
		return nil
	}
	conn, err := m.app.dialTunnelThroughServer(probeCtx, server, "tcp", net.JoinHostPort(profile.DestinationHost, strconv.Itoa(profile.DestinationPort)))
	if err != nil {
		return err
	}
	_ = conn.Close()
	return nil
}

func (m *sshTunnelManager) Stop(profileID string, state domain.SSHTunnelState, message string) {
	m.mu.Lock()
	rt := m.runtimes[profileID]
	if rt == nil {
		rt = &sshTunnelRuntime{profileID: profileID}
		m.runtimes[profileID] = rt
	}
	listener := rt.listener
	rt.listener = nil
	if rt.cancel != nil {
		rt.cancel()
		rt.cancel = nil
	}
	rt.state = state
	rt.lastError = message
	rt.updatedAt = time.Now().UTC()
	m.mu.Unlock()
	if listener != nil {
		_ = listener.Close()
	}
}

func (m *sshTunnelManager) setFailure(profileID string, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rt := m.runtimes[profileID]
	if rt == nil {
		rt = &sshTunnelRuntime{profileID: profileID}
		m.runtimes[profileID] = rt
	}
	rt.state = domain.SSHTunnelStateFailed
	rt.lastError = err.Error()
	rt.listener = nil
	rt.updatedAt = time.Now().UTC()
}

func (m *sshTunnelManager) acceptLoop(ctx context.Context, profile domain.SSHTunnelProfile, rt *sshTunnelRuntime) {
	for {
		client, err := rt.listener.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return
			default:
				m.setFailure(profile.ID, err)
				return
			}
		}
		rt.clientCount.Add(1)
		go func() {
			defer rt.clientCount.Add(-1)
			m.handleClient(ctx, profile, rt, client)
		}()
	}
}

func (m *sshTunnelManager) handleClient(ctx context.Context, profile domain.SSHTunnelProfile, rt *sshTunnelRuntime, client net.Conn) {
	defer client.Close()
	server, err := m.app.deps.Store.GetServer(ctx, profile.ServerID)
	if err != nil {
		m.noteRuntimeError(profile.ID, err)
		return
	}
	connectCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if err := m.app.ensureTunnelServer(connectCtx, server); err != nil {
		m.noteRuntimeError(profile.ID, err)
		return
	}
	var remote net.Conn
	if profile.Kind == domain.SSHTunnelKindSOCKS {
		remote, err = m.handleSOCKSHandshake(connectCtx, server, client)
	} else {
		remote, err = m.app.dialTunnelThroughServer(connectCtx, server, "tcp", net.JoinHostPort(profile.DestinationHost, strconv.Itoa(profile.DestinationPort)))
	}
	if err != nil {
		m.noteRuntimeError(profile.ID, err)
		return
	}
	defer remote.Close()
	local := &countedConn{Conn: client, readBytes: &rt.bytesIn, writeBytes: &rt.bytesOut}
	upstream := &countedConn{Conn: remote, readBytes: &rt.bytesOut, writeBytes: &rt.bytesIn}
	copyBoth(local, upstream)
}

func (m *sshTunnelManager) noteRuntimeError(profileID string, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rt := m.runtimes[profileID]
	if rt == nil {
		return
	}
	rt.lastError = err.Error()
	rt.updatedAt = time.Now().UTC()
	if rt.state != domain.SSHTunnelStateRunning {
		rt.state = domain.SSHTunnelStateFailed
	}
}

func (m *sshTunnelManager) handleSOCKSHandshake(ctx context.Context, server domain.Server, client net.Conn) (net.Conn, error) {
	if _, ok := ctx.Deadline(); ok {
		_ = client.SetDeadline(time.Now().Add(20 * time.Second))
		defer client.SetDeadline(time.Time{})
	}
	header := make([]byte, 2)
	if _, err := io.ReadFull(client, header); err != nil {
		return nil, err
	}
	if header[0] != 0x05 {
		return nil, fmt.Errorf("SOCKS5 client is required")
	}
	methods := make([]byte, int(header[1]))
	if _, err := io.ReadFull(client, methods); err != nil {
		return nil, err
	}
	if _, err := client.Write([]byte{0x05, 0x00}); err != nil {
		return nil, err
	}
	request := make([]byte, 4)
	if _, err := io.ReadFull(client, request); err != nil {
		return nil, err
	}
	if request[0] != 0x05 || request[1] != 0x01 {
		return nil, fmt.Errorf("SOCKS5 CONNECT command is required")
	}
	host, err := readSOCKSAddress(client, request[3])
	if err != nil {
		return nil, err
	}
	portBytes := make([]byte, 2)
	if _, err := io.ReadFull(client, portBytes); err != nil {
		return nil, err
	}
	port := int(binary.BigEndian.Uint16(portBytes))
	remote, err := m.app.dialTunnelThroughServer(ctx, server, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		_, _ = client.Write([]byte{0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return nil, err
	}
	if _, err := client.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0}); err != nil {
		_ = remote.Close()
		return nil, err
	}
	return remote, nil
}

func readSOCKSAddress(reader io.Reader, atyp byte) (string, error) {
	switch atyp {
	case 0x01:
		buf := make([]byte, 4)
		if _, err := io.ReadFull(reader, buf); err != nil {
			return "", err
		}
		return net.IP(buf).String(), nil
	case 0x03:
		length := []byte{0}
		if _, err := io.ReadFull(reader, length); err != nil {
			return "", err
		}
		if length[0] == 0 || length[0] > 253 {
			return "", fmt.Errorf("invalid SOCKS destination hostname length")
		}
		buf := make([]byte, int(length[0]))
		if _, err := io.ReadFull(reader, buf); err != nil {
			return "", err
		}
		host := string(buf)
		if strings.ContainsAny(host, "\x00\r\n\t /\\:@?#[]{}'\"`$;&|<>") {
			return "", fmt.Errorf("invalid SOCKS destination hostname")
		}
		return host, nil
	case 0x04:
		buf := make([]byte, 16)
		if _, err := io.ReadFull(reader, buf); err != nil {
			return "", err
		}
		return net.IP(buf).String(), nil
	default:
		return "", fmt.Errorf("unsupported SOCKS address type %d", atyp)
	}
}

func copyBoth(a net.Conn, b net.Conn) {
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(a, b); _ = a.Close(); _ = b.Close(); done <- struct{}{} }()
	go func() { _, _ = io.Copy(b, a); _ = a.Close(); _ = b.Close(); done <- struct{}{} }()
	<-done
}

func tunnelProbeAddress(profile domain.SSHTunnelProfile, assignedPort int) string {
	host := strings.TrimSpace(profile.BindAddress)
	switch host {
	case "", "0.0.0.0", "::", "[::]":
		host = "127.0.0.1"
	case "localhost":
		host = "127.0.0.1"
	}
	return net.JoinHostPort(host, strconv.Itoa(assignedPort))
}

func probeTimeout(timeoutMillis int) time.Duration {
	if timeoutMillis <= 0 {
		return 20 * time.Second
	}
	timeout := time.Duration(timeoutMillis) * time.Millisecond
	if timeout < time.Second {
		return time.Second
	}
	if timeout > time.Minute {
		return time.Minute
	}
	return timeout
}

func readTunnelProbeLine(reader io.Reader, limit int) (string, error) {
	var builder strings.Builder
	buf := []byte{0}
	for builder.Len() < limit {
		if _, err := reader.Read(buf); err != nil {
			return "", err
		}
		if buf[0] == '\n' {
			break
		}
		if buf[0] == '\r' {
			continue
		}
		builder.WriteByte(buf[0])
	}
	if builder.Len() == 0 {
		return "", fmt.Errorf("probe did not receive a line")
	}
	return builder.String(), nil
}

func probeEchoPayload(conn net.Conn, payloadBytes int64) (int64, int64, error) {
	if payloadBytes <= 0 {
		payloadBytes = 20 * 1024 * 1024
	}
	if payloadBytes > 128*1024*1024 {
		return 0, 0, fmt.Errorf("payload probe is limited to 128 MiB")
	}
	writeErr := make(chan error, 1)
	go func() {
		var written int64
		chunk := deterministicProbeChunk()
		for written < payloadBytes {
			toWrite := int64(len(chunk))
			if remaining := payloadBytes - written; remaining < toWrite {
				toWrite = remaining
			}
			n, err := conn.Write(chunk[:toWrite])
			written += int64(n)
			if err != nil {
				writeErr <- err
				return
			}
		}
		writeErr <- nil
	}()
	chunk := deterministicProbeChunk()
	buf := make([]byte, len(chunk))
	var read int64
	for read < payloadBytes {
		toRead := int64(len(buf))
		if remaining := payloadBytes - read; remaining < toRead {
			toRead = remaining
		}
		n, err := io.ReadFull(conn, buf[:toRead])
		read += int64(n)
		if err != nil {
			return payloadBytes, read, err
		}
		for index := 0; index < n; index++ {
			if buf[index] != chunk[index] {
				return payloadBytes, read, fmt.Errorf("echo payload mismatch at byte %d", read-int64(n)+int64(index))
			}
		}
	}
	if err := <-writeErr; err != nil {
		return payloadBytes, read, err
	}
	return payloadBytes, read, nil
}

func deterministicProbeChunk() []byte {
	chunk := make([]byte, 64*1024)
	for i := range chunk {
		chunk[i] = byte((i*31 + 17) % 251)
	}
	return chunk
}

func (m *sshTunnelManager) probeHTTPSDebugPayload(ctx context.Context, conn net.Conn, input sshTunnelProbeRequest) (int64, string, error) {
	host := strings.TrimSpace(input.HTTPHost)
	if host == "" {
		host = "shellorchestra.example"
	}
	requestPath := strings.TrimSpace(input.HTTPPath)
	if requestPath == "" {
		size := input.PayloadBytes
		if size <= 0 {
			size = 20 * 1024 * 1024
		}
		requestPath = "/api/debug/payload?size=" + strconv.FormatInt(size, 10)
	}
	token := m.app.debugTokenValue()
	if token == "" {
		return 0, "", fmt.Errorf("debug token is not configured")
	}
	tlsConn := tls.Client(conn, &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12})
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		return 0, "", err
	}
	defer tlsConn.Close()
	request := "GET " + requestPath + " HTTP/1.1\r\nHost: " + host + "\r\nX-ShellOrchestra-Debug-Token: " + token + "\r\nConnection: close\r\n\r\n"
	if _, err := io.WriteString(tlsConn, request); err != nil {
		return 0, "", err
	}
	statusLine, err := readTunnelProbeLine(tlsConn, 256)
	if err != nil {
		return 0, "", err
	}
	if !strings.Contains(statusLine, " 200 ") {
		return 0, statusLine, fmt.Errorf("debug payload returned %s", statusLine)
	}
	if err := discardHTTPHeaders(tlsConn); err != nil {
		return 0, statusLine, err
	}
	bytesRead, err := io.Copy(io.Discard, tlsConn)
	if err != nil {
		return bytesRead, statusLine, err
	}
	return bytesRead, statusLine, nil
}

func discardHTTPHeaders(reader io.Reader) error {
	buf := make([]byte, 1)
	var window string
	for i := 0; i < 64*1024; i++ {
		if _, err := reader.Read(buf); err != nil {
			return err
		}
		window += string(buf[0])
		if len(window) > 4 {
			window = window[len(window)-4:]
		}
		if window == "\r\n\r\n" {
			return nil
		}
	}
	return fmt.Errorf("HTTP response headers are too large")
}

func (c *countedConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if n > 0 && c.readBytes != nil {
		c.readBytes.Add(uint64(n))
	}
	return n, err
}

func (c *countedConn) Write(p []byte) (int, error) {
	n, err := c.Conn.Write(p)
	if n > 0 && c.writeBytes != nil {
		c.writeBytes.Add(uint64(n))
	}
	return n, err
}
