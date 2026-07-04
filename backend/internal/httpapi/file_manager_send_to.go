// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package httpapi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	pathpkg "path"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"

	"shellorchestra/backend/internal/auditlog"
	"shellorchestra/backend/internal/domain"
	"shellorchestra/backend/internal/streampipeline"
)

const (
	fileManagerSendToTTL                = 2 * time.Hour
	fileManagerSendToTimeout            = 30 * time.Minute
	fileManagerSendToCompression        = "zstd,gzip,none"
	fileManagerSendToCompressionLevel   = "3"
	fileManagerSendToMaxSourcePathCount = 64
)

type fileManagerSendToJob struct {
	mu                  sync.Mutex
	ID                  string
	Status              string
	TransferMode        string
	SourceServerID      string
	SourcePaths         []string
	SourceTypes         []string
	SourceParent        string
	SourceNames         []string
	DestinationServerID string
	DestinationPath     string
	ResolvedTargetPath  string
	Overwrite           bool
	Compression         string
	BytesTransferred    int64
	Message             string
	Error               string
	AuditEventID        string
	AuditHash           string
	CreatedAt           time.Time
	UpdatedAt           time.Time
	FinishedAt          time.Time
	cancel              context.CancelFunc
}

type fileManagerSendToAuditContext struct {
	ActorDeviceID string
	ActorLabel    string
	ClientIP      string
	RequestID     string
}

type fileManagerSendToAuditInput struct {
	EventType       string
	SourceServerID  string
	SourcePaths     []string
	DestinationID   string
	DestinationPath string
	TargetPath      string
	Overwrite       bool
	JobID           string
	Bytes           int64
	Compression     string
	TransferMode    string
	RequestEventID  string
	Err             error
	Result          map[string]any
}

func (a *App) fileManagerSendTo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if a.deps.Worker == nil {
		writeError(w, http.StatusServiceUnavailable, "SSH worker is not configured.")
		return
	}
	if a.deps.Audit == nil {
		writeError(w, http.StatusServiceUnavailable, "Audit log is required before copying files between managed servers.")
		return
	}
	var body struct {
		SourceServerID      string   `json:"source_server_id"`
		SourcePaths         []string `json:"source_paths"`
		SourceTypes         []string `json:"source_types"`
		DestinationServerID string   `json:"destination_server_id"`
		DestinationPath     string   `json:"destination_path"`
		Overwrite           bool     `json:"overwrite"`
		Confirmed           bool     `json:"confirmed"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	body.SourceServerID = strings.TrimSpace(body.SourceServerID)
	body.DestinationServerID = strings.TrimSpace(body.DestinationServerID)
	body.DestinationPath = strings.TrimSpace(body.DestinationPath)
	if body.SourceServerID == "" || body.DestinationServerID == "" || body.DestinationPath == "" {
		writeError(w, http.StatusBadRequest, "source_server_id, destination_server_id, and destination_path are required.")
		return
	}
	if !body.Confirmed {
		writeError(w, http.StatusPreconditionRequired, "ShellOrchestra requires explicit confirmation before copying files between managed servers.")
		return
	}
	if err := validateFileManagerSendToPaths(body.SourcePaths, body.DestinationPath); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	sourcePaths := normalizeFileManagerSendToPaths(body.SourcePaths)
	sourceTypes := normalizeFileManagerSendToTypes(body.SourceTypes, len(sourcePaths))
	plan, err := fileManagerSendToPlan(sourcePaths, sourceTypes, body.DestinationPath)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	auditCtx := fileManagerSendToAuditContextFromRequest(r)
	requestEvent, err := a.appendFileManagerSendToAudit(r.Context(), auditCtx, fileManagerSendToAuditInput{
		EventType:       "file.send_to.requested",
		SourceServerID:  body.SourceServerID,
		SourcePaths:     sourcePaths,
		DestinationID:   body.DestinationServerID,
		DestinationPath: body.DestinationPath,
		TargetPath:      plan.ResolvedTargetPath,
		Overwrite:       body.Overwrite,
		Compression:     fileManagerSendToCompression,
		TransferMode:    plan.Mode,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "ShellOrchestra could not append the Send To audit request: "+err.Error())
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	now := time.Now().UTC()
	job := &fileManagerSendToJob{
		ID:                  uuid.NewString(),
		Status:              "queued",
		TransferMode:        plan.Mode,
		SourceServerID:      body.SourceServerID,
		SourcePaths:         sourcePaths,
		SourceTypes:         sourceTypes,
		SourceParent:        plan.SourceParent,
		SourceNames:         plan.SourceNames,
		DestinationServerID: body.DestinationServerID,
		DestinationPath:     body.DestinationPath,
		ResolvedTargetPath:  plan.ResolvedTargetPath,
		Overwrite:           body.Overwrite,
		Compression:         fileManagerSendToCompression,
		Message:             "Send To job queued.",
		CreatedAt:           now,
		UpdatedAt:           now,
		cancel:              cancel,
	}
	a.fileManagerSendToJobs.Store(job.ID, job)
	a.cleanupExpiredFileManagerSendToJobs()
	go a.runFileManagerSendToJob(ctx, job, auditCtx, requestEvent.ID)
	writeJSON(w, http.StatusAccepted, job.snapshot())
}

func (a *App) fileManagerSendToByID(w http.ResponseWriter, r *http.Request) {
	id, suffix := splitIDPath(strings.TrimPrefix(r.URL.Path, "/api/file-manager/send-to/"))
	if id == "" {
		http.NotFound(w, r)
		return
	}
	value, ok := a.fileManagerSendToJobs.Load(id)
	if !ok {
		writeError(w, http.StatusNotFound, "Send To job was not found or has expired.")
		return
	}
	job, ok := value.(*fileManagerSendToJob)
	if !ok {
		a.fileManagerSendToJobs.Delete(id)
		writeError(w, http.StatusNotFound, "Send To job was not found or has expired.")
		return
	}
	switch suffix {
	case "":
		if r.Method != http.MethodGet {
			methodNotAllowed(w)
			return
		}
		writeJSON(w, http.StatusOK, job.snapshot())
	case "/cancel":
		if r.Method != http.MethodPost {
			methodNotAllowed(w)
			return
		}
		job.cancelJob("Cancellation requested by the operator.")
		writeJSON(w, http.StatusAccepted, job.snapshot())
	default:
		http.NotFound(w, r)
	}
}

func (a *App) runFileManagerSendToJob(ctx context.Context, job *fileManagerSendToJob, auditCtx fileManagerSendToAuditContext, requestEventID string) {
	ctx, cancel := context.WithTimeout(ctx, fileManagerSendToTimeout)
	defer cancel()
	if job.transferMode() == "archive" {
		a.runFileManagerArchiveSendToJob(ctx, job, auditCtx, requestEventID)
		return
	}
	job.markRunning("Copying remote file through ShellOrchestra worker streams.")
	sourcePath := job.firstSourcePath()
	response, err := a.deps.Worker.OpenFileDownloadCompressedWithOptions(ctx, job.SourceServerID, sourcePath, fileManagerSendToTimeout, fileManagerSendToCompression, fileManagerSendToCompressionLevel)
	if err != nil {
		job.markFailed(err)
		_, _ = a.appendFileManagerSendToAudit(context.Background(), auditCtx, job.auditInput("file.send_to.failed", requestEventID, err, nil))
		return
	}
	defer response.Body.Close()

	reader, writer := io.Pipe()
	pipelineErr := make(chan error, 1)
	go func() {
		processor := streampipeline.ProcessorHooks{
			ProcessorName: "file-manager-send-to-writer",
			Chunk: func(ctx context.Context, chunk []byte, emit streampipeline.EventSink) (streampipeline.Decision, error) {
				if err := ctx.Err(); err != nil {
					return streampipeline.Decision{Stop: true, Reason: "send-to cancelled"}, err
				}
				written, err := writer.Write(chunk)
				if written > 0 {
					job.addBytes(int64(written))
				}
				return streampipeline.Decision{}, err
			},
		}
		pipeline := streampipeline.New(
			streampipeline.Source{Name: "file-manager-send-to-source", Kind: streampipeline.StreamKindBytes, Reader: response.Body, Compression: streampipeline.CompressionAuto},
			nil,
			[]streampipeline.Processor{processor},
			streampipeline.Options{ApplicationName: "file_manager.send_to", ChunkBytes: 64 << 10},
		)
		_, err := pipeline.Run(ctx)
		if err != nil {
			_ = writer.CloseWithError(err)
		} else {
			_ = writer.Close()
		}
		pipelineErr <- err
	}()

	result, uploadErr := a.deps.Worker.UploadFile(ctx, job.DestinationServerID, job.ResolvedTargetPath, job.Overwrite, reader, fileManagerSendToTimeout)
	if uploadErr != nil {
		_ = reader.CloseWithError(uploadErr)
	}
	streamErr := <-pipelineErr
	if uploadErr != nil {
		if job.cancelled() || errors.Is(ctx.Err(), context.Canceled) {
			_, _ = a.appendFileManagerSendToAudit(context.Background(), auditCtx, job.auditInput("file.send_to.cancelled", requestEventID, uploadErr, result))
			return
		}
		job.markFailed(uploadErr)
		_, _ = a.appendFileManagerSendToAudit(context.Background(), auditCtx, job.auditInput("file.send_to.failed", requestEventID, uploadErr, result))
		return
	}
	if streamErr != nil {
		if job.cancelled() || errors.Is(ctx.Err(), context.Canceled) {
			_, _ = a.appendFileManagerSendToAudit(context.Background(), auditCtx, job.auditInput("file.send_to.cancelled", requestEventID, streamErr, result))
			return
		}
		job.markFailed(streamErr)
		_, _ = a.appendFileManagerSendToAudit(context.Background(), auditCtx, job.auditInput("file.send_to.failed", requestEventID, streamErr, result))
		return
	}
	if !fileUploadResultOK(result) {
		message := stringFromResult(result, "error")
		if strings.TrimSpace(message) == "" {
			message = "remote destination helper did not confirm success"
		}
		err := errors.New(message)
		job.markFailed(err)
		_, _ = a.appendFileManagerSendToAudit(context.Background(), auditCtx, job.auditInput("file.send_to.failed", requestEventID, err, result))
		return
	}
	commitEvent, err := a.appendFileManagerSendToAudit(context.Background(), auditCtx, job.auditInput("file.send_to.completed", requestEventID, nil, result))
	if err != nil {
		job.markFailed(fmt.Errorf("transfer completed, but audit append failed: %w", err))
		return
	}
	job.markCompleted(commitEvent)
}

func (a *App) runFileManagerArchiveSendToJob(ctx context.Context, job *fileManagerSendToJob, auditCtx fileManagerSendToAuditContext, requestEventID string) {
	job.markRunning("Copying selected remote items through ShellOrchestra archive stream.")
	sourceParent, sourceNames := job.archiveSource()
	response, err := a.deps.Worker.OpenFileArchiveDownloadCompressedWithOptions(ctx, job.SourceServerID, sourceParent, sourceNames, fileManagerSendToTimeout, fileManagerSendToCompression, fileManagerSendToCompressionLevel)
	if err != nil {
		job.markFailed(err)
		_, _ = a.appendFileManagerSendToAudit(context.Background(), auditCtx, job.auditInput("file.send_to.failed", requestEventID, err, nil))
		return
	}
	defer response.Body.Close()

	reader, writer := io.Pipe()
	pipelineErr := make(chan error, 1)
	go func() {
		processor := streampipeline.ProcessorHooks{
			ProcessorName: "file-manager-send-to-archive-writer",
			Chunk: func(ctx context.Context, chunk []byte, emit streampipeline.EventSink) (streampipeline.Decision, error) {
				if err := ctx.Err(); err != nil {
					return streampipeline.Decision{Stop: true, Reason: "send-to cancelled"}, err
				}
				written, err := writer.Write(chunk)
				if written > 0 {
					job.addBytes(int64(written))
				}
				return streampipeline.Decision{}, err
			},
		}
		pipeline := streampipeline.New(
			streampipeline.Source{Name: "file-manager-send-to-archive-source", Kind: streampipeline.StreamKindBytes, Reader: response.Body, Compression: streampipeline.CompressionAuto},
			nil,
			[]streampipeline.Processor{processor},
			streampipeline.Options{ApplicationName: "file_manager.send_to.archive", ChunkBytes: 64 << 10},
		)
		_, err := pipeline.Run(ctx)
		if err != nil {
			_ = writer.CloseWithError(err)
		} else {
			_ = writer.Close()
		}
		pipelineErr <- err
	}()

	result, uploadErr := a.deps.Worker.UploadArchive(ctx, job.DestinationServerID, job.DestinationPath, job.Overwrite, reader, fileManagerSendToTimeout)
	if uploadErr != nil {
		_ = reader.CloseWithError(uploadErr)
	}
	streamErr := <-pipelineErr
	if uploadErr != nil {
		if job.cancelled() || errors.Is(ctx.Err(), context.Canceled) {
			_, _ = a.appendFileManagerSendToAudit(context.Background(), auditCtx, job.auditInput("file.send_to.cancelled", requestEventID, uploadErr, result))
			return
		}
		job.markFailed(uploadErr)
		_, _ = a.appendFileManagerSendToAudit(context.Background(), auditCtx, job.auditInput("file.send_to.failed", requestEventID, uploadErr, result))
		return
	}
	if streamErr != nil {
		if job.cancelled() || errors.Is(ctx.Err(), context.Canceled) {
			_, _ = a.appendFileManagerSendToAudit(context.Background(), auditCtx, job.auditInput("file.send_to.cancelled", requestEventID, streamErr, result))
			return
		}
		job.markFailed(streamErr)
		_, _ = a.appendFileManagerSendToAudit(context.Background(), auditCtx, job.auditInput("file.send_to.failed", requestEventID, streamErr, result))
		return
	}
	if !fileUploadResultOK(result) {
		message := stringFromResult(result, "error")
		if strings.TrimSpace(message) == "" {
			message = "remote destination helper did not confirm archive extraction"
		}
		err := errors.New(message)
		job.markFailed(err)
		_, _ = a.appendFileManagerSendToAudit(context.Background(), auditCtx, job.auditInput("file.send_to.failed", requestEventID, err, result))
		return
	}
	commitEvent, err := a.appendFileManagerSendToAudit(context.Background(), auditCtx, job.auditInput("file.send_to.completed", requestEventID, nil, result))
	if err != nil {
		job.markFailed(fmt.Errorf("transfer completed, but audit append failed: %w", err))
		return
	}
	job.markCompleted(commitEvent)
}

func (job *fileManagerSendToJob) snapshot() map[string]any {
	job.mu.Lock()
	defer job.mu.Unlock()
	return map[string]any{
		"id":                    job.ID,
		"status":                job.Status,
		"transfer_mode":         job.TransferMode,
		"source_server_id":      job.SourceServerID,
		"source_paths":          append([]string(nil), job.SourcePaths...),
		"source_types":          append([]string(nil), job.SourceTypes...),
		"source_parent":         job.SourceParent,
		"source_names":          append([]string(nil), job.SourceNames...),
		"destination_server_id": job.DestinationServerID,
		"destination_path":      job.DestinationPath,
		"resolved_target_path":  job.ResolvedTargetPath,
		"overwrite":             job.Overwrite,
		"compression":           job.Compression,
		"bytes_transferred":     job.BytesTransferred,
		"message":               job.Message,
		"error":                 job.Error,
		"audit_event_id":        job.AuditEventID,
		"audit_hash":            job.AuditHash,
		"created_at":            job.CreatedAt,
		"updated_at":            job.UpdatedAt,
		"finished_at":           job.FinishedAt,
	}
}

func (job *fileManagerSendToJob) transferMode() string {
	job.mu.Lock()
	defer job.mu.Unlock()
	return strings.TrimSpace(job.TransferMode)
}

func (job *fileManagerSendToJob) archiveSource() (string, []string) {
	job.mu.Lock()
	defer job.mu.Unlock()
	return job.SourceParent, append([]string(nil), job.SourceNames...)
}

func (job *fileManagerSendToJob) firstSourcePath() string {
	job.mu.Lock()
	defer job.mu.Unlock()
	if len(job.SourcePaths) == 0 {
		return ""
	}
	return job.SourcePaths[0]
}

func (job *fileManagerSendToJob) markRunning(message string) {
	job.mu.Lock()
	defer job.mu.Unlock()
	if job.Status == "cancelled" {
		return
	}
	job.Status = "running"
	job.Message = message
	job.UpdatedAt = time.Now().UTC()
}

func (job *fileManagerSendToJob) addBytes(count int64) {
	job.mu.Lock()
	defer job.mu.Unlock()
	job.BytesTransferred += count
	job.UpdatedAt = time.Now().UTC()
}

func (job *fileManagerSendToJob) markFailed(err error) {
	job.mu.Lock()
	defer job.mu.Unlock()
	if job.Status == "cancelled" {
		return
	}
	job.Status = "failed"
	job.Error = strings.TrimSpace(err.Error())
	job.Message = "Send To failed."
	job.FinishedAt = time.Now().UTC()
	job.UpdatedAt = job.FinishedAt
}

func (job *fileManagerSendToJob) markCompleted(event auditlog.Event) {
	job.mu.Lock()
	defer job.mu.Unlock()
	if job.Status == "cancelled" {
		return
	}
	job.Status = "completed"
	job.Message = "Send To completed."
	job.AuditEventID = event.ID
	job.AuditHash = event.Hash
	job.FinishedAt = time.Now().UTC()
	job.UpdatedAt = job.FinishedAt
}

func (job *fileManagerSendToJob) cancelled() bool {
	job.mu.Lock()
	defer job.mu.Unlock()
	return job.Status == "cancelled"
}

func (job *fileManagerSendToJob) cancelJob(message string) {
	job.mu.Lock()
	if job.Status == "completed" || job.Status == "failed" || job.Status == "cancelled" {
		job.mu.Unlock()
		return
	}
	job.Status = "cancelled"
	job.Message = strings.TrimSpace(message)
	job.FinishedAt = time.Now().UTC()
	job.UpdatedAt = job.FinishedAt
	cancel := job.cancel
	job.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (job *fileManagerSendToJob) auditInput(eventType string, requestEventID string, err error, result map[string]any) fileManagerSendToAuditInput {
	job.mu.Lock()
	defer job.mu.Unlock()
	return fileManagerSendToAuditInput{
		EventType:       eventType,
		SourceServerID:  job.SourceServerID,
		SourcePaths:     append([]string(nil), job.SourcePaths...),
		DestinationID:   job.DestinationServerID,
		DestinationPath: job.DestinationPath,
		TargetPath:      job.ResolvedTargetPath,
		Overwrite:       job.Overwrite,
		JobID:           job.ID,
		Bytes:           job.BytesTransferred,
		Compression:     job.Compression,
		TransferMode:    job.TransferMode,
		RequestEventID:  requestEventID,
		Err:             err,
		Result:          result,
	}
}

func fileManagerSendToAuditContextFromRequest(r *http.Request) fileManagerSendToAuditContext {
	principal, _ := r.Context().Value(principalKey{}).(*domain.Principal)
	return fileManagerSendToAuditContext{
		ActorDeviceID: principalDeviceID(principal),
		ActorLabel:    principalLabel(principal),
		ClientIP:      sessionClientIP(r),
		RequestID:     r.Header.Get("X-ShellOrchestra-Nonce"),
	}
}

func (a *App) appendFileManagerSendToAudit(ctx context.Context, actor fileManagerSendToAuditContext, input fileManagerSendToAuditInput) (auditlog.Event, error) {
	if a.deps.Audit == nil {
		return auditlog.Event{}, fmt.Errorf("audit log is not configured")
	}
	return a.deps.Audit.Append(ctx, auditlog.EventInput{
		Type:          strings.TrimSpace(input.EventType),
		ActorDeviceID: actor.ActorDeviceID,
		ActorLabel:    actor.ActorLabel,
		ClientIP:      actor.ClientIP,
		ServerID:      strings.TrimSpace(input.SourceServerID),
		Operation:     "send_to",
		Path:          strings.TrimSpace(firstString(input.SourcePaths)),
		AfterHash:     fileUploadResultSHA256(input.Result),
		RequestID:     actor.RequestID,
		Metadata:      fileManagerSendToAuditMetadata(input),
	})
}

func fileManagerSendToAuditMetadata(input fileManagerSendToAuditInput) map[string]string {
	metadata := map[string]string{
		"destination_server_id":     strings.TrimSpace(input.DestinationID),
		"destination_path":          strings.TrimSpace(input.DestinationPath),
		"resolved_target_path":      strings.TrimSpace(input.TargetPath),
		"overwrite":                 fmt.Sprintf("%t", input.Overwrite),
		"source_path_count":         strconv.Itoa(len(input.SourcePaths)),
		"bytes_transferred":         strconv.FormatInt(input.Bytes, 10),
		"compression_preference":    strings.TrimSpace(input.Compression),
		"transfer_mode":             strings.TrimSpace(input.TransferMode),
		"content_values_logged":     "false",
		"payload_values_logged":     "false",
		"streaming_binary_transfer": "true",
	}
	if input.JobID != "" {
		metadata["job_id"] = input.JobID
	}
	if input.RequestEventID != "" {
		metadata["request_event_id"] = input.RequestEventID
	}
	if input.Err != nil {
		metadata["error"] = input.Err.Error()
	}
	if input.Result != nil {
		if value := stringFromResult(input.Result, "error"); value != "" {
			metadata["remote_error"] = value
		}
		if value := stringFromResult(input.Result, "size"); value != "" {
			metadata["remote_size_bytes"] = value
		}
		if value := fileUploadResultSHA256(input.Result); value != "" {
			metadata["remote_sha256_present"] = "true"
		}
	}
	return metadata
}

func (a *App) cleanupExpiredFileManagerSendToJobs() {
	now := time.Now()
	a.fileManagerSendToJobs.Range(func(key any, value any) bool {
		job, ok := value.(*fileManagerSendToJob)
		if !ok || now.Sub(job.CreatedAt) > fileManagerSendToTTL {
			if id, ok := key.(string); ok {
				a.fileManagerSendToJobs.Delete(id)
			}
		}
		return true
	})
}

func validateFileManagerSendToPaths(sourcePaths []string, destinationPath string) error {
	if len(sourcePaths) == 0 {
		return fmt.Errorf("select at least one remote file or folder before using Send To")
	}
	if len(sourcePaths) > fileManagerSendToMaxSourcePathCount {
		return fmt.Errorf("Send To accepts at most %d source paths at once", fileManagerSendToMaxSourcePathCount)
	}
	seen := map[string]bool{}
	for _, sourcePath := range sourcePaths {
		path := strings.TrimSpace(sourcePath)
		if err := validateFileManagerRemotePathForSendTo("source path", path, false); err != nil {
			return err
		}
		if seen[path] {
			return fmt.Errorf("Send To source paths must be unique")
		}
		seen[path] = true
	}
	return validateFileManagerRemotePathForSendTo("destination path", strings.TrimSpace(destinationPath), true)
}

type fileManagerSendToPlanResult struct {
	Mode               string
	ResolvedTargetPath string
	SourceParent       string
	SourceNames        []string
}

func normalizeFileManagerSendToPaths(sourcePaths []string) []string {
	normalized := make([]string, 0, len(sourcePaths))
	for _, sourcePath := range sourcePaths {
		path := strings.TrimSpace(sourcePath)
		if path != "" {
			normalized = append(normalized, path)
		}
	}
	return normalized
}

func normalizeFileManagerSendToTypes(sourceTypes []string, expected int) []string {
	normalized := make([]string, expected)
	for index := 0; index < expected; index++ {
		if index >= len(sourceTypes) {
			continue
		}
		normalized[index] = strings.ToLower(strings.TrimSpace(sourceTypes[index]))
	}
	return normalized
}

func fileManagerSendToPlan(sourcePaths []string, sourceTypes []string, destinationPath string) (fileManagerSendToPlanResult, error) {
	if len(sourcePaths) == 1 && !fileManagerSendToTypeIsDirectory(firstString(sourceTypes)) {
		targetPath, err := fileManagerSendToTargetPath(destinationPath, sourcePaths[0])
		if err != nil {
			return fileManagerSendToPlanResult{}, err
		}
		return fileManagerSendToPlanResult{Mode: "file", ResolvedTargetPath: targetPath}, nil
	}
	sourceParent, names, err := fileManagerSendToArchiveSource(sourcePaths)
	if err != nil {
		return fileManagerSendToPlanResult{}, err
	}
	return fileManagerSendToPlanResult{
		Mode:               "archive",
		ResolvedTargetPath: strings.TrimSpace(destinationPath),
		SourceParent:       sourceParent,
		SourceNames:        names,
	}, nil
}

func fileManagerSendToTypeIsDirectory(value string) bool {
	normalized := strings.ToLower(strings.TrimSpace(value))
	return normalized == "directory" || normalized == "folder"
}

func fileManagerSendToArchiveSource(sourcePaths []string) (string, []string, error) {
	var parent string
	names := make([]string, 0, len(sourcePaths))
	for _, sourcePath := range sourcePaths {
		itemParent := parentRemotePath(sourcePath)
		name := lastRemotePathComponent(sourcePath)
		if err := validateFileManagerSendToComponent(name); err != nil {
			return "", nil, fmt.Errorf("source name is not safe for archive Send To: %w", err)
		}
		if strings.HasPrefix(name, "-") {
			return "", nil, fmt.Errorf("source name must not start with a dash for archive Send To")
		}
		if parent == "" {
			parent = itemParent
		} else if parent != itemParent {
			return "", nil, fmt.Errorf("Send To can archive multiple selections only from one source folder")
		}
		names = append(names, name)
	}
	if parent == "" {
		return "", nil, fmt.Errorf("source parent folder is required")
	}
	if len(names) == 0 {
		return "", nil, fmt.Errorf("select at least one remote file or folder before using Send To")
	}
	return parent, names, nil
}

func validateFileManagerRemotePathForSendTo(label string, path string, allowDirectory bool) error {
	if path == "" {
		return fmt.Errorf("%s is required", label)
	}
	if len([]byte(path)) > 4096 {
		return fmt.Errorf("%s is too long", label)
	}
	if strings.ContainsRune(path, '\x00') || strings.ContainsFunc(path, unicode.IsControl) || containsFileManagerBidiControl(path) {
		return fmt.Errorf("%s contains unsafe control characters", label)
	}
	if !utf8String(path) {
		return fmt.Errorf("%s must be valid UTF-8", label)
	}
	if !allowDirectory {
		component := lastRemotePathComponent(path)
		if err := validateFileManagerSendToComponent(component); err != nil {
			return fmt.Errorf("%s must end with a safe file name: %w", label, err)
		}
	}
	return nil
}

func validateFileManagerSendToComponent(component string) error {
	component = strings.TrimSpace(component)
	if component == "" || component == "." || component == ".." {
		return fmt.Errorf("empty or relative path component")
	}
	if len([]byte(component)) > 255 {
		return fmt.Errorf("path component is too long")
	}
	if strings.ContainsAny(component, `/\\`) {
		return fmt.Errorf("path component contains a separator")
	}
	if strings.ContainsRune(component, '\x00') || strings.ContainsFunc(component, unicode.IsControl) || containsFileManagerBidiControl(component) {
		return fmt.Errorf("path component contains unsafe control characters")
	}
	return nil
}

func fileManagerSendToTargetPath(destinationDir string, sourcePath string) (string, error) {
	name := lastRemotePathComponent(sourcePath)
	if err := validateFileManagerSendToComponent(name); err != nil {
		return "", fmt.Errorf("source file name is not safe for Send To: %w", err)
	}
	target := joinFileManagerRemotePath(destinationDir, name)
	if err := validateFileManagerUploadPath(target); err != nil {
		return "", fmt.Errorf("Send To target path is not safe: %w", err)
	}
	return target, nil
}

func parentRemotePath(path string) string {
	normalized := strings.TrimRight(strings.TrimSpace(path), `/\`)
	lastSlash := strings.LastIndex(normalized, "/")
	lastBackslash := strings.LastIndex(normalized, `\`)
	index := lastSlash
	if lastBackslash > index {
		index = lastBackslash
	}
	if index < 0 {
		return "."
	}
	if index == 0 {
		return normalized[:1]
	}
	if index == 2 && len(normalized) >= 2 && normalized[1] == ':' {
		return normalized[:2] + `\`
	}
	return normalized[:index]
}

func joinFileManagerRemotePath(directory string, name string) string {
	directory = strings.TrimSpace(directory)
	name = strings.TrimLeft(strings.TrimSpace(name), `/\\`)
	if directory == "" {
		return name
	}
	if strings.Contains(directory, `\`) && !strings.Contains(directory, "/") {
		return strings.TrimRight(directory, `\`) + `\` + name
	}
	if len(directory) == 2 && directory[1] == ':' {
		return directory + `\` + name
	}
	return pathpkg.Join(directory, name)
}

func firstString(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

func utf8String(value string) bool {
	return utf8.ValidString(value)
}
