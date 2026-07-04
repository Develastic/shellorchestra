// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package worker

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"shellorchestra/backend/internal/batchoutput"
	"shellorchestra/backend/internal/casigner"
	"shellorchestra/backend/internal/config"
	"shellorchestra/backend/internal/domain"
	"shellorchestra/backend/internal/httplimits"
	"shellorchestra/backend/internal/internaljson"
	"shellorchestra/backend/internal/internalurl"
	"shellorchestra/backend/internal/runtime"
	"shellorchestra/backend/internal/scripts"
	"shellorchestra/backend/internal/serviceinfo"
	"shellorchestra/backend/internal/store"
)

const (
	maxWorkerJSONBodyBytes         = 4 << 20
	maxWorkerJSONResponseBodyBytes = 64 << 20
	maxBatchScriptOutputPreview    = batchoutput.DefaultMaxBytes
)

type Server struct {
	cfg         config.AppConfig
	store       *store.SQLiteStore
	scripts     *scripts.Catalog
	runtime     *runtime.SSHRuntime
	signer      *casigner.Client
	connections *ConnectionManager
	periodic    *PeriodicScriptManager
	terminals   *TerminalManager
	speedTests  *SpeedTestManager
}

type Client struct {
	baseURL        *url.URL
	internalSecret string
	client         *http.Client
}

type StateResponse struct {
	Locked      bool   `json:"locked"`
	Initialized bool   `json:"initialized"`
	Message     string `json:"message"`
}

type runScriptRequest struct {
	RunID    string            `json:"run_id"`
	ServerID string            `json:"server_id"`
	Command  string            `json:"command"`
	Variant  string            `json:"variant"`
	Args     map[string]string `json:"args,omitempty"`
}

type runJSONRequest struct {
	ServerID       string            `json:"server_id"`
	Server         domain.Server     `json:"server,omitempty"`
	Command        string            `json:"command"`
	Variant        string            `json:"variant"`
	Args           map[string]string `json:"args,omitempty"`
	OutputEncoding string            `json:"output_encoding,omitempty"`
}

type runBatchScriptTargetRequest struct {
	RunID             string                    `json:"run_id"`
	ServerID          string                    `json:"server_id"`
	Variant           domain.BatchScriptVariant `json:"variant"`
	PreflightRequired bool                      `json:"preflight_required"`
	MaxOutputBytes    int                       `json:"max_output_bytes"`
}

type serverRequest struct {
	Server domain.Server `json:"server"`
}

func NewServer(cfg config.AppConfig, db *store.SQLiteStore, catalog *scripts.Catalog, signer *casigner.Client) *Server {
	sshRuntime := runtime.NewSSHRuntime(runtime.Options{
		ConnectTimeout: time.Duration(cfg.Runtime.ConnectTimeoutSeconds) * time.Second,
		StatusInterval: time.Duration(cfg.Runtime.LightStatusIntervalSeconds) * time.Second,
		CertTTL:        time.Duration(cfg.SSHCA.CertTTLMinutes) * time.Minute,
	})
	if settings, err := db.GetSSHSecuritySettings(context.Background()); err == nil {
		sshRuntime.SetAllowedSourceAddresses(settings.AllowedSourceAddresses)
		sshRuntime.SetCertificateTTL(time.Duration(settings.CertTTLMinutes) * time.Minute)
	}
	sshRuntime.UseCertificateSignerProvider(signer)
	server := &Server{cfg: cfg, store: db, scripts: catalog, runtime: sshRuntime, signer: signer}
	server.terminals = NewTerminalManager(server)
	server.speedTests = NewSpeedTestManager(server)
	server.periodic = NewPeriodicScriptManager(server)
	server.connections = NewConnectionManager(server)
	return server
}

func NewClient(rawURL string, internalSecret string) (*Client, error) {
	parsed, err := internalurl.ParseServiceURL(rawURL, "internal.worker_url")
	if err != nil {
		return nil, err
	}
	secret := strings.TrimSpace(internalSecret)
	if secret == "" {
		return nil, fmt.Errorf("internal.shared_secret is required for ssh-worker")
	}
	return &Client{baseURL: parsed, internalSecret: secret, client: &http.Client{Timeout: 20 * time.Second}}, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/internal/service/status", serviceinfo.Handler(s.cfg, "ssh-worker", s.serviceStatusDetails))
	mux.HandleFunc("/internal/worker/healthz", s.health)
	mux.HandleFunc("/internal/worker/lock-state", s.lockState)
	mux.HandleFunc("/internal/worker/lock-runtime", s.lockRuntime)
	mux.HandleFunc("/internal/worker/connect-all", s.connectAll)
	mux.HandleFunc("/internal/worker/connect-server", s.connectServer)
	mux.HandleFunc("/internal/worker/debug-disconnect-server", s.debugDisconnectServer)
	mux.HandleFunc("/internal/worker/ssh-dial", s.sshDial)
	mux.HandleFunc("/internal/worker/run-script", s.runScript)
	mux.HandleFunc("/internal/worker/run-batch-script-target", s.runBatchScriptTarget)
	mux.HandleFunc("/internal/worker/run-json", s.runJSON)
	mux.HandleFunc("/internal/worker/run-compressed-json", s.runCompressedJSON)
	mux.HandleFunc("/internal/worker/run-compressed-json-stream", s.runCompressedJSONStream)
	mux.HandleFunc("/internal/worker/test-tcp", s.testTCP)
	mux.HandleFunc("/internal/worker/test-auth", s.testAuth)
	mux.HandleFunc("/internal/worker/scan-host-keys", s.scanHostKeys)
	mux.HandleFunc("/internal/worker/detect-facts", s.detectFacts)
	mux.HandleFunc("/internal/worker/speed-test", s.speedTest)
	mux.HandleFunc("/internal/worker/speed-test/start", s.speedTestStart)
	mux.HandleFunc("/internal/worker/speed-test/status", s.speedTestStatus)
	mux.HandleFunc("/internal/worker/speed-test/cancel", s.speedTestCancel)
	mux.HandleFunc("/internal/worker/file-manager/upload-stream", s.fileUploadStream)
	mux.HandleFunc("/internal/worker/file-manager/download-stream", s.fileDownloadStream)
	mux.HandleFunc("/internal/worker/file-manager/archive-download-stream", s.fileArchiveDownloadStream)
	mux.HandleFunc("/internal/worker/file-manager/archive-upload-stream", s.fileArchiveUploadStream)
	mux.HandleFunc("/internal/worker/terminals/create", s.terminalCreate)
	mux.HandleFunc("/internal/worker/terminals/snapshot", s.terminalSnapshot)
	mux.HandleFunc("/internal/worker/terminals/input", s.terminalInput)
	mux.HandleFunc("/internal/worker/terminals/resize", s.terminalResize)
	mux.HandleFunc("/internal/worker/terminals/close", s.terminalClose)
	mux.HandleFunc("/internal/worker/terminals/stream/", s.terminalStream)
	return mux
}

func (s *Server) serviceStatusDetails(ctx context.Context) map[string]any {
	state, err := s.signer.State(ctx)
	if err != nil {
		return map[string]any{"lock_state_error": err.Error()}
	}
	return map[string]any{
		"locked":           state.Locked,
		"initialized":      state.Initialized,
		"connections":      s.connections.Snapshot(),
		"periodic_scripts": s.periodic.Snapshot(),
		"terminals":        s.terminals.Snapshot(),
	}
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "ssh-worker"})
}

func (s *Server) lockState(w http.ResponseWriter, r *http.Request) {
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	state, err := s.signer.State(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, StateResponse{Locked: state.Locked, Initialized: state.Initialized, Message: state.Message})
}

func (s *Server) lockRuntime(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	s.periodic.Stop()
	s.connections.Stop()
	s.runtime.Lock()
	state, err := s.signer.Lock(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	s.connections.MarkAllLocked(context.Background())
	writeJSON(w, http.StatusOK, StateResponse{Locked: state.Locked, Initialized: state.Initialized, Message: state.Message})
}

func (s *Server) connectAll(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	s.periodic.Start()
	s.connections.Start()
	w.WriteHeader(http.StatusAccepted)
}

func (s *Server) connectServer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var body serverRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(s.cfg.Runtime.ConnectTimeoutSeconds)*time.Second+10*time.Second)
	defer cancel()
	status, err := s.runtime.Connect(ctx, body.Server)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	if status.State != domain.StatusConnected {
		if strings.TrimSpace(status.LastError) != "" {
			writeError(w, http.StatusBadGateway, status.LastError)
			return
		}
		writeError(w, http.StatusBadGateway, "Managed SSH connection is not connected.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "state": status.State})
}

func (s *Server) debugDisconnectServer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var body struct {
		ServerID string `json:"server_id"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	serverID := strings.TrimSpace(body.ServerID)
	if serverID == "" {
		writeError(w, http.StatusBadRequest, "server_id is required")
		return
	}
	s.runtime.Disconnect(serverID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "server_id": serverID})
}

func (s *Server) sshDial(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodConnect {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	serverID := strings.TrimSpace(r.URL.Query().Get("server_id"))
	network := strings.TrimSpace(r.URL.Query().Get("network"))
	address := strings.TrimSpace(r.URL.Query().Get("address"))
	if serverID == "" || network != "tcp" || address == "" {
		writeError(w, http.StatusBadRequest, "server_id, network=tcp, and address are required")
		return
	}
	server, err := s.store.GetServer(r.Context(), serverID)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	dialCtx, cancel := context.WithTimeout(r.Context(), time.Duration(s.cfg.Runtime.ConnectTimeoutSeconds)*time.Second+20*time.Second)
	defer cancel()
	remote, err := s.runtime.DialThroughServer(dialCtx, server, network, address)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		_ = remote.Close()
		writeError(w, http.StatusInternalServerError, "HTTP hijacking is not supported by this worker transport.")
		return
	}
	client, buffered, err := hijacker.Hijack()
	if err != nil {
		_ = remote.Close()
		return
	}
	if _, err := buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		_ = client.Close()
		_ = remote.Close()
		return
	}
	if err := buffered.Flush(); err != nil {
		_ = client.Close()
		_ = remote.Close()
		return
	}
	go proxyRawConns(client, remote)
}

func (s *Server) runScript(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var body runScriptRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	go s.executeScript(body)
	w.WriteHeader(http.StatusAccepted)
}

func (s *Server) runBatchScriptTarget(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusUnauthorized, "invalid internal worker request")
		return
	}
	var body runBatchScriptTargetRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.RunID) == "" || strings.TrimSpace(body.ServerID) == "" || strings.TrimSpace(body.Variant.ID) == "" {
		writeError(w, http.StatusBadRequest, "run_id, server_id, and variant.id are required")
		return
	}
	go s.executeBatchScriptTarget(body)
	w.WriteHeader(http.StatusAccepted)
}

func (s *Server) runJSON(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var body runJSONRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	selected, err := s.scriptFromInternalRequest(body.Command, body.Variant)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), selected.Timeout)
	defer cancel()
	execution, err := scripts.RemoteExecutionForVariantWithArgs(selected, body.Args)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	limits := runtimeOutputLimits(selected.Command.EffectiveOutputLimits())
	var result map[string]any
	if execution.StdinEnabled {
		result, err = s.runtime.RunJSONWithInputLimited(ctx, body.ServerID, execution.Command, strings.NewReader(execution.Stdin), limits)
	} else {
		result, err = s.runtime.RunJSONLimited(ctx, body.ServerID, execution.Command, limits)
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) runCompressedJSON(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var body runJSONRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	outputEncoding := strings.ToLower(strings.TrimSpace(body.OutputEncoding))
	if outputEncoding != "auto" && outputEncoding != "zstd" && outputEncoding != "gzip" {
		writeError(w, http.StatusBadRequest, "Unsupported compressed JSON encoding.")
		return
	}
	selected, err := s.scriptFromInternalRequest(body.Command, body.Variant)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), selected.Timeout)
	defer cancel()
	execution, err := scripts.RemoteExecutionForVariantWithArgs(selected, body.Args)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var stdin io.Reader
	if execution.StdinEnabled {
		stdin = strings.NewReader(execution.Stdin)
	}
	result, err := s.runtime.RunCompressedJSONLimited(ctx, body.ServerID, execution.Command, stdin, outputEncoding, runtimeOutputLimits(selected.Command.EffectiveOutputLimits()))
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) runCompressedJSONStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var body runJSONRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	outputEncoding := strings.ToLower(strings.TrimSpace(body.OutputEncoding))
	if outputEncoding != "auto" && outputEncoding != "zstd" && outputEncoding != "gzip" {
		writeError(w, http.StatusBadRequest, "Unsupported compressed JSON stream encoding.")
		return
	}
	selected, err := s.scriptFromInternalRequest(body.Command, body.Variant)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), selected.Timeout)
	defer cancel()
	execution, err := scripts.RemoteExecutionForVariantWithArgs(selected, body.Args)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var stdin io.Reader
	if execution.StdinEnabled {
		stdin = strings.NewReader(execution.Stdin)
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("X-ShellOrchestra-Remote-Output-Encoding", outputEncoding)
	stream := &safeHTTPStreamWriter{w: w}
	if flusher, ok := w.(http.Flusher); ok {
		stream.flusher = flusher
	}
	stderrLimit := runtimeOutputLimits(selected.Command.EffectiveOutputLimits()).MaxStderrBytes
	if stderrLimit <= 0 || stderrLimit > 1<<20 {
		stderrLimit = 1 << 20
	}
	stderr := &limitedStringWriter{limit: int(stderrLimit)}
	if strings.TrimSpace(body.Server.ID) != "" {
		if body.Server.ID != body.ServerID && strings.TrimSpace(body.ServerID) != "" {
			writeError(w, http.StatusBadRequest, "server id mismatch")
			return
		}
		if err := s.runtime.RunStreamServer(ctx, body.Server, execution.Command, stdin, stream, stderr); err != nil {
			log.Printf("worker compressed JSON stream failed: server=%s command=%s error=%v stderr=%q", body.Server.ID, selected.Command.Name, err, stderr.String())
			return
		}
	} else if err := s.runtime.RunStream(ctx, body.ServerID, execution.Command, stdin, stream, stderr); err != nil {
		log.Printf("worker compressed JSON stream failed: server=%s command=%s error=%v stderr=%q", body.ServerID, selected.Command.Name, err, stderr.String())
		return
	}
	if err := stream.Err(); err != nil {
		log.Printf("worker compressed JSON stream write failed: server=%s command=%s error=%v", body.ServerID, selected.Command.Name, err)
		return
	}
}

func (s *Server) testTCP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var body serverRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(s.cfg.Runtime.ConnectTimeoutSeconds)*time.Second+5*time.Second)
	defer cancel()
	writeJSON(w, http.StatusOK, s.runtime.TestTCP(ctx, body.Server))
}

func (s *Server) testAuth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var body serverRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(s.cfg.Runtime.ConnectTimeoutSeconds)*time.Second+10*time.Second)
	defer cancel()
	writeJSON(w, http.StatusOK, s.runtime.TestAuth(ctx, body.Server))
}

func (s *Server) scanHostKeys(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var body serverRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(s.cfg.Runtime.ConnectTimeoutSeconds)*time.Second+10*time.Second)
	defer cancel()
	writeJSON(w, http.StatusOK, s.runtime.ScanHostKeys(ctx, body.Server))
}

func (s *Server) detectFacts(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var body serverRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(s.cfg.Runtime.ConnectTimeoutSeconds)*time.Second+150*time.Second)
	defer cancel()
	status, _ := s.runtime.Connect(ctx, body.Server)
	if status.State != domain.StatusConnected {
		writeError(w, http.StatusBadGateway, status.LastError)
		return
	}
	facts, err := s.detectServerFacts(ctx, body.Server)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, facts)
}

func (s *Server) terminalCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var body terminalCreateRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	snapshot, err := s.terminals.Create(r.Context(), body)
	if err != nil {
		status, message := terminalHTTPError(err)
		writeError(w, status, message)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) terminalSnapshot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var body terminalSessionRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	snapshot, err := s.terminals.SnapshotSession(r.Context(), body.SessionID)
	if err != nil {
		status, message := terminalSessionHTTPError(err)
		writeError(w, status, message)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) terminalInput(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var body terminalInputRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	if err := s.terminals.SendInput(r.Context(), body.SessionID, body.Data); err != nil {
		status, message := terminalSessionHTTPError(err)
		writeError(w, status, message)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) terminalResize(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var body terminalResizeRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	snapshot, err := s.terminals.Resize(r.Context(), body.SessionID, body.Cols, body.Rows)
	if err != nil {
		status, message := terminalSessionHTTPError(err)
		writeError(w, status, message)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) terminalClose(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var body terminalSessionRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	if err := s.terminals.CloseSession(r.Context(), body.SessionID); err != nil {
		status, message := terminalSessionHTTPError(err)
		writeError(w, status, message)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) terminalStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	sessionID := strings.TrimPrefix(r.URL.Path, "/internal/worker/terminals/stream/")
	sessionID, _ = url.PathUnescape(sessionID)
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		writeError(w, http.StatusNotFound, "Terminal session was not found.")
		return
	}
	s.terminals.Stream(w, r, sessionID)
}

func (s *Server) executeScript(request runScriptRequest) {
	selected, selectErr := s.scriptFromInternalRequest(request.Command, request.Variant)
	var execution scripts.RemoteScriptExecution
	var buildErr error
	if selectErr != nil {
		buildErr = selectErr
	} else {
		execution, buildErr = scripts.RemoteExecutionForVariantWithArgs(selected, request.Args)
	}
	timeout := s.workerScriptTimeout(selected, buildErr)
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	var result map[string]any
	var err error
	if buildErr != nil {
		err = buildErr
	} else if execution.StdinEnabled {
		limits := runtimeOutputLimits(selected.Command.EffectiveOutputLimits())
		result, err = s.runtime.RunJSONWithInputLimited(ctx, request.ServerID, execution.Command, strings.NewReader(execution.Stdin), limits)
	} else {
		limits := runtimeOutputLimits(selected.Command.EffectiveOutputLimits())
		result, err = s.runtime.RunJSONLimited(ctx, request.ServerID, execution.Command, limits)
	}
	finished := time.Now().UTC()
	state := domain.ScriptRunSucceeded
	errText := ""
	if err != nil {
		state = domain.ScriptRunFailed
		errText = err.Error()
	}
	saveErr := s.store.UpdateScriptRunResult(context.Background(), domain.ScriptRun{ID: request.RunID, ServerID: request.ServerID, Command: request.Command, Variant: request.Variant, State: state, Result: result, Error: errText, FinishedAt: &finished})
	if saveErr != nil {
		log.Printf("failed to save worker script result: %v", saveErr)
	}
	if state == domain.ScriptRunSucceeded {
		if appName := scripts.InstalledAppNameFromResult(result); appName != "" {
			if err := s.store.MarkServerDetectedApp(context.Background(), request.ServerID, appName, true); err != nil {
				log.Printf("failed to mark installed desktop app %q for server %s: %v", appName, request.ServerID, err)
			}
		}
	}
}

func (s *Server) executeBatchScriptTarget(request runBatchScriptTargetRequest) {
	started := time.Now().UTC()
	if err := s.store.StartBatchScriptRunTarget(context.Background(), request.RunID, request.ServerID); err != nil {
		log.Printf("failed to mark batch script target running: %v", err)
	}
	variant := request.Variant
	timeoutSeconds := variant.TimeoutSeconds
	if timeoutSeconds <= 0 {
		timeoutSeconds = 1800
	}
	if timeoutSeconds < 5 {
		timeoutSeconds = 5
	}
	if timeoutSeconds > 86400 {
		timeoutSeconds = 86400
	}
	timeout := time.Duration(timeoutSeconds) * time.Second
	if request.PreflightRequired && strings.TrimSpace(variant.PreflightBody) != "" {
		stdout, stderr, exitCode, err := s.runBatchScriptBody(request.RunID, request.ServerID, "preflight", variant.Shell, variant.PreflightBody, timeout, request.MaxOutputBytes)
		if err != nil {
			finished := time.Now().UTC()
			message := "Preflight failed"
			if strings.TrimSpace(err.Error()) != "" {
				message += ": " + err.Error()
			}
			saveErr := s.store.FinishBatchScriptRunTarget(context.Background(), domain.BatchScriptRunTarget{
				RunID:           request.RunID,
				ServerID:        request.ServerID,
				State:           domain.BatchScriptRunTargetFailed,
				ExitCode:        exitCode,
				StdoutPreview:   stdout.Preview,
				StdoutTruncated: stdout.Truncated,
				StdoutRef:       stdout.Ref,
				StdoutBytes:     stdout.Bytes,
				StderrPreview:   stderr.Preview,
				StderrTruncated: stderr.Truncated,
				StderrRef:       stderr.Ref,
				StderrBytes:     stderr.Bytes,
				ErrorMessage:    message,
				StartedAt:       &started,
				FinishedAt:      &finished,
			})
			if saveErr != nil {
				log.Printf("failed to save batch script preflight result: %v", saveErr)
			}
			return
		}
	}
	stdout, stderr, exitCode, err := s.runBatchScriptBody(request.RunID, request.ServerID, "", variant.Shell, variant.ScriptBody, timeout, request.MaxOutputBytes)
	finished := time.Now().UTC()
	state := domain.BatchScriptRunTargetSucceeded
	message := ""
	if err != nil {
		state = domain.BatchScriptRunTargetFailed
		message = err.Error()
	}
	saveErr := s.store.FinishBatchScriptRunTarget(context.Background(), domain.BatchScriptRunTarget{
		RunID:           request.RunID,
		ServerID:        request.ServerID,
		State:           state,
		ExitCode:        exitCode,
		StdoutPreview:   stdout.Preview,
		StdoutTruncated: stdout.Truncated,
		StdoutRef:       stdout.Ref,
		StdoutBytes:     stdout.Bytes,
		StderrPreview:   stderr.Preview,
		StderrTruncated: stderr.Truncated,
		StderrRef:       stderr.Ref,
		StderrBytes:     stderr.Bytes,
		ErrorMessage:    message,
		StartedAt:       &started,
		FinishedAt:      &finished,
	})
	if saveErr != nil {
		log.Printf("failed to save batch script target result: %v", saveErr)
	}
}

func (s *Server) runBatchScriptBody(runID string, serverID string, streamPrefix string, shell string, body string, timeout time.Duration, maxOutputBytes int) (batchoutput.Result, batchoutput.Result, *int, error) {
	limit := normalizeBatchScriptOutputLimit(maxOutputBytes)
	execution, err := scripts.RemoteExecutionForShellWithArgs(body, shell, nil)
	if err != nil {
		return batchoutput.Result{}, batchoutput.Result{}, nil, err
	}
	stdoutName := "stdout"
	stderrName := "stderr"
	if strings.TrimSpace(streamPrefix) != "" {
		stdoutName = strings.TrimSpace(streamPrefix) + "-stdout"
		stderrName = strings.TrimSpace(streamPrefix) + "-stderr"
	}
	outputs := batchOutputStore(s.cfg)
	stdout, err := outputs.NewCapture(runID, serverID, stdoutName, int64(limit))
	if err != nil {
		return batchoutput.Result{}, batchoutput.Result{}, nil, err
	}
	defer stdout.Abort()
	stderr, err := outputs.NewCapture(runID, serverID, stderrName, int64(limit))
	if err != nil {
		return batchoutput.Result{}, batchoutput.Result{}, nil, err
	}
	defer stderr.Abort()
	var stdin io.Reader
	if execution.StdinEnabled {
		stdin = strings.NewReader(execution.Stdin)
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	err = s.runtime.RunStream(ctx, serverID, execution.Command, stdin, stdout, stderr)
	exitCode := exitCodeFromSSHError(err)
	if err == nil {
		code := 0
		exitCode = &code
	}
	stdoutResult, stdoutErr := stdout.Finish()
	stderrResult, stderrErr := stderr.Finish()
	if stdoutErr != nil && err == nil {
		err = stdoutErr
	}
	if stderrErr != nil && err == nil {
		err = stderrErr
	}
	return stdoutResult, stderrResult, exitCode, err
}

func normalizeBatchScriptOutputLimit(value int) int {
	return int(batchoutput.NormalizeMaxBytes(int64(value)))
}

func batchOutputStore(cfg config.AppConfig) batchoutput.Store {
	return batchoutput.New(batchoutput.RootForDatabase(cfg.Database.Path))
}

func exitCodeFromSSHError(err error) *int {
	if err == nil {
		return nil
	}
	var exitErr *ssh.ExitError
	if errors.As(err, &exitErr) {
		code := exitErr.ExitStatus()
		return &code
	}
	return nil
}

func (s *Server) workerScriptTimeout(selected scripts.SelectedScript, buildErr error) time.Duration {
	if buildErr == nil && selected.Timeout > 0 {
		return selected.Timeout
	}
	return time.Duration(s.cfg.Scripts.DefaultTimeoutSeconds) * time.Second
}

func (s *Server) detectServerFacts(ctx context.Context, server domain.Server) (scripts.TargetFacts, error) {
	facts, err := s.detectFactsWithScripts(ctx, server, "detect-posix.sh", "detect-powershell.ps1", 20*time.Second)
	if err != nil || !facts.WingetNeedsInitialization {
		return facts, err
	}
	if err := s.initializeWingetForCurrentAccount(ctx, server, facts); err != nil {
		return facts, err
	}
	refreshedFacts, refreshErr := s.detectFactsWithScripts(ctx, server, "detect-posix.sh", "detect-powershell.ps1", 20*time.Second)
	if refreshErr != nil {
		return facts, fmt.Errorf("Windows winget initialization completed, but detection after initialization failed: %w", refreshErr)
	}
	if refreshedFacts.WingetNeedsInitialization || strings.ToLower(strings.TrimSpace(refreshedFacts.PackageManager)) != "winget" {
		return refreshedFacts, fmt.Errorf("Windows winget initialization completed, but winget is still not available to this SSH account")
	}
	return refreshedFacts, nil
}

func (s *Server) initializeWingetForCurrentAccount(ctx context.Context, server domain.Server, facts scripts.TargetFacts) error {
	selected, err := s.scripts.Select("winget_init", facts)
	if err != nil {
		return fmt.Errorf("Windows winget initialization is required, but no init script is available: %w", err)
	}
	timeout := selected.Timeout + 10*time.Second
	if timeout < 30*time.Second {
		timeout = 30 * time.Second
	}
	initCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	payload, err := s.runtime.RunJSONLimited(initCtx, server.ID, scripts.RemoteCommandForVariant(selected), runtimeOutputLimits(selected.Command.EffectiveOutputLimits()))
	if err != nil {
		return fmt.Errorf("Windows winget initialization failed: %w", err)
	}
	if !boolValue(payload["ok"]) {
		return fmt.Errorf("Windows winget initialization failed")
	}
	if manager := strings.ToLower(strings.TrimSpace(stringValue(payload["package_manager"]))); manager != "" && manager != "winget" {
		return fmt.Errorf("Windows winget initialization reported package manager %q instead of winget", manager)
	}
	return nil
}

func (s *Server) detectCriticalServerFacts(ctx context.Context, server domain.Server) (scripts.TargetFacts, error) {
	return s.detectFactsWithScripts(ctx, server, "detect-critical-posix.sh", "detect-critical-powershell.ps1", 5*time.Second)
}

func (s *Server) detectFactsWithScripts(ctx context.Context, server domain.Server, posixScript string, powershellScript string, timeout time.Duration) (scripts.TargetFacts, error) {
	detectCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	powershellCommand, err := powershellFactProbeCommand(s.cfg.Scripts.Root, powershellScript)
	if err != nil {
		return scripts.TargetFacts{}, err
	}
	if prefersPowerShellDetection(server) {
		return s.runFactProbe(detectCtx, server.ID, powershellCommand)
	}
	posixCommand, err := posixFactProbeCommand(s.cfg.Scripts.Root, posixScript)
	if err != nil {
		return scripts.TargetFacts{}, err
	}
	if facts, err := s.runFactProbe(detectCtx, server.ID, posixCommand); err == nil {
		if !posixFactsLookLikeWindows(facts) {
			return facts, nil
		}
		if powershellFacts, powershellErr := s.runFactProbe(detectCtx, server.ID, powershellCommand); powershellErr == nil {
			return powershellFacts, nil
		}
		return scripts.TargetFacts{}, fmt.Errorf("POSIX probe reported a Windows compatibility layer (%s), but PowerShell detection failed", facts.OS)
	}
	return s.runFactProbe(detectCtx, server.ID, powershellCommand)
}

func prefersPowerShellDetection(server domain.Server) bool {
	values := []string{server.ShellHint, server.OSHint, server.DistroHint, server.DetectedShell, server.DetectedOS, server.DetectedDistro, server.OverrideShell, server.OverrideOS, server.OverrideDistro}
	for _, value := range values {
		normalized := strings.ToLower(strings.TrimSpace(value))
		if normalized == "powershell" || normalized == "windows" || strings.HasPrefix(normalized, "windows") {
			return true
		}
	}
	return false
}

func posixFactsLookLikeWindows(facts scripts.TargetFacts) bool {
	osName := strings.ToLower(strings.TrimSpace(facts.OS))
	switch {
	case osName == "windows":
		return true
	case strings.HasPrefix(osName, "cygwin"):
		return true
	case strings.HasPrefix(osName, "mingw"):
		return true
	case strings.HasPrefix(osName, "msys"):
		return true
	default:
		return false
	}
}

func (s *Server) runFactProbe(ctx context.Context, serverID string, command string) (scripts.TargetFacts, error) {
	payload, err := s.runtime.RunJSONLimited(ctx, serverID, command, systemScriptOutputLimits())
	if err != nil {
		return scripts.TargetFacts{}, err
	}
	return scripts.TargetFacts{
		Hostname:                  stringValue(payload["hostname"]),
		Shell:                     stringValue(payload["shell"]),
		OS:                        stringValue(payload["os"]),
		Platform:                  stringValue(payload["platform"]),
		PlatformOS:                stringValue(payload["platform_os"]),
		PlatformArch:              stringValue(payload["platform_arch"]),
		Distro:                    stringValue(payload["distro"]),
		AdminRights:               stringValue(payload["admin_rights"]),
		KernelVersion:             stringValue(payload["kernel_version"]),
		PackageManager:            stringValue(payload["package_manager"]),
		Virtualization:            stringValue(payload["virtualization"]),
		WingetNeedsInitialization: boolValue(payload["winget_needs_initialization"]),
		IsPVEHost:                 boolValue(payload["is_pve_host"]),
		IsDockerHost:              boolValue(payload["is_docker_host"]),
		IsPodmanHost:              boolValue(payload["is_podman_host"]),
		Apps:                      boolMapValue(payload["apps"]),
	}, nil
}

func (s *Server) scriptFromInternalRequest(command string, variant string) (scripts.SelectedScript, error) {
	if s.scripts == nil {
		return scripts.SelectedScript{}, fmt.Errorf("script catalog is not configured")
	}
	if command == "" || variant == "" || strings.TrimSpace(command) != command || strings.TrimSpace(variant) != variant {
		return scripts.SelectedScript{}, fmt.Errorf("script command and variant must be exact non-empty identifiers")
	}
	return s.scripts.SelectExact(command, variant)
}

func (s *Server) validInternalRequest(r *http.Request) bool {
	expected := strings.TrimSpace(s.cfg.Internal.SharedSecret)
	provided := strings.TrimSpace(r.Header.Get("X-ShellOrchestra-Internal-Secret"))
	if expected == "" || provided == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

func (c *Client) LockState(ctx context.Context) (StateResponse, error) {
	var state StateResponse
	err := c.do(ctx, http.MethodGet, "/internal/worker/lock-state", nil, &state, 20*time.Second)
	return state, err
}

func (c *Client) LockRuntime(ctx context.Context) (StateResponse, error) {
	var state StateResponse
	err := c.do(ctx, http.MethodPost, "/internal/worker/lock-runtime", map[string]any{}, &state, 20*time.Second)
	return state, err
}

func (c *Client) ConnectAll(ctx context.Context) error {
	return c.do(ctx, http.MethodPost, "/internal/worker/connect-all", map[string]any{}, nil, 20*time.Second)
}

func (c *Client) EnsureServerConnection(ctx context.Context, server domain.Server) error {
	timeout := 45 * time.Second
	return c.do(ctx, http.MethodPost, "/internal/worker/connect-server", serverRequest{Server: server}, nil, timeout)
}

func (c *Client) DebugDisconnectServer(ctx context.Context, serverID string) error {
	return c.do(ctx, http.MethodPost, "/internal/worker/debug-disconnect-server", map[string]string{"server_id": strings.TrimSpace(serverID)}, nil, 20*time.Second)
}

func (c *Client) DialThroughServer(ctx context.Context, serverID string, network string, address string) (net.Conn, error) {
	if strings.TrimSpace(serverID) == "" {
		return nil, fmt.Errorf("server id is required for worker SSH dial")
	}
	if network != "tcp" {
		return nil, fmt.Errorf("unsupported worker SSH dial network %q", network)
	}
	if strings.TrimSpace(address) == "" {
		return nil, fmt.Errorf("destination address is required for worker SSH dial")
	}
	if c.baseURL.Scheme != "http" {
		return nil, fmt.Errorf("worker SSH dial supports internal http endpoints only")
	}
	dialer := net.Dialer{}
	conn, err := dialer.DialContext(ctx, "tcp", c.baseURL.Host)
	if err != nil {
		return nil, err
	}
	requestURL := c.baseURL.ResolveReference(&url.URL{Path: "/internal/worker/ssh-dial"})
	query := requestURL.Query()
	query.Set("server_id", strings.TrimSpace(serverID))
	query.Set("network", network)
	query.Set("address", strings.TrimSpace(address))
	requestURL.RawQuery = query.Encode()
	if _, err := fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\nX-ShellOrchestra-Internal-Secret: %s\r\n\r\n", requestURL.RequestURI(), c.baseURL.Host, c.internalSecret); err != nil {
		_ = conn.Close()
		return nil, err
	}
	reader := bufio.NewReader(conn)
	resp, err := http.ReadResponse(reader, &http.Request{Method: http.MethodConnect})
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer conn.Close()
		defer resp.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		message := strings.TrimSpace(string(body))
		if message == "" {
			message = resp.Status
		}
		return nil, fmt.Errorf("%s", message)
	}
	return &bufferedWorkerConn{Conn: conn, reader: reader}, nil
}

func (c *Client) RunScript(ctx context.Context, run domain.ScriptRun, selected scripts.SelectedScript, args map[string]string) error {
	timeout := selected.Timeout + 10*time.Second
	if timeout < 20*time.Second {
		timeout = 20 * time.Second
	}
	return c.do(ctx, http.MethodPost, "/internal/worker/run-script", runScriptRequest{RunID: run.ID, ServerID: run.ServerID, Command: run.Command, Variant: run.Variant, Args: args}, nil, timeout)
}

func (c *Client) RunBatchScriptTarget(ctx context.Context, runID string, serverID string, variant domain.BatchScriptVariant, preflightRequired bool, maxOutputBytes int) error {
	timeout := time.Duration(variant.TimeoutSeconds)*time.Second + 10*time.Second
	if timeout < 20*time.Second {
		timeout = 20 * time.Second
	}
	return c.do(ctx, http.MethodPost, "/internal/worker/run-batch-script-target", runBatchScriptTargetRequest{RunID: runID, ServerID: serverID, Variant: variant, PreflightRequired: preflightRequired, MaxOutputBytes: maxOutputBytes}, nil, timeout)
}

func (c *Client) RunJSON(ctx context.Context, serverID string, selected scripts.SelectedScript, args map[string]string) (map[string]any, error) {
	timeout := selected.Timeout + 10*time.Second
	if timeout < 20*time.Second {
		timeout = 20 * time.Second
	}
	var result map[string]any
	err := c.do(ctx, http.MethodPost, "/internal/worker/run-json", runJSONRequest{ServerID: serverID, Command: selected.Command.Name, Variant: selected.Variant.ID, Args: args}, &result, timeout)
	return result, err
}

func (c *Client) RunCompressedJSON(ctx context.Context, serverID string, selected scripts.SelectedScript, args map[string]string, outputEncoding string) (map[string]any, error) {
	timeout := selected.Timeout + 10*time.Second
	if timeout < 20*time.Second {
		timeout = 20 * time.Second
	}
	var result map[string]any
	err := c.do(ctx, http.MethodPost, "/internal/worker/run-compressed-json", runJSONRequest{ServerID: serverID, Command: selected.Command.Name, Variant: selected.Variant.ID, Args: args, OutputEncoding: outputEncoding}, &result, timeout)
	return result, err
}

func (c *Client) OpenCompressedJSONStream(ctx context.Context, serverID string, selected scripts.SelectedScript, args map[string]string, outputEncoding string) (*http.Response, error) {
	return c.openCompressedJSONStream(ctx, runJSONRequest{ServerID: serverID, Command: selected.Command.Name, Variant: selected.Variant.ID, Args: args, OutputEncoding: outputEncoding}, selected)
}

func (c *Client) OpenCompressedJSONStreamServer(ctx context.Context, server domain.Server, selected scripts.SelectedScript, args map[string]string, outputEncoding string) (*http.Response, error) {
	return c.openCompressedJSONStream(ctx, runJSONRequest{ServerID: server.ID, Server: server, Command: selected.Command.Name, Variant: selected.Variant.ID, Args: args, OutputEncoding: outputEncoding}, selected)
}

func (c *Client) openCompressedJSONStream(ctx context.Context, bodyRequest runJSONRequest, selected scripts.SelectedScript) (*http.Response, error) {
	timeout := selected.Timeout + 10*time.Second
	if timeout < 20*time.Second {
		timeout = 20 * time.Second
	}
	requestURL := c.baseURL.ResolveReference(&url.URL{Path: "/internal/worker/run-compressed-json-stream"})
	body, err := json.Marshal(bodyRequest)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, requestURL.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-ShellOrchestra-Internal-Secret", c.internalSecret)
	client := *c.client
	client.Timeout = timeout
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		return nil, responseError(resp)
	}
	return resp, nil
}

func (c *Client) TestTCP(ctx context.Context, server domain.Server) (runtime.TCPTestResult, error) {
	var result runtime.TCPTestResult
	err := c.do(ctx, http.MethodPost, "/internal/worker/test-tcp", serverRequest{Server: server}, &result, 30*time.Second)
	return result, err
}

func runtimeOutputLimits(limits scripts.OutputLimits) runtime.OutputLimits {
	return runtime.OutputLimits{
		MaxStdoutBytes:  limits.MaxStdoutBytes,
		MaxStderrBytes:  limits.MaxStderrBytes,
		MaxDecodedBytes: limits.MaxDecodedBytes,
	}
}

func systemScriptOutputLimits() runtime.OutputLimits {
	return runtime.OutputLimits{
		MaxStdoutBytes:  2 << 20,
		MaxStderrBytes:  128 << 10,
		MaxDecodedBytes: 4 << 20,
	}
}

func (c *Client) TestAuth(ctx context.Context, server domain.Server) (runtime.AuthTestResult, error) {
	var result runtime.AuthTestResult
	err := c.do(ctx, http.MethodPost, "/internal/worker/test-auth", serverRequest{Server: server}, &result, 45*time.Second)
	return result, err
}

func (c *Client) ScanHostKeys(ctx context.Context, server domain.Server) (runtime.HostKeyScanResult, error) {
	var result runtime.HostKeyScanResult
	err := c.do(ctx, http.MethodPost, "/internal/worker/scan-host-keys", serverRequest{Server: server}, &result, 45*time.Second)
	return result, err
}

func (c *Client) DetectFacts(ctx context.Context, server domain.Server) (scripts.TargetFacts, error) {
	var result scripts.TargetFacts
	err := c.do(ctx, http.MethodPost, "/internal/worker/detect-facts", serverRequest{Server: server}, &result, 180*time.Second)
	return result, err
}

func (c *Client) CreateTerminal(ctx context.Context, serverID string, title string, cols int, rows int, initialCommand string) (domain.TerminalSnapshot, error) {
	var result domain.TerminalSnapshot
	err := c.do(ctx, http.MethodPost, "/internal/worker/terminals/create", terminalCreateRequest{ServerID: serverID, Title: title, Cols: cols, Rows: rows, InitialCommand: initialCommand}, &result, 20*time.Second)
	return result, err
}

func (c *Client) TerminalSnapshot(ctx context.Context, sessionID string) (domain.TerminalSnapshot, error) {
	var result domain.TerminalSnapshot
	err := c.do(ctx, http.MethodPost, "/internal/worker/terminals/snapshot", terminalSessionRequest{SessionID: sessionID}, &result, 10*time.Second)
	return result, err
}

func (c *Client) SendTerminalInput(ctx context.Context, sessionID string, data string) error {
	return c.do(ctx, http.MethodPost, "/internal/worker/terminals/input", terminalInputRequest{SessionID: sessionID, Data: data}, nil, 10*time.Second)
}

func (c *Client) ResizeTerminal(ctx context.Context, sessionID string, cols int, rows int) (domain.TerminalSnapshot, error) {
	var result domain.TerminalSnapshot
	err := c.do(ctx, http.MethodPost, "/internal/worker/terminals/resize", terminalResizeRequest{SessionID: sessionID, Cols: cols, Rows: rows}, &result, 10*time.Second)
	return result, err
}

func (c *Client) CloseTerminal(ctx context.Context, sessionID string) error {
	return c.do(ctx, http.MethodPost, "/internal/worker/terminals/close", terminalSessionRequest{SessionID: sessionID}, nil, 10*time.Second)
}

func (c *Client) ProxyTerminalStream(w http.ResponseWriter, r *http.Request, sessionID string) {
	target := *c.baseURL
	proxy := httputil.NewSingleHostReverseProxy(&target)
	originalDirector := proxy.Director
	proxy.Director = func(request *http.Request) {
		originalDirector(request)
		request.URL.Scheme = target.Scheme
		request.URL.Host = target.Host
		request.URL.Path = "/internal/worker/terminals/stream/" + url.PathEscape(strings.TrimSpace(sessionID))
		request.URL.RawQuery = ""
		request.Host = target.Host
		request.Header.Set("X-ShellOrchestra-Internal-Secret", c.internalSecret)
	}
	proxy.ErrorHandler = func(response http.ResponseWriter, request *http.Request, err error) {
		writeError(response, http.StatusBadGateway, "Terminal stream worker is unavailable: "+err.Error())
	}
	proxy.ServeHTTP(w, r)
}

func (c *Client) do(ctx context.Context, method string, path string, payload any, out any, timeout time.Duration) error {
	requestURL := c.baseURL.ResolveReference(&url.URL{Path: path})
	var body io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, requestURL.String(), body)
	if err != nil {
		return err
	}
	req.Header.Set("X-ShellOrchestra-Internal-Secret", c.internalSecret)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := *c.client
	client.Timeout = timeout
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var payload struct {
			Error string `json:"error"`
		}
		internaljson.DecodeBestEffort(resp.Body, 64<<10, &payload)
		if payload.Error == "" {
			payload.Error = resp.Status
		}
		return fmt.Errorf("%s", payload.Error)
	}
	if out == nil || resp.StatusCode == http.StatusNoContent {
		return nil
	}
	return internaljson.DecodeStrictResponse(resp.Body, maxWorkerJSONResponseBodyBytes, out, "worker response")
}

type bufferedWorkerConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedWorkerConn) Read(p []byte) (int, error) {
	if c.reader != nil && c.reader.Buffered() > 0 {
		return c.reader.Read(p)
	}
	return c.Conn.Read(p)
}

func proxyRawConns(a net.Conn, b net.Conn) {
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(a, b)
		_ = a.Close()
		_ = b.Close()
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(b, a)
		_ = a.Close()
		_ = b.Close()
		done <- struct{}{}
	}()
	<-done
}

func ListenAndServe(ctx context.Context, cfg config.AppConfig, db *store.SQLiteStore, catalog *scripts.Catalog, signer *casigner.Client) error {
	workerServer := NewServer(cfg, db, catalog, signer)
	workerServer.connections.MarkAllLocked(context.Background())
	server := &http.Server{Addr: cfg.App.ListenAddr, Handler: workerServer.Handler(), ReadHeaderTimeout: 10 * time.Second, MaxHeaderBytes: httplimits.MaxHeaderBytes}
	go func() {
		<-ctx.Done()
		workerServer.periodic.Stop()
		workerServer.connections.Stop()
		workerServer.terminals.Close()
		workerServer.runtime.Close()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

type ConnectionManager struct {
	server *Server

	mu              sync.Mutex
	cancel          context.CancelFunc
	states          *managedConnectionStates
	connectInFlight map[string]bool
}

type managedConnectionState struct {
	State              domain.ServerStatusState
	RetryCount         int
	NextRetryAt        time.Time
	BlockedFingerprint string
	LastConnectedAt    time.Time
	LastKeepAliveAt    time.Time
	LastLostAt         time.Time
	LastError          string
}

type connectionFailureDecision struct {
	State   domain.ServerStatusState
	Message string
	Retry   bool
	Block   bool
}

type managedConnectionStates struct {
	mu     sync.Mutex
	states map[string]*managedConnectionState
}

func newManagedConnectionStates() *managedConnectionStates {
	return &managedConnectionStates{states: map[string]*managedConnectionState{}}
}

func (s *managedConnectionStates) Reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.states = map[string]*managedConnectionState{}
}

func (s *managedConnectionStates) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.states)
}

func (s *managedConnectionStates) StateFor(serverID string) *managedConnectionState {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.states[serverID]
	if state == nil {
		state = &managedConnectionState{State: domain.StatusDisconnected}
		s.states[serverID] = state
	}
	return state
}

func (s *managedConnectionStates) Prune(servers map[string]domain.Server, onRemoved func(serverID string)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for serverID := range s.states {
		if _, ok := servers[serverID]; !ok {
			delete(s.states, serverID)
			if onRemoved != nil {
				onRemoved(serverID)
			}
		}
	}
}

func (s *managedConnectionStates) EnrichTelemetry(serverID string, telemetry map[string]any, manager *ConnectionManager) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.states[serverID]
	if state == nil {
		return
	}
	enrichStatusTelemetry(telemetry, state, manager)
}

func NewConnectionManager(server *Server) *ConnectionManager {
	return &ConnectionManager{server: server, states: newManagedConnectionStates(), connectInFlight: map[string]bool{}}
}

func (m *ConnectionManager) Start() {
	m.mu.Lock()
	if m.cancel != nil {
		m.cancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.states.Reset()
	m.connectInFlight = map[string]bool{}
	m.mu.Unlock()

	go m.run(ctx)
}

func (m *ConnectionManager) Stop() {
	m.mu.Lock()
	if m.cancel != nil {
		m.cancel()
		m.cancel = nil
	}
	m.mu.Unlock()
}

func (m *ConnectionManager) Snapshot() map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	return map[string]any{
		"connection_manager_running":      m.cancel != nil,
		"connection_manager_managed":      m.states.Len(),
		"keepalive_interval_seconds":      m.keepAliveInterval().Seconds(),
		"reconnect_interval_seconds":      m.reconnectInterval().Seconds(),
		"connection_manager_retry_policy": "Retry network-level TCP failures and lost established sessions; block authentication, host-key, locked-runtime, and configuration failures until a manual reconnect or configuration change.",
	}
}

func (m *ConnectionManager) run(ctx context.Context) {
	m.reconcile(ctx)
	ticker := time.NewTicker(m.cycleInterval())
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.reconcile(ctx)
		}
	}
}

func (m *ConnectionManager) reconcile(ctx context.Context) {
	servers, err := m.server.store.ListServers(ctx)
	if err != nil {
		log.Printf("connection manager failed to list servers: %v", err)
		return
	}
	byID := make(map[string]domain.Server, len(servers))
	for _, server := range servers {
		byID[server.ID] = server
	}
	m.pruneStates(byID)
	for _, server := range orderedServers(servers, byID) {
		if ctx.Err() != nil {
			return
		}
		m.manageServer(ctx, server, byID)
	}
}

func (m *ConnectionManager) manageServer(ctx context.Context, server domain.Server, byID map[string]domain.Server) {
	now := time.Now().UTC()
	fingerprint := serverConnectionFingerprint(server)
	if m.isConnectInFlight(server.ID) {
		return
	}
	state := m.stateFor(server.ID)
	if state.State != domain.StatusConnected && m.server.runtime.IsConnected(server.ID) {
		state.State = domain.StatusConnected
		state.RetryCount = 0
		state.NextRetryAt = time.Time{}
		state.BlockedFingerprint = ""
		if state.LastConnectedAt.IsZero() {
			state.LastConnectedAt = now
		}
		state.LastKeepAliveAt = now
		state.LastError = ""
		m.upsertStatus(context.Background(), server.ID, domain.StatusConnected, "", state, map[string]any{"connected": true, "failure_class": "", "recovered_runtime_connection": true})
	}
	if state.BlockedFingerprint == fingerprint {
		return
	}
	if state.State == domain.StatusConnected {
		if !m.server.runtime.IsConnected(server.ID) {
			state.State = domain.StatusRetryingNetwork
			state.NextRetryAt = now
			state.LastLostAt = now
			state.LastError = "The established SSH connection was closed; ShellOrchestra will reconnect."
			m.upsertStatus(ctx, server.ID, domain.StatusRetryingNetwork, state.LastError, state, map[string]any{"failure_class": "established_connection_lost"})
			return
		}
		if state.LastKeepAliveAt.IsZero() || now.Sub(state.LastKeepAliveAt) >= m.keepAliveInterval() {
			m.keepAlive(ctx, server, state)
		}
		return
	}
	if !state.NextRetryAt.IsZero() && now.Before(state.NextRetryAt) {
		return
	}
	if server.ConnectionMode == domain.ServerConnectionChained {
		jumpID := strings.TrimSpace(server.JumpServerID)
		if jumpID == "" {
			state.State = domain.StatusBlockedConfig
			state.BlockedFingerprint = fingerprint
			m.upsertStatus(ctx, server.ID, domain.StatusBlockedConfig, "This chained server does not have a jump server selected.", state, map[string]any{"failure_class": "configuration_blocked"})
			return
		}
		if _, ok := byID[jumpID]; !ok {
			state.State = domain.StatusBlockedConfig
			state.BlockedFingerprint = fingerprint
			m.upsertStatus(ctx, server.ID, domain.StatusBlockedConfig, "The selected jump server was not found.", state, map[string]any{"failure_class": "configuration_blocked", "jump_server_id": jumpID})
			return
		}
		jumpState := m.stateFor(jumpID)
		jumpConnected := jumpState.State == domain.StatusConnected || m.server.runtime.IsConnected(jumpID)
		if !jumpConnected {
			state.State = domain.StatusJumpUnavailable
			state.NextRetryAt = time.Time{}
			m.upsertStatus(ctx, server.ID, domain.StatusJumpUnavailable, "Jump server is not connected yet; ShellOrchestra will retry this chained target as soon as the jump server is available.", state, map[string]any{"failure_class": "jump_unavailable", "jump_server_id": jumpID})
			return
		}
		if jumpState.State != domain.StatusConnected {
			jumpState.State = domain.StatusConnected
			jumpState.RetryCount = 0
			jumpState.NextRetryAt = time.Time{}
			jumpState.BlockedFingerprint = ""
			if jumpState.LastConnectedAt.IsZero() {
				jumpState.LastConnectedAt = now
			}
			jumpState.LastKeepAliveAt = now
			jumpState.LastError = ""
			m.upsertStatus(context.Background(), jumpID, domain.StatusConnected, "", jumpState, map[string]any{"connected": true, "failure_class": "", "recovered_runtime_connection": true})
		}
	}
	if !m.beginConnect(server.ID) {
		return
	}
	go func() {
		defer m.finishConnect(server.ID)
		m.connect(ctx, server, state, fingerprint)
	}()
}

func (m *ConnectionManager) beginConnect(serverID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.connectInFlight == nil {
		m.connectInFlight = map[string]bool{}
	}
	if m.connectInFlight[serverID] {
		return false
	}
	m.connectInFlight[serverID] = true
	return true
}

func (m *ConnectionManager) finishConnect(serverID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.connectInFlight, serverID)
}

func (m *ConnectionManager) isConnectInFlight(serverID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.connectInFlight[serverID]
}

func (m *ConnectionManager) connect(ctx context.Context, server domain.Server, state *managedConnectionState, fingerprint string) {
	attemptCtx, cancel := context.WithTimeout(ctx, m.connectAttemptTimeout())
	defer cancel()
	now := time.Now().UTC()
	m.upsertStatus(attemptCtx, server.ID, domain.StatusConnecting, "Opening persistent SSH connection.", state, nil)
	status, err := m.server.runtime.Connect(attemptCtx, server)
	if status.State == domain.StatusConnected {
		state.State = domain.StatusConnected
		state.RetryCount = 0
		state.NextRetryAt = time.Time{}
		state.BlockedFingerprint = ""
		state.LastConnectedAt = now
		state.LastKeepAliveAt = now
		state.LastError = ""
		if status.Telemetry == nil {
			status.Telemetry = map[string]any{}
		}
		status.Telemetry["connected"] = true
		status.Telemetry["failure_class"] = ""
		status.Telemetry["telemetry_error"] = ""
		if m.server.periodic != nil && !hasCriticalFacts(server) {
			detectionTelemetry, factsErr := m.server.periodic.RunCriticalDetectionNow(ctx, server)
			if factsErr != nil {
				status.Telemetry["critical_detection_error"] = factsErr.Error()
			}
			for key, value := range detectionTelemetry {
				status.Telemetry[key] = value
			}
		} else if hasCriticalFacts(server) {
			status.Telemetry["critical_detection_error"] = ""
			status.Telemetry["critical_detection_result"] = "existing_facts"
		}
		m.upsertStatus(context.Background(), server.ID, domain.StatusConnected, "", state, status.Telemetry)
		return
	}
	decision := classifyConnectionFailure(status, err)
	state.State = decision.State
	state.LastError = decision.Message
	if decision.Retry {
		state.RetryCount++
		state.NextRetryAt = now.Add(m.reconnectDelay(server.ID))
	} else {
		state.NextRetryAt = time.Time{}
	}
	if decision.Block {
		state.BlockedFingerprint = fingerprint
	}
	m.upsertStatus(attemptCtx, server.ID, decision.State, decision.Message, state, map[string]any{"failure_class": failureClass(decision.State)})
}

func (m *ConnectionManager) keepAlive(ctx context.Context, server domain.Server, state *managedConnectionState) {
	keepAliveCtx, cancel := context.WithTimeout(ctx, minDuration(10*time.Second, m.keepAliveInterval()))
	defer cancel()
	now := time.Now().UTC()
	err := m.server.runtime.KeepAlive(keepAliveCtx, server.ID)
	if err == nil {
		state.LastKeepAliveAt = now
		m.upsertStatus(keepAliveCtx, server.ID, domain.StatusConnected, "", state, map[string]any{"connected": true, "failure_class": "", "last_keepalive_result": "ok", "last_keepalive_failure": ""})
		return
	}
	state.State = domain.StatusRetryingNetwork
	state.RetryCount++
	state.NextRetryAt = now.Add(m.reconnectDelay(server.ID))
	state.LastLostAt = now
	state.LastError = err.Error()
	m.upsertStatus(keepAliveCtx, server.ID, domain.StatusRetryingNetwork, "The established SSH connection stopped responding; ShellOrchestra will reconnect.", state, map[string]any{"failure_class": "established_connection_lost", "last_keepalive_failure": err.Error()})
}

func (m *ConnectionManager) MarkAllLocked(ctx context.Context) {
	servers, err := m.server.store.ListServers(ctx)
	if err != nil {
		log.Printf("failed to mark server statuses locked: %v", err)
		return
	}
	for _, server := range servers {
		status := domain.ServerStatus{ServerID: server.ID, State: domain.StatusLocked, Telemetry: map[string]any{"managed_connection": true}, LastError: "SERVER ACCESS IS LOCKED. Sign in with an approved device to unlock persistent SSH connections.", UpdatedAt: time.Now().UTC()}
		if err := m.server.store.UpsertStatus(ctx, status); err != nil {
			log.Printf("failed to mark %s locked: %v", server.Name, err)
		}
	}
}

func (m *ConnectionManager) stateFor(serverID string) *managedConnectionState {
	return m.states.StateFor(serverID)
}

func (m *ConnectionManager) pruneStates(servers map[string]domain.Server) {
	m.states.Prune(servers, m.server.runtime.Disconnect)
}

func (m *ConnectionManager) upsertStatus(ctx context.Context, serverID string, statusState domain.ServerStatusState, message string, state *managedConnectionState, extra map[string]any) {
	telemetry := map[string]any{}
	for key, value := range extra {
		telemetry[key] = value
	}
	if _, ok := telemetry["connected"]; !ok {
		telemetry["connected"] = statusState == domain.StatusConnected
	}
	enrichStatusTelemetry(telemetry, state, m)
	status := domain.ServerStatus{ServerID: serverID, State: statusState, Telemetry: telemetry, LastError: message, UpdatedAt: time.Now().UTC()}
	saveCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if ctx.Err() == nil {
		saveCtx = ctx
	}
	if err := m.server.store.UpsertStatus(saveCtx, status); err != nil {
		log.Printf("failed to save managed status for %s: %v", serverID, err)
	}
}

func (m *ConnectionManager) EnrichTelemetry(serverID string, telemetry map[string]any) {
	m.states.EnrichTelemetry(serverID, telemetry, m)
}

func enrichStatusTelemetry(telemetry map[string]any, state *managedConnectionState, manager *ConnectionManager) {
	telemetry["managed_connection"] = true
	telemetry["retry_count"] = state.RetryCount
	telemetry["keepalive_interval_seconds"] = int(manager.keepAliveInterval().Seconds())
	telemetry["reconnect_interval_seconds"] = int(manager.reconnectInterval().Seconds())
	if !state.NextRetryAt.IsZero() {
		telemetry["next_retry_at"] = state.NextRetryAt.Format(time.RFC3339)
	} else {
		telemetry["next_retry_at"] = ""
	}
	if !state.LastConnectedAt.IsZero() {
		telemetry["last_connected_at"] = state.LastConnectedAt.Format(time.RFC3339)
	}
	if !state.LastKeepAliveAt.IsZero() {
		telemetry["last_keepalive_at"] = state.LastKeepAliveAt.Format(time.RFC3339)
	}
	if !state.LastLostAt.IsZero() {
		telemetry["last_lost_at"] = state.LastLostAt.Format(time.RFC3339)
	}
	telemetry["last_manager_error"] = state.LastError
}

func classifyConnectionFailure(status domain.ServerStatus, err error) connectionFailureDecision {
	message := strings.TrimSpace(status.LastError)
	if message == "" && err != nil {
		message = err.Error()
	}
	if message == "" {
		message = "SSH connection failed."
	}
	switch status.State {
	case domain.StatusLocked:
		return connectionFailureDecision{State: domain.StatusLocked, Message: message, Block: true}
	case domain.StatusHostKeyRequired, domain.StatusHostKeyMismatch:
		return connectionFailureDecision{State: status.State, Message: message, Block: true}
	}
	var tcpErr runtime.TCPDialError
	if errors.As(err, &tcpErr) {
		retryMessage := "TCP connection failed; ShellOrchestra will retry this server."
		if message != "" {
			retryMessage += " Last error: " + message
		}
		return connectionFailureDecision{State: domain.StatusRetryingNetwork, Message: retryMessage, Retry: true}
	}
	lower := strings.ToLower(message)
	switch {
	case strings.Contains(lower, "unable to authenticate"), strings.Contains(lower, "no supported methods remain"), strings.Contains(lower, "permission denied"):
		return connectionFailureDecision{State: domain.StatusBlockedAuth, Message: message, Block: true}
	case strings.Contains(lower, "not unlocked"), strings.Contains(lower, "access is locked"), strings.Contains(lower, "signer is locked"):
		return connectionFailureDecision{State: domain.StatusLocked, Message: message, Block: true}
	case strings.Contains(lower, "unsupported"), strings.Contains(lower, "requires a selected ssh key"), strings.Contains(lower, "configured host key is invalid"), strings.Contains(lower, "parse host key"):
		return connectionFailureDecision{State: domain.StatusBlockedConfig, Message: message, Block: true}
	default:
		return connectionFailureDecision{State: domain.StatusFailed, Message: message, Block: true}
	}
}

func failureClass(state domain.ServerStatusState) string {
	switch state {
	case domain.StatusRetryingNetwork:
		return "network_retry"
	case domain.StatusBlockedAuth:
		return "authentication_blocked"
	case domain.StatusBlockedConfig:
		return "configuration_blocked"
	case domain.StatusHostKeyRequired:
		return "host_key_required"
	case domain.StatusHostKeyMismatch:
		return "host_key_mismatch"
	case domain.StatusLocked:
		return "runtime_locked"
	case domain.StatusJumpUnavailable:
		return "jump_unavailable"
	default:
		return "blocked_unknown"
	}
}

func orderedServers(servers []domain.Server, byID map[string]domain.Server) []domain.Server {
	ordered := make([]domain.Server, 0, len(servers))
	visited := map[string]bool{}
	visiting := map[string]bool{}
	var visit func(domain.Server)
	visit = func(server domain.Server) {
		if visited[server.ID] || visiting[server.ID] {
			return
		}
		visiting[server.ID] = true
		if server.ConnectionMode == domain.ServerConnectionChained {
			if jump, ok := byID[strings.TrimSpace(server.JumpServerID)]; ok {
				visit(jump)
			}
		}
		visiting[server.ID] = false
		visited[server.ID] = true
		ordered = append(ordered, server)
	}
	sorted := append([]domain.Server(nil), servers...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Name < sorted[j].Name })
	for _, server := range sorted {
		visit(server)
	}
	return ordered
}

func serverConnectionFingerprint(server domain.Server) string {
	parts := []string{server.ID, server.Host, fmt.Sprintf("%d", server.Port), server.Username, string(server.ConnectionMode), server.JumpServerID, string(server.AuthMethod), server.SSHKeyID, server.HostKey}
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(sum[:])
}

func (m *ConnectionManager) cycleInterval() time.Duration {
	interval := minDuration(time.Second, m.reconnectInterval())
	if interval <= 0 {
		return time.Second
	}
	return interval
}

func (m *ConnectionManager) keepAliveInterval() time.Duration {
	interval := time.Duration(m.server.cfg.Runtime.KeepAliveIntervalSeconds) * time.Second
	if interval <= 0 {
		return 30 * time.Second
	}
	return interval
}

func (m *ConnectionManager) reconnectInterval() time.Duration {
	interval := time.Duration(m.server.cfg.Runtime.ReconnectIntervalSeconds) * time.Second
	if interval <= 0 {
		return 10 * time.Second
	}
	return interval
}

func (m *ConnectionManager) reconnectDelay(serverID string) time.Duration {
	return m.reconnectInterval() + deterministicJitter(serverID)
}

func (m *ConnectionManager) connectAttemptTimeout() time.Duration {
	timeout := time.Duration(m.server.cfg.Runtime.ConnectTimeoutSeconds)*time.Second + 20*time.Second
	if timeout < 30*time.Second {
		return 30 * time.Second
	}
	return timeout
}

func deterministicJitter(value string) time.Duration {
	hash := fnv.New32a()
	_, _ = hash.Write([]byte(value))
	return time.Duration(hash.Sum32()%2000) * time.Millisecond
}

func minDuration(a time.Duration, b time.Duration) time.Duration {
	if a <= 0 {
		return b
	}
	if b <= 0 {
		return a
	}
	if a < b {
		return a
	}
	return b
}

func stringValue(value any) string {
	if raw, ok := value.(string); ok {
		return raw
	}
	return ""
}

func boolValue(value any) bool {
	raw, ok := value.(bool)
	return ok && raw
}

func boolMapValue(value any) map[string]bool {
	out := map[string]bool{}
	raw, ok := value.(map[string]any)
	if !ok {
		return out
	}
	for key, value := range raw {
		out[key] = boolValue(value)
	}
	return out
}

func posixFactProbeCommand(scriptsRoot string, name string) (string, error) {
	body, err := readSystemScript(scriptsRoot, name)
	if err != nil {
		return "", err
	}
	encoded := base64.StdEncoding.EncodeToString(body)
	return "printf '%s' '" + encoded + "' | base64 -d | sh", nil
}

func powershellFactProbeCommand(scriptsRoot string, name string) (string, error) {
	body, err := readSystemScript(scriptsRoot, name)
	if err != nil {
		return "", err
	}
	return scripts.PowerShellEncodedCommand(string(body)), nil
}

func readSystemScript(scriptsRoot string, name string) ([]byte, error) {
	body, err := scripts.ReadSystemScript(scriptsRoot, name)
	if err != nil {
		return nil, fmt.Errorf("read system detection script %s: %w", name, err)
	}
	return body, nil
}

func decodeJSON(w http.ResponseWriter, r *http.Request, out any) bool {
	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxWorkerJSONBodyBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON request body.")
		return false
	}
	var trailing struct{}
	if err := decoder.Decode(&trailing); err != io.EOF {
		writeError(w, http.StatusBadRequest, "Invalid JSON request body.")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func methodNotAllowed(w http.ResponseWriter) {
	writeError(w, http.StatusMethodNotAllowed, "Method not allowed.")
}
