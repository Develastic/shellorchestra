// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package apprunner

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"time"

	"shellorchestra/backend/internal/appplan"
	"shellorchestra/backend/internal/config"
	"shellorchestra/backend/internal/httplimits"
	"shellorchestra/backend/internal/internalurl"
	"shellorchestra/backend/internal/serviceinfo"
)

const maxAppRunnerJSONBodyBytes = 1 << 20

type Server struct {
	cfg config.AppConfig
}

func NewServer(cfg config.AppConfig) *Server {
	return &Server{cfg: cfg}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/internal/service/status", serviceinfo.HandlerWithSecret(s.cfg, "app-runner", s.cfg.Internal.AppRunnerSharedSecret, func(ctx context.Context) map[string]any {
		return map[string]any{"mode": "passive-planner", "ssh": false, "keys": false, "database": false}
	}))
	mux.HandleFunc("/internal/app-runner/healthz", s.health)
	mux.HandleFunc("/internal/app-runner/plan", s.plan)
	return mux
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "app-runner", "mode": "passive-planner"})
}

func (s *Server) plan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var request appplan.Request
	if !decodeJSON(w, r, &request) {
		return
	}
	response, err := Plan(request)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func Plan(request appplan.Request) (appplan.Response, error) {
	if err := appplan.ValidateRequest(request); err != nil {
		return appplan.Response{}, err
	}
	action := request.Action
	switch request.Operation {
	case appplan.OperationLaunch, appplan.OperationInstall, appplan.OperationData:
		action = ""
	case appplan.OperationAction:
	default:
		return appplan.Response{}, fmt.Errorf("unsupported app operation %q", request.Operation)
	}
	response := appplan.Response{Version: 1, Kind: "action_request", ActionID: appplan.ActionID(request.PluginID, request.AppID, request.Operation, action)}
	if err := appplan.ValidateResponse(response); err != nil {
		return appplan.Response{}, err
	}
	return response, nil
}

func (s *Server) validInternalRequest(r *http.Request) bool {
	expected := strings.TrimSpace(s.cfg.Internal.AppRunnerSharedSecret)
	provided := strings.TrimSpace(r.Header.Get("X-ShellOrchestra-Internal-Secret"))
	if expected == "" || provided == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

func ListenAndServe(ctx context.Context, cfg config.AppConfig) error {
	server := &http.Server{Addr: cfg.App.ListenAddr, Handler: NewServer(cfg).Handler(), ReadHeaderTimeout: 10 * time.Second, MaxHeaderBytes: httplimits.MaxHeaderBytes}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	if socketPath, ok, err := appRunnerSocketPath(cfg.Internal.AppRunnerURL); err != nil {
		return err
	} else if ok {
		return serveUnixSocket(server, socketPath)
	}
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

func appRunnerSocketPath(rawURL string) (string, bool, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || !strings.EqualFold(parsed.Scheme, "unix") {
		return "", false, err
	}
	endpoint, err := internalurl.ParseServiceOrUnixSocketURL(rawURL, "internal.app_runner_url")
	if err != nil {
		return "", false, err
	}
	return endpoint.UnixSocketPath, true, nil
}

func serveUnixSocket(server *http.Server, socketPath string) error {
	if err := os.MkdirAll(path.Dir(socketPath), 0o750); err != nil {
		return err
	}
	if err := removeStaleUnixSocket(socketPath); err != nil {
		return err
	}
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return err
	}
	if err := os.Chmod(socketPath, 0o660); err != nil {
		_ = listener.Close()
		return err
	}
	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

func removeStaleUnixSocket(socketPath string) error {
	existing, err := os.Lstat(socketPath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if existing.Mode()&os.ModeSocket == 0 {
		return fmt.Errorf("refusing to remove non-socket app-runner path %s", socketPath)
	}
	return os.Remove(socketPath)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func methodNotAllowed(w http.ResponseWriter) {
	writeError(w, http.StatusMethodNotAllowed, "Method not allowed.")
}

func decodeJSON(w http.ResponseWriter, r *http.Request, out any) bool {
	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxAppRunnerJSONBodyBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON: "+err.Error())
		return false
	}
	var trailing struct{}
	if err := decoder.Decode(&trailing); err != io.EOF {
		writeError(w, http.StatusBadRequest, "Invalid JSON: request body must contain exactly one JSON object.")
		return false
	}
	return true
}
