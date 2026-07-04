// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package httpapi

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	stdruntime "runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/google/uuid"
	"shellorchestra/backend/internal/auditlog"
	"shellorchestra/backend/internal/batchoutput"
	"shellorchestra/backend/internal/buildinfo"
	"shellorchestra/backend/internal/casigner"
	"shellorchestra/backend/internal/config"
	"shellorchestra/backend/internal/desktopapps"
	"shellorchestra/backend/internal/devicesig"
	"shellorchestra/backend/internal/domain"
	"shellorchestra/backend/internal/feedback"
	"shellorchestra/backend/internal/fileversion"
	"shellorchestra/backend/internal/httpsecurity"
	"shellorchestra/backend/internal/runtime"
	"shellorchestra/backend/internal/scripts"
	"shellorchestra/backend/internal/security"
	"shellorchestra/backend/internal/servertools"
	"shellorchestra/backend/internal/serviceinfo"
	"shellorchestra/backend/internal/sshconfig"
	"shellorchestra/backend/internal/store"
	webauthnsvc "shellorchestra/backend/internal/webauthn"
	"shellorchestra/backend/internal/worker"

	webauthnlib "github.com/go-webauthn/webauthn/webauthn"
)

type Dependencies struct {
	Config   config.AppConfig
	Store    *store.SQLiteStore
	Runtime  *runtime.SSHRuntime
	Scripts  *scripts.Catalog
	Signer   *casigner.Client
	Worker   *worker.Client
	AppPlans desktopapps.AppPlanner
	Versions *fileversion.Store
	Audit    *auditlog.Store
	Feedback *feedback.Store
}

var httpAPIRuntimeSessionID = fmt.Sprintf("%s:%d", buildinfo.ProductVersion(), time.Now().UTC().UnixNano())

type App struct {
	deps                  Dependencies
	options               Options
	mux                   *http.ServeMux
	desktopAppSvc         *desktopapps.Service
	terminalStreamTickets sync.Map
	fileUploadSessions    sync.Map
	fileManagerSendToJobs sync.Map
	vulnerabilityUploads  sync.Map
	sshTunnelsMu          sync.Mutex
	sshTunnelManager      *sshTunnelManager
	versionCheckMu        sync.Mutex
	versionCheckCache     versionCheckCache
}

type Options struct {
	TrustGatewayHeaders bool
	AuthService         bool
	Role                string
}

type principalKey struct{}
type csrfHashKey struct{}

const (
	lanAdminDeviceID             = "lan-totp-admin"
	lanAdminCredential           = "lan-totp-admin"
	userActivityHeader           = "X-ShellOrchestra-User-Activity"
	maxAPIJSONBodyBytes          = 16 << 20
	maxDebugTokenFileBytes       = 4096
	maxFeedbackScreenshotBytes   = 4 << 20
	maxStaticIndexHTMLBytes      = 4 << 20
	maxTerminalStreamTickets     = 4096
	minAdminPassphrase           = 12
	terminalStreamTicketTTL      = 60 * time.Second
	vulnerabilityUploadTicketTTL = 20 * time.Minute
)

type terminalStreamTicket struct {
	SessionID string
	DeviceID  string
	ExpiresAt time.Time
}

type vulnerabilityUploadTicket struct {
	DeviceID  string
	Label     string
	ExpiresAt time.Time
}

type terminalStreamTicketResponse struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expires_at"`
}

func NewApp(deps Dependencies) *App {
	return NewAppWithOptions(deps, Options{})
}

func NewAppWithOptions(deps Dependencies, options Options) *App {
	app := &App{deps: deps, options: options, mux: http.NewServeMux()}
	app.desktopAppSvc = app.newDesktopAppService()
	app.resetPersistedDesktopRuntimeOnServiceStart()
	app.routes()
	return app
}

func (a *App) Handler() http.Handler {
	return a.securityMiddleware(a.mux)
}

func (a *App) debugModeEnabled() bool {
	return buildinfo.DebugSupported() && a.deps.Config.Debug.Enabled
}

func (a *App) validInternalRequest(r *http.Request) bool {
	expected := strings.TrimSpace(a.deps.Config.Internal.SharedSecret)
	provided := strings.TrimSpace(r.Header.Get("X-ShellOrchestra-Internal-Secret"))
	if expected == "" || provided == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

func principalFromGatewayHeaders(r *http.Request) (*domain.Principal, bool) {
	if strings.TrimSpace(r.Header.Get("X-ShellOrchestra-Verified")) != "1" {
		return nil, false
	}
	deviceID := strings.TrimSpace(r.Header.Get("X-ShellOrchestra-Principal-Device-ID"))
	label := strings.TrimSpace(r.Header.Get("X-ShellOrchestra-Principal-Label"))
	kind := domain.DeviceKind(strings.TrimSpace(r.Header.Get("X-ShellOrchestra-Principal-Kind")))
	if deviceID == "" || label == "" || kind == "" {
		return nil, false
	}
	return &domain.Principal{DeviceID: deviceID, Label: label, Kind: kind}, true
}

func (a *App) routes() {
	a.mux.HandleFunc("/internal/service/status", serviceinfo.Handler(a.deps.Config, a.serviceRole(), a.serviceStatusDetails))
	a.mux.HandleFunc("/internal/auth/verify", a.internalVerifyRequest)
	a.mux.HandleFunc("/api/healthz", a.health)
	a.mux.HandleFunc("/api/bootstrap/state", a.bootstrapState)
	a.mux.HandleFunc("/api/auth/me", a.me)
	a.mux.HandleFunc("/api/auth/logout", a.logout)
	a.mux.HandleFunc("/api/auth/device-signing-key", a.deviceSigningKey)
	a.mux.HandleFunc("/api/auth/device-envelope-key", a.deviceEnvelopeKey)
	a.mux.HandleFunc("/api/auth/debug/login", a.debugLogin)
	a.mux.HandleFunc("/api/debug/client-events", a.debugClientEvents)
	a.mux.HandleFunc("/api/debug/feedback", a.debugFeedback)
	a.mux.HandleFunc("/api/debug/feedback/", a.debugFeedbackByID)
	a.mux.HandleFunc("/api/debug/runtime-unlock", a.debugRuntimeUnlock)
	a.mux.HandleFunc("/api/debug/payload", a.debugPayload)
	a.mux.HandleFunc("/api/auth/passkey/register/begin", a.passkeyRegisterBegin)
	a.mux.HandleFunc("/api/auth/passkey/register/finish", a.passkeyRegisterFinish)
	a.mux.HandleFunc("/api/auth/passkey/login/begin", a.passkeyLoginBegin)
	a.mux.HandleFunc("/api/auth/passkey/login/finish", a.passkeyLoginFinish)
	a.mux.HandleFunc("/api/auth/device-requests/register/begin", a.deviceRequestRegisterBegin)
	a.mux.HandleFunc("/api/auth/device-requests/register/finish", a.deviceRequestRegisterFinish)
	a.mux.HandleFunc("/api/auth/device-requests/", a.deviceRequestAuthByID)
	a.mux.HandleFunc("/api/auth/lan/setup/begin", a.lanSetupBegin)
	a.mux.HandleFunc("/api/auth/lan/setup/finish", a.lanSetupFinish)
	a.mux.HandleFunc("/api/auth/lan/login", a.lanLogin)
	a.mux.HandleFunc("/api/devices", a.clientDevices)
	a.mux.HandleFunc("/api/devices/", a.clientDeviceByID)
	a.mux.HandleFunc("/api/device-requests", a.deviceRequests)
	a.mux.HandleFunc("/api/device-requests/", a.deviceRequestByID)
	a.mux.HandleFunc("/api/runtime/lock-state", a.lockState)
	a.mux.HandleFunc("/api/runtime/lock", a.lockRuntime)
	a.mux.HandleFunc("/api/runtime/unlock", a.unlockRuntime)
	a.mux.HandleFunc("/api/keys/status", a.keysStatus)
	a.mux.HandleFunc("/api/keys/create", a.keysCreate)
	a.mux.HandleFunc("/api/keys/change-approvals/", a.keyChangeApprovalByID)
	a.mux.HandleFunc("/api/keys/change-approvals", a.keyChangeApprovals)
	a.mux.HandleFunc("/api/keys/device-share", a.keysDeviceShare)
	a.mux.HandleFunc("/api/keys/device-shares", a.keysDeviceShares)
	a.mux.HandleFunc("/api/keys/current-device-share", a.keysCurrentDeviceShare)
	a.mux.HandleFunc("/api/settings/ui", a.uiSettings)
	a.mux.HandleFunc("/api/system/version-check", a.systemVersionCheck)
	a.mux.HandleFunc("/api/system/upgrade", a.systemUpgrade)
	a.mux.HandleFunc("/api/system/upgrade/jobs/", a.systemUpgradeJob)
	a.mux.HandleFunc("/api/settings/security/ssh", a.sshSecuritySettings)
	a.mux.HandleFunc("/api/settings/wallpaper/custom", a.customWallpaper)
	a.mux.HandleFunc("/api/desktop-wallpapers", a.desktopWallpapers)
	a.mux.HandleFunc("/api/desktop-wallpapers/", a.desktopWallpaperByID)
	a.mux.HandleFunc("/api/ssh-user-keys", a.sshUserKeys)
	a.mux.HandleFunc("/api/servers", a.servers)
	a.mux.HandleFunc("/api/global-apps/batch-scripts", a.batchScripts)
	a.mux.HandleFunc("/api/global-apps/batch-scripts/", a.batchScriptByID)
	a.mux.HandleFunc("/api/global-apps/backup-manager/buckets", a.backupBuckets)
	a.mux.HandleFunc("/api/global-apps/backup-manager/buckets/", a.backupBucketByID)
	a.mux.HandleFunc("/api/global-apps/backup-manager/tasks", a.backupTasks)
	a.mux.HandleFunc("/api/global-apps/backup-manager/tasks/", a.backupTaskByID)
	a.mux.HandleFunc("/api/global-apps/backup-manager/probe-bucket", a.backupProbeBucket)
	a.mux.HandleFunc("/api/global-apps/backup-manager/source-scan", a.backupSourceScan)
	a.mux.HandleFunc("/api/global-apps/backup-manager/compression-probe", a.backupCompressionProbe)
	a.mux.HandleFunc("/api/global-apps/ssh-tunnels", a.sshTunnels)
	a.mux.HandleFunc("/api/global-apps/ssh-tunnels/", a.sshTunnelByID)
	a.mux.HandleFunc("/api/servers/import-ssh-config/scan", a.scanSSHConfigSources)
	a.mux.HandleFunc("/api/servers/import-ssh-config", a.importSSHConfig)
	a.mux.HandleFunc("/api/servers/test-tcp", a.serverTestTCP)
	a.mux.HandleFunc("/api/servers/test-auth", a.serverTestAuth)
	a.mux.HandleFunc("/api/servers/detect-facts", a.serverDetectFacts)
	a.mux.HandleFunc("/api/servers/actions/packages-upgrade", a.serverBatchPackagesUpgrade)
	a.mux.HandleFunc("/api/servers/actions/reboot", a.serverBatchReboot)
	a.mux.HandleFunc("/api/servers/", a.serverByID)
	a.mux.HandleFunc("/api/vulnerability-scan/settings", a.vulnerabilityScanSettings)
	a.mux.HandleFunc("/api/vulnerability-scan/status", a.vulnerabilityScanStatus)
	a.mux.HandleFunc("/api/vulnerability-scan/update", a.vulnerabilityScanUpdate)
	a.mux.HandleFunc("/api/vulnerability-scan/client-upload", a.vulnerabilityScanClientUploadBegin)
	a.mux.HandleFunc("/api/vulnerability-scan/client-upload/", a.vulnerabilityScanClientUploadByToken)
	a.mux.HandleFunc("/api/vulnerability-scan/scan", a.vulnerabilityScanRun)
	a.mux.HandleFunc("/api/desktops/", a.virtualDesktopByServerID)
	a.mux.HandleFunc("/api/desktop-apps", a.desktopApps)
	a.mux.HandleFunc("/api/desktop-apps/", a.desktopAppByID)
	a.mux.HandleFunc("/api/safe-content/document", a.safeContentDocument)
	a.mux.HandleFunc("/api/safe-content/spreadsheet/workbook", a.safeContentSpreadsheetWorkbook)
	a.mux.HandleFunc("/api/safe-content/spreadsheet/rows", a.safeContentSpreadsheetRows)
	a.mux.HandleFunc("/api/file-manager/preview-stream", a.fileManagerPreviewStream)
	a.mux.HandleFunc("/api/file-manager/editor-stream", a.fileManagerEditorStream)
	a.mux.HandleFunc("/api/file-manager/archive-list", a.fileManagerArchiveList)
	a.mux.HandleFunc("/api/file-manager/download", a.fileManagerDownload)
	a.mux.HandleFunc("/api/file-manager/send-to", a.fileManagerSendTo)
	a.mux.HandleFunc("/api/file-manager/send-to/", a.fileManagerSendToByID)
	a.mux.HandleFunc("/api/file-manager/uploads", a.fileManagerUploads)
	a.mux.HandleFunc("/api/file-manager/uploads/", a.fileManagerUploadByID)
	a.mux.HandleFunc("/api/logs/stream", a.logsStream)
	a.mux.HandleFunc("/api/file-versions", a.fileVersions)
	a.mux.HandleFunc("/api/file-versions/", a.fileVersionByID)
	a.mux.HandleFunc("/api/audit/head", a.auditHead)
	a.mux.HandleFunc("/api/audit/verify", a.auditVerify)
	a.mux.HandleFunc("/api/terminals", a.terminals)
	a.mux.HandleFunc("/api/terminals/", a.terminalByID)
	a.mux.HandleFunc("/api/status", a.statuses)
	a.mux.HandleFunc("/api/server-tools/backend", a.backendTools)
	a.mux.HandleFunc("/api/server-tools/backend/restart", a.backendToolsRestart)
	a.mux.HandleFunc("/api/scripts", a.scriptCatalog)
	a.mux.HandleFunc("/api/script-runs/", a.scriptRunStatus)
	a.mux.HandleFunc("/api/scripts/", a.scriptRun)
	a.mux.Handle("/", staticSPA(a.deps.Config.App.PublicDir))
}

func (a *App) serviceRole() string {
	if strings.TrimSpace(a.options.Role) != "" {
		return strings.TrimSpace(a.options.Role)
	}
	if a.options.AuthService {
		return "auth-service"
	}
	if a.options.TrustGatewayHeaders {
		return "api-backend"
	}
	return "all"
}

func (a *App) resetPersistedDesktopRuntimeOnServiceStart() {
	role := a.serviceRole()
	if role != "api" && role != "api-backend" && role != "all" {
		return
	}
	if a.deps.Store == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := a.deps.Store.DeleteAllTerminalSessions(ctx); err != nil {
		log.Printf("failed to reset persisted terminal sessions after %s startup: %v", role, err)
	}
	if count, err := a.deps.Store.DeleteAllVirtualDesktopWindows(ctx); err != nil {
		log.Printf("failed to reset virtual desktop windows after %s startup: %v", role, err)
	} else if count > 0 {
		log.Printf("removed %d virtual desktop windows after %s startup reset", count, role)
	}
}

func (a *App) serviceStatusDetails(ctx context.Context) map[string]any {
	details := map[string]any{}
	if a.deps.Worker != nil {
		state, err := a.deps.Worker.LockState(ctx)
		if err != nil {
			details["worker_lock_state_error"] = err.Error()
		} else {
			details["server_access_locked"] = state.Locked
			details["server_access_initialized"] = state.Initialized
		}
	}
	return details
}

func (a *App) securityMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		httpsecurity.ApplyBrowserSecurityHeaders(w.Header())
		if err := httpsecurity.ValidateRequestPath(r); err != nil {
			writeError(w, http.StatusBadRequest, "Request path is not normalized.")
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/api/") || publicAPIPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		if a.options.TrustGatewayHeaders && !cookieAuthenticatedAPIRequest(r) {
			principal, ok := principalFromGatewayHeaders(r)
			if !ok {
				writeError(w, http.StatusUnauthorized, "Verified gateway identity is required.")
				return
			}
			ctx := context.WithValue(r.Context(), principalKey{}, principal)
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}
		accessCookie, err := r.Cookie(a.deps.Config.Security.AccessCookie)
		if err != nil || strings.TrimSpace(accessCookie.Value) == "" {
			writeError(w, http.StatusUnauthorized, "Authentication required.")
			return
		}
		principal, csrfHash, err := a.deps.Store.Authenticate(r.Context(), accessCookie.Value)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "Authentication required.")
			return
		}
		csrfToken := ""
		if isMutating(r.Method) {
			csrfCookie, err := r.Cookie(a.deps.Config.Security.CSRFCookie)
			if err != nil || store.HashToken(csrfCookie.Value) != csrfHash || r.Header.Get(a.deps.Config.Security.CSRFHeader) != csrfCookie.Value {
				writeError(w, http.StatusForbidden, "CSRF validation failed.")
				return
			}
			csrfToken = csrfCookie.Value
		} else if csrfCookie, err := r.Cookie(a.deps.Config.Security.CSRFCookie); err == nil {
			csrfToken = csrfCookie.Value
		}
		a.refreshAuthenticatedSessionIfUserActive(w, r, accessCookie.Value, csrfToken)
		ctx := context.WithValue(r.Context(), principalKey{}, principal)
		ctx = context.WithValue(ctx, csrfHashKey{}, csrfHash)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func cookieAuthenticatedAPIRequest(r *http.Request) bool {
	return r.Method == http.MethodGet && (r.URL.Path == "/api/settings/wallpaper/custom" || strings.HasPrefix(r.URL.Path, "/api/desktop-wallpapers/") || isTerminalStreamPath(r.URL.Path))
}

func isTerminalStreamPath(path string) bool {
	if !strings.HasPrefix(path, "/api/terminals/") {
		return false
	}
	return strings.HasSuffix(path, "/stream")
}

func publicAPIPath(path string) bool {
	if path == "/api/healthz" || path == "/api/bootstrap/state" {
		return true
	}
	if isTerminalStreamPath(path) {
		return true
	}
	if path == "/api/auth/debug/login" || path == "/api/debug/payload" || path == "/api/auth/device-signing-key" || path == "/api/auth/device-envelope-key" {
		return true
	}
	if strings.HasPrefix(path, "/api/vulnerability-scan/client-upload/") {
		return true
	}
	return strings.HasPrefix(path, "/api/auth/passkey/") || strings.HasPrefix(path, "/api/auth/lan/") || strings.HasPrefix(path, "/api/auth/device-requests/")
}

func isMutating(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	default:
		return false
	}
}

func (a *App) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "shellorchestra"})
}

func (a *App) bootstrapState(w http.ResponseWriter, r *http.Request) {
	count, err := a.deps.Store.CountApprovedDevices(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	window, err := a.deps.Store.BootstrapWindow(r.Context(), time.Duration(a.deps.Config.Security.BootstrapTimeoutMinutes)*time.Minute)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	state := "open"
	if count > 0 {
		state = "complete"
	} else {
		state = window.State
	}
	authMode, passkeyOrigin := a.authModeSnapshot(r.Context())
	expiresAt := any(window.ExpiresAt)
	qrURL := any(nil)
	if state == "complete" {
		expiresAt = nil
	} else if state == "open" {
		qrURL = nullableString(a.requestOrigin(r) + "/setup/phone#token=" + window.Token)
	}
	debugFeedbackSubmitURL := strings.TrimSpace(a.deps.Config.Feedback.SubmitURL)
	if debugFeedbackSubmitURL == "" {
		debugFeedbackSubmitURL = strings.TrimSpace(a.deps.Config.Feedback.RelayURL)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"state":                         state,
		"app_version":                   buildinfo.ProductVersion(),
		"app_edition":                   buildinfo.ProductEdition(),
		"runtime_session_id":            httpAPIRuntimeSessionID,
		"auth_mode":                     authMode,
		"passkey_origin":                nullableString(passkeyOrigin),
		"current_origin":                a.requestOrigin(r),
		"timeout_minutes":               a.deps.Config.Security.BootstrapTimeoutMinutes,
		"qr_url":                        qrURL,
		"expires_at":                    expiresAt,
		"debug_supported":               buildinfo.DebugSupported(),
		"debug_enabled":                 a.debugModeEnabled(),
		"windows_desktop_server":        stdruntime.GOOS == "windows",
		"local_protected_key_available": localProtectedKeyRuntimeAvailable(),
		"debug_feedback": map[string]any{
			"submit_url":            nullableString(debugFeedbackSubmitURL),
			"project":               nullableString(a.deps.Config.Feedback.Project),
			"local_storage_enabled": a.deps.Config.Feedback.AllowLocalStorage,
		},
	})
}

func (a *App) debugLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !a.requireDebugEndpointAccess(w, r, "Debug sign-in") {
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if !a.validDebugToken(body.Token) {
		writeError(w, http.StatusForbidden, "Debug sign-in token is invalid.")
		return
	}
	device, err := a.ensureDebugTrustedDevice(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := a.issueSession(w, r, device.ID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	principal := domain.Principal{DeviceID: device.ID, Label: device.Label, Kind: device.Kind}
	writeJSON(w, http.StatusOK, map[string]any{
		"principal": a.principalResponse(r.Context(), &principal),
	})
}

func (a *App) debugClientEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !a.requireDebugEndpointAccess(w, r, "Debug browser event logging") {
		return
	}
	principal := r.Context().Value(principalKey{}).(*domain.Principal)
	var body struct {
		Source string `json:"source"`
		Events []struct {
			At      string         `json:"at"`
			Step    string         `json:"step"`
			Message string         `json:"message"`
			Details map[string]any `json:"details"`
		} `json:"events"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	source := truncateDebugString(body.Source, 120)
	if source == "" {
		source = "browser"
	}
	if len(body.Events) > 50 {
		writeError(w, http.StatusBadRequest, "Too many debug events in one request.")
		return
	}
	for _, event := range body.Events {
		details := sanitizeClientDebugDetails(event.Details)
		detailsJSON, _ := json.Marshal(details)
		log.Printf(
			"ShellOrchestra client-debug source=%q device_id=%q label=%q kind=%q at=%q step=%q message=%q details=%s",
			source,
			principal.DeviceID,
			principal.Label,
			principal.Kind,
			truncateDebugString(event.At, 80),
			truncateDebugString(event.Step, 160),
			truncateDebugString(event.Message, 800),
			string(detailsJSON),
		)
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"stored": len(body.Events)})
}

func (a *App) debugFeedback(w http.ResponseWriter, r *http.Request) {
	if !a.requireDebugEndpointAccess(w, r, "Debug feedback") {
		return
	}
	switch r.Method {
	case http.MethodGet:
		if !a.deps.Config.Feedback.AllowLocalStorage {
			writeError(w, http.StatusGone, "ShellOrchestra stores debug feedback in the shared tickets service. Open the Tickets service to review existing feedback.")
			return
		}
		if a.deps.Feedback == nil {
			writeError(w, http.StatusServiceUnavailable, "Debug feedback storage is not configured.")
			return
		}
		status := strings.TrimSpace(r.URL.Query().Get("status"))
		if status == "" {
			status = "open"
		}
		tickets, err := a.deps.Feedback.List(r.Context(), status, 80)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"tickets": tickets})
	case http.MethodPost:
		if a.deps.Config.Feedback.AllowLocalStorage {
			if a.deps.Feedback == nil {
				writeError(w, http.StatusServiceUnavailable, "Debug feedback storage is not configured.")
				return
			}
			a.createDebugFeedback(w, r)
			return
		}
		a.relayDebugFeedback(w, r)
	default:
		methodNotAllowed(w)
	}
}

type debugFeedbackSubmitRequest struct {
	Message           string `json:"message"`
	PageURL           string `json:"page_url"`
	UserAgent         string `json:"user_agent"`
	ScreenshotPNGB64  string `json:"screenshot_png_b64"`
	ScreenshotDataURL string `json:"screenshot_data_url"`
}

type debugFeedbackSubmission struct {
	Principal     *domain.Principal
	Message       string
	PageURL       string
	UserAgent     string
	ScreenshotPNG []byte
}

func (a *App) parseDebugFeedbackSubmission(w http.ResponseWriter, r *http.Request) (*debugFeedbackSubmission, bool) {
	principal, _ := r.Context().Value(principalKey{}).(*domain.Principal)
	if principal == nil {
		principal = &domain.Principal{DeviceID: "debug-endpoint", Label: "Debug endpoint", Kind: domain.DeviceKindDesktop}
	}
	var body debugFeedbackSubmitRequest
	if !decodeJSON(w, r, &body) {
		return nil, false
	}
	message := truncateDebugString(body.Message, 4000)
	if message == "" {
		writeError(w, http.StatusBadRequest, "Describe what happened before submitting feedback.")
		return nil, false
	}
	screenshotB64 := strings.TrimSpace(body.ScreenshotPNGB64)
	if screenshotB64 == "" {
		screenshotB64 = screenshotBase64FromDataURL(body.ScreenshotDataURL)
	}
	if screenshotB64 == "" {
		writeError(w, http.StatusBadRequest, "A screenshot is required for debug feedback.")
		return nil, false
	}
	screenshot, err := base64.StdEncoding.DecodeString(screenshotB64)
	if err != nil {
		if decoded, rawErr := base64.RawStdEncoding.DecodeString(screenshotB64); rawErr == nil {
			screenshot = decoded
		} else {
			writeError(w, http.StatusBadRequest, "Screenshot data is not valid base64.")
			return nil, false
		}
	}
	if len(screenshot) > maxFeedbackScreenshotBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "Screenshot is too large for debug feedback.")
		return nil, false
	}
	if len(screenshot) < 8 || !bytes.Equal(screenshot[:8], []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}) {
		writeError(w, http.StatusBadRequest, "Debug feedback accepts PNG screenshots only.")
		return nil, false
	}
	return &debugFeedbackSubmission{
		Principal:     principal,
		Message:       message,
		PageURL:       truncateDebugString(body.PageURL, 2048),
		UserAgent:     truncateDebugString(body.UserAgent, 512),
		ScreenshotPNG: screenshot,
	}, true
}

func (a *App) createDebugFeedback(w http.ResponseWriter, r *http.Request) {
	submission, ok := a.parseDebugFeedbackSubmission(w, r)
	if !ok {
		return
	}
	ticket, err := a.deps.Feedback.Create(r.Context(), feedback.TicketInput{
		DeviceID:              submission.Principal.DeviceID,
		DeviceLabel:           submission.Principal.Label,
		DeviceKind:            string(submission.Principal.Kind),
		PageURL:               submission.PageURL,
		UserAgent:             submission.UserAgent,
		Message:               submission.Message,
		ScreenshotContentType: "image/png",
		ScreenshotPNG:         submission.ScreenshotPNG,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, ticket)
}

func (a *App) relayDebugFeedback(w http.ResponseWriter, r *http.Request) {
	if strings.TrimSpace(a.deps.Config.Feedback.Project) == "" {
		writeError(w, http.StatusServiceUnavailable, "Debug feedback is not configured for the shared tickets service. No ticket was saved.")
		return
	}
	relayURL := strings.TrimSpace(a.deps.Config.Feedback.RelayURL)
	if relayURL == "" {
		relayURL = strings.TrimSpace(a.deps.Config.Feedback.SubmitURL)
	}
	if relayURL == "" {
		writeError(w, http.StatusServiceUnavailable, "Debug feedback is not configured for the shared tickets service. No ticket was saved.")
		return
	}
	submission, ok := a.parseDebugFeedbackSubmission(w, r)
	if !ok {
		return
	}
	body := map[string]any{
		"project":             strings.TrimSpace(a.deps.Config.Feedback.Project),
		"message":             submission.Message,
		"page_url":            submission.PageURL,
		"user_agent":          submission.UserAgent,
		"screenshot_data_url": "data:image/png;base64," + base64.StdEncoding.EncodeToString(submission.ScreenshotPNG),
		"metadata": map[string]string{
			"source":       "shellorchestra.debug_feedback",
			"device_id":    submission.Principal.DeviceID,
			"device_label": submission.Principal.Label,
			"device_kind":  string(submission.Principal.Kind),
		},
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, relayURL, bytes.NewReader(encoded))
	if err != nil {
		writeError(w, http.StatusBadGateway, "Shared ticket service URL is invalid.")
		return
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		writeError(w, http.StatusBadGateway, "ShellOrchestra could not reach the shared tickets service: "+err.Error())
		return
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		writeError(w, http.StatusBadGateway, "ShellOrchestra could not read the shared tickets service response.")
		return
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var errorPayload struct {
			Error string `json:"error"`
		}
		message := strings.TrimSpace(response.Status)
		if json.Unmarshal(responseBody, &errorPayload) == nil && strings.TrimSpace(errorPayload.Error) != "" {
			message = strings.TrimSpace(errorPayload.Error)
		}
		writeError(w, http.StatusBadGateway, "Shared tickets service rejected debug feedback: "+message)
		return
	}
	var payload any
	if len(responseBody) == 0 || json.Unmarshal(responseBody, &payload) != nil {
		writeJSON(w, http.StatusCreated, map[string]any{"submitted": true})
		return
	}
	writeJSON(w, http.StatusCreated, payload)
}

func (a *App) debugFeedbackByID(w http.ResponseWriter, r *http.Request) {
	if !a.requireDebugEndpointAccess(w, r, "Debug feedback") {
		return
	}
	if !a.deps.Config.Feedback.AllowLocalStorage {
		writeError(w, http.StatusGone, "Local debug feedback storage is disabled. Use the shared tickets service.")
		return
	}
	if a.deps.Feedback == nil {
		writeError(w, http.StatusServiceUnavailable, "Debug feedback storage is not configured.")
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/api/debug/feedback/")
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	if len(parts) == 0 || strings.TrimSpace(parts[0]) == "" {
		writeError(w, http.StatusBadRequest, "Feedback ticket id is required.")
		return
	}
	id := strings.TrimSpace(parts[0])
	if len(parts) == 2 && parts[1] == "screenshot" {
		if r.Method != http.MethodGet {
			methodNotAllowed(w)
			return
		}
		a.debugFeedbackScreenshot(w, r, id)
		return
	}
	if len(parts) != 1 {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case http.MethodPatch:
		a.updateDebugFeedback(w, r, id)
	case http.MethodDelete:
		writeError(w, http.StatusMethodNotAllowed, "Debug feedback tickets are retained for audit. Change the ticket status instead of deleting it.")
	default:
		methodNotAllowed(w)
	}
}

func (a *App) updateDebugFeedback(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Message          *string `json:"message"`
		Status           *string `json:"status"`
		ResolutionReport *string `json:"resolution_report"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	ticket, err := a.deps.Feedback.Update(r.Context(), id, body.Message, body.Status, body.ResolutionReport)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "Feedback ticket was not found.")
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, ticket)
}

func (a *App) debugFeedbackScreenshot(w http.ResponseWriter, r *http.Request, id string) {
	ticket, err := a.deps.Feedback.Get(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "Feedback ticket was not found.")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", ticket.ScreenshotContentType)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(ticket.ScreenshotPNG)
}

func screenshotBase64FromDataURL(value string) string {
	value = strings.TrimSpace(value)
	const prefix = "data:image/png;base64,"
	if strings.HasPrefix(strings.ToLower(value), prefix) {
		return strings.TrimSpace(value[len(prefix):])
	}
	return ""
}

func (a *App) debugRuntimeUnlock(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !a.requireDebugEndpointAccess(w, r, "Debug server-access unlock") {
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	token := strings.TrimSpace(body.Token)
	if !a.validDebugToken(token) {
		writeError(w, http.StatusForbidden, "Debug sign-in token is invalid.")
		return
	}
	authority, err := a.deps.Store.GetAuthority(r.Context())
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusConflict, "Server access keys are not initialized yet.")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if authority.AuthMode != store.AuthModePasskey {
		writeError(w, http.StatusBadRequest, "Debug server-access unlock is available only for passkey-mode split keys.")
		return
	}
	share, err := a.deps.Store.GetDebugDeviceKeyShare(r.Context(), authority.ActiveEpoch)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusConflict, "Debug server-access key share is not available yet. Unlock once from a trusted approval device so debug mode can capture a protected debug share for later tests.")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	deviceShareB64, err := decryptDebugDeviceShare(token, share.EncryptedDeviceShareB64)
	if err != nil {
		writeError(w, http.StatusForbidden, "Debug server-access key share could not be opened with the current debug token.")
		return
	}
	lockState, err := a.unlockRuntimeWithDeviceShare(r.Context(), authority, deviceShareB64)
	if err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}
	a.persistDebugDeviceShareIfEnabled(r.Context(), authority.ActiveEpoch, deviceShareB64)
	if a.deps.Config.Runtime.AutoConnectAfterUnlock {
		go a.connectAllServers(context.Background())
	}
	if a.debugModeEnabled() {
		log.Printf("ShellOrchestra key-share-debug action=%q device_id=%q epoch=%d message=%q", "debug-runtime-unlock", debugDeviceID, authority.ActiveEpoch, "debug token unlocked server access")
	}
	writeJSON(w, http.StatusOK, lockState)
}

func (a *App) debugPayload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	if !a.debugModeEnabled() {
		http.NotFound(w, r)
		return
	}
	if !a.validDebugToken(r.Header.Get("X-ShellOrchestra-Debug-Token")) {
		writeError(w, http.StatusForbidden, "Debug payload token is invalid.")
		return
	}
	size := int64(20 * 1024 * 1024)
	if raw := strings.TrimSpace(r.URL.Query().Get("size")); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < 0 {
			writeError(w, http.StatusBadRequest, "Debug payload size must be a positive integer.")
			return
		}
		size = parsed
	}
	if size > 128*1024*1024 {
		writeError(w, http.StatusBadRequest, "Debug payload is limited to 128 MiB.")
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	chunk := deterministicDebugPayloadChunk()
	for written := int64(0); written < size; {
		toWrite := int64(len(chunk))
		if remaining := size - written; remaining < toWrite {
			toWrite = remaining
		}
		n, err := w.Write(chunk[:toWrite])
		written += int64(n)
		if err != nil {
			return
		}
	}
}

func deterministicDebugPayloadChunk() []byte {
	chunk := make([]byte, 64*1024)
	for i := range chunk {
		chunk[i] = byte((i*17 + 43) % 251)
	}
	return chunk
}

func (a *App) passkeyRegisterBegin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var body struct {
		Label                string            `json:"label"`
		Kind                 domain.DeviceKind `json:"kind"`
		BootstrapToken       string            `json:"bootstrap_token"`
		EnvelopePublicKeyB64 string            `json:"envelope_public_key_spki_b64"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	label := strings.TrimSpace(body.Label)
	if label == "" {
		label = "ShellOrchestra device"
	}
	kind := normalizeDeviceKind(body.Kind)
	if err := validateEnvelopePublicKey(body.EnvelopePublicKeyB64); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	count, err := a.deps.Store.CountApprovedDevices(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if count == 0 {
		window, ok, err := a.deps.Store.ValidateBootstrapToken(r.Context(), body.BootstrapToken, time.Duration(a.deps.Config.Security.BootstrapTimeoutMinutes)*time.Minute)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if window.State != "open" {
			writeError(w, http.StatusForbidden, "FIRST PHONE SETUP IS CLOSED. Ask the ShellOrchestra administrator to reset first-phone setup, then scan the new QR code.")
			return
		}
		if !ok {
			writeError(w, http.StatusForbidden, "THIS QR CODE LINK IS OLD OR INVALID. Scan the current QR code from the computer showing ShellOrchestra.")
			return
		}
	} else {
		writeError(w, http.StatusForbidden, "New devices must request authorization from the sign-in page. Open ShellOrchestra on the new device, choose Request authorization, then approve the matching code on the first approved phone.")
		return
	}
	webAuthn, err := a.webAuthnForPasskeyRequest(r, count == 0)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	deviceID, err := randomToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	user := webauthnsvc.User{ID: []byte(deviceID), Name: label, DisplayName: label}
	options, session, err := webAuthn.BeginRegistration(user, registrationAuthenticatorPolicy(kind))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	session.Expires = time.Now().UTC().Add(10 * time.Minute)
	sessionJSON, err := json.Marshal(session)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	ceremonyID, err := randomToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := a.deps.Store.SaveWebAuthnChallenge(r.Context(), store.WebAuthnChallenge{
		ID:             ceremonyID,
		Ceremony:       "registration",
		DeviceID:       deviceID,
		Label:          label,
		Kind:           kind,
		EnvelopeKeyB64: strings.TrimSpace(body.EnvelopePublicKeyB64),
		SessionJSON:    string(sessionJSON),
		ExpiresAt:      session.Expires,
	}); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ceremony_id": ceremonyID, "options": options, "expires_at": session.Expires})
}

func (a *App) passkeyRegisterFinish(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	ceremonyID := strings.TrimSpace(r.URL.Query().Get("ceremony_id"))
	if ceremonyID == "" {
		writeError(w, http.StatusBadRequest, "ceremony_id is required.")
		return
	}
	challenge, err := a.deps.Store.ConsumeWebAuthnChallenge(r.Context(), ceremonyID, "registration")
	if err != nil {
		writeStoreError(w, err)
		return
	}
	var session webauthnlib.SessionData
	if err := json.Unmarshal([]byte(challenge.SessionJSON), &session); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	count, err := a.deps.Store.CountApprovedDevices(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	webAuthn, err := a.webAuthnForPasskeyRequest(r, count == 0)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	user := webauthnsvc.User{ID: []byte(challenge.DeviceID), Name: challenge.Label, DisplayName: challenge.Label}
	credential, err := webAuthn.FinishRegistration(user, session, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	credentialJSON, err := webauthnsvc.EncodeCredential(*credential)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	now := time.Now().UTC()
	var deviceShareB64 any
	var publicKey any
	if count == 0 {
		if err := a.deps.Store.SaveAuthSettings(r.Context(), store.AuthSettings{Mode: store.AuthModePasskey, PasskeyOrigin: a.requestOrigin(r)}); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	device := store.TrustedDevice{
		ID:             challenge.DeviceID,
		Label:          challenge.Label,
		Kind:           challenge.Kind,
		ApprovedAt:     &now,
		CredentialID:   credentialIDKey(credential.ID),
		PublicKeyB64:   b64Raw(credential.PublicKey),
		EnvelopeKeyB64: strings.TrimSpace(challenge.EnvelopeKeyB64),
		UserHandleB64:  b64Raw([]byte(challenge.DeviceID)),
		CredentialJSON: credentialJSON,
		SignerEpoch:    0,
	}
	if err := a.deps.Store.SaveTrustedDevice(r.Context(), device); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	principal := domain.Principal{DeviceID: device.ID, Label: device.Label, Kind: device.Kind}
	if err := a.issueSession(w, r, principal.DeviceID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"principal":        a.principalResponse(r.Context(), &principal),
		"credential_id":    device.CredentialID,
		"device_share_b64": deviceShareB64,
		"public_key":       publicKey,
	})
}

func (a *App) passkeyLoginBegin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var body struct {
		DeviceID     string `json:"device_id"`
		CredentialID string `json:"credential_id"`
	}
	if !decodeOptionalJSON(w, r, &body, 8192, "Invalid passkey login request body.") {
		return
	}
	if a.debugModeEnabled() {
		log.Printf(
			"ShellOrchestra passkey-debug action=%q has_device_hint=%t has_credential_hint=%t",
			"login-begin",
			strings.TrimSpace(body.DeviceID) != "",
			strings.TrimSpace(body.CredentialID) != "",
		)
	}
	webAuthn, err := a.webAuthnForPasskeyRequest(r, false)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	credentialIDs, err := a.passkeyCredentialIDsForLoginHint(r.Context(), body.DeviceID, body.CredentialID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusBadRequest, "This browser has an outdated local passkey reference. Request authorization for this device again, or sign in from a device that was authorized after the latest update.")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	options, session, err := webAuthn.BeginLoginAllowed(credentialIDs)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	session.Expires = time.Now().UTC().Add(10 * time.Minute)
	sessionJSON, err := json.Marshal(session)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	ceremonyID, err := randomToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := a.deps.Store.SaveWebAuthnChallenge(r.Context(), store.WebAuthnChallenge{
		ID:          ceremonyID,
		Ceremony:    "login",
		SessionJSON: string(sessionJSON),
		ExpiresAt:   session.Expires,
	}); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ceremony_id": ceremonyID, "options": options, "expires_at": session.Expires})
}

func (a *App) passkeyLoginFinish(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	ceremonyID := strings.TrimSpace(r.URL.Query().Get("ceremony_id"))
	if ceremonyID == "" {
		writeError(w, http.StatusBadRequest, "ceremony_id is required.")
		return
	}
	challenge, err := a.deps.Store.ConsumeWebAuthnChallenge(r.Context(), ceremonyID, "login")
	if err != nil {
		writeStoreError(w, err)
		return
	}
	var session webauthnlib.SessionData
	if err := json.Unmarshal([]byte(challenge.SessionJSON), &session); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	webAuthn, err := a.webAuthnForPasskeyRequest(r, false)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var loginDevice store.TrustedDevice
	user, credential, err := webAuthn.FinishLogin(func(rawID []byte, userHandle []byte) (webauthnlib.User, error) {
		device, err := a.lookupDiscoverableDevice(r.Context(), rawID, userHandle)
		if err != nil {
			return nil, err
		}
		loginDevice = device
		storedCredential, err := webauthnsvc.DecodeCredential(device.CredentialJSON)
		if err != nil {
			return nil, err
		}
		userID := []byte(device.ID)
		if device.UserHandleB64 != "" {
			decoded, err := base64.RawURLEncoding.DecodeString(device.UserHandleB64)
			if err != nil {
				return nil, err
			}
			userID = decoded
		}
		if len(userHandle) > 0 && string(userHandle) != string(userID) {
			return nil, store.ErrNotFound
		}
		return webauthnsvc.User{
			ID:          userID,
			Name:        device.Label,
			DisplayName: device.Label,
			Credentials: []webauthnlib.Credential{storedCredential},
		}, nil
	}, session, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	credentialJSON, err := webauthnsvc.EncodeCredential(*credential)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	device := loginDevice
	if device.ID == "" {
		device, err = a.lookupDiscoverableDevice(r.Context(), credential.ID, user.ID)
		if err != nil {
			writeStoreError(w, err)
			return
		}
	}
	if err := a.deps.Store.UpdateTrustedDeviceCredential(r.Context(), device.ID, credentialJSON); err != nil {
		writeStoreError(w, err)
		return
	}
	principal := domain.Principal{DeviceID: device.ID, Label: user.DisplayName, Kind: device.Kind}
	if err := a.issueSession(w, r, principal.DeviceID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"principal":     a.principalResponse(r.Context(), &principal),
		"credential_id": credentialIDKey(credential.ID),
	})
}

func (a *App) deviceRequestRegisterBegin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var body struct {
		Label                    string            `json:"label"`
		Kind                     domain.DeviceKind `json:"kind"`
		EnvelopePublicKeySPKIB64 string            `json:"envelope_public_key_spki_b64"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if err := validateEnvelopePublicKey(body.EnvelopePublicKeySPKIB64); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	count, err := a.deps.Store.CountApprovedDevices(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if count == 0 {
		writeError(w, http.StatusConflict, "Initial setup is not complete yet. Register the first approved device before requesting authorization for another device.")
		return
	}
	if strings.TrimSpace(body.EnvelopePublicKeySPKIB64) == "" {
		writeError(w, http.StatusBadRequest, "Device encryption public key is required.")
		return
	}
	webAuthn, err := a.webAuthnForPasskeyRequest(r, false)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	label := strings.TrimSpace(body.Label)
	if label == "" {
		label = "New ShellOrchestra device"
	}
	kind := normalizeDeviceKind(body.Kind)
	deviceID, err := randomToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	user := webauthnsvc.User{ID: []byte(deviceID), Name: label, DisplayName: label}
	options, session, err := webAuthn.BeginRegistration(user, registrationAuthenticatorPolicy(kind))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	session.Expires = time.Now().UTC().Add(10 * time.Minute)
	sessionJSON, err := json.Marshal(session)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	ceremonyID, err := randomToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := a.deps.Store.SaveWebAuthnChallenge(r.Context(), store.WebAuthnChallenge{
		ID:             ceremonyID,
		Ceremony:       "device_request_registration",
		DeviceID:       deviceID,
		Label:          label,
		Kind:           kind,
		EnvelopeKeyB64: strings.TrimSpace(body.EnvelopePublicKeySPKIB64),
		SessionJSON:    string(sessionJSON),
		ExpiresAt:      session.Expires,
	}); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ceremony_id": ceremonyID, "options": options, "expires_at": session.Expires})
}

func (a *App) deviceRequestRegisterFinish(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	ceremonyID := strings.TrimSpace(r.URL.Query().Get("ceremony_id"))
	if ceremonyID == "" {
		writeError(w, http.StatusBadRequest, "ceremony_id is required.")
		return
	}
	challenge, err := a.deps.Store.ConsumeWebAuthnChallenge(r.Context(), ceremonyID, "device_request_registration")
	if err != nil {
		writeStoreError(w, err)
		return
	}
	var session webauthnlib.SessionData
	if err := json.Unmarshal([]byte(challenge.SessionJSON), &session); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	webAuthn, err := a.webAuthnForPasskeyRequest(r, false)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	user := webauthnsvc.User{ID: []byte(challenge.DeviceID), Name: challenge.Label, DisplayName: challenge.Label}
	credential, err := webAuthn.FinishRegistration(user, session, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	credentialJSON, err := webauthnsvc.EncodeCredential(*credential)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	requestID, err := randomToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	pollToken, err := randomToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	verificationCode, err := randomVerificationCode()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	now := time.Now().UTC()
	expiresAt := now.Add(15 * time.Minute)
	if err := a.deps.Store.CreateDeviceRequest(r.Context(), store.PendingDeviceRequest{
		ID:                       requestID,
		PollTokenHash:            store.HashToken(pollToken),
		Label:                    challenge.Label,
		Kind:                     challenge.Kind,
		DeviceID:                 challenge.DeviceID,
		CredentialID:             credentialIDKey(credential.ID),
		PublicKeyB64:             b64Raw(credential.PublicKey),
		UserHandleB64:            b64Raw([]byte(challenge.DeviceID)),
		CredentialJSON:           credentialJSON,
		EnvelopePublicKeySPKIB64: challenge.EnvelopeKeyB64,
		VerificationCode:         verificationCode,
		State:                    store.DeviceRequestPending,
		CreatedAt:                now,
		ExpiresAt:                expiresAt,
	}); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"request_id":        requestID,
		"poll_token":        pollToken,
		"verification_code": verificationCode,
		"state":             store.DeviceRequestPending,
		"expires_at":        expiresAt,
	})
}

func (a *App) deviceRequestAuthByID(w http.ResponseWriter, r *http.Request) {
	remainder := strings.TrimPrefix(r.URL.Path, "/api/auth/device-requests/")
	parts := strings.Split(strings.Trim(remainder, "/"), "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] != "status" {
		http.NotFound(w, r)
		return
	}
	a.deviceRequestStatus(w, r, parts[0])
}

func (a *App) deviceRequestStatus(w http.ResponseWriter, r *http.Request, requestID string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var body struct {
		PollToken string `json:"poll_token"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	pollToken := strings.TrimSpace(body.PollToken)
	if strings.TrimSpace(requestID) == "" || pollToken == "" {
		writeError(w, http.StatusBadRequest, "request_id path parameter and poll_token body field are required.")
		return
	}
	request, err := a.deps.Store.GetDeviceRequestByPollToken(r.Context(), requestID, pollToken)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if request.State == store.DeviceRequestApproved {
		if err := a.issueSession(w, r, request.DeviceID); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"request_id":                 request.ID,
		"state":                      request.State,
		"verification_code":          request.VerificationCode,
		"encrypted_device_share_b64": nullableString(request.EncryptedDeviceShareB64),
		"device_id":                  nullableString(request.DeviceID),
		"label":                      nullableString(request.Label),
		"kind":                       nullableString(string(request.Kind)),
		"credential_id":              nullableString(request.CredentialID),
		"expires_at":                 request.ExpiresAt,
	})
}

func (a *App) clientDevices(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	principal := r.Context().Value(principalKey{}).(*domain.Principal)
	overviews, err := a.deps.Store.ListTrustedDeviceOverviews(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	authModeRaw, _ := a.authModeSnapshot(r.Context())
	authMode := store.AuthMode(authModeRaw)
	if authMode == "" || authMode == store.AuthMode("unset") {
		authMode = store.AuthModePasskey
	}
	initialized := false
	activeEpoch := 0
	if authority, err := a.deps.Store.GetAuthority(r.Context()); err == nil {
		initialized = true
		activeEpoch = authority.ActiveEpoch
		authMode = authority.AuthMode
	} else if !errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	firstDeviceID, _ := a.deps.Store.FirstApprovedDeviceID(r.Context())
	items := make([]map[string]any, 0, len(overviews))
	for _, overview := range overviews {
		items = append(items, clientDeviceResponse(overview, principal.DeviceID, firstDeviceID, initialized, authMode, activeEpoch, a.debugModeEnabled()))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"devices":                   items,
		"current_device_id":         principal.DeviceID,
		"key_authority_initialized": initialized,
		"active_epoch":              activeEpoch,
		"auth_mode":                 authMode,
	})
}

func (a *App) clientDeviceByID(w http.ResponseWriter, r *http.Request) {
	id, action := splitIDPath(strings.TrimPrefix(r.URL.Path, "/api/devices/"))
	if id == "" || action != "/revoke" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	principal := r.Context().Value(principalKey{}).(*domain.Principal)
	device, err := a.deps.Store.GetTrustedDeviceByID(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	firstDeviceID, _ := a.deps.Store.FirstApprovedDeviceID(r.Context())
	if ok, blocker := clientDeviceRevokeState(device, principal.DeviceID, firstDeviceID); !ok {
		writeError(w, http.StatusConflict, blocker)
		return
	}
	if err := a.deps.Store.RevokeTrustedDevice(r.Context(), id); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"device_id": id,
		"revoked":   true,
		"message":   "Authorization revoked. The device has been signed out and must request authorization again before it can access ShellOrchestra.",
	})
}

func (a *App) deviceRequests(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	if !a.requireDeviceApprovalPrincipal(w, r) {
		return
	}
	requests, err := a.deps.Store.ListPendingDeviceRequests(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	items := make([]map[string]any, 0, len(requests))
	for _, request := range requests {
		items = append(items, deviceRequestResponse(request))
	}
	writeJSON(w, http.StatusOK, map[string]any{"requests": items})
}

func (a *App) deviceRequestByID(w http.ResponseWriter, r *http.Request) {
	id, suffix := splitIDPath(strings.TrimPrefix(r.URL.Path, "/api/device-requests/"))
	if id == "" {
		writeError(w, http.StatusNotFound, "Device request not found.")
		return
	}
	switch suffix {
	case "/approve":
		a.approveDeviceRequest(w, r, id)
	case "/deny":
		a.denyDeviceRequest(w, r, id)
	default:
		writeError(w, http.StatusNotFound, "Device request route not found.")
	}
}

func (a *App) approveDeviceRequest(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !a.requireDeviceApprovalPrincipal(w, r) {
		return
	}
	var body struct {
		EncryptedDeviceShareB64 string `json:"encrypted_device_share_b64"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	authority, authorityErr := a.deps.Store.GetAuthority(r.Context())
	signerEpoch := 0
	if authorityErr == nil {
		signerEpoch = authority.ActiveEpoch
		if strings.TrimSpace(body.EncryptedDeviceShareB64) == "" {
			writeError(w, http.StatusBadRequest, "Encrypted device approval key is required after server access keys are initialized.")
			return
		}
	} else if !errors.Is(authorityErr, store.ErrNotFound) {
		writeError(w, http.StatusInternalServerError, authorityErr.Error())
		return
	}
	request, err := a.deps.Store.ApproveDeviceRequest(r.Context(), id, strings.TrimSpace(body.EncryptedDeviceShareB64), signerEpoch)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, deviceRequestResponse(request))
}

func (a *App) denyDeviceRequest(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !a.requireDeviceApprovalPrincipal(w, r) {
		return
	}
	if err := a.deps.Store.DenyDeviceRequest(r.Context(), id); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) lanSetupBegin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var body struct {
		BootstrapToken string `json:"bootstrap_token"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if ok := a.validateFirstSetupToken(w, r, body.BootstrapToken); !ok {
		return
	}
	secret, err := security.GenerateTOTPSecret()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := a.deps.Store.SaveAuthSettings(r.Context(), store.AuthSettings{
		Mode:       store.AuthModeLANTOTP,
		TOTPSecret: secret,
	}); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	window, err := a.deps.Store.BootstrapWindow(r.Context(), time.Duration(a.deps.Config.Security.BootstrapTimeoutMinutes)*time.Minute)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"secret":      secret,
		"otpauth_url": security.TOTPAuthURL(a.deps.Config.App.Name, "admin", secret),
		"expires_at":  window.ExpiresAt,
	})
}

func (a *App) lanSetupFinish(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var body struct {
		BootstrapToken string `json:"bootstrap_token"`
		Passphrase     string `json:"passphrase"`
		TOTPCode       string `json:"totp_code"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if ok := a.validateFirstSetupToken(w, r, body.BootstrapToken); !ok {
		return
	}
	if len(strings.TrimSpace(body.Passphrase)) < minAdminPassphrase {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("Admin passphrase must be at least %d characters.", minAdminPassphrase))
		return
	}
	settings, err := a.deps.Store.GetAuthSettings(r.Context())
	if err != nil || settings.Mode != store.AuthModeLANTOTP || strings.TrimSpace(settings.TOTPSecret) == "" {
		writeError(w, http.StatusConflict, "LAN-only setup was not started. Choose LAN-only setup again, then scan the new authenticator QR code.")
		return
	}
	if !security.VerifyTOTPCode(settings.TOTPSecret, body.TOTPCode, time.Now().UTC()) {
		writeError(w, http.StatusForbidden, "The one-time code is incorrect or expired.")
		return
	}
	verifier, err := security.CreatePassphraseVerifier(body.Passphrase)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// Server access keys are intentionally configured later from the desktop-only Keys wizard.
	now := time.Now().UTC()
	if err := a.deps.Store.SaveTrustedDevice(r.Context(), store.TrustedDevice{
		ID:             lanAdminDeviceID,
		Label:          "LAN-only administrator",
		Kind:           domain.DeviceKindBrowser,
		ApprovedAt:     &now,
		CredentialID:   lanAdminCredential,
		PublicKeyB64:   b64Raw([]byte("lan-totp")),
		EnvelopeKeyB64: "",
		UserHandleB64:  b64Raw([]byte(lanAdminDeviceID)),
		CredentialJSON: "",
		SignerEpoch:    0,
	}); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	settings.TOTPConfirmedAt = &now
	settings.LANPassphraseVerifierB64 = verifier.VerifierB64
	settings.LANPassphraseSaltB64 = verifier.SaltB64
	settings.LANPassphraseKDFName = verifier.KDFName
	settings.LANPassphraseKDFParamsJSON = verifier.KDFParamsJSON
	if err := a.deps.Store.SaveAuthSettings(r.Context(), *settings); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := a.issueSession(w, r, lanAdminDeviceID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	lockState := runtimeKeysNotInitializedState()
	principal := domain.Principal{DeviceID: lanAdminDeviceID, Label: "LAN-only administrator", Kind: domain.DeviceKindBrowser}
	writeJSON(w, http.StatusOK, map[string]any{
		"principal":  a.principalResponse(r.Context(), &principal),
		"public_key": nil,
		"lock_state": lockState,
	})
}

func (a *App) lanLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var body struct {
		Passphrase string `json:"passphrase"`
		TOTPCode   string `json:"totp_code"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	settings, err := a.deps.Store.GetAuthSettings(r.Context())
	if err != nil || settings.Mode != store.AuthModeLANTOTP || strings.TrimSpace(settings.TOTPSecret) == "" || settings.TOTPConfirmedAt == nil {
		writeError(w, http.StatusConflict, "LAN-only sign-in is not configured.")
		return
	}
	if !security.VerifyTOTPCode(settings.TOTPSecret, body.TOTPCode, time.Now().UTC()) {
		writeError(w, http.StatusForbidden, "The one-time code is incorrect or expired.")
		return
	}
	if !security.VerifyPassphrase(security.PassphraseVerifier{
		VerifierB64:   settings.LANPassphraseVerifierB64,
		SaltB64:       settings.LANPassphraseSaltB64,
		KDFName:       settings.LANPassphraseKDFName,
		KDFParamsJSON: settings.LANPassphraseKDFParamsJSON,
	}, body.Passphrase) {
		writeError(w, http.StatusForbidden, "Admin passphrase or one-time code is incorrect.")
		return
	}
	authority, err := a.deps.Store.GetAuthority(r.Context())
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			if err := a.issueSession(w, r, lanAdminDeviceID); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			lockState := runtimeKeysNotInitializedState()
			principal := domain.Principal{DeviceID: lanAdminDeviceID, Label: "LAN-only administrator", Kind: domain.DeviceKindBrowser}
			writeJSON(w, http.StatusOK, map[string]any{
				"principal":  a.principalResponse(r.Context(), &principal),
				"lock_state": lockState,
			})
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if authority.AuthMode != store.AuthModeLANTOTP {
		writeError(w, http.StatusConflict, "LAN-only key authority is not initialized.")
		return
	}
	if err := a.issueSession(w, r, lanAdminDeviceID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	lockState := runtimeLockState(false)
	if a.deps.Signer != nil {
		state, err := a.deps.Signer.UnlockLAN(r.Context(), body.Passphrase)
		if err != nil {
			writeError(w, http.StatusForbidden, err.Error())
			return
		}
		lockState = runtimeLockState(state.Locked)
		lockState["message"] = state.Message
	} else {
		seed, err := security.DecryptSeedWithPassphrase(security.EncryptedSeed{
			CiphertextB64: authority.EncryptedSeedB64,
			SaltB64:       authority.KDFSaltB64,
			NonceB64:      authority.NonceB64,
			KDFName:       authority.KDFName,
			KDFParamsJSON: authority.KDFParamsJSON,
		}, body.Passphrase)
		if err != nil {
			writeError(w, http.StatusForbidden, err.Error())
			return
		}
		publicKey, err := security.PublicKeyOpenSSHFromSeed(seed)
		if err != nil {
			writeError(w, http.StatusForbidden, err.Error())
			return
		}
		if publicKey != authority.PublicKeyOpenSSH {
			writeError(w, http.StatusForbidden, "Admin passphrase does not unlock the configured ShellOrchestra key.")
			return
		}
		signer, err := security.SignerFromSeed(seed)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		a.deps.Runtime.Unlock(signer)
	}
	if a.deps.Config.Runtime.AutoConnectAfterUnlock {
		go a.connectAllServers(context.Background())
	}
	principal := domain.Principal{DeviceID: lanAdminDeviceID, Label: "LAN-only administrator", Kind: domain.DeviceKindBrowser}
	writeJSON(w, http.StatusOK, map[string]any{
		"principal":  a.principalResponse(r.Context(), &principal),
		"lock_state": lockState,
	})
}

func (a *App) me(w http.ResponseWriter, r *http.Request) {
	principal := r.Context().Value(principalKey{}).(*domain.Principal)
	writeJSON(w, http.StatusOK, a.principalResponse(r.Context(), principal))
}

func (a *App) deviceSigningKey(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	accessCookie, err := r.Cookie(a.deps.Config.Security.AccessCookie)
	if err != nil || strings.TrimSpace(accessCookie.Value) == "" {
		writeError(w, http.StatusUnauthorized, "Authentication required before registering this device signing key.")
		return
	}
	principal, csrfHash, err := a.deps.Store.Authenticate(r.Context(), accessCookie.Value)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "Authentication required before registering this device signing key.")
		return
	}
	csrfCookie, err := r.Cookie(a.deps.Config.Security.CSRFCookie)
	if err != nil || store.HashToken(csrfCookie.Value) != csrfHash || r.Header.Get(a.deps.Config.Security.CSRFHeader) != csrfCookie.Value {
		writeError(w, http.StatusForbidden, "CSRF validation failed.")
		return
	}
	var body struct {
		PublicKeySPKIB64 string `json:"public_key_spki_b64"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.PublicKeySPKIB64) == "" {
		writeError(w, http.StatusBadRequest, "Device signing public key is required.")
		return
	}
	if err := devicesig.ValidatePublicKey(body.PublicKeySPKIB64); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := a.deps.Store.UpdateTrustedDeviceSigningKey(r.Context(), principal.DeviceID, body.PublicKeySPKIB64); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"device_id": principal.DeviceID, "registered": true})
}

func (a *App) deviceEnvelopeKey(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	accessCookie, err := r.Cookie(a.deps.Config.Security.AccessCookie)
	if err != nil || strings.TrimSpace(accessCookie.Value) == "" {
		writeError(w, http.StatusUnauthorized, "Authentication required before updating this device protection.")
		return
	}
	principal, csrfHash, err := a.deps.Store.Authenticate(r.Context(), accessCookie.Value)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "Authentication required before updating this device protection.")
		return
	}
	csrfCookie, err := r.Cookie(a.deps.Config.Security.CSRFCookie)
	if err != nil || store.HashToken(csrfCookie.Value) != csrfHash || r.Header.Get(a.deps.Config.Security.CSRFHeader) != csrfCookie.Value {
		writeError(w, http.StatusForbidden, "CSRF validation failed.")
		return
	}
	var body struct {
		EnvelopePublicKeySPKIB64 string `json:"envelope_public_key_spki_b64"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if err := validateEnvelopePublicKey(body.EnvelopePublicKeySPKIB64); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := a.deps.Store.UpdateTrustedDeviceEnvelopeKey(r.Context(), principal.DeviceID, body.EnvelopePublicKeySPKIB64); err != nil {
		writeStoreError(w, err)
		return
	}
	keyShareRefreshed, keyShareRefreshMessage := a.refreshCurrentDeviceShareForEnvelope(r.Context(), principal.DeviceID, body.EnvelopePublicKeySPKIB64)
	writeJSON(w, http.StatusOK, map[string]any{
		"device_id":                    principal.DeviceID,
		"registered":                   true,
		"envelope_public_key_spki_b64": strings.TrimSpace(body.EnvelopePublicKeySPKIB64),
		"key_share_refreshed":          keyShareRefreshed,
		"key_share_refresh_message":    keyShareRefreshMessage,
	})
}

func (a *App) internalVerifyRequest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !a.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var body struct {
		Method      string `json:"method"`
		PathQuery   string `json:"path_query"`
		BodyHash    string `json:"body_hash"`
		Timestamp   string `json:"timestamp"`
		Nonce       string `json:"nonce"`
		DeviceID    string `json:"device_id"`
		SessionID   string `json:"session_id"`
		Signature   string `json:"signature"`
		CSRFToken   string `json:"csrf_token"`
		AccessToken string `json:"access_token"`
		Mutating    bool   `json:"mutating"`
		UserActive  bool   `json:"user_active"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	principal, csrfHash, err := a.deps.Store.Authenticate(r.Context(), body.AccessToken)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "Authentication required.")
		return
	}
	if body.Mutating && (body.CSRFToken == "" || store.HashToken(body.CSRFToken) != csrfHash) {
		writeError(w, http.StatusForbidden, "CSRF validation failed.")
		return
	}
	if principal.DeviceID != strings.TrimSpace(body.DeviceID) {
		writeError(w, http.StatusForbidden, "Request signature device does not match the authenticated session.")
		return
	}
	device, err := a.deps.Store.GetTrustedDeviceByID(r.Context(), principal.DeviceID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if strings.TrimSpace(device.SigningKeyB64) == "" {
		writeError(w, http.StatusForbidden, "This device has no registered request signing key. Sign in again so ShellOrchestra can register one.")
		return
	}
	timestamp, err := time.Parse(time.RFC3339, strings.TrimSpace(body.Timestamp))
	if err != nil {
		writeError(w, http.StatusForbidden, "Request signature timestamp is invalid.")
		return
	}
	maxAge := time.Duration(a.deps.Config.Gateway.SignatureMaxAge) * time.Second
	if time.Since(timestamp) > maxAge || time.Until(timestamp) > maxAge {
		writeError(w, http.StatusForbidden, "Request signature timestamp is outside the accepted window.")
		return
	}
	proof := devicesig.RequestProof{
		Method: body.Method, PathQuery: body.PathQuery, BodyHash: body.BodyHash,
		Timestamp: body.Timestamp, Nonce: body.Nonce, DeviceID: body.DeviceID,
		SessionID: body.SessionID, Signature: body.Signature,
	}
	if err := devicesig.VerifyRequest(proof, device.SigningKeyB64); err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}
	if err := a.deps.Store.RememberRequestNonce(r.Context(), principal.DeviceID, strings.TrimSpace(body.Nonce), maxAge*2); err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}
	sessionMaxAgeSeconds := 0
	if body.UserActive {
		sessionMaxAgeSeconds = a.refreshAuthenticatedSessionTTL(r.Context(), body.AccessToken)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"principal":               a.principalResponse(r.Context(), principal),
		"session_max_age_seconds": sessionMaxAgeSeconds,
	})
}

func (a *App) principalResponse(ctx context.Context, principal *domain.Principal) map[string]any {
	if principal == nil {
		return map[string]any{}
	}
	return map[string]any{
		"device_id":                    principal.DeviceID,
		"label":                        principal.Label,
		"kind":                         principal.Kind,
		"can_approve_device_requests":  a.canApproveDeviceRequests(ctx, principal),
		"session_idle_timeout_seconds": int(a.sessionIdleTTL(ctx).Seconds()),
	}
}

func (a *App) requireDeviceApprovalPrincipal(w http.ResponseWriter, r *http.Request) bool {
	principal, ok := r.Context().Value(principalKey{}).(*domain.Principal)
	if !ok || !a.canApproveDeviceRequests(r.Context(), principal) {
		writeError(w, http.StatusForbidden, "Device authorization requests are shown only on the first approved phone. Open ShellOrchestra on that phone to approve a new device.")
		return false
	}
	return true
}

func (a *App) canApproveDeviceRequests(ctx context.Context, principal *domain.Principal) bool {
	if a.isDebugApprovalPrincipal(principal) {
		return true
	}
	if principal == nil || principal.Kind != domain.DeviceKindPhone {
		return false
	}
	firstDeviceID, err := a.deps.Store.FirstApprovedDeviceID(ctx)
	return err == nil && firstDeviceID == principal.DeviceID
}

func (a *App) isDebugApprovalPrincipal(principal *domain.Principal) bool {
	return principal != nil && a.debugModeEnabled() && principal.DeviceID == debugDeviceID
}

func (a *App) logout(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(a.deps.Config.Security.AccessCookie)
	if err == nil {
		_ = a.deps.Store.RevokeSession(r.Context(), cookie.Value)
	}
	clearCookie(w, a.deps.Config.Security.AccessCookie, a.deps.Config.Security.SecureCookies)
	clearCookie(w, a.deps.Config.Security.RefreshCookie, a.deps.Config.Security.SecureCookies)
	clearCookie(w, a.deps.Config.Security.CSRFCookie, a.deps.Config.Security.SecureCookies)
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) lockState(w http.ResponseWriter, r *http.Request) {
	if a.deps.Worker != nil {
		state, err := a.deps.Worker.LockState(r.Context())
		if err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		payload := runtimeLockState(state.Locked)
		payload["initialized"] = state.Initialized
		payload["message"] = state.Message
		writeJSON(w, http.StatusOK, payload)
		return
	}
	if _, err := a.deps.Store.GetAuthority(r.Context()); errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusOK, runtimeKeysNotInitializedState())
		return
	}
	writeJSON(w, http.StatusOK, runtimeLockState(a.deps.Runtime.Locked()))
}

func (a *App) lockRuntime(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if a.deps.Worker != nil {
		state, err := a.deps.Worker.LockRuntime(r.Context())
		if err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		payload := runtimeLockState(state.Locked)
		payload["initialized"] = state.Initialized
		payload["message"] = state.Message
		writeJSON(w, http.StatusOK, payload)
		return
	}
	if a.deps.Runtime != nil {
		a.deps.Runtime.Lock()
	}
	lockState := runtimeLockState(true)
	if a.deps.Signer != nil {
		state, err := a.deps.Signer.Lock(r.Context())
		if err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		lockState = runtimeLockState(state.Locked)
		lockState["initialized"] = state.Initialized
		lockState["message"] = state.Message
	}
	writeJSON(w, http.StatusOK, lockState)
}

func (a *App) unlockRuntime(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DeviceShareB64 string `json:"device_share_b64"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	authority, err := a.deps.Store.GetAuthority(r.Context())
	if err != nil {
		writeError(w, http.StatusConflict, "ShellOrchestra key authority is not initialized.")
		return
	}
	if authority.AuthMode == store.AuthModeLANTOTP {
		writeError(w, http.StatusBadRequest, "This installation uses LAN-only one-time-code sign-in. Use the admin passphrase and authenticator code to unlock server access.")
		return
	}
	lockState, err := a.unlockRuntimeWithDeviceShare(r.Context(), authority, body.DeviceShareB64)
	if err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}
	a.persistDebugDeviceShareIfEnabled(r.Context(), authority.ActiveEpoch, body.DeviceShareB64)
	if a.deps.Config.Runtime.AutoConnectAfterUnlock {
		go a.connectAllServers(context.Background())
	}
	writeJSON(w, http.StatusOK, lockState)
}

func (a *App) unlockRuntimeWithDeviceShare(ctx context.Context, authority *store.Authority, deviceShareB64 string) (map[string]any, error) {
	lockState := runtimeLockState(false)
	if a.deps.Signer != nil {
		state, err := a.deps.Signer.UnlockWithDeviceShare(ctx, deviceShareB64)
		if err != nil {
			return nil, err
		}
		lockState = runtimeLockState(state.Locked)
		lockState["message"] = state.Message
		return lockState, nil
	}
	seed, err := security.SeedFromShares(authority.BackendShareB64, deviceShareB64)
	if err != nil {
		return nil, err
	}
	publicKey, err := security.PublicKeyOpenSSHFromSeed(seed)
	if err != nil || publicKey != authority.PublicKeyOpenSSH {
		return nil, fmt.Errorf("device share does not reconstruct the configured ShellOrchestra key")
	}
	classicSeed, err := security.ClassicFallbackSeedFromAuthoritySeed(seed)
	if err != nil {
		return nil, err
	}
	signer, err := security.SignerFromSeed(seed)
	if err != nil {
		return nil, err
	}
	classicSigner, err := security.SignerFromSeed(classicSeed)
	if err != nil {
		return nil, err
	}
	a.deps.Runtime.UnlockAuthoritySigners(signer, classicSigner)
	return lockState, nil
}

func (a *App) keysStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	principal := r.Context().Value(principalKey{}).(*domain.Principal)
	authModeRaw, _ := a.authModeSnapshot(r.Context())
	authMode := store.AuthMode(authModeRaw)
	if authMode == "" || authMode == store.AuthMode("unset") {
		authMode = store.AuthModePasskey
	}
	devices, err := a.deps.Store.ListTrustedDevices(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	securitySettings, err := a.deps.Store.GetSSHSecuritySettings(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	deviceItems := make([]map[string]any, 0, len(devices))
	for _, device := range devices {
		deviceItems = append(deviceItems, keyDeviceResponse(device))
	}
	response := map[string]any{
		"initialized":                   false,
		"auth_mode":                     authMode,
		"label":                         nil,
		"public_key":                    nil,
		"classic_public_key":            nil,
		"active_epoch":                  0,
		"cert_ttl_minutes":              securitySettings.CertTTLMinutes,
		"installer":                     installerMetadata(a.deps.Config.Installer),
		"install_command":               nil,
		"install_targets":               []installCommandTarget{},
		"classic_install_targets":       []installCommandTarget{},
		"current_device_id":             principal.DeviceID,
		"current_device_kind":           principal.Kind,
		"desktop_setup_allowed":         principal.Kind != domain.DeviceKindPhone,
		"windows_desktop_server":        stdruntime.GOOS == "windows",
		"local_protected_key_available": localProtectedKeyRuntimeAvailable(),
		"devices":                       deviceItems,
	}
	authority, err := a.deps.Store.GetAuthority(r.Context())
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeJSON(w, http.StatusOK, response)
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	response["initialized"] = true
	response["auth_mode"] = authority.AuthMode
	response["label"] = nullableString(authority.Label)
	response["public_key"] = authority.PublicKeyOpenSSH
	response["classic_public_key"] = nullableString(authority.ClassicPublicKeyOpenSSH)
	response["active_epoch"] = authority.ActiveEpoch
	response["install_command"] = authorityInstallCommand(authority.PublicKeyOpenSSH)
	response["install_targets"] = authorityInstallTargets(authority.PublicKeyOpenSSH)
	response["classic_install_targets"] = classicInstallTargets(authority.ClassicPublicKeyOpenSSH, securitySettings.AllowedSourceAddresses)
	writeJSON(w, http.StatusOK, response)
}

func (a *App) keyChangeApprovals(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	principal := r.Context().Value(principalKey{}).(*domain.Principal)
	if principal.Kind == domain.DeviceKindPhone {
		writeError(w, http.StatusForbidden, "Server-access key changes are started from a desktop browser. This phone approves the change after the desktop shows a QR code.")
		return
	}
	requestID, err := randomToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	pollToken, err := randomToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	verificationCode, err := randomVerificationCode()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	now := time.Now().UTC()
	expiresAt := now.Add(10 * time.Minute)
	if err := a.deps.Store.CreateKeyChangeApproval(r.Context(), store.KeyChangeApproval{
		ID:               requestID,
		PollTokenHash:    store.HashToken(pollToken),
		VerificationCode: verificationCode,
		State:            store.KeyChangeApprovalPending,
		CreatedAt:        now,
		ExpiresAt:        expiresAt,
	}); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"request_id":        requestID,
		"poll_token":        pollToken,
		"verification_code": verificationCode,
		"approve_url":       a.requestOrigin(r) + "/k#" + requestID,
		"state":             store.KeyChangeApprovalPending,
		"expires_at":        expiresAt,
	})
}

func (a *App) keyChangeApprovalByID(w http.ResponseWriter, r *http.Request) {
	remainder := strings.TrimPrefix(r.URL.Path, "/api/keys/change-approvals/")
	parts := strings.Split(strings.Trim(remainder, "/"), "/")
	if len(parts) != 2 || parts[0] == "" {
		http.NotFound(w, r)
		return
	}
	switch parts[1] {
	case "status":
		a.keyChangeApprovalStatus(w, r, parts[0])
	case "approve":
		a.keyChangeApprovalApprove(w, r, parts[0])
	default:
		http.NotFound(w, r)
	}
}

func (a *App) keyChangeApprovalStatus(w http.ResponseWriter, r *http.Request, requestID string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var body struct {
		PollToken string `json:"poll_token"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	approval, err := a.deps.Store.GetKeyChangeApprovalByPollToken(r.Context(), requestID, body.PollToken)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, keyChangeApprovalResponse(approval))
}

func (a *App) keyChangeApprovalApprove(w http.ResponseWriter, r *http.Request, requestID string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !a.requireDeviceApprovalPrincipal(w, r) {
		return
	}
	principal := r.Context().Value(principalKey{}).(*domain.Principal)
	approval, err := a.deps.Store.ApproveKeyChangeApproval(r.Context(), requestID, principal.DeviceID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusConflict, "This key-change approval request is no longer active. Return to the desktop Keys page and start the key change again.")
			return
		}
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, keyChangeApprovalResponse(approval))
}

func (a *App) keysCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	principal := r.Context().Value(principalKey{}).(*domain.Principal)
	if principal.Kind == domain.DeviceKindPhone {
		writeError(w, http.StatusForbidden, "Server access keys must be initialized from a desktop browser. This phone can approve devices after setup, but it cannot run the Keys wizard.")
		return
	}
	var body struct {
		PrivateKey      string `json:"private_key"`
		PublicKey       string `json:"public_key"`
		Label           string `json:"label"`
		Passphrase      string `json:"passphrase"`
		RotateConfirmed bool   `json:"rotate_confirmed"`
		ApprovalID      string `json:"approval_id"`
		ApprovalToken   string `json:"approval_poll_token"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if _, err := a.deps.Store.GetAuthority(r.Context()); err == nil && !body.RotateConfirmed {
		writeError(w, http.StatusConflict, "Server access keys already exist. Rotation changes the public CA key and requires updating every server. Confirm rotation before continuing.")
		return
	} else if err != nil && !errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	authModeRaw, _ := a.authModeSnapshot(r.Context())
	authMode := store.AuthMode(authModeRaw)
	if authMode == "" || authMode == store.AuthMode("unset") {
		authMode = store.AuthModePasskey
	}
	if authMode == store.AuthModeLANTOTP && strings.TrimSpace(body.Passphrase) == "" {
		writeError(w, http.StatusBadRequest, "Admin passphrase is required to protect server access keys in LAN-only mode.")
		return
	}
	if authMode == store.AuthModePasskey {
		if strings.TrimSpace(body.ApprovalID) == "" || strings.TrimSpace(body.ApprovalToken) == "" {
			writeError(w, http.StatusForbidden, "Approve this server-access key change on the primary approval phone before ShellOrchestra creates or rotates keys.")
			return
		}
		if _, err := a.deps.Store.ConsumeKeyChangeApproval(r.Context(), body.ApprovalID, body.ApprovalToken); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeError(w, http.StatusForbidden, "The phone approval is missing, expired, or already used. Start the key workflow again and approve the new verification code on the primary phone.")
				return
			}
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	if authMode == store.AuthModeLANTOTP {
		settings, err := a.deps.Store.GetAuthSettings(r.Context())
		if err != nil {
			writeError(w, http.StatusConflict, "LAN-only sign-in is not configured.")
			return
		}
		if !security.VerifyPassphrase(security.PassphraseVerifier{
			VerifierB64:   settings.LANPassphraseVerifierB64,
			SaltB64:       settings.LANPassphraseSaltB64,
			KDFName:       settings.LANPassphraseKDFName,
			KDFParamsJSON: settings.LANPassphraseKDFParamsJSON,
		}, body.Passphrase) {
			writeError(w, http.StatusForbidden, "Admin passphrase is incorrect.")
			return
		}
	}
	created, err := a.createKeyAuthority(r.Context(), authMode, strings.TrimSpace(body.Passphrase), body.PrivateKey, body.PublicKey, body.Label)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	a.persistDebugDeviceShareIfEnabled(r.Context(), created.ActiveEpoch, created.DeviceShareB64)
	devices, err := a.deps.Store.ListTrustedDevices(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	securitySettings, err := a.deps.Store.GetSSHSecuritySettings(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	deviceItems := make([]map[string]any, 0, len(devices))
	for _, device := range devices {
		deviceItems = append(deviceItems, keyDeviceResponse(device))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"initialized":                   true,
		"auth_mode":                     authMode,
		"label":                         created.Label,
		"public_key":                    created.PublicKey,
		"classic_public_key":            created.ClassicPublicKey,
		"active_epoch":                  created.ActiveEpoch,
		"device_share_b64":              nullableString(created.DeviceShareB64),
		"install_command":               authorityInstallCommand(created.PublicKey),
		"installer":                     installerMetadata(a.deps.Config.Installer),
		"install_targets":               authorityInstallTargets(created.PublicKey),
		"classic_install_targets":       classicInstallTargets(created.ClassicPublicKey, securitySettings.AllowedSourceAddresses),
		"windows_desktop_server":        stdruntime.GOOS == "windows",
		"local_protected_key_available": localProtectedKeyRuntimeAvailable(),
		"devices":                       deviceItems,
	})
}

func (a *App) keysDeviceShare(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	principal := r.Context().Value(principalKey{}).(*domain.Principal)
	authority, err := a.deps.Store.GetAuthority(r.Context())
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusConflict, "Server access keys are not initialized yet. Open Keys from a desktop browser to finish setup.")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if refreshedShare, refreshed := a.refreshStoredDeviceShareForCurrentEnvelope(r.Context(), principal.DeviceID, authority.ActiveEpoch); refreshed {
		a.logDebugKeyShare("fetch-refreshed", principal, refreshedShare.Epoch, "encrypted share refreshed for this device envelope")
		writeJSON(w, http.StatusOK, map[string]any{"active_epoch": refreshedShare.Epoch, "encrypted_device_share_b64": refreshedShare.EncryptedDeviceShareB64})
		return
	}
	share, err := a.deps.Store.GetDeviceKeyShare(r.Context(), principal.DeviceID, authority.ActiveEpoch)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			a.logDebugKeyShare("fetch-missing", principal, authority.ActiveEpoch, "no share for active epoch")
			writeError(w, http.StatusNotFound, "This device has not received the current server-access key share yet. Redistribute current server-access keys from a desktop device that already unlocks server access.")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	a.logDebugKeyShare("fetch-ok", principal, share.Epoch, "encrypted share returned")
	writeJSON(w, http.StatusOK, map[string]any{"active_epoch": share.Epoch, "encrypted_device_share_b64": share.EncryptedDeviceShareB64})
}

func (a *App) refreshStoredDeviceShareForCurrentEnvelope(ctx context.Context, deviceID string, activeEpoch int) (store.DeviceKeyShare, bool) {
	if a.deps.Signer == nil || activeEpoch <= 0 {
		return store.DeviceKeyShare{}, false
	}
	device, err := a.deps.Store.GetTrustedDeviceByID(ctx, strings.TrimSpace(deviceID))
	if err != nil || strings.TrimSpace(device.EnvelopeKeyB64) == "" {
		return store.DeviceKeyShare{}, false
	}
	response, err := a.deps.Signer.EncryptCurrentDeviceShare(ctx, device.EnvelopeKeyB64)
	if err != nil || response.ActiveEpoch != activeEpoch || strings.TrimSpace(response.EncryptedDeviceShareB64) == "" {
		return store.DeviceKeyShare{}, false
	}
	share := store.DeviceKeyShare{
		DeviceID:                strings.TrimSpace(deviceID),
		Epoch:                   response.ActiveEpoch,
		EncryptedDeviceShareB64: strings.TrimSpace(response.EncryptedDeviceShareB64),
	}
	if err := a.deps.Store.UpsertDeviceKeyShare(ctx, share); err != nil {
		if a.debugModeEnabled() {
			log.Printf("ShellOrchestra key-share-debug action=%q device_id=%q epoch=%d message=%q", "fetch-refresh-store-failed", deviceID, response.ActiveEpoch, err.Error())
		}
		return store.DeviceKeyShare{}, false
	}
	return share, true
}

func (a *App) keysDeviceShares(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	principal := r.Context().Value(principalKey{}).(*domain.Principal)
	authority, err := a.deps.Store.GetAuthority(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	var body struct {
		Shares []struct {
			DeviceID                string `json:"device_id"`
			Epoch                   int    `json:"epoch"`
			EncryptedDeviceShareB64 string `json:"encrypted_device_share_b64"`
		} `json:"shares"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	stored := 0
	for _, item := range body.Shares {
		if item.Epoch != authority.ActiveEpoch {
			writeError(w, http.StatusBadRequest, "Device key share epoch does not match the active key authority epoch.")
			return
		}
		if err := a.deps.Store.UpsertDeviceKeyShare(r.Context(), store.DeviceKeyShare{DeviceID: strings.TrimSpace(item.DeviceID), Epoch: item.Epoch, EncryptedDeviceShareB64: strings.TrimSpace(item.EncryptedDeviceShareB64)}); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		a.logDebugKeyShareForDevice("bulk-upsert", strings.TrimSpace(item.DeviceID), item.Epoch, principal.DeviceID)
		stored++
	}
	writeJSON(w, http.StatusOK, map[string]any{"stored": stored, "active_epoch": authority.ActiveEpoch})
}

func (a *App) keysCurrentDeviceShare(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	principal := r.Context().Value(principalKey{}).(*domain.Principal)
	authority, err := a.deps.Store.GetAuthority(r.Context())
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if authority.AuthMode != store.AuthModePasskey {
		writeError(w, http.StatusBadRequest, "Per-device key share delivery is used only in passkey mode.")
		return
	}
	var body struct {
		Epoch                   int    `json:"epoch"`
		EncryptedDeviceShareB64 string `json:"encrypted_device_share_b64"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.Epoch != authority.ActiveEpoch {
		writeError(w, http.StatusBadRequest, "Device key share epoch does not match the active key authority epoch.")
		return
	}
	if err := a.deps.Store.UpsertDeviceKeyShare(r.Context(), store.DeviceKeyShare{DeviceID: principal.DeviceID, Epoch: body.Epoch, EncryptedDeviceShareB64: strings.TrimSpace(body.EncryptedDeviceShareB64)}); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	a.logDebugKeyShare("current-upsert", principal, body.Epoch, "current device encrypted share saved")
	writeJSON(w, http.StatusOK, map[string]any{"stored": true, "active_epoch": authority.ActiveEpoch, "device_id": principal.DeviceID})
}

func (a *App) refreshCurrentDeviceShareForEnvelope(ctx context.Context, deviceID string, envelopePublicKeySPKIB64 string) (bool, string) {
	if a.deps.Signer == nil {
		return false, "Server-access key share refresh is available only when the isolated CA signer service is configured."
	}
	response, err := a.deps.Signer.EncryptCurrentDeviceShare(ctx, strings.TrimSpace(envelopePublicKeySPKIB64))
	if err != nil {
		message := err.Error()
		if strings.Contains(strings.ToLower(message), "ca signer is locked") {
			a.logDebugKeyShareForDevice("envelope-refresh-locked", strings.TrimSpace(deviceID), 0, strings.TrimSpace(deviceID))
			return false, "Server access is currently locked. This device will receive a refreshed key share after server access is unlocked by a device that already has the current share."
		}
		if a.debugModeEnabled() {
			log.Printf("ShellOrchestra key-share-debug action=%q device_id=%q message=%q", "envelope-refresh-failed", deviceID, message)
		}
		return false, "Server-access key share refresh did not complete. Sign-in still works, but unlock may require another trusted device."
	}
	if err := a.deps.Store.UpsertDeviceKeyShare(ctx, store.DeviceKeyShare{
		DeviceID:                strings.TrimSpace(deviceID),
		Epoch:                   response.ActiveEpoch,
		EncryptedDeviceShareB64: strings.TrimSpace(response.EncryptedDeviceShareB64),
	}); err != nil {
		if a.debugModeEnabled() {
			log.Printf("ShellOrchestra key-share-debug action=%q device_id=%q epoch=%d message=%q", "envelope-refresh-store-failed", deviceID, response.ActiveEpoch, err.Error())
		}
		return false, "Server-access key share refresh could not be saved. Sign-in still works, but unlock may require another trusted device."
	}
	a.logDebugKeyShareForDevice("envelope-refresh-upsert", strings.TrimSpace(deviceID), response.ActiveEpoch, strings.TrimSpace(deviceID))
	return true, "This device received the current encrypted server-access key share."
}

func (a *App) createKeyAuthority(ctx context.Context, authMode store.AuthMode, passphrase string, privateKey string, publicKey string, label string) (casigner.CreateAuthorityResponse, error) {
	if a.deps.Signer != nil {
		return a.deps.Signer.CreateAuthority(ctx, authMode, passphrase, privateKey, publicKey, label)
	}
	var material security.AuthorityMaterial
	var err error
	if strings.TrimSpace(privateKey) == "" {
		material, _, _, err = security.GenerateAuthorityMaterial()
	} else {
		material, err = security.MaterialFromOpenSSHKeyPair([]byte(privateKey), publicKey)
	}
	if err != nil {
		return casigner.CreateAuthorityResponse{}, err
	}
	activeEpoch := 1
	if current, err := a.deps.Store.GetAuthority(ctx); err == nil && current.ActiveEpoch > 0 {
		activeEpoch = current.ActiveEpoch + 1
	}
	switch authMode {
	case store.AuthModePasskey:
		backendShare := make([]byte, security.ShareSize)
		if _, err := rand.Read(backendShare); err != nil {
			return casigner.CreateAuthorityResponse{}, err
		}
		deviceShare, err := security.DeriveDeviceShare(material.Seed, backendShare)
		if err != nil {
			return casigner.CreateAuthorityResponse{}, err
		}
		keyLabel := authorityLabel(label, strings.TrimSpace(privateKey) != "")
		if err := a.deps.Store.SaveAuthority(ctx, store.Authority{AuthMode: store.AuthModePasskey, Label: keyLabel, PublicKeyOpenSSH: material.PublicKeyOpenSSH, ClassicPublicKeyOpenSSH: material.ClassicPublicKeyOpenSSH, BackendShareB64: security.B64(backendShare), ActiveEpoch: activeEpoch}); err != nil {
			return casigner.CreateAuthorityResponse{}, err
		}
		signer, err := security.SignerFromSeed(material.Seed)
		if err != nil {
			return casigner.CreateAuthorityResponse{}, err
		}
		classicSigner, err := classicSignerForMaterial(material)
		if err != nil {
			return casigner.CreateAuthorityResponse{}, err
		}
		a.deps.Runtime.UnlockAuthoritySigners(signer, classicSigner)
		return casigner.CreateAuthorityResponse{Label: keyLabel, PublicKey: material.PublicKeyOpenSSH, ClassicPublicKey: material.ClassicPublicKeyOpenSSH, ActiveEpoch: activeEpoch, DeviceShareB64: security.B64(deviceShare)}, nil
	case store.AuthModeLANTOTP:
		encrypted, err := security.EncryptSeedWithPassphrase(material.Seed, passphrase)
		if err != nil {
			return casigner.CreateAuthorityResponse{}, err
		}
		keyLabel := authorityLabel(label, strings.TrimSpace(privateKey) != "")
		if err := a.deps.Store.SaveAuthority(ctx, store.Authority{AuthMode: store.AuthModeLANTOTP, Label: keyLabel, PublicKeyOpenSSH: material.PublicKeyOpenSSH, ClassicPublicKeyOpenSSH: material.ClassicPublicKeyOpenSSH, EncryptedSeedB64: encrypted.CiphertextB64, KDFSaltB64: encrypted.SaltB64, NonceB64: encrypted.NonceB64, KDFName: encrypted.KDFName, KDFParamsJSON: encrypted.KDFParamsJSON, ActiveEpoch: activeEpoch}); err != nil {
			return casigner.CreateAuthorityResponse{}, err
		}
		signer, err := security.SignerFromSeed(material.Seed)
		if err != nil {
			return casigner.CreateAuthorityResponse{}, err
		}
		classicSigner, err := classicSignerForMaterial(material)
		if err != nil {
			return casigner.CreateAuthorityResponse{}, err
		}
		a.deps.Runtime.UnlockAuthoritySigners(signer, classicSigner)
		return casigner.CreateAuthorityResponse{Label: keyLabel, PublicKey: material.PublicKeyOpenSSH, ClassicPublicKey: material.ClassicPublicKeyOpenSSH, ActiveEpoch: activeEpoch}, nil
	default:
		return casigner.CreateAuthorityResponse{}, fmt.Errorf("unsupported auth mode %q", authMode)
	}
}

func classicSignerForMaterial(material security.AuthorityMaterial) (ssh.Signer, error) {
	classicSeed := material.ClassicSeed
	if len(classicSeed) == 0 {
		var err error
		classicSeed, err = security.ClassicFallbackSeedFromAuthoritySeed(material.Seed)
		if err != nil {
			return nil, err
		}
	}
	return security.SignerFromSeed(classicSeed)
}

func keyDeviceResponse(device store.TrustedDevice) map[string]any {
	return map[string]any{
		"device_id":                    device.ID,
		"label":                        device.Label,
		"kind":                         device.Kind,
		"signer_epoch":                 device.SignerEpoch,
		"envelope_key_available":       strings.TrimSpace(device.EnvelopeKeyB64) != "",
		"envelope_public_key_spki_b64": nullableString(device.EnvelopeKeyB64),
	}
}

func clientDeviceResponse(overview store.TrustedDeviceOverview, currentDeviceID string, firstDeviceID string, initialized bool, authMode store.AuthMode, activeEpoch int, debugAuthEnabled bool) map[string]any {
	device := overview.Device
	canRevoke, revokeBlocker := clientDeviceRevokeState(device, currentDeviceID, firstDeviceID)
	canApproveNewDevices := device.ID == firstDeviceID && device.Kind == domain.DeviceKindPhone
	if debugAuthEnabled && device.ID == debugDeviceID {
		canApproveNewDevices = true
	}
	return map[string]any{
		"device_id":                device.ID,
		"label":                    device.Label,
		"kind":                     device.Kind,
		"current_device":           device.ID == currentDeviceID,
		"can_approve_new_devices":  canApproveNewDevices,
		"can_revoke":               canRevoke,
		"revoke_blocker":           nullableString(revokeBlocker),
		"approved_at":              device.ApprovedAt,
		"last_login_at":            overview.LastLoginAt,
		"last_login_ip":            nullableString(overview.LastLoginIP),
		"active_session_count":     overview.ActiveSessionCount,
		"passkey_ready":            strings.TrimSpace(device.CredentialJSON) != "" || strings.TrimSpace(device.CredentialID) != "",
		"request_protection_ready": strings.TrimSpace(device.SigningKeyB64) != "",
		"key_distribution":         clientDeviceKeyDistribution(overview, initialized, authMode, activeEpoch),
	}
}

func clientDeviceRevokeState(device store.TrustedDevice, currentDeviceID string, firstDeviceID string) (bool, string) {
	if device.ID == currentDeviceID {
		return false, "You cannot revoke the device you are currently using from this screen. Use Log out for this browser, or sign in from another trusted device to revoke this one."
	}
	if device.ID == firstDeviceID && device.Kind == domain.DeviceKindPhone {
		return false, "This phone approves new-device requests. ShellOrchestra cannot revoke it from this screen until a replacement approval-phone workflow exists."
	}
	return true, ""
}

func clientDeviceKeyDistribution(overview store.TrustedDeviceOverview, initialized bool, authMode store.AuthMode, activeEpoch int) map[string]any {
	device := overview.Device
	if !initialized {
		return map[string]any{
			"status":       "not_configured",
			"label":        "Server access keys are not configured",
			"detail":       "Open Keys on a desktop browser to generate or import server-access keys before distributing them to client devices.",
			"device_epoch": device.SignerEpoch,
			"active_epoch": activeEpoch,
			"updated_at":   overview.LatestKeyShareUpdatedAt,
		}
	}
	if authMode == store.AuthModeLANTOTP {
		return map[string]any{
			"status":       "not_required",
			"label":        "No per-device key delivery needed",
			"detail":       "This installation uses LAN-only sign-in with the administrator passphrase and authenticator code.",
			"device_epoch": device.SignerEpoch,
			"active_epoch": activeEpoch,
			"updated_at":   overview.LatestKeyShareUpdatedAt,
		}
	}
	if device.SignerEpoch == activeEpoch && activeEpoch > 0 {
		return map[string]any{
			"status":       "current",
			"label":        "Ready for current server-access keys",
			"detail":       "This device can unlock ShellOrchestra and receive future server-access key updates.",
			"device_epoch": device.SignerEpoch,
			"active_epoch": activeEpoch,
			"updated_at":   overview.LatestKeyShareUpdatedAt,
		}
	}
	if strings.TrimSpace(device.EnvelopeKeyB64) == "" {
		return map[string]any{
			"status":       "add_again",
			"label":        "Automatic update at next sign-in",
			"detail":       "Open ShellOrchestra on this already trusted device and sign in normally. ShellOrchestra will update browser protection automatically during sign-in; no new-device approval is needed.",
			"device_epoch": device.SignerEpoch,
			"active_epoch": activeEpoch,
			"updated_at":   overview.LatestKeyShareUpdatedAt,
		}
	}
	if device.SignerEpoch > 0 && device.SignerEpoch < activeEpoch {
		return map[string]any{
			"status":       "outdated",
			"label":        "Needs the latest server-access keys",
			"detail":       "This trusted device is older than the current server-access key epoch. The next desktop key workflow approved on the primary phone can deliver the current encrypted share.",
			"device_epoch": device.SignerEpoch,
			"active_epoch": activeEpoch,
			"updated_at":   overview.LatestKeyShareUpdatedAt,
		}
	}
	return map[string]any{
		"status":       "missing",
		"label":        "Server-access keys were not delivered",
		"detail":       "This trusted device can sign in, but it does not have the current server-access key share. The primary approval phone receives the current share automatically when it approves a desktop key workflow.",
		"device_epoch": device.SignerEpoch,
		"active_epoch": activeEpoch,
		"updated_at":   overview.LatestKeyShareUpdatedAt,
	}
}

func authorityLabel(label string, imported bool) string {
	trimmed := strings.TrimSpace(label)
	if trimmed != "" {
		return trimmed
	}
	if imported {
		return "Imported SSH CA"
	}
	return "ShellOrchestra generated SSH CA"
}

func validateEnvelopePublicKey(value string) error {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	data, err := base64.StdEncoding.DecodeString(trimmed)
	if err != nil {
		return fmt.Errorf("device envelope public key is invalid base64: %w", err)
	}
	key, err := x509.ParsePKIXPublicKey(data)
	if err != nil {
		return fmt.Errorf("device envelope public key is invalid: %w", err)
	}
	publicKey, ok := key.(*rsa.PublicKey)
	if !ok || publicKey.N.BitLen() < 2048 {
		return fmt.Errorf("device envelope public key must be RSA-OAEP with at least 2048 bits")
	}
	return nil
}

func authorityInstallCommand(publicKey string) string {
	targets := authorityInstallTargets(publicKey)
	if len(targets) == 0 {
		return ""
	}
	return targets[0].LocalCommand
}

func installerMetadata(installer config.InstallerSection) map[string]string {
	return map[string]string{
		"script_url":          strings.TrimSpace(installer.ScriptURL),
		"expected_sha256_url": strings.TrimSpace(installer.ExpectedSHA256URL),
		"source_url":          strings.TrimSpace(installer.SourceURL),
	}
}

type installCommandTarget struct {
	ID                string `json:"id"`
	Label             string `json:"label"`
	Platform          string `json:"platform"`
	RemoteShell       string `json:"remote_shell"`
	LocalCommand      string `json:"local_command"`
	AuthorizedKeyLine string `json:"authorized_key_line,omitempty"`
}

func authorityInstallTargets(publicKey string) []installCommandTarget {
	key := strings.TrimSpace(publicKey)
	if key == "" {
		return []installCommandTarget{}
	}
	return []installCommandTarget{
		{
			ID:           "ubuntu_debian",
			Label:        "Debian / Ubuntu / Raspberry Pi OS",
			Platform:     "linux",
			RemoteShell:  "posix",
			LocalCommand: posixTrustedUserCACommand(key, "root", "ssh"),
		},
		{
			ID:           "rhel_arch",
			Label:        "RHEL / Fedora / Arch",
			Platform:     "linux",
			RemoteShell:  "posix",
			LocalCommand: posixTrustedUserCACommand(key, "root", "sshd"),
		},
		{
			ID:           "alpine_openrc",
			Label:        "Alpine / OpenRC",
			Platform:     "linux",
			RemoteShell:  "posix",
			LocalCommand: alpineTrustedUserCACommand(key),
		},
		{
			ID:           "macos",
			Label:        "macOS OpenSSH",
			Platform:     "macos",
			RemoteShell:  "posix",
			LocalCommand: macOSTrustedUserCACommand(key),
		},
		{
			ID:           "windows_openssh",
			Label:        "Windows OpenSSH",
			Platform:     "windows",
			RemoteShell:  "powershell",
			LocalCommand: windowsTrustedUserCACommand(key),
		},
	}
}

func classicInstallTargets(publicKey string, allowedSourceAddresses []string) []installCommandTarget {
	key := strings.TrimSpace(publicKey)
	if key == "" {
		return []installCommandTarget{}
	}
	authorizedKeyLine := classicAuthorizedKeyLine(key, allowedSourceAddresses)
	return []installCommandTarget{
		{
			ID:                "linux_authorized_keys",
			Label:             "Linux authorized_keys",
			Platform:          "linux",
			RemoteShell:       "posix",
			LocalCommand:      posixClassicAuthorizedKeysCommand(authorizedKeyLine),
			AuthorizedKeyLine: authorizedKeyLine,
		},
		{
			ID:                "macos_authorized_keys",
			Label:             "macOS authorized_keys",
			Platform:          "macos",
			RemoteShell:       "posix",
			LocalCommand:      macOSClassicAuthorizedKeysCommand(authorizedKeyLine),
			AuthorizedKeyLine: authorizedKeyLine,
		},
		{
			ID:                "windows_authorized_keys",
			Label:             "Windows OpenSSH authorized_keys",
			Platform:          "windows",
			RemoteShell:       "powershell",
			LocalCommand:      windowsClassicAuthorizedKeysCommand(authorizedKeyLine),
			AuthorizedKeyLine: authorizedKeyLine,
		},
	}
}

func classicAuthorizedKeyLine(publicKey string, allowedSourceAddresses []string) string {
	if len(allowedSourceAddresses) == 0 {
		return publicKey
	}
	return fmt.Sprintf("from=\"%s\" %s", strings.Join(allowedSourceAddresses, ","), publicKey)
}

func posixTrustedUserCACommand(publicKey string, group string, serviceName string) string {
	return strings.TrimSpace(fmt.Sprintf(`
set -eu
ca_file=/etc/ssh/shellorchestra_user_ca.pub
conf_dir=/etc/ssh/sshd_config.d
conf_file="$conf_dir/99-shellorchestra-user-ca.conf"
main_config=/etc/ssh/sshd_config
preferred_service='%s'
tmp_file=$(mktemp)
run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
    return
  fi
  if command -v doas >/dev/null 2>&1; then
    doas "$@"
    return
  fi
  echo "Root privileges are required. Run this command as root, or install/configure sudo or doas first." >&2
  exit 1
}
sshd_bin=$(command -v sshd 2>/dev/null || true)
if [ -z "$sshd_bin" ] && [ -x /usr/sbin/sshd ]; then
  sshd_bin=/usr/sbin/sshd
fi
if [ -z "$sshd_bin" ]; then
  echo "OpenSSH server binary was not found. Install and start OpenSSH Server before adding ShellOrchestra trust." >&2
  exit 1
fi
if [ ! -f "$main_config" ]; then
  echo "OpenSSH server config was not found at $main_config." >&2
  exit 1
fi
reload_ssh() {
  if command -v systemctl >/dev/null 2>&1; then
    for ssh_service in "$preferred_service" sshd ssh; do
      [ -n "$ssh_service" ] || continue
      if systemctl list-unit-files "$ssh_service.service" 2>/dev/null | grep -q "^$ssh_service\\.service[[:space:]]"; then
        run_root systemctl reload "$ssh_service"
        return
      fi
    done
  fi
  if command -v service >/dev/null 2>&1; then
    for ssh_service in "$preferred_service" sshd ssh; do
      [ -n "$ssh_service" ] || continue
      if service "$ssh_service" status >/dev/null 2>&1; then
        run_root service "$ssh_service" reload
        return
      fi
    done
  fi
  echo "OpenSSH configuration is valid, but SSH reload method was not detected. Reload ssh or sshd manually." >&2
  exit 1
}
printf '%%s\n' '%s' > "$tmp_file"
run_root install -d -o root -g %s -m 0755 "$(dirname "$ca_file")"
run_root install -o root -g %s -m 0644 "$tmp_file" "$ca_file"
rm -f "$tmp_file"
if [ -d "$conf_dir" ] || grep -Eq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf' "$main_config" 2>/dev/null; then
  run_root install -d -o root -g %s -m 0755 "$conf_dir"
  printf 'TrustedUserCAKeys /etc/ssh/shellorchestra_user_ca.pub\n' | run_root tee "$conf_file" >/dev/null
else
  if grep -Eq '^[[:space:]]*TrustedUserCAKeys[[:space:]]+/etc/ssh/shellorchestra_user_ca\.pub[[:space:]]*$' "$main_config" 2>/dev/null; then
    :
  elif grep -Eq '^[[:space:]]*TrustedUserCAKeys[[:space:]]+' "$main_config" 2>/dev/null; then
    echo "TrustedUserCAKeys is already configured in $main_config. Update it manually or remove the old directive before using this command." >&2
    exit 1
  else
    printf '\n# ShellOrchestra SSH CA\nTrustedUserCAKeys /etc/ssh/shellorchestra_user_ca.pub\n' | run_root tee -a "$main_config" >/dev/null
  fi
fi
run_root "$sshd_bin" -t -f "$main_config"
reload_ssh`, shellSingleQuote(serviceName), shellSingleQuote(publicKey), shellSingleQuote(group), shellSingleQuote(group), shellSingleQuote(group)))
}

func alpineTrustedUserCACommand(publicKey string) string {
	return strings.TrimSpace(fmt.Sprintf(`
set -eu
ca_file=/etc/ssh/shellorchestra_user_ca.pub
conf_dir=/etc/ssh/sshd_config.d
conf_file="$conf_dir/99-shellorchestra-user-ca.conf"
main_config=/etc/ssh/sshd_config
tmp_file=$(mktemp)
run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
    return
  fi
  if command -v doas >/dev/null 2>&1; then
    doas "$@"
    return
  fi
  echo "Root privileges are required. Run this command as root, or install/configure sudo or doas first." >&2
  exit 1
}
sshd_bin=$(command -v sshd 2>/dev/null || true)
if [ -z "$sshd_bin" ] && [ -x /usr/sbin/sshd ]; then
  sshd_bin=/usr/sbin/sshd
fi
if [ -z "$sshd_bin" ]; then
  echo "OpenSSH server binary was not found. Install and start Alpine openssh before adding ShellOrchestra trust." >&2
  exit 1
fi
if [ ! -f "$main_config" ]; then
  echo "OpenSSH server config was not found at $main_config." >&2
  exit 1
fi
printf '%%s\n' '%s' > "$tmp_file"
run_root install -d -o root -g root -m 0755 "$(dirname "$ca_file")"
run_root install -o root -g root -m 0644 "$tmp_file" "$ca_file"
rm -f "$tmp_file"
if [ -d "$conf_dir" ] || grep -Eq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf' "$main_config" 2>/dev/null; then
  run_root install -d -o root -g root -m 0755 "$conf_dir"
  printf 'TrustedUserCAKeys /etc/ssh/shellorchestra_user_ca.pub\n' | run_root tee "$conf_file" >/dev/null
else
  if run_root grep -Eq '^[[:space:]]*TrustedUserCAKeys[[:space:]]+' "$main_config" 2>/dev/null; then
    echo "TrustedUserCAKeys is already configured in $main_config. Update it manually or remove the old directive before using this command." >&2
    exit 1
  fi
  printf '\n# ShellOrchestra SSH CA\nTrustedUserCAKeys /etc/ssh/shellorchestra_user_ca.pub\n' | run_root tee -a "$main_config" >/dev/null
fi
run_root "$sshd_bin" -t -f "$main_config"
if ! command -v service >/dev/null 2>&1; then
  echo "OpenRC service command was not found. SSH configuration is valid; reload sshd manually." >&2
  exit 1
fi
run_root service sshd status >/dev/null 2>&1 || {
  echo "OpenRC sshd service is not running or is not registered. Start sshd, then rerun this command." >&2
  exit 1
}
run_root service sshd reload`, shellSingleQuote(publicKey)))
}

func posixClassicAuthorizedKeysCommand(authorizedKeyLine string) string {
	return strings.TrimSpace(fmt.Sprintf(`
set -eu
target_user=${SHELLORCHESTRA_TARGET_USER:-root}
run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
    return
  fi
  if command -v doas >/dev/null 2>&1; then
    doas "$@"
    return
  fi
  echo "Root privileges are required. Run this command as root, or install/configure sudo or doas first." >&2
  exit 1
}
target_home=$(getent passwd "$target_user" | cut -d: -f6)
if [ -z "$target_home" ]; then
  echo "Target user was not found: $target_user" >&2
  exit 1
fi
target_group=$(id -gn "$target_user")
ssh_dir="$target_home/.ssh"
authorized_keys="$ssh_dir/authorized_keys"
entry='%s'
run_root install -d -o "$target_user" -g "$target_group" -m 0700 "$ssh_dir"
run_root touch "$authorized_keys"
run_root chown "$target_user:$target_group" "$authorized_keys"
run_root chmod 0600 "$authorized_keys"
if ! run_root grep -qxF "$entry" "$authorized_keys" 2>/dev/null; then
  printf '%%s\n' "$entry" | run_root tee -a "$authorized_keys" >/dev/null
fi`, shellSingleQuote(authorizedKeyLine)))
}

func macOSTrustedUserCACommand(publicKey string) string {
	return strings.TrimSpace(fmt.Sprintf(`
set -eu
ca_file=/etc/ssh/shellorchestra_user_ca.pub
tmp_file=$(mktemp)
printf '%%s\n' '%s' > "$tmp_file"
sudo install -o root -g wheel -m 0644 "$tmp_file" "$ca_file"
rm -f "$tmp_file"
if ! sudo grep -Eq '^[[:space:]]*TrustedUserCAKeys[[:space:]]+/etc/ssh/shellorchestra_user_ca.pub[[:space:]]*$' /etc/ssh/sshd_config; then
  printf '\nTrustedUserCAKeys /etc/ssh/shellorchestra_user_ca.pub\n' | sudo tee -a /etc/ssh/sshd_config >/dev/null
fi
sudo /usr/sbin/sshd -t -f /etc/ssh/sshd_config
sudo launchctl kickstart -k system/com.openssh.sshd`, shellSingleQuote(publicKey)))
}

func macOSClassicAuthorizedKeysCommand(authorizedKeyLine string) string {
	return strings.TrimSpace(fmt.Sprintf(`
set -eu
target_user=${SHELLORCHESTRA_TARGET_USER:-root}
if [ "$target_user" = "root" ]; then
  target_home=/var/root
else
  target_home=$(dscl . -read "/Users/$target_user" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
fi
if [ -z "$target_home" ]; then
  echo "Target user was not found: $target_user" >&2
  exit 1
fi
target_group=$(id -gn "$target_user")
ssh_dir="$target_home/.ssh"
authorized_keys="$ssh_dir/authorized_keys"
entry='%s'
sudo install -d -o "$target_user" -g "$target_group" -m 0700 "$ssh_dir"
sudo touch "$authorized_keys"
sudo chown "$target_user:$target_group" "$authorized_keys"
sudo chmod 0600 "$authorized_keys"
if ! sudo grep -qxF "$entry" "$authorized_keys" 2>/dev/null; then
  printf '%%s\n' "$entry" | sudo tee -a "$authorized_keys" >/dev/null
fi`, shellSingleQuote(authorizedKeyLine)))
}

func windowsTrustedUserCACommand(publicKey string) string {
	return strings.TrimSpace(fmt.Sprintf(`
$ErrorActionPreference = "Stop"
$caFile = Join-Path $env:ProgramData "ssh\shellorchestra_user_ca.pub"
$confFile = Join-Path $env:ProgramData "ssh\sshd_config"
New-Item -ItemType Directory -Force -Path (Split-Path $caFile) | Out-Null
Set-Content -Path $caFile -Value "%s" -Encoding ascii
if (!(Test-Path $confFile)) {
  throw "OpenSSH server config was not found at $confFile"
}
$caFileForConfig = $caFile.Replace('\', '/')
$line = "TrustedUserCAKeys $caFileForConfig"
$content = Get-Content -Path $confFile -ErrorAction Stop
$trustedLines = @($content | Where-Object { $_ -match '^\s*TrustedUserCAKeys\s+' })
$matchingTrustedLines = @($trustedLines | Where-Object {
  $configuredPath = ($_ -replace '^\s*TrustedUserCAKeys\s+', '').Trim().Replace('\', '/')
  $configuredPath -eq $caFileForConfig
})
if ($trustedLines.Count -gt 0 -and $matchingTrustedLines.Count -eq 0) {
  throw "TrustedUserCAKeys is already configured differently in $confFile"
}
if ($matchingTrustedLines.Count -eq 0) {
  Add-Content -Path $confFile -Value $line -Encoding ascii
}
& "$env:WINDIR\System32\OpenSSH\sshd.exe" -t -f $confFile
Restart-Service sshd`, powershellDoubleQuote(publicKey)))
}

func windowsClassicAuthorizedKeysCommand(authorizedKeyLine string) string {
	return strings.TrimSpace(fmt.Sprintf(`
$ErrorActionPreference = "Stop"
$targetUser = if ($env:SHELLORCHESTRA_TARGET_USER) { $env:SHELLORCHESTRA_TARGET_USER } else { "Administrator" }
$profileDir = if ($targetUser -eq $env:USERNAME) { $HOME } else { Join-Path $env:SystemDrive "Users\$targetUser" }
if (!(Test-Path $profileDir)) {
  throw "Target user profile was not found: $profileDir"
}
$sshDir = Join-Path $profileDir ".ssh"
$authorizedKeys = Join-Path $sshDir "authorized_keys"
$entry = "%s"
New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
if (!(Test-Path $authorizedKeys)) {
  New-Item -ItemType File -Force -Path $authorizedKeys | Out-Null
}
$content = Get-Content -Path $authorizedKeys -ErrorAction Stop
if ($content -notcontains $entry) {
  Add-Content -Path $authorizedKeys -Value $entry -Encoding ascii
}`, powershellDoubleQuote(authorizedKeyLine)))
}

func shellSingleQuote(value string) string {
	return strings.ReplaceAll(value, "'", "'\\''")
}

func powershellDoubleQuote(value string) string {
	escaped := strings.ReplaceAll(value, "`", "``")
	escaped = strings.ReplaceAll(escaped, "$", "`$")
	return strings.ReplaceAll(escaped, "\"", "`\"")
}

func (a *App) sshSecuritySettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		settings, err := a.deps.Store.GetSSHSecuritySettings(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, sshSecuritySettingsResponse(settings))
	case http.MethodPut:
		var body struct {
			AllowedSourceAddresses     []string `json:"allowed_source_addresses"`
			CertTTLMinutes             int      `json:"cert_ttl_minutes"`
			AccessTokenTTLMinutes      int      `json:"access_token_ttl_minutes"`
			LightStatusIntervalSeconds int      `json:"light_status_interval_seconds"`
			DetectionIntervalSeconds   int      `json:"detection_interval_seconds"`
			PeriodicScriptTickSeconds  int      `json:"periodic_script_tick_seconds"`
		}
		if !decodeJSON(w, r, &body) {
			return
		}
		addresses, err := normalizeAllowedSourceAddresses(body.AllowedSourceAddresses)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		settings := store.SSHSecuritySettings{
			AllowedSourceAddresses:     addresses,
			CertTTLMinutes:             body.CertTTLMinutes,
			AccessTokenTTLMinutes:      body.AccessTokenTTLMinutes,
			LightStatusIntervalSeconds: body.LightStatusIntervalSeconds,
			DetectionIntervalSeconds:   body.DetectionIntervalSeconds,
			PeriodicScriptTickSeconds:  body.PeriodicScriptTickSeconds,
			UpdatedAt:                  time.Now().UTC(),
		}
		if settings.CertTTLMinutes <= 0 || settings.AccessTokenTTLMinutes <= 0 || settings.LightStatusIntervalSeconds <= 0 || settings.DetectionIntervalSeconds <= 0 || settings.PeriodicScriptTickSeconds <= 0 {
			current, err := a.deps.Store.GetSSHSecuritySettings(r.Context())
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			if settings.CertTTLMinutes <= 0 {
				settings.CertTTLMinutes = current.CertTTLMinutes
			}
			if settings.AccessTokenTTLMinutes <= 0 {
				settings.AccessTokenTTLMinutes = current.AccessTokenTTLMinutes
			}
			if settings.LightStatusIntervalSeconds <= 0 {
				settings.LightStatusIntervalSeconds = current.LightStatusIntervalSeconds
			}
			if settings.DetectionIntervalSeconds <= 0 {
				settings.DetectionIntervalSeconds = current.DetectionIntervalSeconds
			}
			if settings.PeriodicScriptTickSeconds <= 0 {
				settings.PeriodicScriptTickSeconds = current.PeriodicScriptTickSeconds
			}
		}
		if err := a.deps.Store.SaveSSHSecuritySettings(r.Context(), settings); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if a.deps.Runtime != nil {
			a.deps.Runtime.SetAllowedSourceAddresses(settings.AllowedSourceAddresses)
			a.deps.Runtime.SetCertificateTTL(time.Duration(settings.CertTTLMinutes) * time.Minute)
		}
		writeJSON(w, http.StatusOK, sshSecuritySettingsResponse(settings))
	default:
		methodNotAllowed(w)
	}
}

func sshSecuritySettingsResponse(settings store.SSHSecuritySettings) map[string]any {
	return map[string]any{
		"allowed_source_addresses":      settings.AllowedSourceAddresses,
		"allows_any_source":             len(settings.AllowedSourceAddresses) == 0,
		"cert_ttl_minutes":              settings.CertTTLMinutes,
		"access_token_ttl_minutes":      settings.AccessTokenTTLMinutes,
		"light_status_interval_seconds": settings.LightStatusIntervalSeconds,
		"detection_interval_seconds":    settings.DetectionIntervalSeconds,
		"periodic_script_tick_seconds":  settings.PeriodicScriptTickSeconds,
		"updated_at":                    settings.UpdatedAt.Format(time.RFC3339),
	}
}

func normalizeAllowedSourceAddresses(values []string) ([]string, error) {
	seen := map[string]struct{}{}
	normalized := []string{}
	for _, value := range values {
		for _, token := range strings.FieldsFunc(value, func(r rune) bool {
			return r == ',' || r == ';' || r == '\n' || r == '\r' || r == '\t' || r == ' '
		}) {
			item, err := normalizeAllowedSourceAddress(token)
			if err != nil {
				return nil, err
			}
			if _, exists := seen[item]; exists {
				continue
			}
			seen[item] = struct{}{}
			normalized = append(normalized, item)
		}
	}
	return normalized, nil
}

func normalizeAllowedSourceAddress(value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", fmt.Errorf("empty source address is not allowed")
	}
	if ip := net.ParseIP(trimmed); ip != nil {
		return ip.String(), nil
	}
	ip, network, err := net.ParseCIDR(trimmed)
	if err != nil {
		return "", fmt.Errorf("allowed source %q must be an IP address or CIDR network", trimmed)
	}
	network.IP = ip.Mask(network.Mask)
	return network.String(), nil
}

func (a *App) uiSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		settings, err := a.deps.Store.GetUISettings(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, a.uiSettingsResponse(settings))
	case http.MethodPut:
		var body struct {
			WallpaperChoice               string  `json:"wallpaper_choice"`
			WallpaperDimPercent           int     `json:"wallpaper_dim_percent"`
			WallpaperOverridden           bool    `json:"wallpaper_overridden"`
			LocaleOverride                *string `json:"locale_override"`
			TimezoneOverride              *string `json:"timezone_override"`
			TerminalFontSize              *int    `json:"terminal_font_size"`
			TerminalScrollbackLines       *int    `json:"terminal_scrollback_lines"`
			TerminalCursorStyle           *string `json:"terminal_cursor_style"`
			TerminalKeymapLayout          *string `json:"terminal_keymap_layout"`
			TerminalSuppressTouchKeyboard *bool   `json:"terminal_suppress_touch_keyboard"`
			TerminalTmuxPrefixGuard       *bool   `json:"terminal_tmux_prefix_guard"`
			DesktopControlHeightPX        *int    `json:"desktop_control_height_px"`
			DesktopWindowPaddingPX        *int    `json:"desktop_window_padding_px"`
			DesktopTaskbarPaddingPX       *int    `json:"desktop_taskbar_padding_px"`
			DesktopTaskbarPaddingYPX      *int    `json:"desktop_taskbar_padding_y_px"`
			DesktopToolbarPaddingXPX      *int    `json:"desktop_toolbar_padding_x_px"`
			DesktopToolbarPaddingYPX      *int    `json:"desktop_toolbar_padding_y_px"`
			DesktopToastVisibleMS         *int    `json:"desktop_toast_visible_ms"`
			DesktopToastFadeMS            *int    `json:"desktop_toast_fade_ms"`
		}
		if !decodeJSON(w, r, &body) {
			return
		}
		current, err := a.deps.Store.GetUISettings(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		current.WallpaperChoice = store.WallpaperChoice(strings.TrimSpace(body.WallpaperChoice))
		current.WallpaperDimPercent = body.WallpaperDimPercent
		current.WallpaperOverridden = body.WallpaperOverridden
		current.LocaleOverride = trimmedOptionalString(body.LocaleOverride)
		current.TimezoneOverride = trimmedOptionalString(body.TimezoneOverride)
		if body.TerminalFontSize != nil {
			current.TerminalFontSize = *body.TerminalFontSize
		}
		if body.TerminalScrollbackLines != nil {
			current.TerminalScrollbackLines = *body.TerminalScrollbackLines
		}
		if body.TerminalCursorStyle != nil {
			current.TerminalCursorStyle = strings.TrimSpace(*body.TerminalCursorStyle)
		}
		if body.TerminalKeymapLayout != nil {
			current.TerminalKeymapLayout = strings.TrimSpace(*body.TerminalKeymapLayout)
		}
		if body.TerminalSuppressTouchKeyboard != nil {
			current.TerminalSuppressKeyboard = *body.TerminalSuppressTouchKeyboard
		}
		if body.TerminalTmuxPrefixGuard != nil {
			current.TerminalTmuxPrefixGuard = *body.TerminalTmuxPrefixGuard
		}
		if body.DesktopControlHeightPX != nil {
			current.DesktopControlHeightPX = *body.DesktopControlHeightPX
		}
		if body.DesktopWindowPaddingPX != nil {
			current.DesktopWindowPaddingPX = *body.DesktopWindowPaddingPX
		}
		if body.DesktopTaskbarPaddingPX != nil {
			current.DesktopTaskbarPaddingPX = *body.DesktopTaskbarPaddingPX
		}
		if body.DesktopTaskbarPaddingYPX != nil {
			current.DesktopTaskbarPaddingYPX = *body.DesktopTaskbarPaddingYPX
		}
		if body.DesktopToolbarPaddingXPX != nil {
			current.DesktopToolbarPaddingXPX = *body.DesktopToolbarPaddingXPX
		}
		if body.DesktopToolbarPaddingYPX != nil {
			current.DesktopToolbarPaddingYPX = *body.DesktopToolbarPaddingYPX
		}
		if body.DesktopToastVisibleMS != nil {
			current.DesktopToastVisibleMS = *body.DesktopToastVisibleMS
		}
		if body.DesktopToastFadeMS != nil {
			current.DesktopToastFadeMS = *body.DesktopToastFadeMS
		}
		current.UpdatedAt = time.Now().UTC()
		if current.WallpaperChoice == store.WallpaperCustom && !a.customWallpaperAvailable(current) {
			writeError(w, http.StatusBadRequest, "Upload a custom wallpaper before selecting Custom.")
			return
		}
		if err := a.deps.Store.SaveUISettings(r.Context(), current); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, a.uiSettingsResponse(current))
	default:
		methodNotAllowed(w)
	}
}

func (a *App) customWallpaper(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.serveCustomWallpaper(w, r)
	case http.MethodPost:
		a.uploadCustomWallpaper(w, r)
	default:
		methodNotAllowed(w)
	}
}

func (a *App) desktopWallpapers(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		wallpapers, err := a.deps.Store.ListVirtualDesktopWallpapers(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		items := make([]map[string]any, 0, len(wallpapers))
		for _, wallpaper := range wallpapers {
			items = append(items, a.virtualDesktopWallpaperResponse(wallpaper))
		}
		writeJSON(w, http.StatusOK, map[string]any{"wallpapers": items})
	case http.MethodPost:
		a.uploadVirtualDesktopWallpaper(w, r)
	default:
		methodNotAllowed(w)
	}
}

func (a *App) desktopWallpaperByID(w http.ResponseWriter, r *http.Request) {
	id, rest := splitIDPath(strings.TrimPrefix(r.URL.Path, "/api/desktop-wallpapers/"))
	if id == "" || rest != "" {
		writeError(w, http.StatusNotFound, "Virtual desktop wallpaper was not found.")
		return
	}
	normalizedID, ok := normalizeUUIDPathID(id)
	if !ok {
		writeError(w, http.StatusNotFound, "Virtual desktop wallpaper was not found.")
		return
	}
	switch r.Method {
	case http.MethodGet:
		a.serveVirtualDesktopWallpaper(w, r, normalizedID)
	case http.MethodDelete:
		a.deleteVirtualDesktopWallpaper(w, r, normalizedID)
	default:
		methodNotAllowed(w)
	}
}

func (a *App) uploadVirtualDesktopWallpaper(w http.ResponseWriter, r *http.Request) {
	const maxWallpaperBytes = 10 << 20
	r.Body = http.MaxBytesReader(w, r.Body, maxWallpaperBytes+1024*1024)
	data, ok := readWallpaperUpload(w, r, maxWallpaperBytes)
	if !ok {
		return
	}
	if len(data) == 0 {
		writeError(w, http.StatusBadRequest, "Wallpaper file is required.")
		return
	}
	if len(data) > maxWallpaperBytes {
		writeError(w, http.StatusBadRequest, "Wallpaper file is too large. Upload an image up to 10 MB.")
		return
	}
	contentType := http.DetectContentType(data[:min(len(data), 512)])
	if !allowedWallpaperContentType(contentType) {
		writeError(w, http.StatusBadRequest, "Wallpaper must be PNG, JPEG, or WebP.")
		return
	}
	wallpaper := domain.VirtualDesktopWallpaper{
		ID:          uuid.NewString(),
		Label:       strings.TrimSpace(r.URL.Query().Get("label")),
		ContentType: contentType,
		Source:      "upload",
	}
	if wallpaper.Label == "" {
		wallpaper.Label = "Custom wallpaper"
	}
	path, err := a.virtualDesktopWallpaperPath(wallpaper.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	created, err := a.deps.Store.CreateVirtualDesktopWallpaper(r.Context(), wallpaper)
	if err != nil {
		_ = os.Remove(tmp)
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	finalPath, err := a.virtualDesktopWallpaperPath(created.ID)
	if err != nil {
		_ = os.Remove(tmp)
		_ = a.deps.Store.DeleteVirtualDesktopWallpaper(r.Context(), created.ID)
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := os.Rename(tmp, finalPath); err != nil {
		_ = os.Remove(tmp)
		_ = a.deps.Store.DeleteVirtualDesktopWallpaper(r.Context(), created.ID)
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, a.virtualDesktopWallpaperResponse(created))
}

func (a *App) serveVirtualDesktopWallpaper(w http.ResponseWriter, r *http.Request, id string) {
	wallpaper, err := a.deps.Store.GetVirtualDesktopWallpaper(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	path, err := a.virtualDesktopWallpaperPath(wallpaper.ID)
	if err != nil {
		writeError(w, http.StatusNotFound, "Virtual desktop wallpaper image is not available.")
		return
	}
	file, err := os.Open(path)
	if err != nil {
		writeError(w, http.StatusNotFound, "Virtual desktop wallpaper image is not available.")
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", wallpaper.ContentType)
	w.Header().Set("Cache-Control", "private, max-age=300")
	http.ServeContent(w, r, wallpaper.ID, info.ModTime(), file)
}

func (a *App) deleteVirtualDesktopWallpaper(w http.ResponseWriter, r *http.Request, id string) {
	path, err := a.virtualDesktopWallpaperPath(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "Virtual desktop wallpaper was not found.")
		return
	}
	if err := a.deps.Store.DeleteVirtualDesktopWallpaper(r.Context(), id); err != nil {
		writeStoreError(w, err)
		return
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) serveCustomWallpaper(w http.ResponseWriter, r *http.Request) {
	settings, err := a.deps.Store.GetUISettings(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !a.customWallpaperAvailable(settings) {
		writeError(w, http.StatusNotFound, "Custom wallpaper is not uploaded.")
		return
	}
	file, err := os.Open(a.customWallpaperPath())
	if err != nil {
		writeError(w, http.StatusNotFound, "Custom wallpaper is not available.")
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", settings.CustomWallpaperContentType)
	w.Header().Set("Cache-Control", "private, max-age=300")
	http.ServeContent(w, r, "custom-wallpaper", info.ModTime(), file)
}

func (a *App) uploadCustomWallpaper(w http.ResponseWriter, r *http.Request) {
	const maxWallpaperBytes = 10 << 20
	r.Body = http.MaxBytesReader(w, r.Body, maxWallpaperBytes+1024*1024)
	data, ok := readWallpaperUpload(w, r, maxWallpaperBytes)
	if !ok {
		return
	}
	if len(data) == 0 {
		writeError(w, http.StatusBadRequest, "Wallpaper file is required.")
		return
	}
	if len(data) > maxWallpaperBytes {
		writeError(w, http.StatusBadRequest, "Wallpaper file is too large. Upload an image up to 10 MB.")
		return
	}
	contentType := http.DetectContentType(data[:min(len(data), 512)])
	if !allowedWallpaperContentType(contentType) {
		writeError(w, http.StatusBadRequest, "Wallpaper must be PNG, JPEG, or WebP.")
		return
	}
	path := a.customWallpaperPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	settings, err := a.deps.Store.GetUISettings(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	settings.WallpaperChoice = store.WallpaperCustom
	settings.WallpaperOverridden = true
	settings.CustomWallpaperContentType = contentType
	settings.UpdatedAt = time.Now().UTC()
	if err := a.deps.Store.SaveUISettings(r.Context(), settings); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, a.uiSettingsResponse(settings))
}

func readWallpaperUpload(w http.ResponseWriter, r *http.Request, maxWallpaperBytes int64) ([]byte, bool) {
	contentType := strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Type")))
	if strings.HasPrefix(contentType, "image/") {
		data, err := io.ReadAll(io.LimitReader(r.Body, maxWallpaperBytes+1))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Cannot read uploaded wallpaper.")
			return nil, false
		}
		return data, true
	}
	reader, err := r.MultipartReader()
	if err != nil {
		writeError(w, http.StatusBadRequest, "Upload an image file as the request body or as a multipart wallpaper field.")
		return nil, false
	}
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			writeError(w, http.StatusBadRequest, "Cannot read uploaded wallpaper.")
			return nil, false
		}
		if part.FormName() != "wallpaper" {
			continue
		}
		data, err := io.ReadAll(io.LimitReader(part, maxWallpaperBytes+1))
		if err != nil {
			writeError(w, http.StatusBadRequest, "Cannot read uploaded wallpaper.")
			return nil, false
		}
		return data, true
	}
	return nil, true
}

func (a *App) uiSettingsResponse(settings store.UISettings) map[string]any {
	return map[string]any{
		"wallpaper_choice":                 settings.WallpaperChoice,
		"wallpaper_dim_percent":            settings.WallpaperDimPercent,
		"wallpaper_overridden":             settings.WallpaperOverridden,
		"locale_override":                  nullableString(settings.LocaleOverride),
		"timezone_override":                nullableString(settings.TimezoneOverride),
		"terminal_font_size":               settings.TerminalFontSize,
		"terminal_scrollback_lines":        settings.TerminalScrollbackLines,
		"terminal_cursor_style":            settings.TerminalCursorStyle,
		"terminal_keymap_layout":           settings.TerminalKeymapLayout,
		"terminal_suppress_touch_keyboard": settings.TerminalSuppressKeyboard,
		"terminal_tmux_prefix_guard":       settings.TerminalTmuxPrefixGuard,
		"desktop_control_height_px":        settings.DesktopControlHeightPX,
		"desktop_window_padding_px":        settings.DesktopWindowPaddingPX,
		"desktop_taskbar_padding_px":       settings.DesktopTaskbarPaddingPX,
		"desktop_taskbar_padding_y_px":     settings.DesktopTaskbarPaddingYPX,
		"desktop_toolbar_padding_x_px":     settings.DesktopToolbarPaddingXPX,
		"desktop_toolbar_padding_y_px":     settings.DesktopToolbarPaddingYPX,
		"desktop_toast_visible_ms":         settings.DesktopToastVisibleMS,
		"desktop_toast_fade_ms":            settings.DesktopToastFadeMS,
		"custom_wallpaper_available":       a.customWallpaperAvailable(settings),
		"custom_wallpaper_url":             nullableString(a.customWallpaperURL(settings)),
		"custom_wallpaper_content_type":    nullableString(settings.CustomWallpaperContentType),
		"updated_at":                       settings.UpdatedAt,
	}
}

func (a *App) customWallpaperURL(settings store.UISettings) string {
	if !a.customWallpaperAvailable(settings) {
		return ""
	}
	return "/api/settings/wallpaper/custom?v=" + fmt.Sprintf("%d", settings.UpdatedAt.Unix())
}

func (a *App) customWallpaperAvailable(settings store.UISettings) bool {
	if strings.TrimSpace(settings.CustomWallpaperContentType) == "" {
		return false
	}
	info, err := os.Stat(a.customWallpaperPath())
	return err == nil && !info.IsDir() && info.Size() > 0
}

func (a *App) customWallpaperPath() string {
	return filepath.Join(filepath.Dir(a.deps.Config.Database.Path), "custom-wallpaper")
}

func (a *App) virtualDesktopWallpaperResponse(wallpaper domain.VirtualDesktopWallpaper) map[string]any {
	url := ""
	if id, ok := exactUUIDPathID(wallpaper.ID); ok {
		url = "/api/desktop-wallpapers/" + id + "?v=" + fmt.Sprintf("%d", wallpaper.UpdatedAt.Unix())
	}
	return map[string]any{
		"id":           wallpaper.ID,
		"label":        wallpaper.Label,
		"content_type": wallpaper.ContentType,
		"source":       wallpaper.Source,
		"url":          url,
		"created_at":   wallpaper.CreatedAt,
		"updated_at":   wallpaper.UpdatedAt,
	}
}

func (a *App) virtualDesktopWallpaperPath(id string) (string, error) {
	normalizedID, ok := exactUUIDPathID(id)
	if !ok {
		return "", fmt.Errorf("virtual desktop wallpaper id must be a canonical UUID")
	}
	return filepath.Join(filepath.Dir(a.deps.Config.Database.Path), "virtual-desktop-wallpapers", normalizedID), nil
}

func normalizeUUIDPathID(value string) (string, bool) {
	parsed, err := uuid.Parse(strings.TrimSpace(value))
	if err != nil {
		return "", false
	}
	return parsed.String(), true
}

func exactUUIDPathID(value string) (string, bool) {
	parsed, err := uuid.Parse(value)
	if err != nil {
		return "", false
	}
	normalized := parsed.String()
	return normalized, normalized == value
}

func allowedWallpaperContentType(contentType string) bool {
	switch contentType {
	case "image/png", "image/jpeg", "image/webp":
		return true
	default:
		return false
	}
}

func (a *App) batchScripts(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		templates, err := a.deps.Store.ListBatchScriptTemplates(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"scripts": templates, "examples": batchScriptExamples()})
	case http.MethodPost:
		var input domain.BatchScriptTemplateInput
		if !decodeJSON(w, r, &input) {
			return
		}
		if err := a.validateBatchScriptServerIDs(r.Context(), input.TargetSelector.ServerIDs); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		template, err := a.deps.Store.CreateBatchScriptTemplate(r.Context(), input)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, template)
	default:
		methodNotAllowed(w)
	}
}

func (a *App) batchScriptByID(w http.ResponseWriter, r *http.Request) {
	id, rest := splitIDPath(strings.TrimPrefix(r.URL.Path, "/api/global-apps/batch-scripts/"))
	if id == "" {
		writeError(w, http.StatusNotFound, "Batch script was not found.")
		return
	}
	if id == "preview" && rest == "" {
		a.batchScriptPreview(w, r)
		return
	}
	if _, err := uuid.Parse(id); err != nil {
		writeError(w, http.StatusNotFound, "Batch script was not found.")
		return
	}
	if rest == "/runs" {
		a.batchScriptRuns(w, r, id)
		return
	}
	if strings.HasPrefix(rest, "/runs/") {
		runID, runRest := splitIDPath(strings.TrimPrefix(rest, "/runs/"))
		if _, err := uuid.Parse(runID); err != nil {
			writeError(w, http.StatusNotFound, "Batch script run was not found.")
			return
		}
		if strings.HasPrefix(runRest, "/targets/") {
			a.batchScriptRunTargetOutput(w, r, id, runID, strings.TrimPrefix(runRest, "/targets/"))
			return
		}
		if runRest != "" {
			writeError(w, http.StatusNotFound, "Batch script run was not found.")
			return
		}
		a.batchScriptRunByID(w, r, id, runID)
		return
	}
	if rest != "" {
		writeError(w, http.StatusNotFound, "Batch script was not found.")
		return
	}
	_, ok := exactUUIDPathID(id)
	if !ok {
		writeError(w, http.StatusNotFound, "Batch script was not found.")
		return
	}
	switch r.Method {
	case http.MethodGet:
		template, err := a.deps.Store.GetBatchScriptTemplate(r.Context(), id)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) || errors.Is(err, store.ErrNotFound) {
				writeError(w, http.StatusNotFound, "Batch script was not found.")
				return
			}
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, template)
	case http.MethodPut:
		var input domain.BatchScriptTemplateInput
		if !decodeJSON(w, r, &input) {
			return
		}
		if err := a.validateBatchScriptServerIDs(r.Context(), input.TargetSelector.ServerIDs); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		template, err := a.deps.Store.UpdateBatchScriptTemplate(r.Context(), id, input)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) || errors.Is(err, store.ErrNotFound) {
				writeError(w, http.StatusNotFound, "Batch script was not found.")
				return
			}
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, template)
	case http.MethodDelete:
		if err := a.deps.Store.DeleteBatchScriptTemplate(r.Context(), id); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeError(w, http.StatusNotFound, "Batch script was not found.")
				return
			}
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		methodNotAllowed(w)
	}
}

type backupBucketCreateRequest struct {
	Label      string `json:"label"`
	ServerID   string `json:"server_id"`
	RootPath   string `json:"root_path"`
	BucketName string `json:"bucket_name"`
}

type backupPathRequest struct {
	ServerID        string `json:"server_id"`
	RootPath        string `json:"root_path"`
	BucketName      string `json:"bucket_name"`
	Label           string `json:"label"`
	SourcePath      string `json:"source_path"`
	ExcludePatterns string `json:"exclude_patterns"`
}

func (a *App) backupBuckets(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		buckets, err := a.deps.Store.ListBackupBuckets(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"buckets": buckets})
	case http.MethodPost:
		var input backupBucketCreateRequest
		if !decodeJSON(w, r, &input) {
			return
		}
		server, err := a.deps.Store.GetServer(r.Context(), input.ServerID)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		args := map[string]string{
			"backup_root_path":    strings.TrimSpace(input.RootPath),
			"backup_bucket_name":  backupBucketFolderName(input.BucketName),
			"backup_bucket_label": strings.TrimSpace(input.Label),
		}
		result, err := a.runBackupJSON(r.Context(), server, "backup_bucket_create", args)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		bucket, err := a.deps.Store.CreateBackupBucket(r.Context(), domain.BackupBucketInput{
			Label:          firstNonEmpty(strings.TrimSpace(input.Label), server.Name+" backups"),
			ServerID:       server.ID,
			RootPath:       strings.TrimSpace(input.RootPath),
			BucketPath:     stringFromResult(result, "bucket_path"),
			Filesystem:     stringFromResult(result, "filesystem"),
			FreeBytes:      int64FromResult(result, "free_bytes"),
			TotalBytes:     int64FromResult(result, "total_bytes"),
			ManifestStatus: firstNonEmpty(stringFromResult(result, "manifest_status"), "ok"),
		})
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"bucket": bucket, "probe": result})
	default:
		methodNotAllowed(w)
	}
}

func (a *App) backupBucketByID(w http.ResponseWriter, r *http.Request) {
	id, rest := splitIDPath(strings.TrimPrefix(r.URL.Path, "/api/global-apps/backup-manager/buckets/"))
	if rest != "" {
		writeError(w, http.StatusNotFound, "Backup bucket was not found.")
		return
	}
	if _, err := uuid.Parse(id); err != nil {
		writeError(w, http.StatusNotFound, "Backup bucket was not found.")
		return
	}
	switch r.Method {
	case http.MethodGet:
		bucket, err := a.deps.Store.GetBackupBucket(r.Context(), id)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, bucket)
	case http.MethodDelete:
		if err := a.deps.Store.DeleteBackupBucket(r.Context(), id); err != nil {
			writeStoreError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		methodNotAllowed(w)
	}
}

func (a *App) backupTasks(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		tasks, err := a.deps.Store.ListBackupTasks(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"tasks": tasks})
	case http.MethodPost:
		var input domain.BackupTaskInput
		if !decodeJSON(w, r, &input) {
			return
		}
		if err := a.validateBackupTaskInput(r.Context(), input); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		task, err := a.deps.Store.CreateBackupTask(r.Context(), input)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, task)
	default:
		methodNotAllowed(w)
	}
}

func (a *App) backupTaskByID(w http.ResponseWriter, r *http.Request) {
	id, rest := splitIDPath(strings.TrimPrefix(r.URL.Path, "/api/global-apps/backup-manager/tasks/"))
	if id == "" {
		writeError(w, http.StatusNotFound, "Backup task was not found.")
		return
	}
	if rest == "/runs" {
		a.backupTaskRuns(w, r, id)
		return
	}
	if strings.HasPrefix(rest, "/runs/") {
		runID, runRest := splitIDPath(strings.TrimPrefix(rest, "/runs/"))
		if runRest != "" {
			writeError(w, http.StatusNotFound, "Backup run was not found.")
			return
		}
		a.backupTaskRunByID(w, r, id, runID)
		return
	}
	if rest != "" {
		writeError(w, http.StatusNotFound, "Backup task was not found.")
		return
	}
	if _, err := uuid.Parse(id); err != nil {
		writeError(w, http.StatusNotFound, "Backup task was not found.")
		return
	}
	switch r.Method {
	case http.MethodGet:
		task, err := a.deps.Store.GetBackupTask(r.Context(), id)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, task)
	case http.MethodPut:
		var input domain.BackupTaskInput
		if !decodeJSON(w, r, &input) {
			return
		}
		if err := a.validateBackupTaskInput(r.Context(), input); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		task, err := a.deps.Store.UpdateBackupTask(r.Context(), id, input)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, task)
	case http.MethodDelete:
		if err := a.deps.Store.DeleteBackupTask(r.Context(), id); err != nil {
			writeStoreError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		methodNotAllowed(w)
	}
}

func (a *App) validateBackupTaskInput(ctx context.Context, input domain.BackupTaskInput) error {
	sourceServerID := strings.TrimSpace(input.SourceServerID)
	if sourceServerID == "" {
		return fmt.Errorf("backup task source server is required")
	}
	if _, err := a.deps.Store.GetServer(ctx, sourceServerID); err != nil {
		return fmt.Errorf("backup task source server was not found")
	}
	targetBucketID := strings.TrimSpace(input.TargetBucketID)
	if targetBucketID == "" {
		return fmt.Errorf("backup task target bucket is required")
	}
	targetBucket, err := a.deps.Store.GetBackupBucket(ctx, targetBucketID)
	if err != nil {
		return fmt.Errorf("backup task target bucket was not found")
	}
	if targetBucket.ServerID != sourceServerID {
		return fmt.Errorf("this Backup Manager version requires the target bucket to be on the same server as the source. Cross-server streaming is reserved in the design")
	}
	fallbackBucketID := strings.TrimSpace(input.FallbackBucketID)
	if fallbackBucketID == "" {
		return nil
	}
	fallbackBucket, err := a.deps.Store.GetBackupBucket(ctx, fallbackBucketID)
	if err != nil {
		return fmt.Errorf("backup task fallback bucket was not found")
	}
	if fallbackBucket.ServerID != sourceServerID {
		return fmt.Errorf("this Backup Manager version requires the fallback bucket to be on the same server as the source")
	}
	return nil
}

func (a *App) backupTaskRuns(w http.ResponseWriter, r *http.Request, taskID string) {
	switch r.Method {
	case http.MethodGet:
		runs, err := a.deps.Store.ListBackupRuns(r.Context(), taskID, 20)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"runs": runs})
	case http.MethodPost:
		task, err := a.deps.Store.GetBackupTask(r.Context(), taskID)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		run, err := a.startBackupTaskRun(r.Context(), task, "manual")
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusAccepted, run)
	default:
		methodNotAllowed(w)
	}
}

func (a *App) backupTaskRunByID(w http.ResponseWriter, r *http.Request, taskID string, runID string) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	run, err := a.deps.Store.GetBackupRun(r.Context(), runID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if run.TaskID != taskID {
		writeError(w, http.StatusNotFound, "Backup run was not found.")
		return
	}
	writeJSON(w, http.StatusOK, run)
}

func (a *App) backupProbeBucket(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var input backupPathRequest
	if !decodeJSON(w, r, &input) {
		return
	}
	server, err := a.deps.Store.GetServer(r.Context(), input.ServerID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	result, err := a.runBackupJSON(r.Context(), server, "backup_bucket_probe", map[string]string{
		"backup_root_path":   strings.TrimSpace(input.RootPath),
		"backup_bucket_name": backupBucketFolderName(input.BucketName),
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *App) backupSourceScan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var input backupPathRequest
	if !decodeJSON(w, r, &input) {
		return
	}
	server, err := a.deps.Store.GetServer(r.Context(), input.ServerID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	result, err := a.runBackupJSON(r.Context(), server, "backup_source_scan", map[string]string{
		"backup_source_path":       strings.TrimSpace(input.SourcePath),
		"backup_exclude_patterns":  input.ExcludePatterns,
		"backup_scan_max_entries":  "200000",
		"backup_manager_operation": "source_scan",
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *App) backupCompressionProbe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var input backupPathRequest
	if !decodeJSON(w, r, &input) {
		return
	}
	server, err := a.deps.Store.GetServer(r.Context(), input.ServerID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	result, err := a.runBackupJSON(r.Context(), server, "backup_compression_probe", nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *App) executeBackupRun(run domain.BackupRun, task domain.BackupTask, bucket domain.BackupBucket, server domain.Server) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Hour+30*time.Second)
	defer cancel()
	result, err := a.runBackupJSON(ctx, server, "backup_run", map[string]string{
		"backup_source_path":       task.SourcePath,
		"backup_bucket_path":       bucket.BucketPath,
		"backup_task_id":           task.ID,
		"backup_compression":       task.Compression,
		"backup_exclude_patterns":  task.ExcludePatterns,
		"backup_keep_latest":       strconv.Itoa(task.Rotation.KeepLatest),
		"backup_keep_weekly":       strconv.Itoa(task.Rotation.KeepWeekly),
		"backup_keep_monthly":      strconv.Itoa(task.Rotation.KeepMonthly),
		"backup_manager_operation": "run",
	})
	state := "succeeded"
	errText := ""
	logText := ""
	archiveName := ""
	var archiveBytes int64
	if err != nil {
		state = "failed"
		errText = err.Error()
		logText = err.Error()
	} else {
		archiveName = stringFromResult(result, "archive_name")
		archiveBytes = int64FromResult(result, "archive_bytes")
		logText = fmt.Sprintf("Backup archive created: %s (%d bytes)", archiveName, archiveBytes)
	}
	finished := time.Now().UTC()
	if saveErr := a.deps.Store.FinishBackupRun(context.Background(), domain.BackupRun{ID: run.ID, TaskID: task.ID, State: state, Log: logText, Error: errText, ArchiveName: archiveName, ArchiveBytes: archiveBytes, FinishedAt: &finished}); saveErr != nil {
		log.Printf("failed to save backup run result: %v", saveErr)
	}
}

func (a *App) runBackupJSON(ctx context.Context, server domain.Server, commandName string, args map[string]string) (map[string]any, error) {
	if a.deps.Scripts == nil {
		return nil, fmt.Errorf("script catalog is not configured")
	}
	selected, err := a.deps.Scripts.Select(commandName, targetFactsForHTTPServer(server))
	if err != nil {
		return nil, err
	}
	if a.deps.Worker != nil {
		response, err := a.deps.Worker.OpenCompressedJSONStreamServer(ctx, server, selected, args, "auto")
		if err != nil {
			return nil, err
		}
		defer response.Body.Close()
		result, _, err := collectJSONFromRemoteStream(ctx, "backup."+commandName, response.Body, selected.Command.EffectiveOutputLimits().MaxDecodedBytes)
		return result, err
	}
	if a.deps.Runtime == nil {
		return nil, fmt.Errorf("SSH runtime is not configured")
	}
	execution, buildErr := scripts.RemoteExecutionForVariantWithArgs(selected, args)
	if buildErr != nil {
		return nil, buildErr
	}
	limits := runtimeOutputLimitsForHTTP(selected.Command.EffectiveOutputLimits())
	if execution.StdinEnabled {
		return a.deps.Runtime.RunJSONWithInputLimited(ctx, server.ID, execution.Command, strings.NewReader(execution.Stdin), limits)
	}
	return a.deps.Runtime.RunJSONLimited(ctx, server.ID, execution.Command, limits)
}

func backupBucketFolderName(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "ShellOrchestraBackups"
	}
	return value
}

func (a *App) batchScriptPreview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var input domain.BatchScriptTemplateInput
	if !decodeJSON(w, r, &input) {
		return
	}
	if err := a.validateBatchScriptServerIDs(r.Context(), input.TargetSelector.ServerIDs); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	template, err := store.NormalizeBatchScriptTemplateInput(input)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	template.ID = "preview"
	targets, dispatch, err := a.prepareBatchScriptRunTargets(r.Context(), template)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"targets":       targets,
		"target_count":  len(targets),
		"ready_count":   len(dispatch),
		"skipped_count": len(targets) - len(dispatch),
	})
}

func (a *App) batchScriptRuns(w http.ResponseWriter, r *http.Request, templateID string) {
	switch r.Method {
	case http.MethodGet:
		runs, err := a.deps.Store.ListBatchScriptRuns(r.Context(), templateID, 50)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"runs": runs})
	case http.MethodPost:
		if a.deps.Worker == nil {
			writeError(w, http.StatusServiceUnavailable, "Batch Script execution requires the ssh-worker service. Start the full ShellOrchestra backend stack and try again.")
			return
		}
		if a.deps.Audit == nil {
			writeError(w, http.StatusServiceUnavailable, "Batch Script execution requires the append-only audit log. Start the full ShellOrchestra backend stack and try again.")
			return
		}
		template, err := a.deps.Store.GetBatchScriptTemplate(r.Context(), templateID)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		if !template.Enabled {
			writeError(w, http.StatusBadRequest, "Enable this batch script before running it.")
			return
		}
		principal, _ := r.Context().Value(principalKey{}).(*domain.Principal)
		deviceID := ""
		if principal != nil {
			deviceID = principal.DeviceID
		}
		run, targets, dispatchCount, err := a.startBatchScriptRun(r.Context(), template, "manual", deviceID, "")
		if err != nil {
			var storeErr batchScriptRunStoreError
			if errors.As(err, &storeErr) {
				writeError(w, http.StatusInternalServerError, storeErr.Unwrap().Error())
				return
			}
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if dispatchCount == 0 {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error":   "No target is ready to run this batch script. Review the target selection, connected status, and ready variants.",
				"targets": targets,
			})
			return
		}
		if _, err := a.appendBatchScriptAuditEvent(r.Context(), batchScriptAuditInput{
			EventType:            "batch_script.manual.started",
			Operation:            "manual_started",
			Template:             template,
			Run:                  run,
			Trigger:              "manual",
			RequestedByDeviceID:  deviceID,
			RequestedBySessionID: "",
			ClientIP:             sessionClientIP(r),
			RequestID:            r.Header.Get("X-ShellOrchestra-Nonce"),
			TargetCount:          len(targets),
			DispatchCount:        dispatchCount,
			TargetIDs:            batchScriptTargetIDs(targets),
		}); err != nil {
			writeError(w, http.StatusInternalServerError, "The batch script was queued, but ShellOrchestra could not append the audit event: "+err.Error())
			return
		}
		writeJSON(w, http.StatusAccepted, run)
	default:
		methodNotAllowed(w)
	}
}

func (a *App) batchScriptRunByID(w http.ResponseWriter, r *http.Request, templateID string, runID string) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	run, err := a.deps.Store.GetBatchScriptRun(r.Context(), runID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if run.TemplateID != templateID {
		writeError(w, http.StatusNotFound, "Batch script run was not found.")
		return
	}
	writeJSON(w, http.StatusOK, run)
}

func (a *App) batchScriptRunTargetOutput(w http.ResponseWriter, r *http.Request, templateID string, runID string, rest string) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	serverID, outputRest := splitIDPath(rest)
	if strings.TrimSpace(serverID) == "" || !strings.HasPrefix(outputRest, "/output/") {
		writeError(w, http.StatusNotFound, "Batch script target output was not found.")
		return
	}
	stream := strings.TrimPrefix(outputRest, "/output/")
	if stream != "stdout" && stream != "stderr" {
		writeError(w, http.StatusNotFound, "Batch script output stream was not found.")
		return
	}
	run, err := a.deps.Store.GetBatchScriptRun(r.Context(), runID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if run.TemplateID != templateID {
		writeError(w, http.StatusNotFound, "Batch script run was not found.")
		return
	}
	var target *domain.BatchScriptRunTarget
	for index := range run.Targets {
		if run.Targets[index].ServerID == serverID {
			target = &run.Targets[index]
			break
		}
	}
	if target == nil {
		writeError(w, http.StatusNotFound, "Batch script target output was not found.")
		return
	}
	ref := target.StdoutRef
	preview := target.StdoutPreview
	if stream == "stderr" {
		ref = target.StderrRef
		preview = target.StderrPreview
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if r.URL.Query().Get("download") == "1" {
		w.Header().Set("Content-Disposition", `attachment; filename="`+batchScriptOutputDownloadName(run, *target, stream)+`"`)
	}
	if strings.TrimSpace(ref) == "" {
		_, _ = w.Write([]byte(preview))
		return
	}
	file, err := batchOutputStore(a.deps.Config).Open(ref)
	if err != nil {
		writeError(w, http.StatusNotFound, "Stored batch script output is no longer available.")
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		writeError(w, http.StatusNotFound, "Stored batch script output is no longer available.")
		return
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}

func batchScriptOutputDownloadName(run domain.BatchScriptRun, target domain.BatchScriptRunTarget, stream string) string {
	name := "shellorchestra-batch-" + safeBatchOutputFilenameToken(run.ID) + "-" + safeBatchOutputFilenameToken(target.ServerLabelSnapshot) + "-" + safeBatchOutputFilenameToken(stream) + ".log"
	if len(name) > 180 {
		name = name[:176] + ".log"
	}
	return name
}

func safeBatchOutputFilenameToken(value string) string {
	value = strings.TrimSpace(value)
	var b strings.Builder
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			b.WriteRune(r)
			continue
		}
		if b.Len() == 0 || strings.HasSuffix(b.String(), "-") {
			continue
		}
		b.WriteByte('-')
	}
	out := strings.Trim(b.String(), "-.")
	if out == "" {
		return "output"
	}
	return out
}

func batchOutputStore(cfg config.AppConfig) batchoutput.Store {
	return batchoutput.New(batchoutput.RootForDatabase(cfg.Database.Path))
}

type batchScriptDispatchTarget struct {
	serverID string
	variant  domain.BatchScriptVariant
}

type batchScriptRunStoreError struct {
	err error
}

func (e batchScriptRunStoreError) Error() string {
	return e.err.Error()
}

func (e batchScriptRunStoreError) Unwrap() error {
	return e.err
}

type batchScriptAuditInput struct {
	EventType            string
	Operation            string
	Template             domain.BatchScriptTemplate
	Run                  domain.BatchScriptRun
	Trigger              string
	RequestedByDeviceID  string
	RequestedBySessionID string
	ClientIP             string
	RequestID            string
	NoopReason           string
	TargetCount          int
	DispatchCount        int
	TargetIDs            []string
	NextRunAt            *time.Time
}

func (a *App) appendBatchScriptAuditEvent(ctx context.Context, input batchScriptAuditInput) (auditlog.Event, error) {
	if a.deps.Audit == nil {
		return auditlog.Event{}, fmt.Errorf("audit log is not configured")
	}
	metadata := map[string]string{
		"template_id":               strings.TrimSpace(input.Template.ID),
		"template_name":             strings.TrimSpace(input.Template.Name),
		"run_id":                    strings.TrimSpace(input.Run.ID),
		"trigger":                   strings.TrimSpace(input.Trigger),
		"requested_by_device_id":    strings.TrimSpace(input.RequestedByDeviceID),
		"requested_by_session_id":   strings.TrimSpace(input.RequestedBySessionID),
		"target_count":              fmt.Sprintf("%d", input.TargetCount),
		"dispatch_count":            fmt.Sprintf("%d", input.DispatchCount),
		"target_ids":                strings.Join(uniqueNonEmptyStrings(input.TargetIDs), ","),
		"schedule_interval_seconds": fmt.Sprintf("%d", input.Template.Schedule.IntervalSeconds),
		"schedule_missed_policy":    string(input.Template.Schedule.MissedRunPolicy),
		"script_body_logged":        "false",
		"output_logged":             "false",
	}
	if input.NoopReason != "" {
		metadata["noop_reason"] = strings.TrimSpace(input.NoopReason)
	}
	if input.NextRunAt != nil {
		metadata["next_run_at"] = input.NextRunAt.Format(time.RFC3339)
	}
	eventType := strings.TrimSpace(input.EventType)
	if eventType == "" {
		eventType = "batch_script.run"
	}
	operation := strings.TrimSpace(input.Operation)
	if operation == "" {
		operation = "batch_script"
	}
	return a.deps.Audit.Append(ctx, auditlog.EventInput{
		Type:          eventType,
		ActorDeviceID: strings.TrimSpace(input.RequestedByDeviceID),
		ClientIP:      strings.TrimSpace(input.ClientIP),
		Operation:     operation,
		Path:          "global-apps/batch-script/" + strings.TrimSpace(input.Template.ID),
		RequestID:     strings.TrimSpace(input.RequestID),
		Metadata:      metadata,
	})
}

func batchScriptTargetIDs(targets []domain.BatchScriptRunTarget) []string {
	ids := make([]string, 0, len(targets))
	for _, target := range targets {
		if strings.TrimSpace(target.ServerID) != "" {
			ids = append(ids, target.ServerID)
		}
	}
	return ids
}

func (a *App) startBatchScriptRun(ctx context.Context, template domain.BatchScriptTemplate, trigger string, requestedByDeviceID string, requestedBySessionID string) (domain.BatchScriptRun, []domain.BatchScriptRunTarget, int, error) {
	targets, dispatch, err := a.prepareBatchScriptRunTargets(ctx, template)
	if err != nil {
		return domain.BatchScriptRun{}, nil, 0, err
	}
	if len(dispatch) == 0 {
		return domain.BatchScriptRun{}, targets, 0, nil
	}
	run := domain.BatchScriptRun{
		TemplateID:           template.ID,
		NameSnapshot:         template.Name,
		RequestedByDeviceID:  requestedByDeviceID,
		RequestedBySessionID: requestedBySessionID,
		Trigger:              strings.TrimSpace(trigger),
		State:                domain.BatchScriptRunRunning,
		SettingsSnapshot: map[string]any{
			"default_timeout_seconds":     template.DefaultTimeoutSeconds,
			"default_concurrency":         template.DefaultConcurrency,
			"failure_policy":              template.FailurePolicy,
			"preflight_required":          template.PreflightRequired,
			"schedule_enabled":            template.Schedule.Enabled,
			"schedule_interval_seconds":   template.Schedule.IntervalSeconds,
			"schedule_missed_run_policy":  template.Schedule.MissedRunPolicy,
			"retention_max_runs":          template.Retention.MaxRuns,
			"retention_max_output_bytes":  template.Retention.MaxOutputBytes,
			"retention_delete_after_days": template.Retention.DeleteAfterDays,
		},
	}
	run, err = a.deps.Store.CreateBatchScriptRun(ctx, run, targets)
	if err != nil {
		return domain.BatchScriptRun{}, targets, 0, batchScriptRunStoreError{err: err}
	}
	for _, item := range dispatch {
		item := item
		go a.dispatchBatchScriptTarget(run.ID, item.serverID, item.variant, template.PreflightRequired, template.Retention.MaxOutputBytes)
	}
	prunedRefs, err := a.deps.Store.PruneBatchScriptRuns(context.Background(), template.ID, template.Retention)
	if err != nil {
		log.Printf("failed to prune batch script runs for template %s: %v", template.ID, err)
	} else {
		batchOutputStore(a.deps.Config).DeleteRefs(prunedRefs)
	}
	return run, targets, len(dispatch), nil
}

func (a *App) prepareBatchScriptRunTargets(ctx context.Context, template domain.BatchScriptTemplate) ([]domain.BatchScriptRunTarget, []batchScriptDispatchTarget, error) {
	serverIDs := uniqueNonEmptyStrings(template.TargetSelector.ServerIDs)
	if len(serverIDs) == 0 {
		return nil, nil, fmt.Errorf("Choose target servers before running this batch script.")
	}
	statuses, err := a.deps.Store.ListStatuses(ctx)
	if err != nil {
		return nil, nil, err
	}
	statusByServer := make(map[string]domain.ServerStatus, len(statuses))
	for _, status := range statuses {
		statusByServer[status.ServerID] = status
	}
	targets := make([]domain.BatchScriptRunTarget, 0, len(serverIDs))
	dispatch := []batchScriptDispatchTarget{}
	for _, serverID := range serverIDs {
		server, err := a.deps.Store.GetServer(ctx, serverID)
		if err != nil {
			targets = append(targets, skippedBatchScriptTarget(serverID, serverID, "Server profile was not found."))
			continue
		}
		status := statusByServer[server.ID]
		if strings.TrimSpace(template.TargetSelector.RequiredStatus) == "" || strings.EqualFold(template.TargetSelector.RequiredStatus, "connected") {
			if status.State != domain.StatusConnected {
				message := "Server is not connected."
				if status.LastError != "" {
					message += " " + status.LastError
				}
				targets = append(targets, skippedBatchScriptTarget(server.ID, server.Name, message))
				continue
			}
		}
		variant, reason := selectBatchScriptVariantForServer(template, server)
		if reason != "" {
			targets = append(targets, skippedBatchScriptTarget(server.ID, server.Name, reason))
			continue
		}
		targets = append(targets, domain.BatchScriptRunTarget{
			ServerID:            server.ID,
			ServerLabelSnapshot: server.Name,
			VariantID:           variant.ID,
			State:               domain.BatchScriptRunTargetQueued,
			VariantSelectorSnapshot: map[string]string{
				"target_kind":     variant.TargetKind,
				"platform":        variant.Platform,
				"distro":          variant.Distro,
				"package_manager": variant.PackageManager,
				"shell":           variant.Shell,
			},
		})
		dispatch = append(dispatch, batchScriptDispatchTarget{serverID: server.ID, variant: variant})
	}
	return targets, dispatch, nil
}

func skippedBatchScriptTarget(serverID string, label string, reason string) domain.BatchScriptRunTarget {
	return domain.BatchScriptRunTarget{
		ServerID:            serverID,
		ServerLabelSnapshot: label,
		State:               domain.BatchScriptRunTargetSkipped,
		ErrorMessage:        reason,
	}
}

func (a *App) dispatchBatchScriptTarget(runID string, serverID string, variant domain.BatchScriptVariant, preflightRequired bool, maxOutputBytes int) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := a.deps.Worker.RunBatchScriptTarget(ctx, runID, serverID, variant, preflightRequired, maxOutputBytes); err != nil {
		finished := time.Now().UTC()
		saveErr := a.deps.Store.FinishBatchScriptRunTarget(context.Background(), domain.BatchScriptRunTarget{
			RunID:        runID,
			ServerID:     serverID,
			State:        domain.BatchScriptRunTargetFailed,
			ErrorMessage: "Could not dispatch the target to ssh-worker: " + err.Error(),
			FinishedAt:   &finished,
		})
		if saveErr != nil {
			log.Printf("failed to save batch script dispatch error: %v", saveErr)
		}
	}
}

func selectBatchScriptVariantForServer(template domain.BatchScriptTemplate, server domain.Server) (domain.BatchScriptVariant, string) {
	for _, variant := range template.Variants {
		if variant.State != domain.BatchScriptVariantReady {
			continue
		}
		if batchScriptVariantMatchesServer(variant, server) {
			return variant, ""
		}
	}
	return domain.BatchScriptVariant{}, "No ready variant matches this server's detected platform, distro, package manager, and shell."
}

func batchScriptVariantMatchesServer(variant domain.BatchScriptVariant, server domain.Server) bool {
	facts := targetFactsForHTTPServer(server)
	platformValues := lowerSet(facts.Platform, facts.PlatformOS, facts.OS)
	distroValues := lowerSet(facts.Distro)
	packageManagerValues := lowerSet(facts.PackageManager)
	shellValues := lowerSet(facts.Shell)
	switch strings.ToLower(strings.TrimSpace(variant.Shell)) {
	case "powershell", "cmd_wrapped_powershell":
		if !platformValues["windows"] && !shellValues["powershell"] && !shellValues["cmd_wrapped_powershell"] {
			return false
		}
	case "bash", "zsh":
		if !shellValues[strings.ToLower(strings.TrimSpace(variant.Shell))] {
			return false
		}
	case "posix", "sh", "":
		if platformValues["windows"] {
			return false
		}
	default:
		return false
	}
	if variant.Platform != "" && !platformValues[strings.ToLower(strings.TrimSpace(variant.Platform))] {
		return false
	}
	if variant.Distro != "" && !distroValues[strings.ToLower(strings.TrimSpace(variant.Distro))] {
		return false
	}
	if variant.PackageManager != "" && !packageManagerValues[strings.ToLower(strings.TrimSpace(variant.PackageManager))] {
		return false
	}
	kind := strings.ToLower(strings.TrimSpace(variant.TargetKind))
	switch kind {
	case "", "any":
		return true
	case "posix":
		return !platformValues["windows"]
	case "linux":
		return platformValues["linux"]
	case "windows":
		return platformValues["windows"]
	case "macos", "darwin":
		return platformValues["darwin"] || platformValues["macos"]
	case "debian", "ubuntu-debian":
		return distroValues["debian"] || distroValues["ubuntu"] || packageManagerValues["apt"]
	case "arch":
		return distroValues["arch"] || distroValues["archlinux"] || packageManagerValues["pacman"]
	case "fedora-rocky", "rhel", "rocky", "fedora":
		return distroValues["rocky"] || distroValues["fedora"] || distroValues["rhel"] || distroValues["centos"] || packageManagerValues["dnf"] || packageManagerValues["yum"]
	case "alpine":
		return distroValues["alpine"] || packageManagerValues["apk"]
	default:
		return distroValues[kind] || platformValues[kind] || packageManagerValues[kind]
	}
}

func lowerSet(values ...string) map[string]bool {
	out := map[string]bool{}
	for _, value := range values {
		value = strings.ToLower(strings.TrimSpace(value))
		if value != "" {
			out[value] = true
		}
	}
	return out
}

func (a *App) validateBatchScriptServerIDs(ctx context.Context, serverIDs []string) error {
	for _, serverID := range uniqueNonEmptyStrings(serverIDs) {
		if _, err := a.deps.Store.GetServer(ctx, serverID); err != nil {
			return fmt.Errorf("Target server %q was not found", serverID)
		}
	}
	return nil
}

func batchScriptExamples() []domain.BatchScriptTemplate {
	now := time.Now().UTC()
	return []domain.BatchScriptTemplate{
		{
			ID:                    "example-install-btop",
			Name:                  "Install btop on supported package managers",
			Description:           "Example template with distro/package-manager variants for installing btop. Duplicate it before editing or running.",
			Enabled:               false,
			DefaultTimeoutSeconds: 1800,
			DefaultConcurrency:    8,
			FailurePolicy:         domain.BatchScriptFailureContinue,
			TargetSelector:        domain.BatchScriptTargetSelector{RequiredStatus: "connected"},
			Variants: []domain.BatchScriptVariant{
				{ID: "example-btop-apt", TargetKind: "debian", Platform: "linux", PackageManager: "apt", Shell: "posix", State: domain.BatchScriptVariantReady, SyntaxLanguage: "shell", ScriptBody: "sudo apt-get update && sudo apt-get install -y btop"},
				{ID: "example-btop-pacman", TargetKind: "arch", Platform: "linux", PackageManager: "pacman", Shell: "posix", State: domain.BatchScriptVariantReady, SyntaxLanguage: "shell", ScriptBody: "sudo pacman -Sy --noconfirm btop"},
				{ID: "example-btop-dnf", TargetKind: "fedora-rocky", Platform: "linux", PackageManager: "dnf", Shell: "posix", State: domain.BatchScriptVariantReady, SyntaxLanguage: "shell", ScriptBody: "sudo dnf install -y btop"},
				{ID: "example-btop-apk", TargetKind: "alpine", Platform: "linux", PackageManager: "apk", Shell: "posix", State: domain.BatchScriptVariantReady, SyntaxLanguage: "shell", ScriptBody: "sudo apk add btop"},
				{ID: "example-btop-brew", TargetKind: "macos", Platform: "darwin", PackageManager: "brew", Shell: "zsh", State: domain.BatchScriptVariantReady, SyntaxLanguage: "shell", ScriptBody: "brew install btop"},
				{ID: "example-btop-winget", TargetKind: "windows", Platform: "windows", PackageManager: "winget", Shell: "powershell", State: domain.BatchScriptVariantReady, SyntaxLanguage: "powershell", ScriptBody: "winget install --id aristocratos.btop4win --silent --accept-package-agreements --accept-source-agreements"},
			},
			Example:   true,
			CreatedAt: now,
			UpdatedAt: now,
		},
		{
			ID:                    "example-print-host-summary",
			Name:                  "Print host summary",
			Description:           "Read-only example that prints basic host identity and runtime facts.",
			Enabled:               false,
			DefaultTimeoutSeconds: 300,
			DefaultConcurrency:    8,
			FailurePolicy:         domain.BatchScriptFailureContinue,
			TargetSelector:        domain.BatchScriptTargetSelector{RequiredStatus: "connected"},
			Variants: []domain.BatchScriptVariant{
				{ID: "example-summary-posix", TargetKind: "posix", Shell: "posix", State: domain.BatchScriptVariantReady, SyntaxLanguage: "shell", ScriptBody: "hostname; uname -a; id"},
				{ID: "example-summary-powershell", TargetKind: "windows", Platform: "windows", Shell: "powershell", State: domain.BatchScriptVariantReady, SyntaxLanguage: "powershell", ScriptBody: "$env:COMPUTERNAME; Get-ComputerInfo | Select-Object OsName,OsVersion,OsArchitecture; whoami"},
			},
			Example:   true,
			CreatedAt: now,
			UpdatedAt: now,
		},
		{
			ID:                    "example-motd-marker",
			Name:                  "Apply idempotent MOTD marker",
			Description:           "Example mutating template that demonstrates preflight plus idempotent text change.",
			Enabled:               false,
			DefaultTimeoutSeconds: 600,
			DefaultConcurrency:    8,
			FailurePolicy:         domain.BatchScriptFailureContinue,
			PreflightRequired:     true,
			TargetSelector:        domain.BatchScriptTargetSelector{RequiredStatus: "connected"},
			Variants: []domain.BatchScriptVariant{
				{ID: "example-motd-posix", TargetKind: "posix", Shell: "posix", State: domain.BatchScriptVariantReady, SyntaxLanguage: "shell", PreflightBody: "test -w /etc/motd || test -w /etc", ScriptBody: "grep -q 'Managed by ShellOrchestra' /etc/motd 2>/dev/null || printf '\\nManaged by ShellOrchestra\\n' | sudo tee -a /etc/motd >/dev/null"},
			},
			Example:   true,
			CreatedAt: now,
			UpdatedAt: now,
		},
	}
}

func (a *App) servers(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		servers, err := a.deps.Store.ListServers(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"servers": servers})
	case http.MethodPost:
		var input domain.ServerInput
		if !decodeJSON(w, r, &input) {
			return
		}
		normalized, err := store.NormalizeServerInput(input)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := a.validateServerProfileReferences(r.Context(), "", normalized); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := a.validateServerLabelUnique(r.Context(), "", normalized.Name); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		server, err := a.deps.Store.CreateServer(r.Context(), input)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, server)
	default:
		methodNotAllowed(w)
	}
}

func (a *App) sshUserKeys(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		keys, err := a.deps.Store.ListSSHUserKeys(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"keys": keys})
	case http.MethodPost:
		var body struct {
			Label      string `json:"label"`
			PublicKey  string `json:"public_key"`
			PrivateKey string `json:"private_key"`
		}
		if !decodeJSON(w, r, &body) {
			return
		}
		publicKey, err := validateSSHPrivateKeyPair(body.PrivateKey, body.PublicKey)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		key, err := a.deps.Store.CreateSSHUserKey(r.Context(), body.Label, publicKey, body.PrivateKey)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, key)
	default:
		methodNotAllowed(w)
	}
}

func (a *App) serverTestTCP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	server, ok := a.decodeServerWizardRequest(w, r)
	if !ok {
		return
	}
	if err := a.validateServerProfileReferences(r.Context(), "", server); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	result, err := a.testTCP(r.Context(), server)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *App) serverTestAuth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	server, ok := a.decodeServerWizardRequest(w, r)
	if !ok {
		return
	}
	if err := a.validateServerProfileReferences(r.Context(), "", server); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	result, err := a.testAuth(r.Context(), server)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *App) serverDetectFacts(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	server, ok := a.decodeServerWizardRequest(w, r)
	if !ok {
		return
	}
	if err := a.validateServerProfileReferences(r.Context(), "", server); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	facts, err := a.detectFactsForServer(r.Context(), server)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, facts)
}

func (a *App) serverBatchPackagesUpgrade(w http.ResponseWriter, r *http.Request) {
	a.runServerBatchAction(w, r, "packages_upgrade")
}

func (a *App) serverBatchReboot(w http.ResponseWriter, r *http.Request) {
	a.runServerBatchAction(w, r, "reboot")
}

func (a *App) runServerBatchAction(w http.ResponseWriter, r *http.Request, commandName string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var body struct {
		ServerIDs []string `json:"server_ids"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	serverIDs := uniqueNonEmptyStrings(body.ServerIDs)
	if len(serverIDs) == 0 {
		writeError(w, http.StatusBadRequest, "Choose at least one server before starting this action.")
		return
	}
	type item struct {
		ServerID   string            `json:"server_id"`
		ServerName string            `json:"server_name"`
		Run        *domain.ScriptRun `json:"run,omitempty"`
		Error      string            `json:"error,omitempty"`
	}
	items := make([]item, 0, len(serverIDs))
	started := 0
	for _, serverID := range serverIDs {
		server, err := a.deps.Store.GetServer(r.Context(), serverID)
		if err != nil {
			items = append(items, item{ServerID: serverID, Error: "Server profile was not found."})
			continue
		}
		selected, err := a.deps.Scripts.Select(commandName, targetFactsForHTTPServer(server))
		if err != nil {
			items = append(items, item{ServerID: server.ID, ServerName: server.Name, Error: err.Error()})
			continue
		}
		run := domain.ScriptRun{ServerID: server.ID, Command: commandName, Variant: selected.Variant.ID, State: domain.ScriptRunRunning}
		run, err = a.deps.Store.CreateScriptRun(r.Context(), run)
		if err != nil {
			items = append(items, item{ServerID: server.ID, ServerName: server.Name, Error: err.Error()})
			continue
		}
		started++
		runCopy := run
		items = append(items, item{ServerID: server.ID, ServerName: server.Name, Run: &runCopy})
		go a.executeScript(run, selected)
	}
	status := http.StatusAccepted
	if started == 0 {
		status = http.StatusBadRequest
	}
	writeJSON(w, status, map[string]any{
		"command": commandName,
		"started": started,
		"results": items,
	})
}

func (a *App) decodeServerWizardRequest(w http.ResponseWriter, r *http.Request) (domain.Server, bool) {
	var body struct {
		Server domain.ServerInput `json:"server"`
	}
	if !decodeJSON(w, r, &body) {
		return domain.Server{}, false
	}
	server, err := store.NormalizeServerInput(body.Server)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return domain.Server{}, false
	}
	if server.ID == "" {
		principal := r.Context().Value(principalKey{}).(*domain.Principal)
		server.ID = "wizard-" + sanitizeDetectedFactForID(principal.DeviceID)
	}
	return server, true
}

func (a *App) validateServerProfileReferences(ctx context.Context, currentID string, server domain.Server) error {
	if server.ConnectionMode == domain.ServerConnectionChained {
		if server.JumpServerID == "" {
			return fmt.Errorf("jump server is required for chained connections")
		}
		if server.JumpServerID == currentID && currentID != "" {
			return fmt.Errorf("a server cannot use itself as its jump server")
		}
		if err := a.validateJumpChain(ctx, currentID, server.JumpServerID); err != nil {
			return err
		}
	}
	if server.AuthMethod == domain.ServerAuthCustomKey {
		if _, err := a.deps.Store.GetSSHUserKey(ctx, server.SSHKeyID); err != nil {
			return fmt.Errorf("selected SSH key was not found")
		}
	}
	if server.AuthMethod == domain.ServerAuthLocalProtectedKey && stdruntime.GOOS != "windows" {
		return fmt.Errorf("local Windows protected key authentication is available only in the Windows desktop-server package")
	}
	if server.AuthMethod == domain.ServerAuthLocalProtectedKey && !localProtectedKeyRuntimeAvailable() {
		return fmt.Errorf("local Windows protected key authentication requires a non-interactive local protected key provider before this profile can be saved")
	}
	return nil
}

func localProtectedKeyRuntimeAvailable() bool {
	return runtime.LocalProtectedKeyRuntimeAvailable()
}

func (a *App) validateServerLabelUnique(ctx context.Context, currentID string, label string) error {
	normalizedLabel := normalizeServerLabelKey(label)
	if normalizedLabel == "" {
		return fmt.Errorf("server label is required")
	}
	servers, err := a.deps.Store.ListServers(ctx)
	if err != nil {
		return err
	}
	for _, existing := range servers {
		if existing.ID == currentID {
			continue
		}
		if normalizeServerLabelKey(existing.Name) == normalizedLabel {
			return fmt.Errorf("a server with this label already exists; choose a unique operator-facing label")
		}
	}
	return nil
}

func normalizeServerLabelKey(value string) string {
	return strings.ToLower(strings.Join(strings.Fields(strings.TrimSpace(value)), " "))
}

func (a *App) validateJumpChain(ctx context.Context, currentID string, jumpID string) error {
	visited := map[string]bool{}
	for strings.TrimSpace(jumpID) != "" {
		if visited[jumpID] {
			return fmt.Errorf("chained connection contains a cycle")
		}
		visited[jumpID] = true
		if currentID != "" && jumpID == currentID {
			return fmt.Errorf("chained connection cannot point back to this server")
		}
		jump, err := a.deps.Store.GetServer(ctx, jumpID)
		if err != nil {
			return fmt.Errorf("jump server was not found")
		}
		if jump.ConnectionMode != domain.ServerConnectionChained {
			return nil
		}
		jumpID = jump.JumpServerID
	}
	return nil
}

func (a *App) testTCP(ctx context.Context, server domain.Server) (runtime.TCPTestResult, error) {
	if a.deps.Worker != nil {
		return a.deps.Worker.TestTCP(ctx, server)
	}
	return a.deps.Runtime.TestTCP(ctx, server), nil
}

func (a *App) testAuth(ctx context.Context, server domain.Server) (runtime.AuthTestResult, error) {
	if a.deps.Worker != nil {
		return a.deps.Worker.TestAuth(ctx, server)
	}
	return a.deps.Runtime.TestAuth(ctx, server), nil
}

func (a *App) scanHostKeys(ctx context.Context, server domain.Server) (runtime.HostKeyScanResult, error) {
	if a.deps.Worker != nil {
		return a.deps.Worker.ScanHostKeys(ctx, server)
	}
	return a.deps.Runtime.ScanHostKeys(ctx, server), nil
}

func (a *App) detectFactsForServer(ctx context.Context, server domain.Server) (scripts.TargetFacts, error) {
	if a.deps.Worker != nil {
		return a.deps.Worker.DetectFacts(ctx, server)
	}
	status, _ := a.deps.Runtime.Connect(ctx, server)
	if status.State != domain.StatusConnected {
		return scripts.TargetFacts{}, errors.New(status.LastError)
	}
	return a.detectServerFacts(ctx, server)
}

func validateSSHPrivateKeyPair(privateKey string, publicKey string) (string, error) {
	privateKey = strings.TrimSpace(privateKey)
	publicKey = strings.TrimSpace(publicKey)
	if privateKey == "" {
		return "", fmt.Errorf("Private key is required.")
	}
	if publicKey == "" {
		return "", fmt.Errorf("Public key is required.")
	}
	signer, err := ssh.ParsePrivateKey([]byte(privateKey))
	if err != nil {
		return "", fmt.Errorf("Private key must be an unencrypted OpenSSH private key: %w", err)
	}
	parsedPublicKey, _, _, _, err := ssh.ParseAuthorizedKey([]byte(publicKey))
	if err != nil {
		return "", fmt.Errorf("Public key must be an OpenSSH authorized-key line: %w", err)
	}
	if !bytes.Equal(signer.PublicKey().Marshal(), parsedPublicKey.Marshal()) {
		return "", fmt.Errorf("Public key does not match the private key.")
	}
	return string(bytes.TrimSpace(ssh.MarshalAuthorizedKey(parsedPublicKey))), nil
}

func validateSSHHostKeySet(hostKey string) error {
	count := 0
	for _, line := range strings.Split(hostKey, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if _, _, _, _, err := ssh.ParseAuthorizedKey([]byte(line)); err != nil {
			fields := strings.Fields(line)
			if len(fields) < 3 {
				return fmt.Errorf("Host key line must be an OpenSSH public key line.")
			}
			if _, _, _, _, retryErr := ssh.ParseAuthorizedKey([]byte(strings.Join(fields[1:], " "))); retryErr != nil {
				return fmt.Errorf("Host key line must be an OpenSSH public key line: %w", retryErr)
			}
		}
		count++
	}
	if count == 0 {
		return fmt.Errorf("At least one SSH host key is required.")
	}
	return nil
}

func sanitizeDetectedFactForID(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var builder strings.Builder
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			builder.WriteRune(r)
		}
		if builder.Len() >= 48 {
			break
		}
	}
	if builder.Len() == 0 {
		return "device"
	}
	return builder.String()
}

func (a *App) scanSSHConfigSources(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var body struct {
		DefaultUsername string `json:"default_username"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	result := sshconfig.ScanLocalSources(r.Context(), body.DefaultUsername)
	existingServers, err := a.deps.Store.ListServers(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	usedLabels := make(map[string]struct{}, len(existingServers)+len(result.Profiles))
	for _, server := range existingServers {
		usedLabels[normalizeServerLabelKey(server.Name)] = struct{}{}
	}
	for index := range result.Profiles {
		profile := &result.Profiles[index]
		profile.LabelProposed = uniqueImportedServerLabel(firstNonEmptyString(profile.LabelProposed, profile.HostAlias, profile.Hostname), profile.User, usedLabels)
		if profile.LabelProposed != "" {
			usedLabels[normalizeServerLabelKey(profile.LabelProposed)] = struct{}{}
		}
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *App) importSSHConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024*1024)
	var body struct {
		Config                   string `json:"config"`
		DefaultUsername          string `json:"default_username"`
		ImportIdentityFiles      bool   `json:"import_identity_files"`
		ImportLocalProtectedKeys bool   `json:"import_local_protected_keys"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.Config) == "" {
		writeError(w, http.StatusBadRequest, "SSH config is required.")
		return
	}
	authority, err := a.deps.Store.GetAuthority(r.Context())
	if err != nil {
		writeError(w, http.StatusConflict, "ShellOrchestra key authority is not initialized.")
		return
	}
	profiles, issues := sshconfig.Parse(body.Config, body.DefaultUsername)
	existingServers, err := a.deps.Store.ListServers(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	usedLabels := make(map[string]struct{}, len(existingServers)+len(profiles))
	for _, server := range existingServers {
		usedLabels[normalizeServerLabelKey(server.Name)] = struct{}{}
	}
	keyLabelSet := map[string]struct{}{}
	if body.ImportIdentityFiles {
		if stdruntime.GOOS != "windows" {
			writeError(w, http.StatusBadRequest, "Importing local IdentityFile keys is available only in the Windows desktop-server package, where ShellOrchestra can read the operator-selected local SSH config and key files.")
			return
		}
		keys, err := a.deps.Store.ListSSHUserKeys(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		for _, key := range keys {
			keyLabelSet[normalizeServerLabelKey(key.Label)] = struct{}{}
		}
	}
	localProtectedPublicKeys := map[string]struct{}{}
	if body.ImportLocalProtectedKeys {
		if stdruntime.GOOS != "windows" {
			writeError(w, http.StatusBadRequest, "Local protected key / TPM / agent import is available only in the Windows desktop-server package.")
			return
		}
		if !localProtectedKeyRuntimeAvailable() {
			writeError(w, http.StatusBadRequest, "Local protected key / TPM / agent import requires a Windows OpenSSH agent key that ShellOrchestra can use without a passphrase or UI prompt.")
			return
		}
		publicKeys, err := runtime.LocalProtectedKeyPublicKeyStrings(r.Context())
		if err != nil {
			writeError(w, http.StatusBadRequest, "Local protected key / TPM / agent import requires a Windows OpenSSH agent key that ShellOrchestra can enumerate without user interaction.")
			return
		}
		for _, publicKey := range publicKeys {
			if normalized := normalizeAuthorizedKeyLine(publicKey); normalized != "" {
				localProtectedPublicKeys[normalized] = struct{}{}
			}
		}
	}
	var created []domain.Server
	var updated []domain.Server
	importedKeys := 0
	skipped := make([]sshconfig.Issue, 0, len(issues))
	skipped = append(skipped, issues...)
	for _, profile := range profiles {
		authMethod := domain.ServerAuthCA
		sshKeyID := ""
		extraNotes := []string{}
		localProtectedMatched, localProtectedNote := profileMatchesLocalProtectedKey(profile, localProtectedPublicKeys)
		if localProtectedMatched {
			authMethod = domain.ServerAuthLocalProtectedKey
			extraNotes = append(extraNotes, localProtectedNote)
		} else if body.ImportIdentityFiles && len(profile.IdentityFiles) > 0 {
			keyID, note, err := a.importFirstUsableSSHConfigIdentityFile(r.Context(), profile, keyLabelSet)
			if err != nil {
				skipped = append(skipped, sshconfig.Issue{Line: profile.Line, Host: profile.Name, Reason: err.Error()})
				continue
			} else {
				authMethod = domain.ServerAuthCustomKey
				sshKeyID = keyID
				importedKeys++
				if note != "" {
					extraNotes = append(extraNotes, note)
				}
			}
		} else if body.ImportLocalProtectedKeys && len(profile.IdentityFiles) > 0 {
			skipped = append(skipped, sshconfig.Issue{
				Line:   profile.Line,
				Host:   profile.Name,
				Reason: "IdentityFile entries did not match an unattended local Windows protected key / TPM / OpenSSH-agent identity. ShellOrchestra did not fall back to another authentication method.",
			})
			continue
		}
		label := uniqueImportedServerLabel(profile.Name, profile.Username, usedLabels)
		if label == "" {
			skipped = append(skipped, sshconfig.Issue{Line: profile.Line, Host: profile.Name, Reason: "Could not build a unique server label for this Host block."})
			continue
		}
		usedLabels[normalizeServerLabelKey(label)] = struct{}{}
		input := importedServerInput(profile, authority.PublicKeyOpenSSH, label, authMethod, sshKeyID, extraNotes)
		server, err := a.deps.Store.CreateServer(r.Context(), input)
		if err != nil {
			skipped = append(skipped, sshconfig.Issue{Line: profile.Line, Host: profile.Name, Reason: err.Error()})
			continue
		}
		created = append(created, server)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"created":       created,
		"updated":       updated,
		"skipped":       skipped,
		"public_key":    authority.PublicKeyOpenSSH,
		"imported_keys": importedKeys,
	})
}

func (a *App) serverByID(w http.ResponseWriter, r *http.Request) {
	id, suffix := splitIDPath(strings.TrimPrefix(r.URL.Path, "/api/servers/"))
	if id == "" {
		writeError(w, http.StatusNotFound, "Server not found.")
		return
	}
	if suffix == "/bootstrap-command" {
		a.bootstrapCommand(w, r, id)
		return
	}
	if suffix == "/host-keys/scan" {
		a.scanServerHostKeys(w, r, id)
		return
	}
	if suffix == "/host-keys/accept" {
		a.acceptServerHostKeys(w, r, id)
		return
	}
	if suffix == "/debug-disconnect" {
		a.debugDisconnectServer(w, r, id)
		return
	}
	switch r.Method {
	case http.MethodPut:
		var input domain.ServerInput
		if !decodeJSON(w, r, &input) {
			return
		}
		normalized, err := store.NormalizeServerInput(input)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := a.validateServerProfileReferences(r.Context(), id, normalized); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := a.validateServerLabelUnique(r.Context(), id, normalized.Name); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		server, err := a.deps.Store.UpdateServer(r.Context(), id, input)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		if a.deps.Config.Runtime.AutoConnectAfterUnlock {
			go a.connectAllServers(context.Background())
		}
		writeJSON(w, http.StatusOK, server)
	case http.MethodDelete:
		if err := a.deps.Store.DeleteServer(r.Context(), id); err != nil {
			writeStoreError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		methodNotAllowed(w)
	}
}

func (a *App) scanServerHostKeys(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	server, err := a.deps.Store.GetServer(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(a.deps.Config.Runtime.ConnectTimeoutSeconds)*time.Second+10*time.Second)
	defer cancel()
	result, err := a.scanHostKeys(ctx, server)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *App) acceptServerHostKeys(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var body struct {
		HostKey string `json:"host_key"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	hostKey := strings.TrimSpace(body.HostKey)
	if hostKey == "" {
		writeError(w, http.StatusBadRequest, "Scanned host key data is required.")
		return
	}
	if err := validateSSHHostKeySet(hostKey); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	server, err := a.deps.Store.UpdateServerHostKey(r.Context(), id, hostKey)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if a.deps.Config.Runtime.AutoConnectAfterUnlock {
		go a.connectAllServers(context.Background())
	}
	writeJSON(w, http.StatusOK, server)
}

func (a *App) debugDisconnectServer(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !a.debugModeEnabled() {
		http.NotFound(w, r)
		return
	}
	if a.deps.Worker == nil {
		writeError(w, http.StatusServiceUnavailable, "ssh-worker is not configured")
		return
	}
	if _, err := a.deps.Store.GetServer(r.Context(), id); err != nil {
		writeStoreError(w, err)
		return
	}
	if err := a.deps.Worker.DebugDisconnectServer(r.Context(), id); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "server_id": id})
}

func (a *App) bootstrapCommand(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if _, err := a.deps.Store.GetServer(r.Context(), id); err != nil {
		writeStoreError(w, err)
		return
	}
	authority, err := a.deps.Store.GetAuthority(r.Context())
	if err != nil {
		writeError(w, http.StatusConflict, "ShellOrchestra key authority is not initialized.")
		return
	}
	command := posixTrustedUserCACommand(authority.PublicKeyOpenSSH, "root", "sshd")
	writeJSON(w, http.StatusOK, map[string]string{"command": command, "public_key": authority.PublicKeyOpenSSH})
}

func (a *App) virtualDesktopByServerID(w http.ResponseWriter, r *http.Request) {
	serverID, rest := splitIDPath(strings.TrimPrefix(r.URL.Path, "/api/desktops/"))
	if serverID == "" || rest != "" {
		writeError(w, http.StatusNotFound, "Virtual desktop was not found.")
		return
	}
	switch r.Method {
	case http.MethodGet:
		state, err := a.deps.Store.GetVirtualDesktopState(r.Context(), serverID)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, state)
	case http.MethodPut:
		var body virtualDesktopSaveRequest
		if !decodeJSON(w, r, &body) {
			return
		}
		previous, err := a.deps.Store.GetVirtualDesktopState(r.Context(), serverID)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		windows := body.DomainWindows()
		state, err := a.deps.Store.SaveVirtualDesktopState(r.Context(), serverID, windows, body.Wallpaper, body.BaseRevision)
		if err != nil {
			var conflict store.VirtualDesktopRevisionConflict
			if errors.As(err, &conflict) {
				writeJSON(w, http.StatusConflict, map[string]any{
					"error": "This virtual desktop changed on another trusted device. ShellOrchestra will merge the latest layout and retry.",
					"state": conflict.Current,
				})
				return
			}
			writeStoreError(w, err)
			return
		}
		a.closeRemovedDesktopTerminalSessions(r.Context(), removedTerminalSessionIDs(previous.Windows, state.Windows))
		writeJSON(w, http.StatusOK, state)
	default:
		methodNotAllowed(w)
	}
}

func removedTerminalSessionIDs(before []domain.VirtualDesktopWindow, after []domain.VirtualDesktopWindow) []string {
	remaining := make(map[string]struct{}, len(after))
	for _, window := range after {
		sessionID := strings.TrimSpace(window.TerminalSessionID)
		if sessionID == "" {
			continue
		}
		remaining[sessionID] = struct{}{}
	}
	seen := make(map[string]struct{})
	removed := make([]string, 0)
	for _, window := range before {
		sessionID := strings.TrimSpace(window.TerminalSessionID)
		if sessionID == "" {
			continue
		}
		if _, ok := remaining[sessionID]; ok {
			continue
		}
		if _, ok := seen[sessionID]; ok {
			continue
		}
		seen[sessionID] = struct{}{}
		removed = append(removed, sessionID)
	}
	return removed
}

func (a *App) closeRemovedDesktopTerminalSessions(ctx context.Context, sessionIDs []string) {
	if len(sessionIDs) == 0 || a.deps.Worker == nil {
		return
	}
	for _, sessionID := range sessionIDs {
		closeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		err := a.deps.Worker.CloseTerminal(closeCtx, sessionID)
		cancel()
		if err != nil && !terminalCloseErrorIsNotFound(err) {
			log.Printf("failed to close removed virtual desktop terminal session %s: %v", sessionID, err)
		}
	}
}

func terminalCloseErrorIsNotFound(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, store.ErrNotFound) {
		return true
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "terminal session was not found") || strings.Contains(message, "not found")
}

type virtualDesktopSaveRequest struct {
	Windows      []virtualDesktopWindowRequest `json:"windows"`
	Wallpaper    *string                       `json:"wallpaper"`
	BaseRevision *int64                        `json:"base_revision"`
}

type virtualDesktopWindowRequest struct {
	ID                string            `json:"id"`
	AppID             string            `json:"app_id,omitempty"`
	PluginID          string            `json:"plugin_id,omitempty"`
	FrontendModule    string            `json:"frontend_module,omitempty"`
	Kind              string            `json:"kind"`
	Title             string            `json:"title"`
	X                 float64           `json:"x"`
	Y                 float64           `json:"y"`
	Width             float64           `json:"width"`
	Height            float64           `json:"height"`
	Minimized         bool              `json:"minimized"`
	Maximized         bool              `json:"maximized"`
	ZIndex            float64           `json:"z_index"`
	TerminalSessionID string            `json:"terminal_session_id,omitempty"`
	Metadata          map[string]string `json:"metadata,omitempty"`
}

func (r virtualDesktopSaveRequest) DomainWindows() []domain.VirtualDesktopWindow {
	windows := make([]domain.VirtualDesktopWindow, 0, len(r.Windows))
	for index, window := range r.Windows {
		windows = append(windows, domain.VirtualDesktopWindow{
			ID:                strings.TrimSpace(window.ID),
			AppID:             strings.TrimSpace(window.AppID),
			PluginID:          strings.TrimSpace(window.PluginID),
			FrontendModule:    strings.TrimSpace(window.FrontendModule),
			Kind:              strings.TrimSpace(window.Kind),
			Title:             strings.TrimSpace(window.Title),
			X:                 roundedDesktopPixel(window.X),
			Y:                 roundedDesktopPixel(window.Y),
			Width:             maxDesktopInt(240, roundedDesktopPixel(window.Width)),
			Height:            maxDesktopInt(160, roundedDesktopPixel(window.Height)),
			Minimized:         window.Minimized,
			Maximized:         window.Maximized,
			ZIndex:            maxDesktopInt(1, roundedDesktopPixelWithFallback(window.ZIndex, index+1)),
			TerminalSessionID: strings.TrimSpace(window.TerminalSessionID),
			Metadata:          window.Metadata,
		})
	}
	return windows
}

func roundedDesktopPixel(value float64) int {
	return roundedDesktopPixelWithFallback(value, 0)
}

func roundedDesktopPixelWithFallback(value float64, fallback int) int {
	if value != value || value > 100000 || value < -100000 {
		return fallback
	}
	if value >= 0 {
		return int(value + 0.5)
	}
	return int(value - 0.5)
}

func maxDesktopInt(minimum int, value int) int {
	if value < minimum {
		return minimum
	}
	return value
}

func (a *App) desktopApps(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	items, err := a.desktopAppService().List(r.Context(), r.URL.Query().Get("server_id"))
	if err != nil {
		writeDesktopAppError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"apps": items})
}

func (a *App) desktopAppByID(w http.ResponseWriter, r *http.Request) {
	appID, rest := splitIDPath(strings.TrimPrefix(r.URL.Path, "/api/desktop-apps/"))
	if appID == "" {
		http.NotFound(w, r)
		return
	}
	switch rest {
	case "/launch":
		a.desktopAppLaunch(w, r, appID)
	case "/install":
		a.desktopAppInstall(w, r, appID)
	case "/action":
		a.desktopAppAction(w, r, appID)
	case "/data":
		a.desktopAppData(w, r, appID)
	case "/data-stream":
		a.desktopAppDataStream(w, r, appID)
	default:
		http.NotFound(w, r)
	}
}

func (a *App) desktopAppLaunch(w http.ResponseWriter, r *http.Request, appID string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var body struct {
		ServerID string            `json:"server_id"`
		Cols     int               `json:"cols"`
		Rows     int               `json:"rows"`
		Args     map[string]string `json:"args"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	response, err := a.desktopAppService().Launch(r.Context(), appID, desktopapps.LaunchRequest{ServerID: body.ServerID, Cols: body.Cols, Rows: body.Rows, Args: body.Args})
	if err != nil {
		a.writeDesktopAppValidationError(w, r, desktopAppMutationAuditInput{
			EventType: "desktop_app.validation.failed",
			Operation: "launch",
			ServerID:  body.ServerID,
			AppID:     appID,
			Err:       err,
		}, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (a *App) desktopAppInstall(w http.ResponseWriter, r *http.Request, appID string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var body struct {
		ServerID  string `json:"server_id"`
		Confirmed bool   `json:"confirmed"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	requestEvent, err := a.appendDesktopAppMutationAudit(r.Context(), r, desktopAppMutationAuditInput{
		EventType: "desktop_app.install.requested",
		Operation: "install",
		ServerID:  body.ServerID,
		AppID:     appID,
		Confirmed: body.Confirmed,
	})
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "Audit log is required before running an app install script: "+err.Error())
		return
	}
	response, err := a.desktopAppService().Install(r.Context(), appID, desktopapps.InstallRequest{ServerID: body.ServerID, Confirmed: body.Confirmed})
	if err != nil {
		_, _ = a.appendDesktopAppMutationAudit(context.WithoutCancel(r.Context()), r, desktopAppMutationAuditInput{
			EventType:      "desktop_app.install.failed",
			Operation:      "install",
			ServerID:       body.ServerID,
			AppID:          appID,
			Confirmed:      body.Confirmed,
			RequestEventID: requestEvent.ID,
			Err:            err,
		})
		writeDesktopAppError(w, err)
		return
	}
	commitEvent, err := a.appendDesktopAppMutationAudit(r.Context(), r, desktopAppMutationAuditInput{
		EventType:      "desktop_app.install.queued",
		Operation:      "install",
		ServerID:       body.ServerID,
		AppID:          appID,
		Confirmed:      body.Confirmed,
		RequestEventID: requestEvent.ID,
		RunID:          response.Run.ID,
		Command:        response.Run.Command,
		Variant:        response.Run.Variant,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "The app install was queued, but ShellOrchestra could not append the audit event: "+err.Error())
		return
	}
	response.Run.Result = map[string]any{"audit_event_id": commitEvent.ID, "audit_hash": commitEvent.Hash}
	writeJSON(w, http.StatusAccepted, response)
}

func (a *App) desktopAppAction(w http.ResponseWriter, r *http.Request, appID string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var body struct {
		ServerID  string            `json:"server_id"`
		Action    string            `json:"action"`
		Args      map[string]string `json:"args"`
		Confirmed bool              `json:"confirmed"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	requestEvent, err := a.appendDesktopAppMutationAudit(r.Context(), r, desktopAppMutationAuditInput{
		EventType: "desktop_app.action.requested",
		Operation: "action",
		ServerID:  body.ServerID,
		AppID:     appID,
		Action:    body.Action,
		Confirmed: body.Confirmed,
		Args:      body.Args,
	})
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "Audit log is required before running an app action script: "+err.Error())
		return
	}
	response, err := a.desktopAppService().Action(r.Context(), appID, desktopapps.ActionRequest{ServerID: body.ServerID, Action: body.Action, Args: body.Args, Confirmed: body.Confirmed})
	if err != nil {
		_, _ = a.appendDesktopAppMutationAudit(context.WithoutCancel(r.Context()), r, desktopAppMutationAuditInput{
			EventType:      "desktop_app.action.failed",
			Operation:      "action",
			ServerID:       body.ServerID,
			AppID:          appID,
			Action:         body.Action,
			Confirmed:      body.Confirmed,
			Args:           body.Args,
			RequestEventID: requestEvent.ID,
			Err:            err,
		})
		writeDesktopAppError(w, err)
		return
	}
	commitEvent, err := a.appendDesktopAppMutationAudit(r.Context(), r, desktopAppMutationAuditInput{
		EventType:      "desktop_app.action.queued",
		Operation:      "action",
		ServerID:       body.ServerID,
		AppID:          appID,
		Action:         response.Action,
		Confirmed:      body.Confirmed,
		Args:           body.Args,
		RequestEventID: requestEvent.ID,
		RunID:          response.Run.ID,
		Command:        response.Run.Command,
		Variant:        response.Run.Variant,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "The app action was queued, but ShellOrchestra could not append the audit event: "+err.Error())
		return
	}
	response.Run.Result = map[string]any{"audit_event_id": commitEvent.ID, "audit_hash": commitEvent.Hash}
	writeJSON(w, http.StatusAccepted, response)
}

func (a *App) desktopAppData(w http.ResponseWriter, r *http.Request, appID string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var body struct {
		ServerID  string            `json:"server_id"`
		Args      map[string]string `json:"args"`
		Confirmed bool              `json:"confirmed"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	dataAction := strings.TrimSpace(body.Args["file_manager_action"])
	if appID == "file_manager" && fileManagerLegacyJSONContentAction(dataAction) {
		writeError(w, http.StatusGone, "File Manager file content must use the stream endpoints. The legacy JSON/base64 content endpoint is disabled.")
		return
	}
	if appID == "sudo_editor" && strings.TrimSpace(body.Args["sudo_mode"]) == "save" {
		a.sudoEditorWriteWithHistory(w, r, desktopapps.DataRequest{ServerID: body.ServerID, Args: body.Args, Confirmed: body.Confirmed})
		return
	}
	mutatingData := desktopapps.PayloadMutatesServer(appID, "data", body.Args)
	var requestEvent auditlog.Event
	if mutatingData {
		if !body.Confirmed {
			writeError(w, http.StatusPreconditionRequired, "ShellOrchestra requires explicit confirmation before changing a managed server.")
			return
		}
		var err error
		requestEvent, err = a.appendDesktopAppMutationAudit(r.Context(), r, desktopAppMutationAuditInput{
			EventType: "desktop_app.data.requested",
			Operation: "data",
			ServerID:  body.ServerID,
			AppID:     appID,
			Action:    dataAction,
			Confirmed: body.Confirmed,
			Args:      body.Args,
		})
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, "Audit log is required before running a mutating app data script: "+err.Error())
			return
		}
	}
	response, err := a.desktopAppService().Data(r.Context(), appID, desktopapps.DataRequest{ServerID: body.ServerID, Args: body.Args, Confirmed: body.Confirmed})
	if err != nil {
		if mutatingData {
			_, _ = a.appendDesktopAppMutationAudit(context.WithoutCancel(r.Context()), r, desktopAppMutationAuditInput{
				EventType:      "desktop_app.data.failed",
				Operation:      "data",
				ServerID:       body.ServerID,
				AppID:          appID,
				Action:         dataAction,
				Confirmed:      body.Confirmed,
				Args:           body.Args,
				RequestEventID: requestEvent.ID,
				Err:            err,
			})
		} else {
			a.writeDesktopAppValidationError(w, r, desktopAppMutationAuditInput{
				EventType: "desktop_app.validation.failed",
				Operation: "data",
				ServerID:  body.ServerID,
				AppID:     appID,
				Confirmed: body.Confirmed,
				Args:      body.Args,
				Err:       err,
			}, err)
			return
		}
		writeDesktopAppError(w, err)
		return
	}
	if mutatingData {
		commitEvent, err := a.appendDesktopAppMutationAudit(r.Context(), r, desktopAppMutationAuditInput{
			EventType:      "desktop_app.data.committed",
			Operation:      "data",
			ServerID:       body.ServerID,
			AppID:          appID,
			Action:         dataAction,
			Confirmed:      body.Confirmed,
			Args:           body.Args,
			RequestEventID: requestEvent.ID,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "The app data operation completed, but ShellOrchestra could not append the audit event: "+err.Error())
			return
		}
		if result, ok := response.Result.(map[string]any); ok {
			result["audit_event_id"] = commitEvent.ID
			result["audit_hash"] = commitEvent.Hash
			response.Result = result
		}
	}
	writeJSON(w, http.StatusOK, response)
}

func fileManagerLegacyJSONContentAction(action string) bool {
	switch strings.TrimSpace(action) {
	case "preview", "read", "read_range", "write":
		return true
	default:
		return false
	}
}

func (a *App) fileManagerSaveBytesWithHistory(w http.ResponseWriter, r *http.Request, request desktopapps.DataRequest, afterContent []byte, browserUploadTransport string, remoteWrite func(context.Context) (map[string]any, error)) (map[string]any, bool) {
	if a.deps.Versions == nil || a.deps.Audit == nil {
		writeError(w, http.StatusServiceUnavailable, "File versioning and audit services are not configured.")
		return nil, false
	}
	if a.deps.Worker == nil {
		writeError(w, http.StatusServiceUnavailable, "SSH worker is not configured.")
		return nil, false
	}
	principal, _ := r.Context().Value(principalKey{}).(*domain.Principal)
	clientIP := sessionClientIP(r)
	path := strings.TrimSpace(request.Args["file_manager_path"])
	if path == "" {
		writeError(w, http.StatusBadRequest, "File path is required for editor save.")
		return nil, false
	}
	if !request.Confirmed {
		writeError(w, http.StatusPreconditionRequired, "ShellOrchestra requires explicit confirmation before saving a file on a managed server.")
		return nil, false
	}
	requestID := r.Header.Get("X-ShellOrchestra-Nonce")
	beforeHash := ""
	beforeVersionID := ""
	beforeContent, beforeRemoteHash, beforeErr := a.readFileManagerVersionContent(r.Context(), request.ServerID, path)
	if beforeErr == nil {
		beforeVersion, err := a.deps.Versions.Save(r.Context(), fileversion.SaveInput{
			ServerID:      request.ServerID,
			Path:          path,
			Role:          "before_write",
			Content:       beforeContent,
			RemoteSHA256:  beforeRemoteHash,
			ActorDeviceID: principalDeviceID(principal),
			ActorLabel:    principalLabel(principal),
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Could not create the pre-save file version: "+err.Error())
			return nil, false
		}
		beforeHash = beforeVersion.ContentSHA256
		beforeVersionID = beforeVersion.ID
	}
	requestEvent, err := a.deps.Audit.Append(r.Context(), auditlog.EventInput{
		Type:          "file.write.requested",
		ActorDeviceID: principalDeviceID(principal),
		ActorLabel:    principalLabel(principal),
		ClientIP:      clientIP,
		ServerID:      request.ServerID,
		Operation:     "write",
		Path:          path,
		BeforeHash:    beforeHash,
		AfterHash:     sha256Hex(afterContent),
		VersionID:     beforeVersionID,
		RequestID:     requestID,
		Metadata: map[string]string{
			"before_read_error":        errorString(beforeErr),
			"before_read_transport":    "compressed_stream",
			"content_size":             fmt.Sprintf("%d", len(afterContent)),
			"browser_upload_transport": browserUploadTransport,
			"content_values_logged":    "false",
		},
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not append the pre-save audit event: "+err.Error())
		return nil, false
	}
	if beforeVersionID != "" {
		if err := a.deps.Versions.AttachAuditEvent(r.Context(), beforeVersionID, requestEvent.ID); err != nil {
			writeError(w, http.StatusInternalServerError, "Could not link the pre-save file version to its audit event: "+err.Error())
			return nil, false
		}
	}
	result, err := remoteWrite(r.Context())
	if err != nil {
		_, _ = a.deps.Audit.Append(context.WithoutCancel(r.Context()), auditlog.EventInput{
			Type:          "file.write.failed",
			ActorDeviceID: principalDeviceID(principal),
			ActorLabel:    principalLabel(principal),
			ClientIP:      clientIP,
			ServerID:      request.ServerID,
			Operation:     "write",
			Path:          path,
			BeforeHash:    beforeHash,
			AfterHash:     sha256Hex(afterContent),
			RequestID:     requestID,
			Metadata:      map[string]string{"request_event_id": requestEvent.ID, "error": err.Error()},
		})
		writeDesktopAppError(w, err)
		return nil, false
	}
	remoteHash := stringFromResult(result, "sha256")
	afterVersion, err := a.deps.Versions.Save(r.Context(), fileversion.SaveInput{
		ServerID:      request.ServerID,
		Path:          path,
		Role:          "after_write",
		Content:       afterContent,
		RemoteSHA256:  remoteHash,
		ActorDeviceID: principalDeviceID(principal),
		ActorLabel:    principalLabel(principal),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "The file was saved, but ShellOrchestra could not persist the post-save version: "+err.Error())
		return nil, false
	}
	commitEvent, err := a.deps.Audit.Append(r.Context(), auditlog.EventInput{
		Type:          "file.write.committed",
		ActorDeviceID: principalDeviceID(principal),
		ActorLabel:    principalLabel(principal),
		ClientIP:      clientIP,
		ServerID:      request.ServerID,
		Operation:     "write",
		Path:          path,
		BeforeHash:    beforeHash,
		AfterHash:     afterVersion.ContentSHA256,
		VersionID:     afterVersion.ID,
		RequestID:     requestID,
		Metadata:      map[string]string{"request_event_id": requestEvent.ID, "remote_sha256": remoteHash},
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "The file was saved, but ShellOrchestra could not append the post-save audit event: "+err.Error())
		return nil, false
	}
	if err := a.deps.Versions.AttachAuditEvent(r.Context(), afterVersion.ID, commitEvent.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "The file was saved, but ShellOrchestra could not link the post-save version to its audit event: "+err.Error())
		return nil, false
	}
	if result == nil {
		result = map[string]any{}
	}
	result["version_id"] = afterVersion.ID
	result["audit_event_id"] = commitEvent.ID
	result["audit_hash"] = commitEvent.Hash
	result["editor_save_stream"] = true
	result["browser_upload_transport"] = browserUploadTransport
	return result, true
}

func (a *App) sudoEditorWriteWithHistory(w http.ResponseWriter, r *http.Request, request desktopapps.DataRequest) {
	if a.deps.Versions == nil || a.deps.Audit == nil {
		writeError(w, http.StatusServiceUnavailable, "File versioning and audit services are not configured.")
		return
	}
	principal, _ := r.Context().Value(principalKey{}).(*domain.Principal)
	clientIP := sessionClientIP(r)
	path := strings.TrimSpace(request.Args["sudo_path"])
	afterContent := []byte(request.Args["sudo_content"])
	if path == "" || strings.TrimSpace(request.Args["sudo_mode"]) != "save" {
		writeError(w, http.StatusBadRequest, "Sudoers file path and save mode are required.")
		return
	}
	if !request.Confirmed {
		writeError(w, http.StatusPreconditionRequired, "ShellOrchestra requires explicit confirmation before saving sudoers on a managed server.")
		return
	}
	requestID := r.Header.Get("X-ShellOrchestra-Nonce")
	beforeHash := ""
	beforeVersionID := ""
	beforeRead, beforeErr := a.desktopAppService().Data(r.Context(), "sudo_editor", desktopapps.DataRequest{
		ServerID: request.ServerID,
		Args: map[string]string{
			"sudo_mode": "read",
			"sudo_path": path,
		},
	})
	if beforeErr == nil {
		if beforeContent, ok := contentBytesFromTextResult(beforeRead.Result, "content"); ok {
			beforeVersion, err := a.deps.Versions.Save(r.Context(), fileversion.SaveInput{
				ServerID:      request.ServerID,
				Path:          path,
				Role:          "before_sudoers_write",
				Content:       beforeContent,
				RemoteSHA256:  stringFromResult(beforeRead.Result, "sha256"),
				ActorDeviceID: principalDeviceID(principal),
				ActorLabel:    principalLabel(principal),
			})
			if err != nil {
				writeError(w, http.StatusInternalServerError, "Could not create the pre-save sudoers version: "+err.Error())
				return
			}
			beforeHash = beforeVersion.ContentSHA256
			beforeVersionID = beforeVersion.ID
		}
	}
	requestEvent, err := a.deps.Audit.Append(r.Context(), auditlog.EventInput{
		Type:          "sudoers.write.requested",
		ActorDeviceID: principalDeviceID(principal),
		ActorLabel:    principalLabel(principal),
		ClientIP:      clientIP,
		ServerID:      request.ServerID,
		Operation:     "sudoers_write",
		Path:          path,
		BeforeHash:    beforeHash,
		AfterHash:     sha256Hex(afterContent),
		VersionID:     beforeVersionID,
		RequestID:     requestID,
		Metadata: map[string]string{
			"before_read_error": errorString(beforeErr),
			"content_size":      fmt.Sprintf("%d", len(afterContent)),
			"app_id":            "sudo_editor",
		},
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not append the pre-save sudoers audit event: "+err.Error())
		return
	}
	if beforeVersionID != "" {
		if err := a.deps.Versions.AttachAuditEvent(r.Context(), beforeVersionID, requestEvent.ID); err != nil {
			writeError(w, http.StatusInternalServerError, "Could not link the pre-save sudoers version to its audit event: "+err.Error())
			return
		}
	}
	response, err := a.desktopAppService().Data(r.Context(), "sudo_editor", request)
	if err != nil {
		_, _ = a.deps.Audit.Append(context.WithoutCancel(r.Context()), auditlog.EventInput{
			Type:          "sudoers.write.failed",
			ActorDeviceID: principalDeviceID(principal),
			ActorLabel:    principalLabel(principal),
			ClientIP:      clientIP,
			ServerID:      request.ServerID,
			Operation:     "sudoers_write",
			Path:          path,
			BeforeHash:    beforeHash,
			AfterHash:     sha256Hex(afterContent),
			RequestID:     requestID,
			Metadata:      map[string]string{"request_event_id": requestEvent.ID, "error": err.Error(), "app_id": "sudo_editor"},
		})
		writeDesktopAppError(w, err)
		return
	}
	afterVersionContent := afterContent
	remoteHash := stringFromResult(response.Result, "sha256")
	afterRead, afterReadErr := a.desktopAppService().Data(r.Context(), "sudo_editor", desktopapps.DataRequest{
		ServerID: request.ServerID,
		Args: map[string]string{
			"sudo_mode": "read",
			"sudo_path": path,
		},
	})
	if afterReadErr == nil {
		if remoteContent, ok := contentBytesFromTextResult(afterRead.Result, "content"); ok {
			afterVersionContent = remoteContent
		}
		if readHash := stringFromResult(afterRead.Result, "sha256"); readHash != "" {
			remoteHash = readHash
		}
	}
	afterVersion, err := a.deps.Versions.Save(r.Context(), fileversion.SaveInput{
		ServerID:      request.ServerID,
		Path:          path,
		Role:          "after_sudoers_write",
		Content:       afterVersionContent,
		RemoteSHA256:  remoteHash,
		ActorDeviceID: principalDeviceID(principal),
		ActorLabel:    principalLabel(principal),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "The sudoers file was saved, but ShellOrchestra could not persist the post-save version: "+err.Error())
		return
	}
	commitEvent, err := a.deps.Audit.Append(r.Context(), auditlog.EventInput{
		Type:          "sudoers.write.committed",
		ActorDeviceID: principalDeviceID(principal),
		ActorLabel:    principalLabel(principal),
		ClientIP:      clientIP,
		ServerID:      request.ServerID,
		Operation:     "sudoers_write",
		Path:          path,
		BeforeHash:    beforeHash,
		AfterHash:     afterVersion.ContentSHA256,
		VersionID:     afterVersion.ID,
		RequestID:     requestID,
		Metadata:      map[string]string{"request_event_id": requestEvent.ID, "remote_sha256": remoteHash, "after_read_error": errorString(afterReadErr), "app_id": "sudo_editor"},
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "The sudoers file was saved, but ShellOrchestra could not append the post-save audit event: "+err.Error())
		return
	}
	if err := a.deps.Versions.AttachAuditEvent(r.Context(), afterVersion.ID, commitEvent.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "The sudoers file was saved, but ShellOrchestra could not link the post-save version to its audit event: "+err.Error())
		return
	}
	if result, ok := response.Result.(map[string]any); ok {
		result["version_id"] = afterVersion.ID
		result["audit_event_id"] = commitEvent.ID
		result["audit_hash"] = commitEvent.Hash
		response.Result = result
	}
	writeJSON(w, http.StatusOK, response)
}

func (a *App) desktopAppService() *desktopapps.Service {
	if a.desktopAppSvc == nil {
		a.desktopAppSvc = a.newDesktopAppService()
	}
	return a.desktopAppSvc
}

func (a *App) newDesktopAppService() *desktopapps.Service {
	return desktopapps.NewService(desktopapps.Config{
		ScriptsRoot:   a.deps.Config.Scripts.Root,
		Scripts:       a.deps.Scripts,
		Store:         a.deps.Store,
		Worker:        a.deps.Worker,
		Planner:       a.deps.AppPlans,
		ExecuteScript: a.executeScriptWithArgs,
	})
}

func (a *App) fileVersions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	if a.deps.Versions == nil {
		writeError(w, http.StatusServiceUnavailable, "File versioning is not configured.")
		return
	}
	serverID := strings.TrimSpace(r.URL.Query().Get("server_id"))
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	versions, err := a.deps.Versions.List(r.Context(), serverID, path, 100)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"versions": versions})
}

func (a *App) fileVersionByID(w http.ResponseWriter, r *http.Request) {
	versionID, rest := splitIDPath(strings.TrimPrefix(r.URL.Path, "/api/file-versions/"))
	if versionID == "" || rest != "" {
		writeError(w, http.StatusNotFound, "File version was not found.")
		return
	}
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	if a.deps.Versions == nil {
		writeError(w, http.StatusServiceUnavailable, "File versioning is not configured.")
		return
	}
	version, err := a.deps.Versions.Content(r.Context(), versionID)
	if err != nil {
		if errors.Is(err, fileversion.ErrNotFound) {
			writeError(w, http.StatusNotFound, "File version was not found.")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, version)
}

func (a *App) auditHead(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	if a.deps.Audit == nil {
		writeError(w, http.StatusServiceUnavailable, "Audit log is not configured.")
		return
	}
	head, err := a.deps.Audit.Head(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, head)
}

func (a *App) auditVerify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	if a.deps.Audit == nil {
		writeError(w, http.StatusServiceUnavailable, "Audit log is not configured.")
		return
	}
	result, err := a.deps.Audit.Verify(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

type desktopAppMutationAuditInput struct {
	EventType      string
	Operation      string
	ServerID       string
	AppID          string
	Action         string
	Confirmed      bool
	Args           map[string]string
	RequestEventID string
	RunID          string
	Command        string
	Variant        string
	Err            error
}

func (a *App) appendDesktopAppMutationAudit(ctx context.Context, r *http.Request, input desktopAppMutationAuditInput) (auditlog.Event, error) {
	if a.deps.Audit == nil {
		return auditlog.Event{}, fmt.Errorf("audit log is not configured")
	}
	principal, _ := r.Context().Value(principalKey{}).(*domain.Principal)
	metadata := desktopAppPayloadAuditMetadata(input.Args)
	metadata["app_id"] = strings.TrimSpace(input.AppID)
	metadata["confirmed"] = fmt.Sprintf("%t", input.Confirmed)
	if action := strings.TrimSpace(input.Action); action != "" {
		metadata["action"] = action
	}
	if input.RequestEventID != "" {
		metadata["request_event_id"] = input.RequestEventID
	}
	if input.RunID != "" {
		metadata["run_id"] = input.RunID
	}
	if input.Command != "" {
		metadata["command"] = input.Command
	}
	if input.Variant != "" {
		metadata["variant"] = input.Variant
	}
	if input.Err != nil {
		metadata["error_status"] = fmt.Sprintf("%d", desktopapps.HTTPStatus(input.Err))
		metadata["error_message_logged"] = "false"
	}
	operation := strings.TrimSpace(input.Operation)
	if operation == "" {
		operation = "desktop_app"
	}
	return a.deps.Audit.Append(ctx, auditlog.EventInput{
		Type:          strings.TrimSpace(input.EventType),
		ActorDeviceID: principalDeviceID(principal),
		ActorLabel:    principalLabel(principal),
		ClientIP:      sessionClientIP(r),
		ServerID:      strings.TrimSpace(input.ServerID),
		Operation:     operation,
		Path:          "desktop-app/" + strings.TrimSpace(input.AppID),
		RequestID:     r.Header.Get("X-ShellOrchestra-Nonce"),
		Metadata:      metadata,
	})
}

func (a *App) writeDesktopAppValidationError(w http.ResponseWriter, r *http.Request, input desktopAppMutationAuditInput, err error) {
	if strings.TrimSpace(input.EventType) == "" {
		input.EventType = "desktop_app.validation.failed"
	}
	input.Err = err
	_, _ = a.appendDesktopAppMutationAudit(context.WithoutCancel(r.Context()), r, input)
	writeDesktopAppError(w, err)
}

func desktopAppPayloadAuditMetadata(args map[string]string) map[string]string {
	metadata := map[string]string{}
	if len(args) == 0 {
		metadata["payload_field_count"] = "0"
		return metadata
	}
	keys := make([]string, 0, len(args))
	totalBytes := 0
	sensitiveFields := 0
	for key, value := range args {
		trimmedKey := strings.TrimSpace(key)
		if trimmedKey == "" {
			continue
		}
		keys = append(keys, auditMetadataFieldName(trimmedKey))
		totalBytes += len([]byte(value))
		if desktopAppPayloadKeyLooksSensitive(trimmedKey) {
			sensitiveFields++
		}
	}
	sort.Strings(keys)
	metadata["payload_field_count"] = fmt.Sprintf("%d", len(keys))
	metadata["payload_value_bytes"] = fmt.Sprintf("%d", totalBytes)
	metadata["payload_keys"] = strings.Join(keys, ",")
	metadata["payload_values_logged"] = "false"
	if sensitiveFields > 0 {
		metadata["payload_sensitive_field_count"] = fmt.Sprintf("%d", sensitiveFields)
	}
	return metadata
}

const maxAuditMetadataFieldNameRunes = 96

func auditMetadataFieldName(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	var builder strings.Builder
	runes := 0
	truncated := false
	for _, r := range trimmed {
		if runes >= maxAuditMetadataFieldNameRunes {
			truncated = true
			break
		}
		switch {
		case r < 0x20 || r == 0x7f || (r >= 0x80 && r <= 0x9f):
			fmt.Fprintf(&builder, "\\u%04x", r)
		default:
			builder.WriteRune(r)
		}
		runes++
	}
	if truncated {
		builder.WriteString("…")
	}
	return builder.String()
}

func desktopAppPayloadKeyLooksSensitive(key string) bool {
	key = strings.ToLower(strings.TrimSpace(key))
	for _, marker := range []string{"content", "password", "secret", "token", "private", "share", "key"} {
		if strings.Contains(key, marker) {
			return true
		}
	}
	return false
}

func contentBytesFromTextResult(result any, key string) ([]byte, bool) {
	values, ok := result.(map[string]any)
	if !ok {
		return nil, false
	}
	value, ok := values[key]
	if !ok {
		return nil, false
	}
	raw, ok := value.(string)
	if !ok || raw == "" {
		return nil, false
	}
	return []byte(raw), true
}

func stringFromResult(result any, key string) string {
	values, ok := result.(map[string]any)
	if !ok {
		return ""
	}
	value, ok := values[key]
	if !ok {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}

func principalDeviceID(principal *domain.Principal) string {
	if principal == nil {
		return ""
	}
	return principal.DeviceID
}

func principalLabel(principal *domain.Principal) string {
	if principal == nil {
		return ""
	}
	return principal.Label
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func sha256Hex(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

func writeDesktopAppError(w http.ResponseWriter, err error) {
	writeError(w, desktopapps.HTTPStatus(err), err.Error())
}

func (a *App) terminals(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var body struct {
		ServerID       string `json:"server_id"`
		Title          string `json:"title"`
		Cols           int    `json:"cols"`
		Rows           int    `json:"rows"`
		InitialCommand string `json:"initial_command"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.InitialCommand) != "" {
		writeError(w, http.StatusBadRequest, "Interactive terminal sessions must start with the server's default shell. Application launch commands are selected only by backend-owned desktop app policy.")
		return
	}
	if a.deps.Worker == nil {
		writeError(w, http.StatusServiceUnavailable, "Terminal worker is not configured.")
		return
	}
	snapshot, err := a.deps.Worker.CreateTerminal(r.Context(), body.ServerID, body.Title, body.Cols, body.Rows, "")
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (a *App) terminalByID(w http.ResponseWriter, r *http.Request) {
	sessionID, rest := splitIDPath(strings.TrimPrefix(r.URL.Path, "/api/terminals/"))
	if sessionID == "" {
		writeError(w, http.StatusNotFound, "Terminal session was not found.")
		return
	}
	if a.deps.Worker == nil {
		writeError(w, http.StatusServiceUnavailable, "Terminal worker is not configured.")
		return
	}
	switch rest {
	case "/snapshot":
		if r.Method != http.MethodGet {
			methodNotAllowed(w)
			return
		}
		snapshot, err := a.deps.Worker.TerminalSnapshot(r.Context(), sessionID)
		if err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, snapshot)
	case "/input":
		if r.Method != http.MethodPost {
			methodNotAllowed(w)
			return
		}
		var body struct {
			Data string `json:"data"`
		}
		if !decodeJSON(w, r, &body) {
			return
		}
		if err := a.deps.Worker.SendTerminalInput(r.Context(), sessionID, body.Data); err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case "/resize":
		if r.Method != http.MethodPost {
			methodNotAllowed(w)
			return
		}
		var body struct {
			Cols int `json:"cols"`
			Rows int `json:"rows"`
		}
		if !decodeJSON(w, r, &body) {
			return
		}
		snapshot, err := a.deps.Worker.ResizeTerminal(r.Context(), sessionID, body.Cols, body.Rows)
		if err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, snapshot)
	case "/stream-ticket":
		if r.Method != http.MethodPost {
			methodNotAllowed(w)
			return
		}
		ticket, err := a.issueTerminalStreamTicket(r, sessionID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, ticket)
	case "/stream":
		if r.Method != http.MethodGet {
			methodNotAllowed(w)
			return
		}
		if a.deps.Worker == nil {
			writeError(w, http.StatusServiceUnavailable, "Terminal worker is not configured.")
			return
		}
		if !a.validTerminalStreamOrigin(r) {
			writeError(w, http.StatusForbidden, "Terminal stream origin is not allowed.")
			return
		}
		if !a.consumeTerminalStreamTicket(r, sessionID) {
			writeError(w, http.StatusForbidden, "Terminal stream ticket is missing, expired, or does not match this session.")
			return
		}
		a.deps.Worker.ProxyTerminalStream(w, r, sessionID)
	case "/close":
		if r.Method != http.MethodPost {
			methodNotAllowed(w)
			return
		}
		if err := a.deps.Worker.CloseTerminal(r.Context(), sessionID); err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		writeError(w, http.StatusNotFound, "Terminal action was not found.")
	}
}

func (a *App) issueTerminalStreamTicket(r *http.Request, sessionID string) (terminalStreamTicketResponse, error) {
	principal, ok := r.Context().Value(principalKey{}).(*domain.Principal)
	if !ok || principal == nil || strings.TrimSpace(principal.DeviceID) == "" {
		return terminalStreamTicketResponse{}, fmt.Errorf("authenticated device identity is required")
	}
	token, err := randomToken()
	if err != nil {
		return terminalStreamTicketResponse{}, err
	}
	expiresAt := time.Now().UTC().Add(terminalStreamTicketTTL)
	a.purgeExpiredTerminalStreamTickets()
	if a.activeTerminalStreamTicketCount() >= maxTerminalStreamTickets {
		return terminalStreamTicketResponse{}, fmt.Errorf("too many pending terminal stream tickets; retry after existing tickets expire")
	}
	a.terminalStreamTickets.Store(token, terminalStreamTicket{
		SessionID: strings.TrimSpace(sessionID),
		DeviceID:  strings.TrimSpace(principal.DeviceID),
		ExpiresAt: expiresAt,
	})
	return terminalStreamTicketResponse{Token: token, ExpiresAt: expiresAt}, nil
}

func (a *App) purgeExpiredTerminalStreamTickets() {
	now := time.Now().UTC()
	a.terminalStreamTickets.Range(func(key any, value any) bool {
		ticket, ok := value.(terminalStreamTicket)
		if ok && now.After(ticket.ExpiresAt) {
			a.terminalStreamTickets.Delete(key)
		}
		return true
	})
}

func (a *App) activeTerminalStreamTicketCount() int {
	count := 0
	a.terminalStreamTickets.Range(func(_ any, _ any) bool {
		count++
		return count < maxTerminalStreamTickets
	})
	return count
}

func (a *App) consumeTerminalStreamTicket(r *http.Request, sessionID string) bool {
	token := strings.TrimSpace(r.URL.Query().Get("ticket"))
	if token == "" {
		return false
	}
	value, ok := a.terminalStreamTickets.LoadAndDelete(token)
	if !ok {
		return false
	}
	ticket, ok := value.(terminalStreamTicket)
	if !ok {
		return false
	}
	return strings.TrimSpace(ticket.SessionID) == strings.TrimSpace(sessionID) &&
		strings.TrimSpace(ticket.DeviceID) != "" &&
		time.Now().UTC().Before(ticket.ExpiresAt)
}

func (a *App) validTerminalStreamOrigin(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return false
	}
	if origin == "null" && strings.TrimSpace(r.URL.Query().Get("ticket")) != "" {
		return true
	}
	return sameOrigin(a.requestOrigin(r), origin)
}

func (a *App) importFirstUsableSSHConfigIdentityFile(ctx context.Context, profile sshconfig.Profile, usedKeyLabels map[string]struct{}) (string, string, error) {
	reasons := make([]string, 0, len(profile.IdentityFiles))
	for _, identityFile := range profile.IdentityFiles {
		resolved, err := resolveSSHConfigIdentityFilePath(identityFile)
		if err != nil {
			reasons = append(reasons, fmt.Sprintf("%s: %v", identityFile, err))
			continue
		}
		content, err := os.ReadFile(resolved)
		if err != nil {
			reasons = append(reasons, fmt.Sprintf("%s: %v", identityFile, err))
			continue
		}
		publicKey, err := publicKeyFromUnencryptedPrivateKey(string(content))
		if err != nil {
			reasons = append(reasons, fmt.Sprintf("%s: %v", identityFile, err))
			continue
		}
		label := uniqueImportedKeyLabel(profile.Name, filepath.Base(resolved), usedKeyLabels)
		key, err := a.deps.Store.CreateSSHUserKey(ctx, label, publicKey, string(content))
		if err != nil {
			return "", "", fmt.Errorf("could not store imported key %s: %w", identityFile, err)
		}
		usedKeyLabels[normalizeServerLabelKey(key.Label)] = struct{}{}
		note := fmt.Sprintf("Imported unencrypted IdentityFile %s into key vault as %q and selected it for unattended SSH authentication.", identityFile, key.Label)
		return key.ID, note, nil
	}
	if len(reasons) == 0 {
		return "", "", fmt.Errorf("No IdentityFile entry was available for unattended import.")
	}
	return "", "", fmt.Errorf("IdentityFile entries could not be used for unattended SSH authentication. ShellOrchestra did not fall back to another auth method. Details: %s", strings.Join(reasons, "; "))
}

func resolveSSHConfigIdentityFilePath(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", fmt.Errorf("path is empty")
	}
	if strings.ContainsAny(value, "*?") {
		return "", fmt.Errorf("paths with globs are not imported automatically")
	}
	value = expandWindowsPercentEnv(value)
	if strings.Contains(value, "%") {
		return "", fmt.Errorf("paths with unresolved OpenSSH tokens or percent expansion are not imported automatically")
	}
	if strings.HasPrefix(value, "~") {
		home, err := os.UserHomeDir()
		if err != nil || strings.TrimSpace(home) == "" {
			return "", fmt.Errorf("cannot expand home directory")
		}
		switch {
		case value == "~":
			value = home
		case strings.HasPrefix(value, "~/") || strings.HasPrefix(value, `~\`):
			value = filepath.Join(home, value[2:])
		default:
			return "", fmt.Errorf("home expansion for another user is not supported")
		}
	}
	value = os.ExpandEnv(value)
	if !filepath.IsAbs(value) {
		return "", fmt.Errorf("path must be absolute after expansion")
	}
	cleaned := filepath.Clean(value)
	info, err := os.Stat(cleaned)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", fmt.Errorf("path points to a directory")
	}
	if info.Size() > 256*1024 {
		return "", fmt.Errorf("private key file is larger than the supported 256 KiB limit")
	}
	return cleaned, nil
}

func expandWindowsPercentEnv(value string) string {
	var builder strings.Builder
	for index := 0; index < len(value); {
		if value[index] != '%' {
			builder.WriteByte(value[index])
			index++
			continue
		}
		end := strings.IndexByte(value[index+1:], '%')
		if end < 0 {
			builder.WriteByte(value[index])
			index++
			continue
		}
		name := value[index+1 : index+1+end]
		if name == "" {
			builder.WriteString("%%")
			index += 2
			continue
		}
		if replacement, ok := os.LookupEnv(name); ok {
			builder.WriteString(replacement)
		} else {
			builder.WriteByte('%')
			builder.WriteString(name)
			builder.WriteByte('%')
		}
		index += len(name) + 2
	}
	return builder.String()
}

func publicKeyFromUnencryptedPrivateKey(privateKey string) (string, error) {
	signer, err := ssh.ParsePrivateKey([]byte(strings.TrimSpace(privateKey)))
	if err != nil {
		return "", fmt.Errorf("private key must be unencrypted and usable without a passphrase or UI prompt: %w", err)
	}
	return string(bytes.TrimSpace(ssh.MarshalAuthorizedKey(signer.PublicKey()))), nil
}

func publicKeyFromIdentityMaterial(content []byte) (string, error) {
	if key, _, _, _, err := ssh.ParseAuthorizedKey(bytes.TrimSpace(content)); err == nil {
		return string(bytes.TrimSpace(ssh.MarshalAuthorizedKey(key))), nil
	}
	return publicKeyFromUnencryptedPrivateKey(string(content))
}

func normalizeAuthorizedKeyLine(value string) string {
	key, _, _, _, err := ssh.ParseAuthorizedKey([]byte(strings.TrimSpace(value)))
	if err != nil {
		return ""
	}
	return string(bytes.TrimSpace(ssh.MarshalAuthorizedKey(key)))
}

func profileMatchesLocalProtectedKey(profile sshconfig.Profile, localProtectedPublicKeys map[string]struct{}) (bool, string) {
	if len(localProtectedPublicKeys) == 0 {
		return false, ""
	}
	for _, identityFile := range profile.IdentityFiles {
		resolved, err := resolveSSHConfigIdentityFilePath(identityFile)
		if err != nil {
			continue
		}
		if publicKey, err := publicKeyFromIdentityFileOrSidecar(resolved); err == nil {
			if _, ok := localProtectedPublicKeys[normalizeAuthorizedKeyLine(publicKey)]; ok {
				return true, fmt.Sprintf("Runtime authentication uses the local Windows protected key / TPM / OpenSSH-agent identity matching IdentityFile %s. The private key material stays on this Windows desktop-server host.", identityFile)
			}
		}
	}
	if strings.TrimSpace(profile.IdentityAgent) != "" && len(profile.IdentityFiles) == 0 {
		return true, "Runtime authentication uses the local Windows protected key / TPM / OpenSSH-agent identity exposed through IdentityAgent. ShellOrchestra accepts this only because the provider is available for unattended backend reconnects."
	}
	return false, ""
}

func publicKeyFromIdentityFileOrSidecar(resolved string) (string, error) {
	content, err := os.ReadFile(resolved)
	if err != nil {
		return "", err
	}
	if publicKey, err := publicKeyFromIdentityMaterial(content); err == nil {
		return publicKey, nil
	}
	publicContent, err := os.ReadFile(resolved + ".pub")
	if err != nil {
		return "", err
	}
	return publicKeyFromIdentityMaterial(publicContent)
}

func uniqueImportedServerLabel(baseLabel string, username string, usedLabels map[string]struct{}) string {
	base := strings.TrimSpace(baseLabel)
	if base == "" {
		return ""
	}
	if _, exists := usedLabels[normalizeServerLabelKey(base)]; !exists {
		return base
	}
	userScoped := fmt.Sprintf("%s@%s", firstNonEmptyString(strings.TrimSpace(username), "user"), base)
	if _, exists := usedLabels[normalizeServerLabelKey(userScoped)]; !exists {
		return userScoped
	}
	for index := 2; index < 10000; index++ {
		candidate := fmt.Sprintf("%s %d", userScoped, index)
		if _, exists := usedLabels[normalizeServerLabelKey(candidate)]; !exists {
			return candidate
		}
	}
	return fmt.Sprintf("%s %d", userScoped, time.Now().UTC().Unix())
}

func uniqueImportedKeyLabel(profileName string, fileName string, usedLabels map[string]struct{}) string {
	base := strings.TrimSpace(profileName)
	if base == "" {
		base = "SSH config"
	}
	if fileName != "" {
		base = fmt.Sprintf("%s %s", base, fileName)
	}
	base = strings.TrimSpace(base + " key")
	if _, exists := usedLabels[normalizeServerLabelKey(base)]; !exists {
		return base
	}
	for index := 2; index < 10000; index++ {
		candidate := fmt.Sprintf("%s %d", base, index)
		if _, exists := usedLabels[normalizeServerLabelKey(candidate)]; !exists {
			return candidate
		}
	}
	return fmt.Sprintf("%s %d", base, time.Now().UTC().Unix())
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func importedServerInput(profile sshconfig.Profile, publicKey string, label string, authMethod domain.ServerAuthMethod, sshKeyID string, extraNotes []string) domain.ServerInput {
	notes := []string{
		"Imported from SSH config.",
		"ShellOrchestra SSH CA public key for TrustedUserCAKeys:",
		publicKey,
	}
	if authMethod == domain.ServerAuthCustomKey {
		notes = append(notes, "Runtime authentication uses the imported key vault entry selected for this profile.")
	} else if authMethod == domain.ServerAuthLocalProtectedKey {
		notes = append(notes, "Runtime authentication uses a local Windows protected key / TPM / OpenSSH-agent identity that stays on this Windows desktop-server host.")
	} else {
		notes = append(notes, "Runtime authentication uses short-lived ShellOrchestra SSH certificates, not IdentityFile entries from SSH config.")
	}
	if profile.UsedDefaultUser {
		notes = append(notes, "User was not set in SSH config; the import form default username was applied.")
	}
	if len(profile.IdentityFiles) > 0 {
		if authMethod == domain.ServerAuthCustomKey || authMethod == domain.ServerAuthLocalProtectedKey {
			notes = append(notes, "Original IdentityFile entries: "+strings.Join(profile.IdentityFiles, ", "))
		} else {
			notes = append(notes, "Ignored IdentityFile entries: "+strings.Join(profile.IdentityFiles, ", "))
		}
	}
	if profile.IdentityAgent != "" {
		notes = append(notes, "Original IdentityAgent: "+profile.IdentityAgent)
	}
	if len(extraNotes) > 0 {
		notes = append(notes, extraNotes...)
	}
	if profile.ProxyJump != "" {
		notes = append(notes, "Original ProxyJump was not imported into runtime routing yet: "+profile.ProxyJump)
	}
	if profile.ProxyCommand != "" {
		notes = append(notes, "Original ProxyCommand was not imported into runtime routing yet: "+profile.ProxyCommand)
	}
	return domain.ServerInput{
		Name:       label,
		Host:       profile.Host,
		Port:       profile.Port,
		Username:   profile.Username,
		AuthMethod: authMethod,
		SSHKeyID:   sshKeyID,
		ShellHint:  "auto",
		OSHint:     "",
		DistroHint: "",
		HostKey:    "",
		Tags:       []string{"ssh-config-import"},
		Notes:      strings.Join(notes, "\n"),
	}
}

func (a *App) statuses(w http.ResponseWriter, r *http.Request) {
	statuses, err := a.deps.Store.ListStatuses(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"statuses": statuses})
}

func (a *App) backendTools(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	writeJSON(w, http.StatusOK, servertools.NewTelemetryClient(a.deps.Config).Status(r.Context()))
}

func (a *App) backendToolsRestart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	client := servertools.NewTelemetryClient(a.deps.Config)
	status := client.Status(r.Context())
	if !status.Enabled {
		writeError(w, http.StatusConflict, "Backend service telemetry is disabled by the server configuration.")
		return
	}
	if !status.RestartAllowed {
		writeError(w, http.StatusConflict, "Backend restart requires a separate supervisor service and is disabled for this deployment.")
		return
	}
	writeJSON(w, http.StatusAccepted, status)
	go func() {
		time.Sleep(750 * time.Millisecond)
		if err := client.RestartConfiguredServices(context.Background()); err != nil {
			log.Printf("backend service restart failed: %v", err)
		}
	}()
}

func (a *App) scriptCatalog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	if !a.requireDebugEndpointAccess(w, r, "Debug script catalog") {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"commands":       a.deps.Scripts.List(true),
		"system_scripts": systemScriptSources(a.deps.Config.Scripts.Root),
	})
}

func systemScriptSources(scriptsRoot string) []map[string]any {
	systemRoot := scripts.SystemScriptsRoot(scriptsRoot)
	entries, listError := scripts.ReadSystemScriptEntries(scriptsRoot)
	if listError != "" && len(entries) == 0 {
		return []map[string]any{{
			"name":         "system-scripts",
			"file":         systemRoot,
			"shell":        "unknown",
			"source_error": listError,
		}}
	}
	items := make([]map[string]any, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		path := filepath.Join(systemRoot, name)
		item := map[string]any{
			"name":  strings.TrimSuffix(strings.TrimSuffix(name, ".ps1"), ".sh"),
			"file":  filepath.ToSlash(filepath.Join("system-scripts", name)),
			"shell": systemScriptShell(name),
		}
		source, sourceError := scripts.ReadSourcePreview(path)
		if sourceError != "" {
			item["source_error"] = sourceError
		}
		if source != "" {
			item["source"] = source
		}
		items = append(items, item)
	}
	if listError != "" {
		items = append(items, map[string]any{
			"name":         "system-scripts",
			"file":         systemRoot,
			"shell":        "unknown",
			"source_error": listError,
		})
	}
	return items
}

func systemScriptShell(name string) string {
	switch {
	case strings.HasSuffix(name, ".ps1"):
		return "powershell"
	case strings.HasSuffix(name, ".sh"):
		return "posix"
	default:
		return "unknown"
	}
}

func (a *App) scriptRunStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	runID, rest := splitIDPath(strings.TrimPrefix(r.URL.Path, "/api/script-runs/"))
	if runID == "" || rest != "" {
		writeError(w, http.StatusNotFound, "Script run was not found.")
		return
	}
	run, err := a.deps.Store.GetScriptRun(r.Context(), runID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, run)
}

func (a *App) scriptRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !a.requireDebugEndpointAccess(w, r, "Debug script execution") {
		return
	}
	commandName := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/scripts/"), "/run")
	commandName = strings.Trim(commandName, "/")
	var body struct {
		ServerID string         `json:"server_id"`
		Args     map[string]any `json:"args"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	server, err := a.deps.Store.GetServer(r.Context(), body.ServerID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	selected, err := a.deps.Scripts.Select(commandName, targetFactsForHTTPServer(server))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	run := domain.ScriptRun{ServerID: server.ID, Command: commandName, Variant: selected.Variant.ID, State: domain.ScriptRunRunning}
	run, err = a.deps.Store.CreateScriptRun(r.Context(), run)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	go a.executeScript(run, selected)
	writeJSON(w, http.StatusAccepted, run)
}

func (a *App) executeScript(run domain.ScriptRun, selected scripts.SelectedScript) {
	a.executeScriptWithArgs(run, selected, nil)
}

func (a *App) executeScriptWithArgs(run domain.ScriptRun, selected scripts.SelectedScript, args map[string]string) {
	if a.deps.Worker != nil {
		ctx, cancel := context.WithTimeout(context.Background(), selected.Timeout+10*time.Second)
		defer cancel()
		if err := a.deps.Worker.RunScript(ctx, run, selected, args); err != nil {
			finished := time.Now().UTC()
			saveErr := a.deps.Store.UpdateScriptRunResult(context.Background(), domain.ScriptRun{ID: run.ID, ServerID: run.ServerID, Command: run.Command, Variant: run.Variant, State: domain.ScriptRunFailed, Error: err.Error(), CreatedAt: run.CreatedAt, FinishedAt: &finished})
			if saveErr != nil {
				log.Printf("failed to save worker dispatch error: %v", saveErr)
			}
		}
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), selected.Timeout)
	defer cancel()
	execution, buildErr := scripts.RemoteExecutionForVariantWithArgs(selected, args)
	var result map[string]any
	var err error
	if buildErr != nil {
		err = buildErr
	} else if execution.StdinEnabled {
		result, err = a.deps.Runtime.RunJSONWithInputLimited(ctx, run.ServerID, execution.Command, strings.NewReader(execution.Stdin), runtimeOutputLimitsForHTTP(selected.Command.EffectiveOutputLimits()))
	} else {
		result, err = a.deps.Runtime.RunJSONLimited(ctx, run.ServerID, execution.Command, runtimeOutputLimitsForHTTP(selected.Command.EffectiveOutputLimits()))
	}
	finished := time.Now().UTC()
	state := domain.ScriptRunSucceeded
	errText := ""
	if err != nil {
		state = domain.ScriptRunFailed
		errText = err.Error()
	}
	saveErr := a.deps.Store.UpdateScriptRunResult(context.Background(), domain.ScriptRun{ID: run.ID, ServerID: run.ServerID, Command: run.Command, Variant: run.Variant, State: state, Result: result, Error: errText, CreatedAt: run.CreatedAt, FinishedAt: &finished})
	if saveErr != nil {
		log.Printf("failed to save script result: %v", saveErr)
	}
	if state == domain.ScriptRunSucceeded {
		if appName := scripts.InstalledAppNameFromResult(result); appName != "" {
			if err := a.deps.Store.MarkServerDetectedApp(context.Background(), run.ServerID, appName, true); err != nil {
				log.Printf("failed to mark installed desktop app %q for server %s: %v", appName, run.ServerID, err)
			}
		}
	}
}

func (a *App) connectAllServers(ctx context.Context) {
	if a.deps.Worker != nil {
		if err := a.deps.Worker.ConnectAll(ctx); err != nil {
			log.Printf("worker connect all failed: %v", err)
		}
		return
	}
	servers, err := a.deps.Store.ListServers(ctx)
	if err != nil {
		log.Printf("connect all failed: %v", err)
		return
	}
	byID := make(map[string]domain.Server, len(servers))
	for _, server := range servers {
		byID[server.ID] = server
	}
	connected := map[string]bool{}
	for _, server := range servers {
		a.connectServerWithDependencies(ctx, server, byID, connected, map[string]bool{})
	}
}

func (a *App) connectServerWithDependencies(ctx context.Context, server domain.Server, byID map[string]domain.Server, connected map[string]bool, visiting map[string]bool) domain.ServerStatus {
	if connected[server.ID] {
		return domain.ServerStatus{ServerID: server.ID, State: domain.StatusConnected, UpdatedAt: time.Now().UTC()}
	}
	if visiting[server.ID] {
		status := domain.ServerStatus{ServerID: server.ID, State: domain.StatusFailed, Telemetry: map[string]any{}, LastError: "Chained connection contains a cycle.", UpdatedAt: time.Now().UTC()}
		_ = a.deps.Store.UpsertStatus(ctx, status)
		return status
	}
	visiting[server.ID] = true
	if server.ConnectionMode == domain.ServerConnectionChained {
		jump, ok := byID[server.JumpServerID]
		if !ok {
			status := domain.ServerStatus{ServerID: server.ID, State: domain.StatusFailed, Telemetry: map[string]any{}, LastError: "Jump server was not found.", UpdatedAt: time.Now().UTC()}
			_ = a.deps.Store.UpsertStatus(ctx, status)
			delete(visiting, server.ID)
			return status
		}
		jumpStatus := a.connectServerWithDependencies(ctx, jump, byID, connected, visiting)
		if jumpStatus.State != domain.StatusConnected {
			status := domain.ServerStatus{ServerID: server.ID, State: domain.StatusFailed, Telemetry: map[string]any{}, LastError: "Jump server is not connected: " + jumpStatus.LastError, UpdatedAt: time.Now().UTC()}
			_ = a.deps.Store.UpsertStatus(ctx, status)
			delete(visiting, server.ID)
			return status
		}
	}
	status, _ := a.deps.Runtime.Connect(ctx, server)
	if status.State == domain.StatusConnected {
		connected[server.ID] = true
		if facts, err := a.detectServerFacts(ctx, server); err != nil {
			status.Telemetry["detection_error"] = err.Error()
		} else {
			if status.Telemetry == nil {
				status.Telemetry = map[string]any{}
			}
			if err := a.deps.Store.UpdateServerDetectedFacts(ctx, server.ID, domainFactsFromTargetFacts(facts)); err != nil {
				log.Printf("failed to save detected facts for %s: %v", server.Name, err)
			}
			addFactTelemetry(status.Telemetry, "detected", facts)
		}
	}
	if err := a.deps.Store.UpsertStatus(ctx, status); err != nil {
		log.Printf("failed to save status for %s: %v", server.Name, err)
	}
	delete(visiting, server.ID)
	return status
}

func (a *App) detectServerFacts(ctx context.Context, server domain.Server) (scripts.TargetFacts, error) {
	facts, err := a.detectServerFactsWithTimeout(ctx, server)
	if err != nil || !facts.WingetNeedsInitialization {
		return facts, err
	}
	if err := a.initializeWingetForCurrentAccount(ctx, server, facts); err != nil {
		return facts, err
	}
	refreshedFacts, refreshErr := a.detectServerFactsWithTimeout(ctx, server)
	if refreshErr != nil {
		return facts, fmt.Errorf("Windows winget initialization completed, but detection after initialization failed: %w", refreshErr)
	}
	if refreshedFacts.WingetNeedsInitialization || strings.ToLower(strings.TrimSpace(refreshedFacts.PackageManager)) != "winget" {
		return refreshedFacts, fmt.Errorf("Windows winget initialization completed, but winget is still not available to this SSH account")
	}
	return refreshedFacts, nil
}

func (a *App) detectServerFactsWithTimeout(ctx context.Context, server domain.Server) (scripts.TargetFacts, error) {
	detectCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	return a.detectServerFactsOnce(detectCtx, server)
}

func (a *App) detectServerFactsOnce(ctx context.Context, server domain.Server) (scripts.TargetFacts, error) {
	powershellCommand, err := powershellFactProbeCommand(a.deps.Config.Scripts.Root)
	if err != nil {
		return scripts.TargetFacts{}, err
	}
	if prefersPowerShellDetection(server) {
		return a.runFactProbe(ctx, server.ID, powershellCommand)
	}
	posixCommand, err := posixFactProbeCommand(a.deps.Config.Scripts.Root)
	if err != nil {
		return scripts.TargetFacts{}, err
	}
	if facts, err := a.runFactProbe(ctx, server.ID, posixCommand); err == nil {
		if !posixFactsLookLikeWindows(facts) {
			return facts, nil
		}
		if powershellFacts, powershellErr := a.runFactProbe(ctx, server.ID, powershellCommand); powershellErr == nil {
			return powershellFacts, nil
		}
		return scripts.TargetFacts{}, fmt.Errorf("POSIX probe reported a Windows compatibility layer (%s), but PowerShell detection failed", facts.OS)
	} else {
		return a.runFactProbe(ctx, server.ID, powershellCommand)
	}
}

func (a *App) initializeWingetForCurrentAccount(ctx context.Context, server domain.Server, facts scripts.TargetFacts) error {
	selected, err := a.deps.Scripts.Select("winget_init", facts)
	if err != nil {
		return fmt.Errorf("Windows winget initialization is required, but no init script is available: %w", err)
	}
	timeout := selected.Timeout + 10*time.Second
	if timeout < 30*time.Second {
		timeout = 30 * time.Second
	}
	initCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	payload, err := a.deps.Runtime.RunJSONLimited(initCtx, server.ID, scripts.RemoteCommandForVariant(selected), runtimeOutputLimitsForHTTP(selected.Command.EffectiveOutputLimits()))
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

func (a *App) runFactProbe(ctx context.Context, serverID string, command string) (scripts.TargetFacts, error) {
	payload, err := a.deps.Runtime.RunJSONLimited(ctx, serverID, command, systemScriptOutputLimitsForHTTP())
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
		WingetNeedsInitialization: boolValue(payload["winget_needs_initialization"]),
		IsPVEHost:                 boolValue(payload["is_pve_host"]),
		IsDockerHost:              boolValue(payload["is_docker_host"]),
		Apps:                      boolMapValue(payload["apps"]),
	}, nil
}

func targetFactsForHTTPServer(server domain.Server) scripts.TargetFacts {
	return scripts.TargetFacts{
		Hostname: firstNonEmpty(server.DetectedHostname, server.Name),
		Shell: firstNonEmpty(
			server.OverrideShell,
			server.DetectedShell,
			server.ShellHint,
		),
		OS: firstNonEmpty(
			server.OverrideOS,
			server.DetectedOS,
			server.OSHint,
		),
		Platform:     server.DetectedPlatform,
		PlatformOS:   server.DetectedPlatformOS,
		PlatformArch: server.DetectedPlatformArch,
		Distro: firstNonEmpty(
			server.OverrideDistro,
			server.DetectedDistro,
			server.DistroHint,
		),
		AdminRights: firstNonEmpty(
			server.OverrideAdminRights,
			server.DetectedAdminRights,
		),
		KernelVersion:  server.DetectedKernelVersion,
		PackageManager: server.DetectedPackageManager,
		IsPVEHost:      server.DetectedPVEHost,
		IsDockerHost:   server.DetectedDockerHost,
		Apps:           server.DetectedApps,
	}
}

func runtimeOutputLimitsForHTTP(limits scripts.OutputLimits) runtime.OutputLimits {
	return runtime.OutputLimits{
		MaxStdoutBytes:  limits.MaxStdoutBytes,
		MaxStderrBytes:  limits.MaxStderrBytes,
		MaxDecodedBytes: limits.MaxDecodedBytes,
	}
}

func systemScriptOutputLimitsForHTTP() runtime.OutputLimits {
	return runtime.OutputLimits{
		MaxStdoutBytes:  2 << 20,
		MaxStderrBytes:  128 << 10,
		MaxDecodedBytes: 4 << 20,
	}
}

func domainFactsFromTargetFacts(facts scripts.TargetFacts) domain.ServerFacts {
	return domain.ServerFacts{
		Hostname:       facts.Hostname,
		Shell:          facts.Shell,
		OS:             facts.OS,
		Platform:       facts.Platform,
		PlatformOS:     facts.PlatformOS,
		PlatformArch:   facts.PlatformArch,
		Distro:         facts.Distro,
		AdminRights:    facts.AdminRights,
		KernelVersion:  facts.KernelVersion,
		PackageManager: facts.PackageManager,
		IsPVEHost:      facts.IsPVEHost,
		IsDockerHost:   facts.IsDockerHost,
		Apps:           facts.Apps,
	}
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
	telemetry[prefix+"_winget_needs_initialization"] = facts.WingetNeedsInitialization
	telemetry[prefix+"_is_pve_host"] = facts.IsPVEHost
	telemetry[prefix+"_is_docker_host"] = facts.IsDockerHost
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

func stringValue(value any) string {
	if raw, ok := value.(string); ok {
		return raw
	}
	return ""
}

func int64FromResult(result any, key string) int64 {
	values, ok := result.(map[string]any)
	if !ok {
		return 0
	}
	value, ok := values[key]
	if !ok {
		return 0
	}
	switch typed := value.(type) {
	case float64:
		if typed < 0 {
			return 0
		}
		return int64(typed)
	case int64:
		if typed < 0 {
			return 0
		}
		return typed
	case int:
		if typed < 0 {
			return 0
		}
		return int64(typed)
	case string:
		var parsed int64
		if _, err := fmt.Sscan(strings.TrimSpace(typed), &parsed); err == nil && parsed > 0 {
			return parsed
		}
	}
	return 0
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

func posixFactProbeCommand(scriptsRoot string) (string, error) {
	body, err := readSystemScript(scriptsRoot, "detect-posix.sh")
	if err != nil {
		return "", err
	}
	encoded := base64.StdEncoding.EncodeToString(body)
	return "printf '%s' '" + encoded + "' | base64 -d | sh", nil
}

func powershellFactProbeCommand(scriptsRoot string) (string, error) {
	body, err := readSystemScript(scriptsRoot, "detect-powershell.ps1")
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

func runtimeLockState(locked bool) map[string]any {
	if locked {
		return map[string]any{"locked": true, "initialized": true, "message": "SERVER ACCESS IS LOCKED. Sign in with the configured security method to unlock server connections."}
	}
	return map[string]any{"locked": false, "initialized": true, "message": "SERVER ACCESS IS UNLOCKED. ShellOrchestra can connect to servers from this running backend."}
}

func runtimeKeysNotInitializedState() map[string]any {
	return map[string]any{"locked": true, "initialized": false, "message": "SERVER ACCESS KEYS ARE NOT INITIALIZED. Open Keys from a desktop browser to set up server access."}
}

func deviceRequestResponse(request store.PendingDeviceRequest) map[string]any {
	return map[string]any{
		"id":                           request.ID,
		"label":                        request.Label,
		"kind":                         request.Kind,
		"verification_code":            request.VerificationCode,
		"envelope_public_key_spki_b64": request.EnvelopePublicKeySPKIB64,
		"state":                        request.State,
		"created_at":                   request.CreatedAt,
		"expires_at":                   request.ExpiresAt,
	}
}

func keyChangeApprovalResponse(approval store.KeyChangeApproval) map[string]any {
	return map[string]any{
		"request_id":            approval.ID,
		"verification_code":     approval.VerificationCode,
		"state":                 approval.State,
		"approved_by_device_id": nullableString(approval.ApprovedByDeviceID),
		"expires_at":            approval.ExpiresAt,
	}
}

func (a *App) requireDebugEndpointAccess(w http.ResponseWriter, r *http.Request, feature string) bool {
	if !a.debugModeEnabled() {
		http.NotFound(w, r)
		return false
	}
	if authenticatedDebugTelemetryPath(r.URL.Path) {
		if _, ok := r.Context().Value(principalKey{}).(*domain.Principal); ok {
			return true
		}
	}
	clientIP, allowed := a.allowedDebugClientIP(r)
	if !allowed {
		writeError(w, http.StatusForbidden, fmt.Sprintf("%s is not allowed from this address (%s).", feature, clientIP))
		return false
	}
	return true
}

func authenticatedDebugTelemetryPath(path string) bool {
	return path == "/api/debug/client-events" || path == "/api/debug/feedback" || strings.HasPrefix(path, "/api/debug/feedback/")
}

func (a *App) validDebugToken(provided string) bool {
	expected := a.debugTokenValue()
	provided = strings.TrimSpace(provided)
	if expected == "" || provided == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

func (a *App) debugTokenValue() string {
	token, err := readDebugTokenFile(a.deps.Config.DebugAuth.TokenFile)
	if err != nil {
		return ""
	}
	return token
}

func readDebugTokenFile(path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", fmt.Errorf("debug token file is not configured")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxDebugTokenFileBytes+1))
	if err != nil {
		return "", err
	}
	if len(data) > maxDebugTokenFileBytes {
		return "", fmt.Errorf("debug token file exceeds %d bytes", maxDebugTokenFileBytes)
	}
	return strings.TrimSpace(string(data)), nil
}

func (a *App) persistDebugDeviceShareIfEnabled(ctx context.Context, epoch int, deviceShareB64 string) {
	if !a.debugModeEnabled() || epoch <= 0 || strings.TrimSpace(deviceShareB64) == "" {
		return
	}
	token := a.debugTokenValue()
	if token == "" {
		return
	}
	encrypted, err := encryptDebugDeviceShare(token, deviceShareB64)
	if err != nil {
		if a.debugModeEnabled() {
			log.Printf("ShellOrchestra key-share-debug action=%q epoch=%d message=%q", "debug-share-encrypt-failed", epoch, err.Error())
		}
		return
	}
	if err := a.deps.Store.UpsertDebugDeviceKeyShare(ctx, store.DebugDeviceKeyShare{Epoch: epoch, EncryptedDeviceShareB64: encrypted}); err != nil {
		if a.debugModeEnabled() {
			log.Printf("ShellOrchestra key-share-debug action=%q epoch=%d message=%q", "debug-share-store-failed", epoch, err.Error())
		}
		return
	}
	if a.debugModeEnabled() {
		log.Printf("ShellOrchestra key-share-debug action=%q device_id=%q epoch=%d message=%q", "debug-share-stored", debugDeviceID, epoch, "debug mode stored a protected server-access share for test unlocks")
	}
}

func encryptDebugDeviceShare(token string, deviceShareB64 string) (string, error) {
	block, err := aes.NewCipher(debugShareEncryptionKey(token))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	ciphertext := gcm.Seal(nil, nonce, []byte(strings.TrimSpace(deviceShareB64)), nil)
	payload := append(nonce, ciphertext...)
	return base64.StdEncoding.EncodeToString(payload), nil
}

func decryptDebugDeviceShare(token string, encryptedDeviceShareB64 string) (string, error) {
	payload, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encryptedDeviceShareB64))
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(debugShareEncryptionKey(token))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(payload) <= gcm.NonceSize() {
		return "", fmt.Errorf("debug device share ciphertext is too short")
	}
	nonce := payload[:gcm.NonceSize()]
	ciphertext := payload[gcm.NonceSize():]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(plaintext)), nil
}

func debugShareEncryptionKey(token string) []byte {
	sum := sha256.Sum256([]byte("shellorchestra debug device share v1\x00" + strings.TrimSpace(token)))
	return sum[:]
}

func (a *App) allowedDebugClientIP(r *http.Request) (string, bool) {
	for _, ip := range debugClientIPCandidates(r) {
		if debugIPAllowed(ip, a.deps.Config.DebugAuth.AllowedClientIPs) {
			return ip.String(), true
		}
	}
	if ip := directRemoteIP(r); ip != nil {
		return ip.String(), false
	}
	return "unknown", false
}

func debugClientIPCandidates(r *http.Request) []net.IP {
	var out []net.IP
	direct := directRemoteIP(r)
	if direct != nil && canTrustForwardedClientIP(direct) {
		out = append(out, forwardedClientIPs(r)...)
	}
	if direct != nil {
		out = append(out, direct)
	}
	return out
}

func sessionClientIP(r *http.Request) string {
	for _, ip := range debugClientIPCandidates(r) {
		if ip != nil {
			return ip.String()
		}
	}
	return ""
}

func directRemoteIP(r *http.Request) net.IP {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	return net.ParseIP(strings.TrimSpace(host))
}

func canTrustForwardedClientIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate()
}

func forwardedClientIPs(r *http.Request) []net.IP {
	var out []net.IP
	for _, value := range r.Header.Values("X-Forwarded-For") {
		for _, part := range strings.Split(value, ",") {
			if ip := net.ParseIP(strings.TrimSpace(part)); ip != nil {
				out = append(out, ip)
			}
		}
	}
	if ip := net.ParseIP(strings.TrimSpace(r.Header.Get("X-Real-IP"))); ip != nil {
		out = append(out, ip)
	}
	return out
}

func debugIPAllowed(ip net.IP, allowlist []string) bool {
	if ip == nil {
		return false
	}
	for _, raw := range allowlist {
		entry := strings.TrimSpace(raw)
		if entry == "" {
			continue
		}
		if strings.Contains(entry, "/") {
			_, network, err := net.ParseCIDR(entry)
			if err == nil && network.Contains(ip) {
				return true
			}
			continue
		}
		allowed := net.ParseIP(entry)
		if allowed != nil && allowed.Equal(ip) {
			return true
		}
	}
	return false
}

const debugDeviceID = "debug-controller"

func (a *App) ensureDebugTrustedDevice(ctx context.Context) (store.TrustedDevice, error) {
	device, err := a.deps.Store.GetTrustedDeviceByID(ctx, debugDeviceID)
	if err == nil {
		return device, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return store.TrustedDevice{}, err
	}
	now := time.Now().UTC()
	device = store.TrustedDevice{
		ID:             debugDeviceID,
		Label:          "Debug access",
		Kind:           domain.DeviceKindBrowser,
		ApprovedAt:     &now,
		CredentialID:   debugDeviceID,
		PublicKeyB64:   "debug-token",
		EnvelopeKeyB64: "",
		UserHandleB64:  "",
		CredentialJSON: "",
		SignerEpoch:    0,
	}
	if err := a.deps.Store.SaveTrustedDevice(ctx, device); err != nil {
		return store.TrustedDevice{}, err
	}
	return device, nil
}

func (a *App) validateFirstSetupToken(w http.ResponseWriter, r *http.Request, token string) bool {
	count, err := a.deps.Store.CountApprovedDevices(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return false
	}
	if count > 0 {
		writeError(w, http.StatusConflict, "Initial setup is already complete.")
		return false
	}
	window, ok, err := a.deps.Store.ValidateBootstrapToken(r.Context(), token, time.Duration(a.deps.Config.Security.BootstrapTimeoutMinutes)*time.Minute)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return false
	}
	if window.State != "open" {
		writeError(w, http.StatusForbidden, "INITIAL SETUP IS CLOSED. Restart the ShellOrchestra container to open a new setup window, then reload this page.")
		return false
	}
	if !ok {
		writeError(w, http.StatusForbidden, "THIS SETUP LINK IS OLD OR INVALID. Reload the computer page showing ShellOrchestra and use the current setup options.")
		return false
	}
	return true
}

func (a *App) issueSession(w http.ResponseWriter, r *http.Request, deviceID string) error {
	accessToken, err := randomToken()
	if err != nil {
		return err
	}
	csrfToken, err := randomToken()
	if err != nil {
		return err
	}
	ttl := a.sessionIdleTTL(r.Context())
	if err := a.deps.Store.CreateSession(r.Context(), deviceID, accessToken, csrfToken, ttl, sessionClientIP(r)); err != nil {
		return err
	}
	maxAge := int(ttl.Seconds())
	http.SetCookie(w, &http.Cookie{
		Name:     a.deps.Config.Security.AccessCookie,
		Value:    accessToken,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   a.deps.Config.Security.SecureCookies,
		SameSite: http.SameSiteLaxMode,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     a.deps.Config.Security.CSRFCookie,
		Value:    csrfToken,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: false,
		Secure:   a.deps.Config.Security.SecureCookies,
		SameSite: http.SameSiteLaxMode,
	})
	return nil
}

func (a *App) sessionIdleTTL(ctx context.Context) time.Duration {
	ttlMinutes := a.deps.Config.Security.AccessTokenTTLMinutes
	if settings, err := a.deps.Store.GetSSHSecuritySettings(ctx); err == nil && settings.AccessTokenTTLMinutes > 0 {
		ttlMinutes = settings.AccessTokenTTLMinutes
	}
	if ttlMinutes <= 0 {
		ttlMinutes = 60
	}
	return time.Duration(ttlMinutes) * time.Minute
}

func (a *App) refreshAuthenticatedSessionIfUserActive(w http.ResponseWriter, r *http.Request, accessToken string, csrfToken string) {
	if !requestCarriesUserActivity(r) {
		return
	}
	ttl := a.sessionIdleTTL(r.Context())
	if err := a.deps.Store.RefreshSession(r.Context(), accessToken, ttl); err != nil {
		return
	}
	maxAge := int(ttl.Seconds())
	http.SetCookie(w, &http.Cookie{
		Name:     a.deps.Config.Security.AccessCookie,
		Value:    accessToken,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   a.deps.Config.Security.SecureCookies,
		SameSite: http.SameSiteLaxMode,
	})
	if strings.TrimSpace(csrfToken) != "" {
		http.SetCookie(w, &http.Cookie{
			Name:     a.deps.Config.Security.CSRFCookie,
			Value:    csrfToken,
			Path:     "/",
			MaxAge:   maxAge,
			HttpOnly: false,
			Secure:   a.deps.Config.Security.SecureCookies,
			SameSite: http.SameSiteLaxMode,
		})
	}
}

func (a *App) refreshAuthenticatedSessionTTL(ctx context.Context, accessToken string) int {
	ttl := a.sessionIdleTTL(ctx)
	if err := a.deps.Store.RefreshSession(ctx, accessToken, ttl); err != nil {
		return 0
	}
	return int(ttl.Seconds())
}

func requestCarriesUserActivity(r *http.Request) bool {
	value := strings.TrimSpace(strings.ToLower(r.Header.Get(userActivityHeader)))
	return value == "1" || value == "true"
}

func (a *App) authenticateOptional(r *http.Request) (*domain.Principal, string, bool) {
	accessCookie, err := r.Cookie(a.deps.Config.Security.AccessCookie)
	if err != nil || strings.TrimSpace(accessCookie.Value) == "" {
		return nil, "", false
	}
	principal, csrfHash, err := a.deps.Store.Authenticate(r.Context(), accessCookie.Value)
	if err != nil {
		return nil, "", false
	}
	return principal, csrfHash, true
}

func (a *App) passkeyCredentialIDsForLoginHint(ctx context.Context, deviceIDHint string, credentialIDHint string) ([][]byte, error) {
	credentialIDHint = strings.TrimSpace(credentialIDHint)
	deviceIDHint = strings.TrimSpace(deviceIDHint)
	if credentialIDHint == "" && deviceIDHint == "" {
		return nil, nil
	}
	var device store.TrustedDevice
	var err error
	if credentialIDHint != "" {
		device, err = a.deps.Store.GetTrustedDeviceByCredentialID(ctx, credentialIDHint)
	} else {
		device, err = a.deps.Store.GetTrustedDeviceByID(ctx, deviceIDHint)
	}
	if err != nil {
		return nil, err
	}
	credentialIDs := trustedDeviceCredentialIDBytes(device)
	if len(credentialIDs) == 0 {
		return nil, fmt.Errorf("trusted device %s has no stored passkey credential", device.ID)
	}
	return uniqueCredentialIDs(credentialIDs), nil
}

func uniqueCredentialIDs(credentialIDs [][]byte) [][]byte {
	out := make([][]byte, 0, len(credentialIDs))
	seen := map[string]bool{}
	for _, credentialID := range credentialIDs {
		key := string(credentialID)
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, credentialID)
	}
	return out
}

func trustedDeviceCredentialIDBytes(device store.TrustedDevice) [][]byte {
	var out [][]byte
	if strings.TrimSpace(device.CredentialJSON) != "" {
		credential, err := webauthnsvc.DecodeCredential(device.CredentialJSON)
		if err == nil && len(credential.ID) > 0 {
			out = append(out, credential.ID)
		}
	}
	for _, decoder := range []struct {
		encoding *base64.Encoding
		value    string
	}{
		{base64.StdEncoding, device.CredentialID},
		{base64.RawStdEncoding, device.CredentialID},
		{base64.URLEncoding, device.CredentialID},
		{base64.RawURLEncoding, device.CredentialID},
	} {
		decoded, err := decoder.encoding.DecodeString(decoder.value)
		if err == nil && len(decoded) > 0 {
			out = append(out, decoded)
		}
	}
	return out
}

func (a *App) lookupDiscoverableDevice(ctx context.Context, rawID []byte, userHandle []byte) (store.TrustedDevice, error) {
	tried := map[string]bool{}
	for _, credentialID := range credentialIDCandidates(rawID) {
		if credentialID == "" || tried["credential:"+credentialID] {
			continue
		}
		tried["credential:"+credentialID] = true
		device, err := a.deps.Store.GetTrustedDeviceByCredentialID(ctx, credentialID)
		if err == nil {
			return device, nil
		}
		if !errors.Is(err, store.ErrNotFound) {
			return store.TrustedDevice{}, err
		}
	}
	for _, handle := range userHandleCandidates(userHandle) {
		if handle == "" || tried["handle:"+handle] {
			continue
		}
		tried["handle:"+handle] = true
		device, err := a.deps.Store.GetTrustedDeviceByUserHandleB64(ctx, handle)
		if err == nil {
			return device, nil
		}
		if !errors.Is(err, store.ErrNotFound) {
			return store.TrustedDevice{}, err
		}
	}
	if len(userHandle) > 0 {
		deviceID := string(userHandle)
		if deviceID != "" {
			device, err := a.deps.Store.GetTrustedDeviceByID(ctx, deviceID)
			if err == nil {
				return device, nil
			}
			if !errors.Is(err, store.ErrNotFound) {
				return store.TrustedDevice{}, err
			}
		}
	}
	return store.TrustedDevice{}, store.ErrNotFound
}

func (a *App) webAuthnForPasskeyRequest(r *http.Request, allowInitialize bool) (*webauthnsvc.Service, error) {
	settings, err := a.deps.Store.GetAuthSettings(r.Context())
	currentOrigin := a.requestOrigin(r)
	if err == nil {
		switch settings.Mode {
		case store.AuthModeLANTOTP:
			return nil, fmt.Errorf("This ShellOrchestra instance uses one-time codes and an admin passphrase for LAN-only sign-in. Passkeys are disabled for this setup.")
		case store.AuthModePasskey:
			origin := strings.TrimSpace(settings.PasskeyOrigin)
			if origin == "" {
				origin = strings.TrimSpace(a.deps.Config.App.BaseURL)
			}
			if origin == "" {
				origin = currentOrigin
			}
			normalizedOrigin, _, err := webauthnsvc.OriginAndRPID(origin)
			if err != nil {
				return nil, err
			}
			if !sameOrigin(normalizedOrigin, currentOrigin) {
				return nil, fmt.Errorf("This address cannot use the configured passkeys. Open ShellOrchestra at %s, or reset setup and choose LAN-only one-time-code sign-in for local HTTP/private-IP access.", normalizedOrigin)
			}
			return webauthnsvc.NewFromOrigin(a.deps.Config.App.Name, normalizedOrigin)
		default:
			return nil, fmt.Errorf("unsupported authentication mode %q", settings.Mode)
		}
	}
	if !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	count, err := a.deps.Store.CountApprovedDevices(r.Context())
	if err != nil {
		return nil, err
	}
	if count > 0 {
		origin := strings.TrimSpace(a.deps.Config.App.BaseURL)
		if origin == "" {
			return nil, fmt.Errorf("Passkey origin is not recorded for this installation. Open first setup again or configure LAN-only one-time-code sign-in.")
		}
		normalizedOrigin, _, err := webauthnsvc.OriginAndRPID(origin)
		if err != nil {
			return nil, err
		}
		if !sameOrigin(normalizedOrigin, currentOrigin) {
			return nil, fmt.Errorf("This address cannot use the configured passkeys. Open ShellOrchestra at %s.", normalizedOrigin)
		}
		return webauthnsvc.NewFromOrigin(a.deps.Config.App.Name, normalizedOrigin)
	}
	if !allowInitialize {
		return nil, fmt.Errorf("Initial setup is not complete. Use the first-start setup screen first.")
	}
	return webauthnsvc.NewFromOrigin(a.deps.Config.App.Name, currentOrigin)
}

func (a *App) authModeSnapshot(ctx context.Context) (string, string) {
	settings, err := a.deps.Store.GetAuthSettings(ctx)
	if err == nil {
		return string(settings.Mode), settings.PasskeyOrigin
	}
	count, countErr := a.deps.Store.CountApprovedDevices(ctx)
	if countErr == nil && count > 0 {
		return string(store.AuthModePasskey), a.deps.Config.App.BaseURL
	}
	return "unset", ""
}

func (a *App) requestOrigin(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	host := r.Host
	if a.trustForwardedOriginHeaders(r) {
		if forwardedProto := firstHeaderValue(r.Header.Get("X-Forwarded-Proto")); forwardedProto == "http" || forwardedProto == "https" {
			scheme = forwardedProto
		}
		if forwardedHost := firstHeaderValue(r.Header.Get("X-Forwarded-Host")); forwardedHost != "" {
			host = forwardedHost
		}
		if forwarded := r.Header.Get("Forwarded"); forwarded != "" {
			for _, part := range strings.Split(forwarded, ";") {
				key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
				if !ok {
					continue
				}
				value = strings.Trim(value, `"`)
				switch strings.ToLower(key) {
				case "proto":
					if value == "http" || value == "https" {
						scheme = value
					}
				case "host":
					if value != "" {
						host = value
					}
				}
			}
		}
	}
	return scheme + "://" + host
}

func (a *App) trustForwardedOriginHeaders(r *http.Request) bool {
	ip := directRemoteIP(r)
	if ip == nil {
		return false
	}
	if ip.IsLoopback() {
		return true
	}
	return (a.options.TrustGatewayHeaders || a.options.AuthService) && ip.IsPrivate()
}

func firstHeaderValue(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	first, _, _ := strings.Cut(value, ",")
	return strings.ToLower(strings.TrimSpace(first))
}

func sameOrigin(expected string, actual string) bool {
	left, _, leftErr := webauthnsvc.OriginAndRPID(expected)
	right, _, rightErr := webauthnsvc.OriginAndRPID(actual)
	return leftErr == nil && rightErr == nil && left == right
}

func (a *App) validCSRF(r *http.Request, csrfHash string) bool {
	csrfCookie, err := r.Cookie(a.deps.Config.Security.CSRFCookie)
	if err != nil {
		return false
	}
	return store.HashToken(csrfCookie.Value) == csrfHash && r.Header.Get(a.deps.Config.Security.CSRFHeader) == csrfCookie.Value
}

func normalizeDeviceKind(kind domain.DeviceKind) domain.DeviceKind {
	switch kind {
	case domain.DeviceKindPhone, domain.DeviceKindDesktop, domain.DeviceKindBrowser:
		return kind
	default:
		return domain.DeviceKindBrowser
	}
}

func registrationAuthenticatorPolicy(kind domain.DeviceKind) webauthnsvc.RegistrationAuthenticatorPolicy {
	return webauthnsvc.RegistrationAuthenticatorPlatform
}

func b64Raw(data []byte) string {
	return base64.RawURLEncoding.EncodeToString(data)
}

func credentialIDKey(data []byte) string {
	return base64.StdEncoding.EncodeToString(data)
}

func credentialIDCandidates(data []byte) []string {
	if len(data) == 0 {
		return nil
	}
	return []string{
		base64.StdEncoding.EncodeToString(data),
		base64.RawStdEncoding.EncodeToString(data),
		base64.URLEncoding.EncodeToString(data),
		base64.RawURLEncoding.EncodeToString(data),
	}
}

func userHandleCandidates(data []byte) []string {
	if len(data) == 0 {
		return nil
	}
	return []string{
		base64.RawURLEncoding.EncodeToString(data),
		base64.URLEncoding.EncodeToString(data),
		base64.StdEncoding.EncodeToString(data),
		base64.RawStdEncoding.EncodeToString(data),
	}
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxAPIJSONBodyBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
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

func decodeOptionalJSON(w http.ResponseWriter, r *http.Request, target any, limit int64, message string) bool {
	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		if errors.Is(err, io.EOF) {
			return true
		}
		writeError(w, http.StatusBadRequest, message)
		return false
	}
	var trailing struct{}
	if err := decoder.Decode(&trailing); err != io.EOF {
		writeError(w, http.StatusBadRequest, message)
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

func writeStoreError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "Not found.")
		return
	}
	writeError(w, http.StatusBadRequest, err.Error())
}

func methodNotAllowed(w http.ResponseWriter) {
	writeError(w, http.StatusMethodNotAllowed, "Method not allowed.")
}

func splitIDPath(path string) (string, string) {
	parts := strings.SplitN(path, "/", 2)
	if len(parts) == 1 {
		return parts[0], ""
	}
	return parts[0], "/" + parts[1]
}

func nullableString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func trimmedOptionalString(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func clearCookie(w http.ResponseWriter, name string, secure bool) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode})
}

func randomToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func randomVerificationCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(900000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", n.Int64()+100000), nil
}

func (a *App) logDebugKeyShare(action string, principal *domain.Principal, epoch int, message string) {
	if principal == nil {
		return
	}
	a.logDebugKeyShareForDevice(action, principal.DeviceID, epoch, principal.DeviceID)
	if a.debugModeEnabled() && message != "" {
		log.Printf("ShellOrchestra key-share-debug action=%q device_id=%q label=%q kind=%q epoch=%d message=%q", action, principal.DeviceID, principal.Label, principal.Kind, epoch, message)
	}
}

func (a *App) logDebugKeyShareForDevice(action string, targetDeviceID string, epoch int, actorDeviceID string) {
	if !a.debugModeEnabled() {
		return
	}
	log.Printf("ShellOrchestra key-share-debug action=%q target_device_id=%q actor_device_id=%q epoch=%d", action, targetDeviceID, actorDeviceID, epoch)
}

func sanitizeClientDebugDetails(details map[string]any) map[string]any {
	if len(details) == 0 {
		return map[string]any{}
	}
	clean := make(map[string]any, len(details))
	for key, value := range details {
		clean[truncateDebugString(key, 120)] = sanitizeClientDebugValue(key, value, 0)
	}
	return clean
}

func sanitizeClientDebugValue(key string, value any, depth int) any {
	if debugKeyIsSensitive(key) {
		return "[redacted]"
	}
	if depth > 2 {
		return "[max-depth]"
	}
	switch typed := value.(type) {
	case nil:
		return nil
	case string:
		return truncateDebugString(typed, 500)
	case bool:
		return typed
	case float64:
		return typed
	case map[string]any:
		out := make(map[string]any, len(typed))
		for childKey, childValue := range typed {
			out[truncateDebugString(childKey, 120)] = sanitizeClientDebugValue(childKey, childValue, depth+1)
		}
		return out
	case []any:
		limit := len(typed)
		if limit > 10 {
			limit = 10
		}
		out := make([]any, 0, limit)
		for i := 0; i < limit; i++ {
			out = append(out, sanitizeClientDebugValue(key, typed[i], depth+1))
		}
		return out
	default:
		return truncateDebugString(fmt.Sprint(value), 500)
	}
}

func debugKeyIsSensitive(key string) bool {
	normalized := strings.ToLower(key)
	return strings.Contains(normalized, "share") ||
		strings.Contains(normalized, "token") ||
		strings.Contains(normalized, "secret") ||
		strings.Contains(normalized, "key") ||
		strings.Contains(normalized, "credential") ||
		strings.Contains(normalized, "ciphertext") ||
		strings.Contains(normalized, "payload") ||
		strings.Contains(normalized, "passkey")
}

func truncateDebugString(value string, maxLength int) string {
	value = strings.TrimSpace(value)
	if maxLength <= 0 || len(value) <= maxLength {
		return value
	}
	return value[:maxLength] + "…"
}

func staticSPA(publicDir string) http.Handler {
	files := http.FileServer(http.Dir(publicDir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := httpsecurity.ValidateRequestPath(r); err != nil {
			http.Error(w, "Request path is not normalized.", http.StatusBadRequest)
			return
		}
		path := r.URL.Path
		if strings.HasPrefix(path, "/api/") {
			writeError(w, http.StatusNotFound, "API route not found.")
			return
		}
		if strings.HasPrefix(path, "/assets/") {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Cross-Origin-Resource-Policy", "cross-origin")
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		full := filepath.Join(publicDir, path)
		if info, err := os.Stat(full); err == nil && !info.IsDir() {
			files.ServeHTTP(w, r)
			return
		}
		serveStaticIndexHTML(w, r, filepath.Join(publicDir, "index.html"))
	})
}

func serveStaticIndexHTML(w http.ResponseWriter, r *http.Request, path string) {
	content, err := readStaticIndexHTML(path)
	if err != nil {
		http.Error(w, "Application shell is not available.", http.StatusInternalServerError)
		return
	}
	nonce, err := httpsecurity.NewCSPNonce()
	if err != nil {
		http.Error(w, "Application shell security nonce could not be generated.", http.StatusInternalServerError)
		return
	}
	if r.URL.Path == "/editor-frame" {
		httpsecurity.ApplySandboxedEditorSecurityHeadersWithNonce(w.Header(), nonce)
	} else {
		httpsecurity.ApplyBrowserSecurityHeadersWithNonce(w.Header(), nonce)
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(httpsecurity.HTMLWithCSPNonce(content, nonce)))
}

func readStaticIndexHTML(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, maxStaticIndexHTMLBytes+1))
	if err != nil {
		return nil, err
	}
	if len(content) > maxStaticIndexHTMLBytes {
		return nil, fmt.Errorf("static index.html exceeds %d bytes", maxStaticIndexHTMLBytes)
	}
	return content, nil
}
