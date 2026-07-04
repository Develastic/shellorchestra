// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package desktopapps

import (
	"context"
	"fmt"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"shellorchestra/backend/internal/appplan"
	"shellorchestra/backend/internal/buildinfo"
	"shellorchestra/backend/internal/desktopapps/builtin"
	"shellorchestra/backend/internal/domain"
	"shellorchestra/backend/internal/scripts"
	"shellorchestra/backend/internal/streampipeline"
	"shellorchestra/backend/internal/worker"
)

const (
	SpeedTestAppKind = "speed_test"

	DriverTerminal     = "terminal"
	DriverScriptData   = "script_data"
	DriverScriptAction = "script_action"
	DriverSpeedTest    = "speed_test"

	pveManagerDefaultMonitorInterval = 5 * time.Second
	pveManagerDefaultMonitorTTL      = 2 * time.Minute
)

type ServerStore interface {
	GetServer(ctx context.Context, id string) (domain.Server, error)
	CreateScriptRun(ctx context.Context, run domain.ScriptRun) (domain.ScriptRun, error)
}

type WorkerClient interface {
	CreateTerminal(ctx context.Context, serverID string, title string, cols int, rows int, initialCommand string) (domain.TerminalSnapshot, error)
	RunJSON(ctx context.Context, serverID string, selected scripts.SelectedScript, args map[string]string) (map[string]any, error)
	RunCompressedJSON(ctx context.Context, serverID string, selected scripts.SelectedScript, args map[string]string, outputEncoding string) (map[string]any, error)
	OpenCompressedJSONStream(ctx context.Context, serverID string, selected scripts.SelectedScript, args map[string]string, outputEncoding string) (*http.Response, error)
	OpenCompressedJSONStreamServer(ctx context.Context, server domain.Server, selected scripts.SelectedScript, args map[string]string, outputEncoding string) (*http.Response, error)
	SpeedTest(ctx context.Context, serverID string, direction string, streams int, payloadBytes int64, timeout time.Duration) (worker.SpeedTestResult, error)
	StartSpeedTest(ctx context.Context, serverID string, direction string, streams int, payloadBytes int64) (worker.SpeedTestJobSnapshot, error)
	SpeedTestJob(ctx context.Context, jobID string) (worker.SpeedTestJobSnapshot, error)
	CancelSpeedTest(ctx context.Context, jobID string) (worker.SpeedTestJobSnapshot, error)
}

type AppPlanner interface {
	Plan(ctx context.Context, request appplan.Request) (appplan.Response, error)
}

type ScriptExecutor func(run domain.ScriptRun, selected scripts.SelectedScript, args map[string]string)

type Service struct {
	appsPath        string
	scripts         *scripts.Catalog
	store           ServerStore
	worker          WorkerClient
	planner         AppPlanner
	executeScript   ScriptExecutor
	monitoredDataMu sync.Mutex
	monitoredData   map[string]*monitoredScriptDataEntry
}

type monitoredScriptDataEntry struct {
	result     map[string]any
	errText    string
	updatedAt  time.Time
	lastAccess time.Time
	refreshing bool
}

type Config struct {
	ScriptsRoot   string
	Scripts       *scripts.Catalog
	Store         ServerStore
	Worker        WorkerClient
	Planner       AppPlanner
	ExecuteScript ScriptExecutor
}

type LaunchRequest struct {
	ServerID string
	Cols     int
	Rows     int
	Args     map[string]string
}

type LaunchResponse struct {
	App      map[string]any          `json:"app"`
	Terminal domain.TerminalSnapshot `json:"terminal"`
}

type InstallRequest struct {
	ServerID  string
	Confirmed bool
}

type InstallResponse struct {
	App map[string]any   `json:"app"`
	Run domain.ScriptRun `json:"run"`
}

type DataRequest struct {
	ServerID  string
	Args      map[string]string
	Confirmed bool
}

type DataResponse struct {
	App    map[string]any `json:"app"`
	Result any            `json:"result"`
}

type DataStreamPlan struct {
	App             map[string]any
	Server          domain.Server
	Selected        scripts.SelectedScript
	Args            map[string]string
	OutputEncoding  string
	MaxDecodedBytes int64
}

type ActionRequest struct {
	ServerID  string
	Action    string
	Args      map[string]string
	Confirmed bool
}

type ActionResponse struct {
	App     map[string]any   `json:"app"`
	Action  string           `json:"action"`
	Command string           `json:"command"`
	Run     domain.ScriptRun `json:"run"`
}

type Error struct {
	Status  int
	Message string
	Err     error
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	if e.Message != "" {
		return e.Message
	}
	if e.Err != nil {
		return e.Err.Error()
	}
	return http.StatusText(e.Status)
}

func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func HTTPStatus(err error) int {
	if appErr, ok := err.(*Error); ok && appErr.Status > 0 {
		return appErr.Status
	}
	return http.StatusInternalServerError
}

func NewService(config Config) *Service {
	return &Service{
		appsPath:      filepath.Join(config.ScriptsRoot, "_apps.toml"),
		scripts:       config.Scripts,
		store:         config.Store,
		worker:        config.Worker,
		planner:       config.Planner,
		executeScript: config.ExecuteScript,
		monitoredData: map[string]*monitoredScriptDataEntry{},
	}
}

func (s *Service) List(ctx context.Context, serverID string) ([]map[string]any, error) {
	catalog, err := s.catalog()
	if err != nil {
		return nil, appError(http.StatusInternalServerError, err)
	}
	var server *domain.Server
	if strings.TrimSpace(serverID) != "" {
		loaded, err := s.server(ctx, serverID)
		if err != nil {
			return nil, appError(http.StatusBadRequest, err)
		}
		server = &loaded
	}
	items := make([]map[string]any, 0, len(catalog.Apps))
	for _, profile := range catalog.Apps {
		if profile.Hidden {
			continue
		}
		items = append(items, s.Response(profile, server))
	}
	return items, nil
}

func (s *Service) Launch(ctx context.Context, appID string, request LaunchRequest) (LaunchResponse, error) {
	if s.worker == nil {
		return LaunchResponse{}, &Error{Status: http.StatusServiceUnavailable, Message: "Terminal worker is not configured."}
	}
	profile, server, err := s.profileAndServer(ctx, appID, request.ServerID)
	if err != nil {
		return LaunchResponse{}, err
	}
	if err := s.requireSupported(profile, server); err != nil {
		return LaunchResponse{}, appError(http.StatusBadRequest, err)
	}
	if err := s.requireInstalled(profile, server); err != nil {
		return LaunchResponse{}, appError(http.StatusConflict, err)
	}
	if profile.BackendDriver != DriverTerminal {
		return LaunchResponse{}, &Error{Status: http.StatusBadRequest, Message: fmt.Sprintf("%s does not open an interactive terminal session", profile.Title)}
	}
	if strings.TrimSpace(profile.LaunchCommand) == "" {
		return LaunchResponse{}, &Error{Status: http.StatusBadRequest, Message: "This desktop application does not define a launch profile."}
	}
	plan, err := s.plan(ctx, profile, server, appplan.OperationLaunch, "", request.Args)
	if err != nil {
		return LaunchResponse{}, appError(http.StatusBadRequest, err)
	}
	selected, _, err := s.selectScript(profile, plan.Entry, server)
	if err != nil {
		return LaunchResponse{}, appError(http.StatusBadRequest, err)
	}
	initialCommand, err := scripts.RemoteCommandForVariantWithArgs(selected, plan.Payload)
	if err != nil {
		return LaunchResponse{}, appError(http.StatusBadRequest, err)
	}
	snapshot, err := s.worker.CreateTerminal(ctx, server.ID, profile.Title, request.Cols, request.Rows, initialCommand)
	if err != nil {
		return LaunchResponse{}, appError(http.StatusBadGateway, err)
	}
	return LaunchResponse{App: s.Response(profile, &server), Terminal: snapshot}, nil
}

func (s *Service) Install(ctx context.Context, appID string, request InstallRequest) (InstallResponse, error) {
	profile, server, err := s.profileAndServer(ctx, appID, request.ServerID)
	if err != nil {
		return InstallResponse{}, err
	}
	if err := s.requireSupported(profile, server); err != nil {
		return InstallResponse{}, appError(http.StatusBadRequest, err)
	}
	if strings.TrimSpace(profile.InstallCommand) == "" {
		return InstallResponse{}, &Error{Status: http.StatusBadRequest, Message: "This desktop application does not define an install profile for ShellOrchestra."}
	}
	plan, err := s.plan(ctx, profile, server, appplan.OperationInstall, "", nil)
	if err != nil {
		return InstallResponse{}, appError(http.StatusBadRequest, err)
	}
	if err := requireMutatingConfirmation(plan.Entry, request.Confirmed); err != nil {
		return InstallResponse{}, appError(http.StatusPreconditionRequired, err)
	}
	selected, entry, err := s.selectScript(profile, plan.Entry, server)
	if err != nil {
		return InstallResponse{}, appError(http.StatusBadRequest, err)
	}
	run := domain.ScriptRun{ServerID: server.ID, Command: entry.Command, Variant: selected.Variant.ID, State: domain.ScriptRunRunning}
	run, err = s.store.CreateScriptRun(ctx, run)
	if err != nil {
		return InstallResponse{}, appError(http.StatusInternalServerError, err)
	}
	if s.executeScript != nil {
		go s.executeScript(run, selected, scriptArgsWithConfirmation(plan.Payload, request.Confirmed))
	}
	return InstallResponse{App: s.Response(profile, &server), Run: run}, nil
}

func (s *Service) Action(ctx context.Context, appID string, request ActionRequest) (ActionResponse, error) {
	profile, server, err := s.profileAndServer(ctx, appID, request.ServerID)
	if err != nil {
		return ActionResponse{}, err
	}
	if err := s.requireSupported(profile, server); err != nil {
		return ActionResponse{}, appError(http.StatusBadRequest, err)
	}
	action := request.Action
	if action == "" {
		return ActionResponse{}, &Error{Status: http.StatusBadRequest, Message: "Desktop app action is required."}
	}
	if action != appplan.NormalizedToken(action) {
		return ActionResponse{}, &Error{Status: http.StatusBadRequest, Message: "Desktop app action must use the exact lower-case token form."}
	}
	command := strings.TrimSpace(profile.ActionCommands[action])
	if command == "" {
		return ActionResponse{}, &Error{Status: http.StatusBadRequest, Message: fmt.Sprintf("%s does not define action %q", profile.Title, action)}
	}
	plan, err := s.plan(ctx, profile, server, appplan.OperationAction, action, request.Args)
	if err != nil {
		return ActionResponse{}, appError(http.StatusBadRequest, err)
	}
	if err := requireMutatingConfirmation(plan.Entry, request.Confirmed); err != nil {
		return ActionResponse{}, appError(http.StatusPreconditionRequired, err)
	}
	selected, entry, err := s.selectScript(profile, plan.Entry, server)
	if err != nil {
		return ActionResponse{}, appError(http.StatusBadRequest, err)
	}
	run := domain.ScriptRun{ServerID: server.ID, Command: entry.Command, Variant: selected.Variant.ID, State: domain.ScriptRunRunning}
	run, err = s.store.CreateScriptRun(ctx, run)
	if err != nil {
		return ActionResponse{}, appError(http.StatusInternalServerError, err)
	}
	if s.executeScript != nil {
		go s.executeScript(run, selected, scriptArgsWithConfirmation(plan.Payload, request.Confirmed))
	}
	return ActionResponse{App: s.Response(profile, &server), Action: action, Command: entry.Command, Run: run}, nil
}

func scriptArgsWithConfirmation(args map[string]string, confirmed bool) map[string]string {
	copied := copyArgs(args)
	if confirmed {
		copied["confirmed"] = "1"
	} else {
		copied["confirmed"] = "0"
	}
	return copied
}

func (s *Service) Data(ctx context.Context, appID string, request DataRequest) (DataResponse, error) {
	profile, server, err := s.profileAndServer(ctx, appID, request.ServerID)
	if err != nil {
		return DataResponse{}, err
	}
	if err := s.requireSupported(profile, server); err != nil {
		return DataResponse{}, appError(http.StatusBadRequest, err)
	}
	if profile.BackendDriver == DriverSpeedTest || profile.Kind == SpeedTestAppKind {
		plan, err := s.plan(ctx, profile, server, appplan.OperationData, "", request.Args)
		if err != nil {
			return DataResponse{}, appError(http.StatusBadRequest, err)
		}
		if err := requireMutatingConfirmation(plan.Entry, request.Confirmed); err != nil {
			return DataResponse{}, appError(http.StatusPreconditionRequired, err)
		}
		return s.speedTest(ctx, profile, server, plan.Payload)
	}
	if profile.BackendDriver != DriverScriptData {
		return DataResponse{}, &Error{Status: http.StatusBadRequest, Message: fmt.Sprintf("%s does not expose a JSON data endpoint", profile.Title)}
	}
	if strings.TrimSpace(profile.DataCommand) == "" {
		return DataResponse{}, &Error{Status: http.StatusBadRequest, Message: "This desktop application does not define a data profile for ShellOrchestra."}
	}
	plan, err := s.plan(ctx, profile, server, appplan.OperationData, "", request.Args)
	if err != nil {
		return DataResponse{}, appError(http.StatusBadRequest, err)
	}
	if err := requireMutatingConfirmation(plan.Entry, request.Confirmed); err != nil {
		return DataResponse{}, appError(http.StatusPreconditionRequired, err)
	}
	selected, _, err := s.selectScript(profile, plan.Entry, server)
	if err != nil {
		return DataResponse{}, appError(http.StatusBadRequest, err)
	}
	timeoutCtx, cancel := context.WithTimeout(ctx, selected.Timeout+10*time.Second)
	defer cancel()
	if s.worker == nil {
		return DataResponse{}, &Error{Status: http.StatusServiceUnavailable, Message: "SSH worker is not configured, so ShellOrchestra cannot run this desktop application data script."}
	}
	args := plan.Payload
	if profile.ID == "pve_manager" {
		return s.monitoredPVEData(timeoutCtx, profile, server, selected, args)
	}
	result, err := s.runScriptData(timeoutCtx, profile, server, selected, args)
	if err != nil {
		return DataResponse{}, appError(http.StatusBadGateway, err)
	}
	return DataResponse{App: s.Response(profile, &server), Result: result}, nil
}

func (s *Service) ScriptDataStreamPlan(ctx context.Context, appID string, request DataRequest) (DataStreamPlan, error) {
	profile, server, err := s.profileAndServer(ctx, appID, request.ServerID)
	if err != nil {
		return DataStreamPlan{}, err
	}
	if err := s.requireSupported(profile, server); err != nil {
		return DataStreamPlan{}, appError(http.StatusBadRequest, err)
	}
	if profile.BackendDriver != DriverScriptData {
		return DataStreamPlan{}, &Error{Status: http.StatusBadRequest, Message: fmt.Sprintf("%s does not expose a streamable data endpoint", profile.Title)}
	}
	if strings.TrimSpace(profile.DataCommand) == "" {
		return DataStreamPlan{}, &Error{Status: http.StatusBadRequest, Message: "This desktop application does not define a data profile for ShellOrchestra."}
	}
	plan, err := s.plan(ctx, profile, server, appplan.OperationData, "", request.Args)
	if err != nil {
		return DataStreamPlan{}, appError(http.StatusBadRequest, err)
	}
	if err := requireMutatingConfirmation(plan.Entry, request.Confirmed); err != nil {
		return DataStreamPlan{}, appError(http.StatusPreconditionRequired, err)
	}
	if plan.Entry.Mutating {
		return DataStreamPlan{}, &Error{Status: http.StatusBadRequest, Message: fmt.Sprintf("%s data stream is read-only; use the audited data endpoint for changes.", profile.Title)}
	}
	selected, _, err := s.selectScript(profile, plan.Entry, server)
	if err != nil {
		return DataStreamPlan{}, appError(http.StatusBadRequest, err)
	}
	args := copyArgs(plan.Payload)
	applyCompressedScriptDataArgs(profile, args)
	limits := selected.Command.EffectiveOutputLimits()
	return DataStreamPlan{
		App:             s.Response(profile, &server),
		Server:          server,
		Selected:        selected,
		Args:            args,
		OutputEncoding:  "auto",
		MaxDecodedBytes: limits.MaxDecodedBytes,
	}, nil
}

func (s *Service) runScriptData(ctx context.Context, profile scripts.DesktopAppProfile, server domain.Server, selected scripts.SelectedScript, args map[string]string) (map[string]any, error) {
	var result map[string]any
	var err error
	if !PayloadMutatesServer(profile.ID, appplan.OperationData, args) {
		args = copyArgs(args)
		applyCompressedScriptDataArgs(profile, args)
		response, streamErr := s.worker.OpenCompressedJSONStreamServer(ctx, server, selected, args, "auto")
		if streamErr != nil {
			return nil, streamErr
		}
		defer response.Body.Close()
		limits := selected.Command.EffectiveOutputLimits()
		var stats streampipeline.Stats
		result, stats, err = streampipeline.CollectJSONObject(ctx,
			streampipeline.Source{
				Name:        profile.ID + "-data",
				Kind:        streampipeline.StreamKindRecords,
				Reader:      response.Body,
				Compression: streampipeline.CompressionAuto,
			},
			streampipeline.Options{
				ApplicationName: "desktop-app." + profile.ID,
				MaxDecodedBytes: limits.MaxDecodedBytes,
				ChunkBytes:      32 << 10,
			},
		)
		if result != nil {
			result["_shellorchestra_transport"] = scriptDataTransportFacts(stats.CompressionIn)
		}
		return result, err
	}
	if isCompressedScriptData(profile, args) {
		args = copyArgs(args)
		applyCompressedScriptDataArgs(profile, args)
		result, err = s.worker.RunCompressedJSON(ctx, server.ID, selected, args, "auto")
	} else {
		result, err = s.worker.RunJSON(ctx, server.ID, selected, args)
	}
	return result, err
}

func scriptDataTransportFacts(compression streampipeline.Compression) map[string]any {
	return map[string]any{
		"backend_remote_transport": "raw worker stdout stream from the managed SSH server",
		"browser_transport":        "JSON response compatibility wrapper",
		"compression":              string(compression),
		"binary_stream":            true,
		"base64_payload":           false,
		"streaming_inspection":     true,
	}
}

func (s *Service) monitoredPVEData(ctx context.Context, profile scripts.DesktopAppProfile, server domain.Server, selected scripts.SelectedScript, args map[string]string) (DataResponse, error) {
	key := monitoredDataKey(profile.ID, server.ID)
	now := time.Now().UTC()
	entry := s.monitoredEntry(key, now)

	s.monitoredDataMu.Lock()
	cached := copyAnyMap(entry.result)
	errText := entry.errText
	updatedAt := entry.updatedAt
	needsInitialLoad := cached == nil && errText == ""
	s.monitoredDataMu.Unlock()

	if needsInitialLoad {
		result, err := s.runScriptData(ctx, profile, server, selected, args)
		s.storeMonitoredDataResult(key, result, err)
		if err != nil {
			return DataResponse{}, appError(http.StatusBadGateway, err)
		}
		cached = copyAnyMap(result)
		updatedAt = time.Now().UTC()
		errText = ""
	}

	s.ensurePVEMonitor(key, profile, server, selected, args)
	if cached == nil {
		return DataResponse{}, appError(http.StatusBadGateway, fmt.Errorf("%s", errText))
	}
	cached["_shellorchestra_monitored"] = true
	cached["_shellorchestra_updated_at"] = updatedAt.Format(time.RFC3339Nano)
	if errText != "" {
		cached["_shellorchestra_refresh_error"] = errText
	}
	return DataResponse{App: s.Response(profile, &server), Result: cached}, nil
}

func (s *Service) monitoredEntry(key string, at time.Time) *monitoredScriptDataEntry {
	s.monitoredDataMu.Lock()
	defer s.monitoredDataMu.Unlock()
	entry := s.monitoredData[key]
	if entry == nil {
		entry = &monitoredScriptDataEntry{}
		s.monitoredData[key] = entry
	}
	entry.lastAccess = at
	return entry
}

func (s *Service) storeMonitoredDataResult(key string, result map[string]any, err error) {
	s.monitoredDataMu.Lock()
	defer s.monitoredDataMu.Unlock()
	entry := s.monitoredData[key]
	if entry == nil {
		entry = &monitoredScriptDataEntry{}
		s.monitoredData[key] = entry
	}
	entry.updatedAt = time.Now().UTC()
	if err != nil {
		entry.errText = err.Error()
		return
	}
	entry.result = copyAnyMap(result)
	entry.errText = ""
}

func (s *Service) ensurePVEMonitor(key string, profile scripts.DesktopAppProfile, server domain.Server, selected scripts.SelectedScript, args map[string]string) {
	s.monitoredDataMu.Lock()
	entry := s.monitoredData[key]
	if entry == nil {
		entry = &monitoredScriptDataEntry{lastAccess: time.Now().UTC()}
		s.monitoredData[key] = entry
	}
	if entry.refreshing {
		s.monitoredDataMu.Unlock()
		return
	}
	entry.refreshing = true
	s.monitoredDataMu.Unlock()

	go func() {
		ticker := time.NewTicker(pveManagerMonitorInterval(profile))
		defer ticker.Stop()
		for range ticker.C {
			s.monitoredDataMu.Lock()
			entry := s.monitoredData[key]
			if entry == nil || time.Since(entry.lastAccess) > pveManagerMonitorTTL(profile) {
				if entry != nil {
					entry.refreshing = false
				}
				s.monitoredDataMu.Unlock()
				return
			}
			s.monitoredDataMu.Unlock()

			refreshCtx, cancel := context.WithTimeout(context.Background(), selected.Timeout+10*time.Second)
			result, err := s.runScriptData(refreshCtx, profile, server, selected, copyArgs(args))
			cancel()
			s.storeMonitoredDataResult(key, result, err)
		}
	}()
}

func pveManagerMonitorInterval(profile scripts.DesktopAppProfile) time.Duration {
	if profile.DataMonitorIntervalSeconds > 0 {
		return time.Duration(profile.DataMonitorIntervalSeconds) * time.Second
	}
	return pveManagerDefaultMonitorInterval
}

func pveManagerMonitorTTL(profile scripts.DesktopAppProfile) time.Duration {
	if profile.DataMonitorTTLSeconds > 0 {
		return time.Duration(profile.DataMonitorTTLSeconds) * time.Second
	}
	return pveManagerDefaultMonitorTTL
}

func (s *Service) plan(ctx context.Context, profile scripts.DesktopAppProfile, server domain.Server, operation string, action string, args map[string]string) (ActionPlan, error) {
	if s.planner == nil {
		return ActionPlan{}, &Error{Status: http.StatusServiceUnavailable, Message: "ShellOrchestra app-runner is not configured."}
	}
	request := appplan.Request{
		Version:     1,
		PluginID:    profile.PluginID,
		AppID:       profile.ID,
		Operation:   operation,
		Action:      action,
		ServerID:    server.ID,
		ServerFacts: serverFacts(server),
	}
	if err := appplan.ValidateRequest(request); err != nil {
		return ActionPlan{}, err
	}
	response, err := s.planner.Plan(ctx, request)
	if err != nil {
		return ActionPlan{}, err
	}
	return validatePlan(profile, server, operation, action, response, copyArgs(args))
}

func serverFacts(server domain.Server) map[string]string {
	facts := map[string]string{
		"platform_os":     firstNonEmpty(server.DetectedPlatformOS, server.DetectedOS),
		"platform_arch":   firstNonEmpty(server.DetectedPlatformArch),
		"distro":          firstNonEmpty(server.DetectedDistro),
		"platform":        firstNonEmpty(server.DetectedPlatform),
		"shell":           firstNonEmpty(server.DetectedShell),
		"package_manager": firstNonEmpty(server.DetectedPackageManager),
	}
	out := make(map[string]string, len(facts))
	for key, value := range facts {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			out[key] = trimmed
		}
	}
	return out
}

func isCompressedScriptData(profile scripts.DesktopAppProfile, args map[string]string) bool {
	switch profile.ID {
	case "file_manager":
		action := strings.ToLower(strings.TrimSpace(args["file_manager_action"]))
		return action == "list"
	case "logs":
		return true
	case "package_manager":
		return true
	case "process_monitor":
		return true
	case "containers":
		return true
	case "firewall":
		return true
	case "lan_watch":
		return true
	case "network_connections":
		return true
	case "users":
		return true
	case "cron_editor":
		return true
	case "sudo_editor":
		return true
	case "pve_manager":
		return true
	case "services":
		return true
	case "connection_watch":
		return true
	case "disks":
		return true
	default:
		return false
	}
}

func applyCompressedScriptDataArgs(profile scripts.DesktopAppProfile, args map[string]string) {
	switch profile.ID {
	case "file_manager":
		args["file_manager_output_encoding"] = "auto"
	case "logs":
		args["logs_output_encoding"] = "auto"
	case "package_manager":
		args["package_output_encoding"] = "auto"
	case "process_monitor":
		args["process_output_encoding"] = "auto"
	case "containers":
		args["containers_output_encoding"] = "auto"
	case "firewall":
		args["firewall_output_encoding"] = "auto"
	case "lan_watch":
		args["lan_watch_output_encoding"] = "auto"
	case "network_connections":
		args["network_connections_output_encoding"] = "auto"
	case "users":
		args["users_output_encoding"] = "auto"
	case "cron_editor":
		args["cron_output_encoding"] = "auto"
	case "sudo_editor":
		args["sudo_output_encoding"] = "auto"
	case "pve_manager":
		args["pve_manager_output_encoding"] = "auto"
	case "services":
		args["services_output_encoding"] = "auto"
	case "connection_watch":
		args["connection_watch_output_encoding"] = "auto"
	case "disks":
		args["disks_output_encoding"] = "auto"
	}
}

func copyArgs(args map[string]string) map[string]string {
	copied := make(map[string]string, len(args)+1)
	for key, value := range args {
		copied[key] = value
	}
	return copied
}

func monitoredDataKey(appID string, serverID string) string {
	return strings.TrimSpace(appID) + "\x00" + strings.TrimSpace(serverID)
}

func copyAnyMap(values map[string]any) map[string]any {
	if values == nil {
		return nil
	}
	copied := make(map[string]any, len(values)+3)
	for key, value := range values {
		copied[key] = value
	}
	return copied
}

func (s *Service) Response(profile scripts.DesktopAppProfile, server *domain.Server) map[string]any {
	item := map[string]any{
		"id":                            profile.ID,
		"plugin_id":                     profile.PluginID,
		"edition":                       profile.Edition,
		"title":                         profile.Title,
		"description":                   profile.Description,
		"kind":                          profile.Kind,
		"icon":                          profile.Icon,
		"frontend_module":               profile.FrontendModule,
		"backend_driver":                profile.BackendDriver,
		"detected_app":                  nullableString(profile.DetectedApp),
		"launch_command":                nullableString(profile.LaunchCommand),
		"install_command":               nullableString(profile.InstallCommand),
		"data_command":                  nullableString(profile.DataCommand),
		"actions":                       profile.ActionCommands,
		"supported_os":                  profile.SupportedOS,
		"requires_docker":               profile.RequiresDocker,
		"hidden":                        profile.Hidden,
		"capabilities":                  profile.Capabilities,
		"permissions":                   profile.Permissions,
		"sandbox_policy":                profile.SandboxPolicy,
		"integrated_window":             profile.IntegratedWindow,
		"default_width":                 profile.DefaultWidth,
		"default_height":                profile.DefaultHeight,
		"default_maximized":             profile.DefaultMaximized,
		"data_refresh_interval_seconds": profile.DataRefreshIntervalSeconds,
		"data_monitor_interval_seconds": profile.DataMonitorIntervalSeconds,
		"data_monitor_ttl_seconds":      profile.DataMonitorTTLSeconds,
		"supported":                     true,
		"installed":                     true,
		"installable":                   strings.TrimSpace(profile.InstallCommand) != "",
		"unavailable_hint":              nil,
	}
	if server == nil {
		return item
	}
	if err := s.requireSupported(profile, *server); err != nil {
		item["supported"] = false
		item["installed"] = false
		item["unavailable_hint"] = err.Error()
		return item
	}
	if err := s.requireInstalled(profile, *server); err != nil {
		item["installed"] = false
		item["unavailable_hint"] = err.Error()
	}
	return item
}

func (s *Service) speedTest(ctx context.Context, profile scripts.DesktopAppProfile, server domain.Server, args map[string]string) (DataResponse, error) {
	if s.worker == nil {
		return DataResponse{}, &Error{Status: http.StatusServiceUnavailable, Message: "SSH worker is not configured, so ShellOrchestra cannot run a streaming throughput test."}
	}
	mode := strings.TrimSpace(args["speed_test_mode"])
	switch mode {
	case "":
		mode = "run"
	case "run", "start", "status", "cancel":
	default:
		return DataResponse{}, &Error{Status: http.StatusBadRequest, Message: "Unsupported Test Speed operation."}
	}
	if mode == "status" || mode == "cancel" {
		jobID := strings.TrimSpace(args["speed_test_job_id"])
		if jobID == "" {
			return DataResponse{}, &Error{Status: http.StatusBadRequest, Message: "Test Speed job id is required."}
		}
		requestCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		var (
			result worker.SpeedTestJobSnapshot
			err    error
		)
		if mode == "cancel" {
			result, err = s.worker.CancelSpeedTest(requestCtx, jobID)
		} else {
			result, err = s.worker.SpeedTestJob(requestCtx, jobID)
		}
		if err != nil {
			return DataResponse{}, appError(http.StatusBadGateway, err)
		}
		return DataResponse{App: s.Response(profile, &server), Result: result}, nil
	}
	direction := strings.TrimSpace(args["direction"])
	if direction == "" {
		direction = "download"
	}
	streams, err := intArg(args, "streams", 4, 1, 16)
	if err != nil {
		return DataResponse{}, appError(http.StatusBadRequest, err)
	}
	payloadBytes, err := payloadBytesArg(args)
	if err != nil {
		return DataResponse{}, appError(http.StatusBadRequest, err)
	}
	timeout := speedTestTimeout(payloadBytes)
	if mode == "start" {
		requestCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		result, err := s.worker.StartSpeedTest(requestCtx, server.ID, direction, streams, payloadBytes)
		if err != nil {
			return DataResponse{}, appError(http.StatusBadGateway, err)
		}
		return DataResponse{App: s.Response(profile, &server), Result: result}, nil
	}
	timeoutCtx, cancel := context.WithTimeout(ctx, timeout+10*time.Second)
	defer cancel()
	result, err := s.worker.SpeedTest(timeoutCtx, server.ID, direction, streams, payloadBytes, timeout)
	if err != nil {
		return DataResponse{}, appError(http.StatusBadGateway, err)
	}
	return DataResponse{App: s.Response(profile, &server), Result: result}, nil
}

func (s *Service) profileAndServer(ctx context.Context, appID string, serverID string) (scripts.DesktopAppProfile, domain.Server, error) {
	catalog, err := s.catalog()
	if err != nil {
		return scripts.DesktopAppProfile{}, domain.Server{}, appError(http.StatusInternalServerError, fmt.Errorf("desktop application profiles could not be loaded: %w", err))
	}
	profile, ok := catalog.Find(appID)
	if !ok {
		return scripts.DesktopAppProfile{}, domain.Server{}, &Error{Status: http.StatusBadRequest, Message: fmt.Sprintf("desktop application %q was not found", appID)}
	}
	if definition, ok := builtin.Find(profile.ID); ok {
		if strings.TrimSpace(definition.PluginID) != "" && strings.TrimSpace(definition.PluginID) != strings.TrimSpace(profile.PluginID) {
			return scripts.DesktopAppProfile{}, domain.Server{}, &Error{Status: http.StatusBadRequest, Message: fmt.Sprintf("desktop application %q has plugin %q but backend definition expects %q", profile.ID, profile.PluginID, definition.PluginID)}
		}
		if strings.TrimSpace(definition.Kind) != "" && strings.TrimSpace(definition.Kind) != strings.TrimSpace(profile.Kind) {
			return scripts.DesktopAppProfile{}, domain.Server{}, &Error{Status: http.StatusBadRequest, Message: fmt.Sprintf("desktop application %q has kind %q but backend definition expects %q", profile.ID, profile.Kind, definition.Kind)}
		}
		if strings.TrimSpace(definition.FrontendModule) != "" && strings.TrimSpace(definition.FrontendModule) != strings.TrimSpace(profile.FrontendModule) {
			return scripts.DesktopAppProfile{}, domain.Server{}, &Error{Status: http.StatusBadRequest, Message: fmt.Sprintf("desktop application %q has frontend module %q but backend definition expects %q", profile.ID, profile.FrontendModule, definition.FrontendModule)}
		}
		if strings.TrimSpace(definition.BackendDriver) != "" && strings.TrimSpace(definition.BackendDriver) != strings.TrimSpace(profile.BackendDriver) {
			return scripts.DesktopAppProfile{}, domain.Server{}, &Error{Status: http.StatusBadRequest, Message: fmt.Sprintf("desktop application %q has backend driver %q but backend definition expects %q", profile.ID, profile.BackendDriver, definition.BackendDriver)}
		}
	}
	server, err := s.server(ctx, serverID)
	if err != nil {
		return scripts.DesktopAppProfile{}, domain.Server{}, appError(http.StatusBadRequest, err)
	}
	return profile, server, nil
}

func (s *Service) catalog() (scripts.DesktopAppCatalog, error) {
	catalog, err := builtin.Catalog()
	if err != nil {
		return scripts.DesktopAppCatalog{}, err
	}
	if err := s.validateExternalAppCatalog(catalog); err != nil {
		return scripts.DesktopAppCatalog{}, err
	}
	return catalog.FilterByEdition(buildinfo.ProductEdition()), nil
}

func (s *Service) validateExternalAppCatalog(internal scripts.DesktopAppCatalog) error {
	if strings.TrimSpace(s.appsPath) == "" {
		return nil
	}
	external, err := scripts.LoadDesktopAppCatalog(s.appsPath)
	if err != nil {
		return fmt.Errorf("desktop app manifest could not be loaded: %w", err)
	}
	internalByID := map[string]scripts.DesktopAppProfile{}
	for _, profile := range internal.Apps {
		internalByID[profile.ID] = profile
	}
	for _, externalProfile := range external.Apps {
		internalProfile, ok := internalByID[externalProfile.ID]
		if !ok {
			return fmt.Errorf("desktop app manifest defines %q but no internal plugin with this id is registered", externalProfile.ID)
		}
		if err := validateExternalProfileMatchesInternal(internalProfile, externalProfile); err != nil {
			return err
		}
	}
	return nil
}

func validateExternalProfileMatchesInternal(internal scripts.DesktopAppProfile, external scripts.DesktopAppProfile) error {
	checks := []struct {
		field string
		left  string
		right string
	}{
		{"plugin_id", internal.PluginID, external.PluginID},
		{"edition", internal.Edition, external.Edition},
		{"title", internal.Title, external.Title},
		{"description", internal.Description, external.Description},
		{"kind", internal.Kind, external.Kind},
		{"icon", internal.Icon, external.Icon},
		{"frontend_module", internal.FrontendModule, external.FrontendModule},
		{"backend_driver", internal.BackendDriver, external.BackendDriver},
		{"detected_app", internal.DetectedApp, external.DetectedApp},
		{"launch_command", internal.LaunchCommand, external.LaunchCommand},
		{"install_command", internal.InstallCommand, external.InstallCommand},
		{"data_command", internal.DataCommand, external.DataCommand},
		{"sandbox_policy", internal.SandboxPolicy, external.SandboxPolicy},
	}
	for _, check := range checks {
		if check.left != check.right {
			return fmt.Errorf("desktop app manifest mismatch for %q: %s is %q but internal plugin defines %q", internal.ID, check.field, check.right, check.left)
		}
	}
	if !sameStringMap(internal.ActionCommands, external.ActionCommands) {
		return fmt.Errorf("desktop app manifest mismatch for %q: action command map differs from the internal plugin", internal.ID)
	}
	if !sameStringSlice(internal.SupportedOS, external.SupportedOS) {
		return fmt.Errorf("desktop app manifest mismatch for %q: supported_os differs from the internal plugin", internal.ID)
	}
	if internal.RequiresDocker != external.RequiresDocker {
		return fmt.Errorf("desktop app manifest mismatch for %q: requires_docker is %v but internal plugin defines %v", internal.ID, external.RequiresDocker, internal.RequiresDocker)
	}
	if internal.Hidden != external.Hidden {
		return fmt.Errorf("desktop app manifest mismatch for %q: hidden is %v but internal plugin defines %v", internal.ID, external.Hidden, internal.Hidden)
	}
	if !sameStringSlice(internal.Capabilities, external.Capabilities) {
		return fmt.Errorf("desktop app manifest mismatch for %q: capabilities differs from the internal plugin", internal.ID)
	}
	if !sameStringSlice(internal.Permissions, external.Permissions) {
		return fmt.Errorf("desktop app manifest mismatch for %q: permissions differs from the internal plugin", internal.ID)
	}
	if internal.IntegratedWindow != external.IntegratedWindow {
		return fmt.Errorf("desktop app manifest mismatch for %q: integrated_window is %v but internal plugin defines %v", internal.ID, external.IntegratedWindow, internal.IntegratedWindow)
	}
	if internal.DefaultWidth != external.DefaultWidth {
		return fmt.Errorf("desktop app manifest mismatch for %q: default_width is %d but internal plugin defines %d", internal.ID, external.DefaultWidth, internal.DefaultWidth)
	}
	if internal.DefaultHeight != external.DefaultHeight {
		return fmt.Errorf("desktop app manifest mismatch for %q: default_height is %d but internal plugin defines %d", internal.ID, external.DefaultHeight, internal.DefaultHeight)
	}
	if internal.DefaultMaximized != external.DefaultMaximized {
		return fmt.Errorf("desktop app manifest mismatch for %q: default_maximized is %v but internal plugin defines %v", internal.ID, external.DefaultMaximized, internal.DefaultMaximized)
	}
	if internal.DataRefreshIntervalSeconds != external.DataRefreshIntervalSeconds {
		return fmt.Errorf("desktop app manifest mismatch for %q: data_refresh_interval_seconds is %d but internal plugin defines %d", internal.ID, external.DataRefreshIntervalSeconds, internal.DataRefreshIntervalSeconds)
	}
	if internal.DataMonitorIntervalSeconds != external.DataMonitorIntervalSeconds {
		return fmt.Errorf("desktop app manifest mismatch for %q: data_monitor_interval_seconds is %d but internal plugin defines %d", internal.ID, external.DataMonitorIntervalSeconds, internal.DataMonitorIntervalSeconds)
	}
	if internal.DataMonitorTTLSeconds != external.DataMonitorTTLSeconds {
		return fmt.Errorf("desktop app manifest mismatch for %q: data_monitor_ttl_seconds is %d but internal plugin defines %d", internal.ID, external.DataMonitorTTLSeconds, internal.DataMonitorTTLSeconds)
	}
	return nil
}

func sameStringMap(left map[string]string, right map[string]string) bool {
	if len(left) != len(right) {
		return false
	}
	for key, leftValue := range left {
		rightValue, ok := right[key]
		if !ok || rightValue != leftValue {
			return false
		}
	}
	return true
}

func sameStringSlice(left []string, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func (s *Service) server(ctx context.Context, id string) (domain.Server, error) {
	if s.store == nil {
		return domain.Server{}, fmt.Errorf("desktop app store is not configured")
	}
	return s.store.GetServer(ctx, strings.TrimSpace(id))
}

func (s *Service) selectScript(profile scripts.DesktopAppProfile, entry ActionEntry, server domain.Server) (scripts.SelectedScript, ActionEntry, error) {
	if s.scripts == nil {
		return scripts.SelectedScript{}, ActionEntry{}, fmt.Errorf("script catalog is not configured")
	}
	selected, err := s.scripts.Select(entry.Command, TargetFactsForServer(server))
	if err != nil {
		return scripts.SelectedScript{}, ActionEntry{}, err
	}
	entry, err = applyScriptManifestPolicy(profile, entry, selected.Command)
	if err != nil {
		return scripts.SelectedScript{}, ActionEntry{}, err
	}
	return selected, entry, nil
}

func (s *Service) requireSupported(profile scripts.DesktopAppProfile, server domain.Server) error {
	targetOS := strings.ToLower(strings.TrimSpace(firstNonEmpty(server.DetectedOS, server.DetectedPlatformOS)))
	if len(profile.SupportedOS) > 0 && !containsStringFold(profile.SupportedOS, targetOS) {
		return fmt.Errorf("%s is not supported on this server platform yet", profile.Title)
	}
	if profile.RequiresDocker && !server.DetectedDockerHost {
		return fmt.Errorf("%s needs Docker or Podman on the target server, but neither engine was detected", profile.Title)
	}
	return nil
}

func (s *Service) requireInstalled(profile scripts.DesktopAppProfile, server domain.Server) error {
	detectedApp := strings.TrimSpace(profile.DetectedApp)
	if detectedApp == "" {
		return nil
	}
	if server.DetectedApps != nil && server.DetectedApps[detectedApp] {
		return nil
	}
	return fmt.Errorf("%s is not installed on this server yet", profile.Title)
}

func TargetFactsForServer(server domain.Server) scripts.TargetFacts {
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

func intArg(args map[string]string, key string, fallback int, minimum int, maximum int) (int, error) {
	raw := strings.TrimSpace(args[key])
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s must be a whole number", key)
	}
	if value < minimum || value > maximum {
		return 0, fmt.Errorf("%s must be between %d and %d", key, minimum, maximum)
	}
	return value, nil
}

func payloadBytesArg(args map[string]string) (int64, error) {
	if raw := strings.TrimSpace(args["payload_bytes"]); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			return 0, fmt.Errorf("payload_bytes must be a whole number of bytes")
		}
		if value < 1024*1024 || value > 10*1024*1024*1024 {
			return 0, fmt.Errorf("payload_bytes must be between 1 MiB and 10 GiB")
		}
		return value, nil
	}
	rawMB := strings.TrimSpace(args["payload_mb"])
	if rawMB == "" {
		rawMB = "100"
	}
	value, err := strconv.ParseFloat(rawMB, 64)
	if err != nil {
		return 0, fmt.Errorf("payload_mb must be a number")
	}
	if value < 1 || value > 10240 {
		return 0, fmt.Errorf("payload_mb must be between 1 and 10240")
	}
	return int64(value * 1024 * 1024), nil
}

func speedTestTimeout(payloadBytes int64) time.Duration {
	timeout := 180 * time.Second
	if payloadBytes > 1024*1024*1024 {
		timeout = 600 * time.Second
	}
	return timeout
}

func appError(status int, err error) error {
	if appErr, ok := err.(*Error); ok {
		return appErr
	}
	return &Error{Status: status, Err: err}
}

func nullableString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return strings.TrimSpace(value)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func containsStringFold(values []string, target string) bool {
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), target) {
			return true
		}
	}
	return false
}
