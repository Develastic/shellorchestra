// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package updater

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"shellorchestra/backend/internal/buildinfo"
	"shellorchestra/backend/internal/config"
	"shellorchestra/backend/internal/httplimits"
	"shellorchestra/backend/internal/internaljson"
	"shellorchestra/backend/internal/releases"
	"shellorchestra/backend/internal/serviceinfo"
)

const (
	maxUpdaterJSONBodyBytes     = 1 << 20
	maxUpdaterErrorBodyBytes    = 4096
	defaultUpdaterDownloadLimit = 16 << 30
)

type Server struct {
	cfg            config.AppConfig
	publicKeys     []ed25519.PublicKey
	rootPublicKeys []ed25519.PublicKey
	client         *http.Client
	mu             sync.Mutex
	jobs           map[string]*Job
	running        bool
}

type Job struct {
	ID            string    `json:"id"`
	Status        string    `json:"status"`
	Message       string    `json:"message"`
	Channel       string    `json:"channel"`
	TargetVersion string    `json:"target_version"`
	ArtifactPath  string    `json:"artifact_path,omitempty"`
	StartedAt     time.Time `json:"started_at"`
	CompletedAt   time.Time `json:"completed_at,omitempty"`
	Error         string    `json:"error,omitempty"`
	LogTail       string    `json:"log_tail,omitempty"`
}

type startRequest struct {
	Channel        string `json:"channel"`
	CurrentVersion string `json:"current_version"`
	TargetVersion  string `json:"target_version"`
}

type startResponse struct {
	Status        string `json:"status"`
	JobID         string `json:"job_id"`
	Message       string `json:"message"`
	TargetVersion string `json:"target_version,omitempty"`
}

func ListenAndServe(ctx context.Context, cfg config.AppConfig) error {
	server, err := NewServer(cfg)
	if err != nil {
		return err
	}
	httpServer := &http.Server{Handler: server.Handler(), ReadHeaderTimeout: 10 * time.Second, MaxHeaderBytes: httplimits.MaxHeaderBytes}
	listenAddr := strings.TrimSpace(cfg.App.ListenAddr)
	if strings.HasPrefix(listenAddr, "unix://") {
		socketPath, err := updaterSocketPath(listenAddr)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(socketPath), 0o750); err != nil {
			return err
		}
		if err := os.RemoveAll(socketPath); err != nil {
			return err
		}
		listener, err := net.Listen("unix", socketPath)
		if err != nil {
			return err
		}
		defer listener.Close()
		if err := os.Chmod(socketPath, 0o660); err != nil {
			return err
		}
		go func() {
			<-ctx.Done()
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = httpServer.Shutdown(shutdownCtx)
		}()
		log.Printf("ShellOrchestra updater service listening on unix://%s", socketPath)
		if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	}
	if err := validateUpdaterHTTPListenAddr(listenAddr); err != nil {
		return err
	}
	httpServer.Addr = listenAddr
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()
	log.Printf("ShellOrchestra updater service listening on %s", listenAddr)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func validateUpdaterHTTPListenAddr(listenAddr string) error {
	host, _, err := net.SplitHostPort(strings.TrimSpace(listenAddr))
	if err != nil {
		return fmt.Errorf("updater HTTP listen address must use explicit loopback host and port: %w", err)
	}
	if !isLoopbackHost(host) {
		return fmt.Errorf("updater HTTP listen address must bind to localhost, 127.0.0.1, or ::1")
	}
	return nil
}

func isLoopbackHost(host string) bool {
	normalized := strings.TrimSpace(strings.ToLower(host))
	if normalized == "localhost" {
		return true
	}
	ip := net.ParseIP(normalized)
	return ip != nil && ip.IsLoopback()
}

func NewServer(cfg config.AppConfig) (*Server, error) {
	publicKeys, err := releases.ParseTrustedPublicKeys(append(buildinfo.ReleasePublicKeys(), cfg.Updates.ManifestPublicKeys...))
	if err != nil {
		return nil, err
	}
	rootPublicKeys, err := releases.ParseTrustedPublicKeys(append(buildinfo.ReleaseRootKeys(), cfg.Updates.RootPublicKeys...))
	if err != nil {
		return nil, err
	}
	return &Server{cfg: cfg, publicKeys: publicKeys, rootPublicKeys: rootPublicKeys, client: &http.Client{Timeout: 30 * time.Second}, jobs: map[string]*Job{}}, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/internal/service/status", serviceinfo.Handler(s.cfg, "updater", s.serviceStatusDetails))
	mux.HandleFunc("/v1/updates/start", s.start)
	mux.HandleFunc("/v1/updates/jobs/", s.jobByID)
	return mux
}

func (s *Server) serviceStatusDetails(context.Context) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return map[string]any{"jobs": len(s.jobs), "running": s.running}
}

func (s *Server) start(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusUnauthorized, "Internal updater access is required.")
		return
	}
	var body startRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	body.Channel = strings.TrimSpace(body.Channel)
	body.CurrentVersion = strings.TrimSpace(body.CurrentVersion)
	body.TargetVersion = strings.TrimSpace(body.TargetVersion)
	if body.Channel == "" {
		writeError(w, http.StatusBadRequest, "channel is required.")
		return
	}
	if body.TargetVersion != "" {
		if _, err := releases.ParseVersion(body.TargetVersion); err != nil {
			writeError(w, http.StatusBadRequest, "target_version must use major.minor.build format.")
			return
		}
	}
	if body.CurrentVersion != "" && body.CurrentVersion != "unknown" {
		if _, err := releases.ParseVersion(body.CurrentVersion); err != nil {
			writeError(w, http.StatusBadRequest, "current_version must use major.minor.build format or be omitted.")
			return
		}
	}
	if body.TargetVersion != "" && body.CurrentVersion != "" && body.CurrentVersion != "unknown" {
		comparison, err := releases.CompareVersions(body.TargetVersion, body.CurrentVersion)
		if err != nil {
			writeError(w, http.StatusBadRequest, "target_version and current_version must use major.minor.build format.")
			return
		}
		if comparison <= 0 {
			writeError(w, http.StatusConflict, "Requested target_version is not newer than current_version.")
			return
		}
	}
	if body.TargetVersion == "" {
		body.TargetVersion = "latest"
	}
	if len(s.publicKeys) == 0 && len(s.rootPublicKeys) == 0 {
		writeError(w, http.StatusConflict, "Updater has no trusted release root key or legacy release public key configured.")
		return
	}
	if strings.TrimSpace(s.cfg.Updates.ApplyScript) == "" {
		writeError(w, http.StatusConflict, "Updater apply script is not configured.")
		return
	}
	jobMessage := "Upgrade job accepted."
	if body.TargetVersion == "latest" {
		jobMessage = "Upgrade job accepted. The updater will resolve the latest signed release from the verified manifest."
	}
	job := &Job{ID: newJobID(), Status: "queued", Message: jobMessage, Channel: body.Channel, TargetVersion: body.TargetVersion, StartedAt: time.Now().UTC()}
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		writeError(w, http.StatusConflict, "Another ShellOrchestra upgrade is already running.")
		return
	}
	s.running = true
	s.jobs[job.ID] = job
	s.mu.Unlock()
	go s.runJob(job, body)
	response := startResponse{Status: "accepted", JobID: job.ID, Message: "ShellOrchestra updater accepted the upgrade job."}
	if body.TargetVersion != "latest" {
		response.TargetVersion = body.TargetVersion
	}
	writeJSON(w, http.StatusAccepted, response)
}

func (s *Server) jobByID(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusUnauthorized, "Internal updater access is required.")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/v1/updates/jobs/")
	if !safeJobID(id) {
		writeError(w, http.StatusBadRequest, "Invalid updater job id.")
		return
	}
	s.mu.Lock()
	job, ok := s.jobs[id]
	var snapshot Job
	if ok {
		snapshot = *job
	}
	s.mu.Unlock()
	if !ok {
		writeError(w, http.StatusNotFound, "Updater job was not found.")
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) runJob(job *Job, request startRequest) {
	defer func() {
		s.mu.Lock()
		s.running = false
		s.mu.Unlock()
	}()
	s.setJob(job.ID, "running", "Downloading and verifying the signed ShellOrchestra release artifact.", "", "")
	artifactPath, targetVersion, err := s.downloadAndVerify(request)
	if err != nil {
		s.finishJob(job.ID, "failed", "Release verification failed.", err.Error(), "")
		return
	}
	request.TargetVersion = targetVersion
	s.setJobTargetVersion(job.ID, targetVersion)
	s.setJob(job.ID, "applying", "Signed artifact verified. Running the local updater apply script.", artifactPath, "")
	logTail, err := s.runApplyScript(request, artifactPath)
	if err != nil {
		s.finishJob(job.ID, "failed", "The local updater apply script failed.", err.Error(), logTail)
		return
	}
	s.finishJob(job.ID, "completed", "ShellOrchestra upgrade apply script completed. The main service may restart now.", "", logTail)
}

func (s *Server) downloadAndVerify(request startRequest) (string, string, error) {
	fetchResult, err := s.fetchManifest(context.Background())
	if err != nil {
		return "", "", err
	}
	manifest := fetchResult.Manifest
	if manifest.Signed.Channel != request.Channel {
		return "", "", fmt.Errorf("manifest channel %q does not match requested channel %q", manifest.Signed.Channel, request.Channel)
	}
	targetVersion := strings.TrimSpace(request.TargetVersion)
	if targetVersion == "" || targetVersion == "latest" {
		targetVersion = manifest.Signed.Latest
	} else if manifest.Signed.Latest != targetVersion {
		return "", "", fmt.Errorf("manifest latest version %q does not match requested target version %q", manifest.Signed.Latest, targetVersion)
	}
	if request.CurrentVersion != "" && request.CurrentVersion != "unknown" {
		comparison, err := releases.CompareVersions(targetVersion, request.CurrentVersion)
		if err != nil {
			return "", "", fmt.Errorf("could not compare signed target version %q with current version %q: %w", targetVersion, request.CurrentVersion, err)
		}
		if comparison <= 0 {
			return "", "", fmt.Errorf("no newer signed release is available; current version is %s and latest signed version is %s", request.CurrentVersion, targetVersion)
		}
	}
	artifactName := artifactForInstallMethod(s.cfg.Updates.InstallMethod)
	artifact, ok := manifest.Signed.Artifacts[artifactName]
	if !ok {
		return "", "", fmt.Errorf("manifest does not contain %s artifact", artifactName)
	}
	stagingDir := strings.TrimSpace(s.cfg.Updates.StagingDir)
	if stagingDir == "" {
		return "", "", fmt.Errorf("updates.staging_dir is required for updater role")
	}
	if err := os.MkdirAll(stagingDir, 0o700); err != nil {
		return "", "", err
	}
	artifactPath := filepath.Join(stagingDir, "shellorchestra-"+targetVersion+"-"+artifactName+".artifact")
	sha, err := downloadFile(context.Background(), s.client, artifact.URL, artifactPath, defaultUpdaterDownloadLimit)
	if err != nil {
		return "", "", err
	}
	if !releases.ArtifactDigestMatches(artifact.SHA256, sha) {
		return "", "", fmt.Errorf("artifact sha256 mismatch: got %s, want %s", sha, artifact.SHA256)
	}
	artifactKeys := fetchResult.ReleasePublicKeys
	if len(artifactKeys) == 0 {
		artifactKeys = s.publicKeys
	}
	if err := releases.VerifyArtifactSignature(artifact, artifactKeys); err != nil {
		return "", "", err
	}
	return artifactPath, targetVersion, nil
}

func (s *Server) fetchManifest(ctx context.Context) (releases.FetchResult, error) {
	manifestURL := strings.TrimSpace(s.cfg.Updates.ManifestURL)
	if manifestURL == "" {
		return releases.FetchResult{}, fmt.Errorf("updates.manifest_url is required")
	}
	fetchResult, err := releases.FetchAndVerifyManifest(ctx, releases.TrustOptions{
		ManifestURL:        manifestURL,
		ManifestMirrorURLs: s.cfg.Updates.ManifestMirrorURLs,
		KeyringURL:         s.cfg.Updates.KeyringURL,
		KeyringMirrorURLs:  s.cfg.Updates.KeyringMirrorURLs,
		RootPublicKeys:     s.rootPublicKeys,
		DirectPublicKeys:   s.publicKeys,
		Channel:            strings.TrimSpace(s.cfg.Updates.Channel),
		HTTPClient:         s.client,
	})
	if err != nil {
		return releases.FetchResult{}, err
	}
	return fetchResult, nil
}

func (s *Server) runApplyScript(request startRequest, artifactPath string) (string, error) {
	applyScript := filepath.Clean(strings.TrimSpace(s.cfg.Updates.ApplyScript))
	if !filepath.IsAbs(applyScript) {
		return "", fmt.Errorf("updates.apply_script must be an absolute path")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	cmd, err := buildApplyScriptCommand(ctx, applyScript)
	if err != nil {
		return "", err
	}
	cmd.Env = append(os.Environ(),
		"SHELLORCHESTRA_UPDATE_CHANNEL="+request.Channel,
		"SHELLORCHESTRA_UPDATE_CURRENT_VERSION="+request.CurrentVersion,
		"SHELLORCHESTRA_UPDATE_TARGET_VERSION="+request.TargetVersion,
		"SHELLORCHESTRA_UPDATE_ARTIFACT="+artifactPath,
		"SHELLORCHESTRA_UPDATE_INSTALL_METHOD="+s.cfg.Updates.InstallMethod,
	)
	output, err := cmd.CombinedOutput()
	logTail := tailString(string(output), 12000)
	if ctx.Err() != nil {
		return logTail, ctx.Err()
	}
	if err != nil {
		return logTail, err
	}
	return logTail, nil
}

func buildApplyScriptCommand(ctx context.Context, applyScript string) (*exec.Cmd, error) {
	info, err := os.Stat(applyScript)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, fmt.Errorf("updates.apply_script must be a file")
	}
	if isPowerShellApplyScript(applyScript) {
		powershell, err := exec.LookPath("powershell.exe")
		if err != nil {
			return nil, fmt.Errorf("PowerShell apply script %s requires powershell.exe in PATH: %w", applyScript, err)
		}
		return exec.CommandContext(ctx, powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", applyScript), nil
	}
	if info.Mode()&0o111 == 0 {
		return nil, fmt.Errorf("updates.apply_script must be an executable file")
	}
	return exec.CommandContext(ctx, applyScript), nil
}

func isPowerShellApplyScript(path string) bool {
	return strings.EqualFold(filepath.Ext(path), ".ps1")
}

func downloadFile(ctx context.Context, client *http.Client, rawURL string, path string, maxBytes int64) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return "", fmt.Errorf("artifact URL must be absolute https without credentials")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, maxUpdaterErrorBodyBytes))
		return "", fmt.Errorf("artifact server returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	tmp := path + ".tmp"
	file, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(file, hash), io.LimitReader(resp.Body, maxBytes+1))
	closeErr := file.Close()
	if copyErr != nil {
		_ = os.Remove(tmp)
		return "", copyErr
	}
	if closeErr != nil {
		_ = os.Remove(tmp)
		return "", closeErr
	}
	if written > maxBytes {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("artifact exceeds configured maximum size")
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func (s *Server) validInternalRequest(r *http.Request) bool {
	expected := strings.TrimSpace(s.cfg.Internal.SharedSecret)
	provided := strings.TrimSpace(r.Header.Get("X-ShellOrchestra-Internal-Secret"))
	if expected == "" || provided == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

func (s *Server) setJob(id string, status string, message string, artifactPath string, logTail string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.jobs[id]
	if !ok {
		return
	}
	job.Status = status
	job.Message = message
	if artifactPath != "" {
		job.ArtifactPath = artifactPath
	}
	if logTail != "" {
		job.LogTail = logTail
	}
}

func (s *Server) setJobTargetVersion(id string, targetVersion string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.jobs[id]
	if !ok {
		return
	}
	job.TargetVersion = targetVersion
}

func (s *Server) finishJob(id string, status string, message string, errText string, logTail string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.jobs[id]
	if !ok {
		return
	}
	job.Status = status
	job.Message = message
	job.Error = errText
	job.LogTail = logTail
	job.CompletedAt = time.Now().UTC()
}

func decodeJSON(w http.ResponseWriter, r *http.Request, out any) bool {
	if err := internaljson.DecodeStrictResponse(r.Body, maxUpdaterJSONBodyBytes, out, "updater request"); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
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

func updaterSocketPath(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "unix" || parsed.Path == "" || !filepath.IsAbs(parsed.Path) || parsed.Host != "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("updater unix listen address must use unix:///absolute/path.sock")
	}
	clean := filepath.Clean(parsed.Path)
	if clean != parsed.Path {
		return "", fmt.Errorf("updater unix socket path must be canonical")
	}
	return clean, nil
}

func artifactForInstallMethod(method string) string {
	switch strings.TrimSpace(strings.ToLower(method)) {
	case "windows_app":
		return "windows"
	default:
		return "docker"
	}
}

func newJobID() string {
	return fmt.Sprintf("update-%d", time.Now().UTC().UnixNano())
}

func safeJobID(value string) bool {
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

func tailString(value string, maxBytes int) string {
	if len(value) <= maxBytes {
		return value
	}
	return value[len(value)-maxBytes:]
}
