// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package httpapi

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"log"
	"net/http"
	"os"
	pathpkg "path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"

	"shellorchestra/backend/internal/auditlog"
	"shellorchestra/backend/internal/desktopapps"
	"shellorchestra/backend/internal/domain"
	"shellorchestra/backend/internal/safecontent"
	"shellorchestra/backend/internal/scripts"
	"shellorchestra/backend/internal/streampipeline"
)

const (
	fileManagerUploadChunkMaxBytes          = 16 << 20
	fileManagerUploadTTL                    = 2 * time.Hour
	fileManagerPreviewDefaultBytes          = 256 << 10
	fileManagerPreviewMaxBytes              = 2 << 20
	fileManagerPreviewNoCompressionMaxBytes = 64 << 10
	fileManagerEditorDefaultBytes           = 8 << 20
	fileManagerEditorMaxBytes               = 32 << 20
	fileManagerPreviewMaxLineBytes          = 64 << 10
)

type fileUploadSession struct {
	mu        sync.Mutex
	ID        string
	ServerID  string
	Path      string
	Mode      string
	Overwrite bool
	Confirmed bool
	Size      int64
	Received  int64
	TempPath  string
	CreatedAt time.Time
}

func (a *App) fileManagerUploads(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if a.deps.Worker == nil {
		writeError(w, http.StatusServiceUnavailable, "SSH worker is not configured.")
		return
	}
	var body struct {
		ServerID  string `json:"server_id"`
		Path      string `json:"path"`
		Mode      string `json:"mode"`
		Overwrite bool   `json:"overwrite"`
		Confirmed bool   `json:"confirmed"`
		Size      *int64 `json:"size"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	serverID := strings.TrimSpace(body.ServerID)
	path := strings.TrimSpace(body.Path)
	if serverID == "" || path == "" {
		writeError(w, http.StatusBadRequest, "server_id and path are required.")
		return
	}
	if err := validateFileManagerUploadPath(path); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	mode := normalizeFileManagerUploadMode(body.Mode)
	if mode == "invalid" {
		writeError(w, http.StatusBadRequest, "Unsupported file upload mode.")
		return
	}
	maxUploadBytes := a.fileManagerUploadMaxBytes()
	if mode == "editor_save" && maxUploadBytes > fileManagerEditorMaxBytes {
		maxUploadBytes = fileManagerEditorMaxBytes
	}
	declaredSize, err := validateFileManagerUploadSize(body.Size, maxUploadBytes)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !body.Confirmed {
		writeError(w, http.StatusPreconditionRequired, "ShellOrchestra requires explicit confirmation before uploading a file to a managed server.")
		return
	}
	if a.deps.Audit == nil {
		writeError(w, http.StatusServiceUnavailable, "Audit log is required before uploading a file to a managed server.")
		return
	}
	uploadDir := filepath.Join(filepath.Dir(a.deps.Config.Database.Path), "file-manager-uploads")
	if err := os.MkdirAll(uploadDir, 0o700); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not prepare the upload staging directory.")
		return
	}
	tempFile, err := os.CreateTemp(uploadDir, "upload-*.bin")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create the upload staging file.")
		return
	}
	tempPath := tempFile.Name()
	_ = tempFile.Close()
	id := uuid.NewString()
	session := &fileUploadSession{ID: id, ServerID: serverID, Path: path, Mode: mode, Overwrite: body.Overwrite, Confirmed: body.Confirmed, Size: declaredSize, TempPath: tempPath, CreatedAt: time.Now().UTC()}
	a.fileUploadSessions.Store(id, session)
	a.cleanupExpiredFileUploads()
	writeJSON(w, http.StatusCreated, map[string]any{
		"upload_id": id,
		"received":  0,
		"size":      declaredSize,
	})
}

func (a *App) fileManagerUploadByID(w http.ResponseWriter, r *http.Request) {
	id, suffix := splitIDPath(strings.TrimPrefix(r.URL.Path, "/api/file-manager/uploads/"))
	if id == "" {
		http.NotFound(w, r)
		return
	}
	switch suffix {
	case "/chunk":
		a.fileManagerUploadChunk(w, r, id)
	case "/finish":
		a.fileManagerUploadFinish(w, r, id)
	case "":
		if r.Method != http.MethodDelete {
			methodNotAllowed(w)
			return
		}
		a.deleteFileUploadSession(id)
		w.WriteHeader(http.StatusNoContent)
	default:
		http.NotFound(w, r)
	}
}

func (a *App) fileManagerUploadChunk(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPut {
		methodNotAllowed(w)
		return
	}
	session, ok := a.loadFileUploadSession(w, id)
	if !ok {
		return
	}
	offset, err := strconv.ParseInt(strings.TrimSpace(r.URL.Query().Get("offset")), 10, 64)
	if err != nil || offset < 0 {
		writeError(w, http.StatusBadRequest, "Chunk offset must be a non-negative integer.")
		return
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if offset != session.Received {
		writeError(w, http.StatusConflict, fmt.Sprintf("Upload chunk offset mismatch: expected %d.", session.Received))
		return
	}
	chunkLimit := fileManagerUploadChunkLimit(session)
	if chunkLimit <= 0 {
		writeError(w, http.StatusConflict, "The upload already received the declared number of bytes.")
		return
	}
	file, err := os.OpenFile(session.TempPath, os.O_WRONLY, 0o600)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not open the upload staging file.")
		return
	}
	defer file.Close()
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not seek in the upload staging file.")
		return
	}
	reader := io.LimitReader(r.Body, chunkLimit+1)
	written, err := io.Copy(file, reader)
	if err != nil {
		_ = file.Truncate(offset)
		writeError(w, http.StatusBadRequest, "Could not read the upload chunk: "+err.Error())
		return
	}
	if written > chunkLimit {
		_ = file.Truncate(offset)
		if chunkLimit == fileManagerUploadChunkMaxBytes {
			writeError(w, http.StatusRequestEntityTooLarge, "Upload chunks must be at most 16 MiB.")
			return
		}
		writeError(w, http.StatusBadRequest, "Upload chunk exceeds the declared upload size.")
		return
	}
	session.Received += written
	writeJSON(w, http.StatusOK, map[string]any{"upload_id": id, "received": session.Received, "size": session.Size})
}

func (a *App) fileManagerUploadFinish(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	session, ok := a.loadFileUploadSession(w, id)
	if !ok {
		return
	}
	session.mu.Lock()
	ready := fileManagerUploadReady(session)
	confirmed := session.Confirmed
	serverID := session.ServerID
	path := session.Path
	mode := session.Mode
	overwrite := session.Overwrite
	received := session.Received
	size := session.Size
	tempPath := session.TempPath
	session.mu.Unlock()
	if mode == "editor_save" {
		a.fileManagerUploadFinishEditorSave(w, r, id, serverID, path, overwrite, confirmed, ready, received, size, tempPath)
		return
	}
	if !confirmed {
		writeError(w, http.StatusPreconditionRequired, "ShellOrchestra requires explicit confirmation before uploading a file to a managed server.")
		return
	}
	if a.deps.Audit == nil {
		writeError(w, http.StatusServiceUnavailable, "Audit log is required before uploading a file to a managed server.")
		return
	}
	if !ready {
		writeError(w, http.StatusConflict, "Upload is not complete yet.")
		return
	}
	requestEvent, err := a.appendFileUploadAudit(r.Context(), r, fileUploadAuditInput{
		EventType: "file.upload.requested",
		ServerID:  serverID,
		Path:      path,
		UploadID:  id,
		Overwrite: overwrite,
		Size:      size,
		Received:  received,
	})
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "Audit log is required before uploading a file to a managed server: "+err.Error())
		return
	}
	file, err := os.Open(tempPath)
	if err != nil {
		_, _ = a.appendFileUploadAudit(context.WithoutCancel(r.Context()), r, fileUploadAuditInput{
			EventType:      "file.upload.failed",
			ServerID:       serverID,
			Path:           path,
			UploadID:       id,
			Overwrite:      overwrite,
			Size:           size,
			Received:       received,
			RequestEventID: requestEvent.ID,
			Err:            err,
		})
		writeError(w, http.StatusInternalServerError, "Could not read the staged upload.")
		return
	}
	defer file.Close()
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()
	result, err := a.deps.Worker.UploadFile(ctx, serverID, path, overwrite, file, 30*time.Minute)
	if err != nil {
		_, _ = a.appendFileUploadAudit(context.WithoutCancel(r.Context()), r, fileUploadAuditInput{
			EventType:      "file.upload.failed",
			ServerID:       serverID,
			Path:           path,
			UploadID:       id,
			Overwrite:      overwrite,
			Size:           size,
			Received:       received,
			RequestEventID: requestEvent.ID,
			Err:            err,
		})
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	if !fileUploadResultOK(result) {
		_, _ = a.appendFileUploadAudit(context.WithoutCancel(r.Context()), r, fileUploadAuditInput{
			EventType:      "file.upload.failed",
			ServerID:       serverID,
			Path:           path,
			UploadID:       id,
			Overwrite:      overwrite,
			Size:           size,
			Received:       received,
			RequestEventID: requestEvent.ID,
			Result:         result,
		})
		a.deleteFileUploadSession(id)
		writeJSON(w, http.StatusOK, result)
		return
	}
	commitEvent, err := a.appendFileUploadAudit(r.Context(), r, fileUploadAuditInput{
		EventType:      "file.upload.committed",
		ServerID:       serverID,
		Path:           path,
		UploadID:       id,
		Overwrite:      overwrite,
		Size:           size,
		Received:       received,
		RequestEventID: requestEvent.ID,
		Result:         result,
	})
	if err != nil {
		a.deleteFileUploadSession(id)
		writeError(w, http.StatusInternalServerError, "The file upload completed, but ShellOrchestra could not append the audit event: "+err.Error())
		return
	}
	result["audit_event_id"] = commitEvent.ID
	result["audit_hash"] = commitEvent.Hash
	a.deleteFileUploadSession(id)
	writeJSON(w, http.StatusOK, result)
}

func normalizeFileManagerUploadMode(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "upload":
		return "upload"
	case "editor_save":
		return "editor_save"
	default:
		return "invalid"
	}
}

func (a *App) fileManagerUploadFinishEditorSave(w http.ResponseWriter, r *http.Request, uploadID string, serverID string, path string, overwrite bool, confirmed bool, ready bool, received int64, size int64, tempPath string) {
	if !confirmed {
		writeError(w, http.StatusPreconditionRequired, "ShellOrchestra requires explicit confirmation before saving a file on a managed server.")
		return
	}
	if !ready {
		writeError(w, http.StatusConflict, "Upload is not complete yet.")
		return
	}
	if size > fileManagerEditorMaxBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "Editor save content is too large for the safe versioned editor path.")
		return
	}
	afterContent, err := os.ReadFile(tempPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not read the staged editor content.")
		return
	}
	if int64(len(afterContent)) != received || int64(len(afterContent)) != size {
		writeError(w, http.StatusConflict, "The staged editor content does not match the declared upload size.")
		return
	}
	result, ok := a.fileManagerSaveBytesWithHistory(w, r, desktopapps.DataRequest{ServerID: serverID, Confirmed: confirmed, Args: map[string]string{
		"file_manager_action": "write",
		"file_manager_path":   path,
	}}, afterContent, "raw_chunk_stream", func(ctx context.Context) (map[string]any, error) {
		return a.deps.Worker.UploadFile(ctx, serverID, path, overwrite, bytes.NewReader(afterContent), 30*time.Minute)
	})
	if !ok {
		return
	}
	result["upload_id"] = uploadID
	result["streaming_binary_upload"] = true
	result["editor_save_stream"] = true
	a.deleteFileUploadSession(uploadID)
	writeJSON(w, http.StatusOK, result)
}

func (a *App) fileManagerUploadMaxBytes() int64 {
	maxBytes := a.deps.Config.Runtime.FileUploadMaxBytes
	if maxBytes <= 0 {
		return 16 << 30
	}
	return maxBytes
}

func validateFileManagerUploadSize(size *int64, maxBytes int64) (int64, error) {
	if size == nil {
		return 0, fmt.Errorf("Upload size must be declared before ShellOrchestra accepts file data.")
	}
	declared := *size
	if declared < 0 {
		return 0, fmt.Errorf("Upload size cannot be negative.")
	}
	if maxBytes <= 0 {
		return 0, fmt.Errorf("Upload size policy is not configured.")
	}
	if declared > maxBytes {
		return 0, fmt.Errorf("Upload is too large for this ShellOrchestra server. Maximum allowed size is %d bytes.", maxBytes)
	}
	return declared, nil
}

func validateFileManagerUploadPath(path string) error {
	if path == "" {
		return fmt.Errorf("upload path is required")
	}
	if len([]byte(path)) > 4096 {
		return fmt.Errorf("upload path is too long")
	}
	if strings.ContainsRune(path, '\x00') || strings.ContainsFunc(path, unicode.IsControl) || containsFileManagerBidiControl(path) {
		return fmt.Errorf("upload path contains unsafe control characters")
	}
	if strings.HasSuffix(path, "/") || strings.HasSuffix(path, `\`) {
		return fmt.Errorf("upload path must end with a file name, not a directory separator")
	}
	component := lastRemotePathComponent(path)
	if component == "" || component == "." || component == ".." || len([]byte(component)) > 255 {
		return fmt.Errorf("upload path must end with a safe file name")
	}
	return nil
}

func lastRemotePathComponent(path string) string {
	path = strings.TrimRight(path, `/\`)
	lastSlash := strings.LastIndex(path, "/")
	lastBackslash := strings.LastIndex(path, `\`)
	index := lastSlash
	if lastBackslash > index {
		index = lastBackslash
	}
	if index >= 0 {
		return path[index+1:]
	}
	return path
}

func containsFileManagerBidiControl(value string) bool {
	for _, item := range value {
		if (item >= '\u202a' && item <= '\u202e') || (item >= '\u2066' && item <= '\u2069') {
			return true
		}
	}
	return false
}

func fileManagerUploadChunkLimit(session *fileUploadSession) int64 {
	if session == nil {
		return 0
	}
	remaining := session.Size - session.Received
	if remaining <= 0 {
		return 0
	}
	if remaining < fileManagerUploadChunkMaxBytes {
		return remaining
	}
	return fileManagerUploadChunkMaxBytes
}

func fileManagerUploadReady(session *fileUploadSession) bool {
	return session != nil && session.Received == session.Size
}

type fileUploadAuditInput struct {
	EventType      string
	ServerID       string
	Path           string
	UploadID       string
	Overwrite      bool
	Size           int64
	Received       int64
	RequestEventID string
	Result         map[string]any
	Err            error
}

func (a *App) appendFileUploadAudit(ctx context.Context, r *http.Request, input fileUploadAuditInput) (auditlog.Event, error) {
	if a.deps.Audit == nil {
		return auditlog.Event{}, fmt.Errorf("audit log is not configured")
	}
	principal, _ := r.Context().Value(principalKey{}).(*domain.Principal)
	return a.deps.Audit.Append(ctx, auditlog.EventInput{
		Type:          strings.TrimSpace(input.EventType),
		ActorDeviceID: principalDeviceID(principal),
		ActorLabel:    principalLabel(principal),
		ClientIP:      sessionClientIP(r),
		ServerID:      strings.TrimSpace(input.ServerID),
		Operation:     "upload",
		Path:          strings.TrimSpace(input.Path),
		AfterHash:     fileUploadResultSHA256(input.Result),
		RequestID:     r.Header.Get("X-ShellOrchestra-Nonce"),
		Metadata:      fileUploadAuditMetadata(input),
	})
}

func fileUploadAuditMetadata(input fileUploadAuditInput) map[string]string {
	metadata := map[string]string{
		"upload_id":               strings.TrimSpace(input.UploadID),
		"overwrite":               fmt.Sprintf("%t", input.Overwrite),
		"declared_size_bytes":     strconv.FormatInt(input.Size, 10),
		"received_size_bytes":     strconv.FormatInt(input.Received, 10),
		"content_values_logged":   "false",
		"payload_values_logged":   "false",
		"streaming_binary_upload": "true",
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

func fileUploadResultOK(result map[string]any) bool {
	if result == nil {
		return false
	}
	value, ok := result["ok"].(bool)
	return ok && value
}

func fileUploadResultSHA256(result map[string]any) string {
	value := stringFromResult(result, "sha256")
	if len(value) != 64 {
		return ""
	}
	for _, item := range value {
		if (item >= 'a' && item <= 'f') || (item >= '0' && item <= '9') {
			continue
		}
		return ""
	}
	return value
}

func (a *App) readFileManagerVersionContent(ctx context.Context, serverID string, path string) ([]byte, string, error) {
	serverID = strings.TrimSpace(serverID)
	path = strings.TrimSpace(path)
	if serverID == "" || path == "" {
		return nil, "", fmt.Errorf("server id and path are required for streamed file version reads")
	}
	if strings.ContainsRune(path, '\x00') || strings.ContainsFunc(path, unicode.IsControl) || containsFileManagerBidiControl(path) {
		return nil, "", fmt.Errorf("path contains unsafe control characters")
	}
	if a.deps.Worker == nil {
		return nil, "", fmt.Errorf("SSH worker is not configured")
	}
	streamCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	response, err := a.deps.Worker.OpenFileDownloadCompressedWithLevel(streamCtx, serverID, path, 2*time.Minute, "3")
	if err != nil {
		return nil, "", err
	}
	defer response.Body.Close()
	content, _, err := streampipeline.CollectBytes(streamCtx,
		streampipeline.Source{
			Name:        "file-manager-version-before-read",
			Kind:        streampipeline.StreamKindBytes,
			Reader:      response.Body,
			Compression: streampipeline.CompressionAuto,
		},
		streampipeline.Options{
			ApplicationName: "file_manager.version_before_write",
			MaxDecodedBytes: fileManagerEditorMaxBytes,
			ChunkBytes:      64 << 10,
		},
	)
	if err != nil {
		return nil, "", err
	}
	return content, sha256Hex(content), nil
}

func (a *App) fileManagerPreviewStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	if a.deps.Worker == nil {
		writeError(w, http.StatusServiceUnavailable, "SSH worker is not configured.")
		return
	}
	serverID := strings.TrimSpace(r.URL.Query().Get("server_id"))
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if serverID == "" || path == "" {
		writeError(w, http.StatusBadRequest, "server_id and path are required.")
		return
	}
	if strings.ContainsRune(path, '\x00') || strings.ContainsFunc(path, unicode.IsControl) || containsFileManagerBidiControl(path) {
		writeError(w, http.StatusBadRequest, "path contains unsafe control characters")
		return
	}
	maxBytes := parseFileManagerPreviewLimit(r.URL.Query().Get("max_bytes"), fileManagerPreviewDefaultBytes, fileManagerPreviewMaxBytes)
	maxAllowedBytes := parseFileManagerPreviewLimit(r.URL.Query().Get("editor_max_bytes"), fileManagerEditorMaxBytes, fileManagerEditorMaxBytes)
	maxLineBytes := parseFileManagerPreviewLimit(r.URL.Query().Get("editor_max_line_bytes"), fileManagerPreviewMaxLineBytes, 4<<20)
	editorMode := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("editor_mode")))
	if editorMode != "" && editorMode != "edit" && editorMode != "safe_view" {
		writeError(w, http.StatusBadRequest, "unsupported editor preview mode")
		return
	}
	sizeHint := parseFileManagerPreviewSizeHint(r.URL.Query().Get("size"))
	typeHint := strings.TrimSpace(r.URL.Query().Get("type"))
	detectedLanguage := detectFileManagerPreviewLanguage(path, "")

	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	encoder := json.NewEncoder(w)
	flusher, _ := w.(http.Flusher)
	writeEvent := func(event map[string]any) bool {
		if err := encoder.Encode(event); err != nil {
			return false
		}
		if flusher != nil {
			flusher.Flush()
		}
		return true
	}
	if strings.EqualFold(typeHint, "directory") || strings.EqualFold(typeHint, "parent") {
		transport := fileManagerPreviewTransportFacts("directory")
		_ = writeEvent(map[string]any{
			"event":        "meta",
			"ok":           true,
			"action":       "preview",
			"path":         path,
			"type":         firstNonEmptyString(typeHint, "directory"),
			"size":         0,
			"text":         false,
			"preview_kind": "directory",
			"safe_preview": false,
			"transport":    transport,
		})
		_ = writeEvent(map[string]any{
			"event":        "done",
			"ok":           true,
			"bytes_read":   0,
			"truncated":    false,
			"preview_kind": "directory",
			"transport":    transport,
		})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	debugPreviewTransport := a.debugModeEnabled()
	compressionPreference := streamCompressionPreferenceForKnownSizePreviewRequest(r, debugPreviewTransport, sizeHint)
	compressionLevel := streamCompressionLevelForPreviewRequest(r, debugPreviewTransport)
	var response *http.Response
	var err error
	if compressionPreference == "" {
		response, err = a.deps.Worker.OpenFileDownloadCompressedWithLevel(ctx, serverID, path, 2*time.Minute, compressionLevel)
	} else {
		response, err = a.deps.Worker.OpenFileDownloadCompressedWithOptions(ctx, serverID, path, 2*time.Minute, compressionPreference, compressionLevel)
	}
	if err != nil {
		_ = writeEvent(map[string]any{
			"event": "error",
			"ok":    false,
			"error": err.Error(),
		})
		return
	}
	defer response.Body.Close()

	inspector := newFilePreviewStreamInspector(filePreviewInspectorConfig{
		Path:             path,
		TypeHint:         typeHint,
		SizeHint:         sizeHint,
		MaxBytes:         maxBytes,
		MaxAllowedBytes:  maxAllowedBytes,
		MaxLineBytes:     maxLineBytes,
		DetectedLanguage: detectedLanguage,
		EditorMode:       editorMode,
		WriteEvent:       writeEvent,
	})
	pipeline := streampipeline.New(
		streampipeline.Source{
			Name:        "file-manager-preview",
			Kind:        streampipeline.StreamKindText,
			Reader:      response.Body,
			Compression: streampipeline.CompressionAuto,
		},
		fileManagerPreviewPipelineEventSink(writeEvent),
		[]streampipeline.Processor{inspector},
		streampipeline.Options{
			ApplicationName: "file_manager.quick_preview",
			ChunkBytes:      16 << 10,
		},
	)
	if _, err := pipeline.Run(ctx); err != nil {
		_ = writeEvent(map[string]any{
			"event":      "error",
			"ok":         false,
			"error":      err.Error(),
			"bytes_read": inspector.BytesRead(),
		})
		return
	}
}

func (a *App) fileManagerEditorStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	if a.deps.Worker == nil {
		writeError(w, http.StatusServiceUnavailable, "SSH worker is not configured.")
		return
	}
	serverID := strings.TrimSpace(r.URL.Query().Get("server_id"))
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if serverID == "" || path == "" {
		writeError(w, http.StatusBadRequest, "server_id and path are required.")
		return
	}
	if strings.ContainsRune(path, '\x00') || strings.ContainsFunc(path, unicode.IsControl) || containsFileManagerBidiControl(path) {
		writeError(w, http.StatusBadRequest, "path contains unsafe control characters")
		return
	}
	maxBytes := parseFileManagerPreviewLimit(r.URL.Query().Get("max_bytes"), fileManagerEditorDefaultBytes, fileManagerEditorMaxBytes)
	maxAllowedBytes := parseFileManagerPreviewLimit(r.URL.Query().Get("editor_max_bytes"), fileManagerEditorMaxBytes, fileManagerEditorMaxBytes)
	if maxBytes > maxAllowedBytes {
		maxBytes = maxAllowedBytes
	}
	offsetBytes := parseFileManagerPreviewOffset(r.URL.Query().Get("offset"))
	maxLineBytes := parseFileManagerPreviewLimit(r.URL.Query().Get("editor_max_line_bytes"), fileManagerPreviewMaxLineBytes, 4<<20)
	sizeHint := parseFileManagerPreviewSizeHint(r.URL.Query().Get("size"))
	mode := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("mode")))
	if mode == "" {
		mode = "edit"
	}
	if mode != "edit" && mode != "safe_view" {
		writeError(w, http.StatusBadRequest, "unsupported editor stream mode")
		return
	}
	detectedLanguage := detectFileManagerPreviewLanguage(path, "")

	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	encoder := json.NewEncoder(w)
	flusher, _ := w.(http.Flusher)
	writeEvent := func(event map[string]any) bool {
		if err := encoder.Encode(event); err != nil {
			return false
		}
		if flusher != nil {
			flusher.Flush()
		}
		return true
	}

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	debugPreviewTransport := a.debugModeEnabled()
	compressionPreference := streamCompressionPreferenceForKnownSizePreviewRequest(r, debugPreviewTransport, sizeHint)
	compressionLevel := streamCompressionLevelForPreviewRequest(r, debugPreviewTransport)
	var response *http.Response
	var err error
	if compressionPreference == "" {
		response, err = a.deps.Worker.OpenFileDownloadCompressedWithLevel(ctx, serverID, path, 2*time.Minute, compressionLevel)
	} else {
		response, err = a.deps.Worker.OpenFileDownloadCompressedWithOptions(ctx, serverID, path, 2*time.Minute, compressionPreference, compressionLevel)
	}
	if err != nil {
		_ = writeEvent(map[string]any{
			"event": "error",
			"ok":    false,
			"error": err.Error(),
		})
		return
	}
	defer response.Body.Close()

	inspector := newFilePreviewStreamInspector(filePreviewInspectorConfig{
		Action:           "read",
		Path:             path,
		TypeHint:         "file",
		SizeHint:         sizeHint,
		MaxBytes:         maxBytes,
		MaxAllowedBytes:  maxAllowedBytes,
		MaxLineBytes:     maxLineBytes,
		OffsetBytes:      offsetBytes,
		DetectedLanguage: detectedLanguage,
		EditorMode:       mode,
		WriteEvent:       writeEvent,
	})
	pipeline := streampipeline.New(
		streampipeline.Source{
			Name:        "file-manager-editor",
			Kind:        streampipeline.StreamKindText,
			Reader:      response.Body,
			Compression: streampipeline.CompressionAuto,
		},
		fileManagerPreviewPipelineEventSink(writeEvent),
		[]streampipeline.Processor{inspector},
		streampipeline.Options{
			ApplicationName: "file_manager.editor",
			ChunkBytes:      16 << 10,
		},
	)
	if _, err := pipeline.Run(ctx); err != nil {
		_ = writeEvent(map[string]any{
			"event":      "error",
			"ok":         false,
			"error":      err.Error(),
			"bytes_read": inspector.BytesRead(),
		})
		return
	}
}

func (a *App) fileManagerArchiveList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	serverID := strings.TrimSpace(r.URL.Query().Get("server_id"))
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	innerPath := strings.TrimSpace(r.URL.Query().Get("inner_path"))
	maxEntries := parseFileManagerArchiveListLimit(r.URL.Query().Get("max_entries"))
	if serverID == "" {
		writeError(w, http.StatusBadRequest, "server_id is required")
		return
	}
	if err := validateFileManagerUploadPath(path); err != nil {
		writeError(w, http.StatusBadRequest, "archive path is not safe: "+err.Error())
		return
	}
	if err := validateFileManagerArchiveInnerPath(innerPath); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if a.deps.Worker == nil {
		writeError(w, http.StatusServiceUnavailable, "SSH worker is required for archive listing.")
		return
	}
	server, err := a.deps.Store.GetServer(r.Context(), serverID)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	selected, err := a.deps.Scripts.Select("file_manager_archive_list", desktopapps.TargetFactsForServer(server))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateFileManagerArchiveListManifest(selected.Command); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	result, err := a.deps.Worker.RunJSON(r.Context(), serverID, selected, map[string]string{
		"archive_path":        path,
		"archive_inner_path":  innerPath,
		"archive_max_entries": strconv.Itoa(maxEntries),
	})
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func parseFileManagerArchiveListLimit(value string) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed <= 0 {
		return 1000
	}
	if parsed > 5000 {
		return 5000
	}
	return parsed
}

func validateFileManagerArchiveInnerPath(value string) error {
	if len([]byte(value)) > 4096 {
		return fmt.Errorf("archive inner path is too long")
	}
	if strings.ContainsRune(value, '\x00') || strings.ContainsFunc(value, unicode.IsControl) || containsFileManagerBidiControl(value) {
		return fmt.Errorf("archive inner path contains unsafe control characters")
	}
	normalized := strings.ReplaceAll(value, `\`, "/")
	if strings.HasPrefix(normalized, "/") {
		return fmt.Errorf("archive inner path must be relative")
	}
	normalized = strings.Trim(normalized, "/")
	for _, component := range strings.Split(normalized, "/") {
		if component == ".." {
			return fmt.Errorf("archive inner path must not contain parent-directory segments")
		}
	}
	return nil
}

func validateFileManagerArchiveListManifest(command scripts.CommandManifest) error {
	if strings.ToLower(strings.TrimSpace(command.StreamPolicy)) != "json" {
		return fmt.Errorf("file_manager_archive_list has stream_policy %q but backend policy expected json", command.StreamPolicy)
	}
	if strings.ToLower(strings.TrimSpace(command.AppRole)) != "data" {
		return fmt.Errorf("file_manager_archive_list has app_role %q but backend policy expected data", command.AppRole)
	}
	for _, appID := range command.AppIDs {
		if strings.TrimSpace(appID) == "file_manager" {
			return nil
		}
	}
	return fmt.Errorf("file_manager_archive_list is not registered for the file_manager app")
}

type filePreviewInspectorConfig struct {
	Action           string
	Path             string
	TypeHint         string
	SizeHint         int64
	MaxBytes         int64
	MaxAllowedBytes  int64
	MaxLineBytes     int64
	OffsetBytes      int64
	DetectedLanguage string
	EditorMode       string
	WriteEvent       func(map[string]any) bool
}

func fileManagerPreviewPipelineEventSink(writeEvent func(map[string]any) bool) streampipeline.Emitter {
	return streampipeline.Emitter(func(_ context.Context, event streampipeline.Event) error {
		if event.Event != "stream_stats" {
			return nil
		}
		payload := map[string]any{"event": event.Event}
		if event.OK != nil {
			payload["ok"] = *event.OK
		}
		if event.Stats != nil {
			payload["stats"] = event.Stats
		}
		if !writeEvent(payload) {
			return io.ErrClosedPipe
		}
		return nil
	})
}

type filePreviewStreamInspector struct {
	config       filePreviewInspectorConfig
	bytesRead    int64
	lineBytes    int64
	started      bool
	done         bool
	truncated    bool
	previewKind  string
	pendingUTF8  []byte
	sample       []byte
	documentData []byte
	eventAborted bool
	sourceOffset int64
}

func newFilePreviewStreamInspector(config filePreviewInspectorConfig) *filePreviewStreamInspector {
	sourceOffset := config.OffsetBytes
	maxAllowedBytes := config.MaxAllowedBytes
	if maxAllowedBytes <= 0 {
		maxAllowedBytes = fileManagerPreviewMaxBytes
	}
	if config.MaxBytes <= 0 || config.MaxBytes > maxAllowedBytes {
		config.MaxBytes = fileManagerPreviewDefaultBytes
	}
	if config.MaxLineBytes <= 0 {
		config.MaxLineBytes = fileManagerPreviewMaxLineBytes
	}
	if strings.TrimSpace(config.DetectedLanguage) == "" {
		config.DetectedLanguage = "plaintext"
	}
	return &filePreviewStreamInspector{config: config, sourceOffset: sourceOffset}
}

func (i *filePreviewStreamInspector) BytesRead() int64 {
	if i == nil {
		return 0
	}
	return i.bytesRead
}

func (i *filePreviewStreamInspector) Name() string {
	return "file-manager-preview-inspector"
}

func (i *filePreviewStreamInspector) OnStart(context.Context, streampipeline.Source, streampipeline.EventSink) error {
	return nil
}

func (i *filePreviewStreamInspector) OnChunk(_ context.Context, chunk []byte, _ streampipeline.EventSink) (streampipeline.Decision, error) {
	if i == nil {
		return streampipeline.Decision{Stop: true, Reason: "preview inspector is not available"}, nil
	}
	if i.config.OffsetBytes > 0 {
		if int64(len(chunk)) <= i.config.OffsetBytes {
			i.config.OffsetBytes -= int64(len(chunk))
			return streampipeline.Decision{}, nil
		}
		chunk = chunk[i.config.OffsetBytes:]
		i.config.OffsetBytes = 0
	}
	if i.bytesRead >= i.config.MaxBytes {
		i.truncated = true
		return streampipeline.Decision{Stop: true, Reason: "preview byte cap reached"}, nil
	}
	remaining := i.config.MaxBytes - i.bytesRead
	if remaining <= 0 {
		i.truncated = true
		return streampipeline.Decision{Stop: true, Reason: "preview byte cap reached"}, nil
	}
	if int64(len(chunk)) > remaining {
		chunk = chunk[:remaining]
		i.truncated = true
	}
	if len(chunk) > 0 {
		if err := i.accept(chunk); err != nil {
			return streampipeline.Decision{}, err
		}
	}
	if i.eventAborted {
		return streampipeline.Decision{Stop: true, Reason: "preview inspector stopped stream"}, nil
	}
	if i.bytesRead >= i.config.MaxBytes {
		i.truncated = true
		return streampipeline.Decision{Stop: true, Reason: "preview byte cap reached"}, nil
	}
	return streampipeline.Decision{}, nil
}

func (i *filePreviewStreamInspector) OnFinish(context.Context, streampipeline.Stats, streampipeline.EventSink) error {
	return i.finish()
}

func (i *filePreviewStreamInspector) finish() error {
	if i == nil || i.done || i.eventAborted {
		return nil
	}
	if len(i.pendingUTF8) > 0 {
		if !utf8.Valid(i.pendingUTF8) {
			return fmt.Errorf("ShellOrchestra stopped this preview because the file is not valid UTF-8 text.")
		}
		if err := i.emitText(string(i.pendingUTF8)); err != nil {
			return err
		}
		i.pendingUTF8 = nil
	}
	if !i.started {
		i.previewKind = i.kindFromSample()
		if !i.writeMeta() {
			return nil
		}
	}
	i.emitDone()
	return nil
}

func (i *filePreviewStreamInspector) accept(data []byte) error {
	i.bytesRead += int64(len(data))
	if len(i.sample) < 4096 {
		need := 4096 - len(i.sample)
		if len(data) < need {
			need = len(data)
		}
		i.sample = append(i.sample, data[:need]...)
	}
	if !i.started {
		i.previewKind = i.kindFromSample()
		if !i.writeMeta() {
			i.eventAborted = true
			return nil
		}
		if i.previewKind != "text" {
			i.acceptDocumentPreviewBytes(data)
			if !i.shouldDrainNonTextPreview() {
				i.emitDone()
				i.eventAborted = true
			}
			return nil
		}
	}
	if i.previewKind != "text" {
		i.acceptDocumentPreviewBytes(data)
		return nil
	}
	if bytes.IndexByte(data, 0) >= 0 {
		return fmt.Errorf("ShellOrchestra stopped this preview because the file contains NUL bytes.")
	}
	return i.acceptTextBytes(data)
}

func (i *filePreviewStreamInspector) shouldDrainNonTextPreview() bool {
	if i.config.SizeHint <= 0 {
		return false
	}
	if i.config.SizeHint > i.config.MaxBytes {
		return false
	}
	return i.config.SizeHint <= fileManagerPreviewMaxBytes
}

func (i *filePreviewStreamInspector) acceptDocumentPreviewBytes(data []byte) {
	if i == nil || (i.previewKind != "pdf" && i.previewKind != "document" && i.previewKind != "spreadsheet") || len(data) == 0 {
		return
	}
	limit := int(fileManagerPreviewMaxBytes)
	if i.config.MaxBytes > 0 && i.config.MaxBytes < int64(limit) {
		limit = int(i.config.MaxBytes)
	}
	if len(i.documentData) >= limit {
		return
	}
	remaining := limit - len(i.documentData)
	if len(data) > remaining {
		data = data[:remaining]
	}
	i.documentData = append(i.documentData, data...)
}

func (i *filePreviewStreamInspector) emitDone() {
	if i == nil || i.done {
		return
	}
	if (i.previewKind == "pdf" || i.previewKind == "document" || i.previewKind == "spreadsheet") && len(i.documentData) > 0 {
		text := safeDocumentPreviewText(i.config.Path, i.previewKind, i.documentData, i.config.MaxBytes)
		if strings.TrimSpace(text) != "" {
			_ = i.emitText(text)
		}
	}
	i.done = true
	i.config.WriteEvent(map[string]any{
		"event":        "done",
		"ok":           true,
		"bytes_read":   i.bytesRead,
		"offset":       i.sourceOffset,
		"next_offset":  i.sourceOffset + i.bytesRead,
		"truncated":    i.truncated,
		"preview_kind": i.previewKind,
		"transport":    fileManagerPreviewTransportFacts(i.previewKind),
	})
}

func (i *filePreviewStreamInspector) acceptTextBytes(data []byte) error {
	combined := append(i.pendingUTF8, data...)
	i.pendingUTF8 = i.pendingUTF8[:0]
	var builder strings.Builder
	for len(combined) > 0 {
		r, size := utf8.DecodeRune(combined)
		if r == utf8.RuneError && size == 1 {
			if !utf8.FullRune(combined) {
				i.pendingUTF8 = append(i.pendingUTF8, combined...)
				break
			}
			return fmt.Errorf("ShellOrchestra stopped this preview because the file is not valid UTF-8 text.")
		}
		combined = combined[size:]
		switch r {
		case '\n':
			i.lineBytes = 0
			builder.WriteRune(r)
			continue
		case '\r', '\t':
			i.lineBytes += int64(size)
			builder.WriteRune(r)
			continue
		}
		if r < 0x20 || r == 0x7f || isFileManagerBidiOrInvisibleControl(r) {
			continue
		}
		i.lineBytes += int64(size)
		if i.lineBytes > i.config.MaxLineBytes {
			return fmt.Errorf("ShellOrchestra stopped this preview because a line exceeds %d bytes.", i.config.MaxLineBytes)
		}
		builder.WriteRune(r)
	}
	if builder.Len() == 0 {
		return nil
	}
	return i.emitText(builder.String())
}

func (i *filePreviewStreamInspector) emitText(content string) error {
	if content == "" {
		return nil
	}
	if !i.config.WriteEvent(map[string]any{"event": "chunk", "content": content}) {
		return io.ErrClosedPipe
	}
	return nil
}

func (i *filePreviewStreamInspector) writeMeta() bool {
	i.started = true
	return i.config.WriteEvent(map[string]any{
		"event":             "meta",
		"ok":                true,
		"action":            firstNonEmptyString(i.config.Action, "preview"),
		"path":              i.config.Path,
		"type":              firstNonEmptyString(i.config.TypeHint, "file"),
		"size":              i.config.SizeHint,
		"text":              i.previewKind == "text" || i.previewKind == "pdf" || i.previewKind == "document" || i.previewKind == "spreadsheet",
		"encoding":          "utf-8",
		"detected_language": i.config.DetectedLanguage,
		"preview_kind":      i.previewKind,
		"mime":              fileManagerPreviewMime(i.config.Path, i.previewKind),
		"safe_preview":      i.previewKind == "text" || i.previewKind == "image" || i.previewKind == "pdf" || i.previewKind == "document" || i.previewKind == "spreadsheet",
		"offset":            i.sourceOffset,
		"editor_mode":       i.editorModeForPreview(),
		"editor_safe":       i.previewKind == "text",
		"editor_sanitized":  i.previewKind == "pdf" || i.previewKind == "document" || i.previewKind == "spreadsheet",
		"editor_reason":     i.editorReasonForPreview(),
		"transport":         fileManagerPreviewTransportFacts(i.previewKind),
	})
}

func (i *filePreviewStreamInspector) editorModeForPreview() string {
	if i.previewKind == "pdf" || i.previewKind == "document" || i.previewKind == "spreadsheet" || i.previewKind == "image" || i.previewKind == "binary" {
		return "blocked"
	}
	if i.config.EditorMode == "safe_view" {
		return "read_only"
	}
	if i.config.SizeHint > 0 && i.config.MaxAllowedBytes > 0 && i.config.SizeHint > i.config.MaxAllowedBytes {
		return "read_only"
	}
	if i.previewKind == "text" {
		return "editable"
	}
	return "unknown"
}

func (i *filePreviewStreamInspector) editorReasonForPreview() string {
	if i.previewKind == "pdf" || i.previewKind == "document" || i.previewKind == "spreadsheet" {
		return "This file is shown through a simplified safe preview and is not opened in the code editor."
	}
	if i.previewKind == "image" || i.previewKind == "binary" {
		return "ShellOrchestra does not open binary content in the code editor."
	}
	if i.config.SizeHint > 0 && i.config.MaxAllowedBytes > 0 && i.config.SizeHint > i.config.MaxAllowedBytes {
		return fmt.Sprintf("This file is larger than the browser editor safety limit (%d bytes), so ShellOrchestra opens it read-only in bounded chunks.", i.config.MaxAllowedBytes)
	}
	if i.config.EditorMode == "safe_view" {
		return "This file is opened in safe read-only mode."
	}
	return "Quick Preview is streamed through backend safety inspection. Opening the editor runs a separate stricter editor preflight before editing."
}

func (i *filePreviewStreamInspector) kindFromSample() string {
	typeHint := strings.TrimSpace(i.config.TypeHint)
	if strings.EqualFold(typeHint, "directory") || strings.EqualFold(typeHint, "parent") {
		return "directory"
	}
	sample := i.sample
	if len(sample) >= 8 && bytes.HasPrefix(sample, []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}) {
		return "image"
	}
	if len(sample) >= 3 && sample[0] == 0xff && sample[1] == 0xd8 && sample[2] == 0xff {
		return "image"
	}
	if len(sample) >= 6 && (bytes.HasPrefix(sample, []byte("GIF87a")) || bytes.HasPrefix(sample, []byte("GIF89a"))) {
		return "image"
	}
	if len(sample) >= 12 && bytes.HasPrefix(sample, []byte("RIFF")) && bytes.Equal(sample[8:12], []byte("WEBP")) {
		return "image"
	}
	if bytes.HasPrefix(sample, []byte("%PDF")) {
		return "pdf"
	}
	if safecontent.IsSpreadsheetPath(i.config.Path) {
		return "spreadsheet"
	}
	if isFileManagerDocumentPath(i.config.Path) {
		return "document"
	}
	if bytes.IndexByte(sample, 0) >= 0 {
		return "binary"
	}
	if binaryControlRatio(sample) > 20 {
		return "binary"
	}
	return "text"
}

func safeDocumentPreviewText(path string, kind string, data []byte, maxBytes int64) string {
	if maxBytes <= 0 || maxBytes > fileManagerPreviewMaxBytes {
		maxBytes = fileManagerPreviewDefaultBytes
	}
	options := safecontent.DefaultOptions()
	options.MaxInputBytes = int(maxBytes)
	options.MaxOutputBytes = int(maxBytes)
	options.MaxZipEntryBytes = int(maxBytes)
	options.MaxZipTotalBytes = int(maxBytes) * 8
	if safecontent.IsSpreadsheetPath(path) {
		workbook, err := safecontent.ParseSpreadsheet(path, data, options)
		if err != nil {
			return "Safe spreadsheet preview could not read this file structure. Download the original only if you trust this file."
		}
		text := safecontent.RenderSpreadsheetText(workbook, int(maxBytes))
		if strings.TrimSpace(text) == "" {
			return "No readable spreadsheet cells were found in the bounded safe preview."
		}
		return text
	}
	document, err := safecontent.ParseDocument(path, data, options)
	if err != nil {
		return "Safe document preview could not read this file structure. Download the original only if you trust this file."
	}
	text := safecontent.RenderDocumentText(document, int(maxBytes))
	if strings.TrimSpace(text) == "" {
		return "No readable text was found in the bounded safe preview."
	}
	return text
}

func documentFamilyForPath(value string) string {
	lower := strings.ToLower(value)
	switch {
	case strings.HasSuffix(lower, ".docx"):
		return "word-ooxml"
	case strings.HasSuffix(lower, ".xlsx"):
		return "spreadsheet-ooxml"
	case strings.HasSuffix(lower, ".pptx"):
		return "presentation-ooxml"
	case strings.HasSuffix(lower, ".odt"):
		return "word-opendocument"
	case strings.HasSuffix(lower, ".ods"):
		return "spreadsheet-opendocument"
	case strings.HasSuffix(lower, ".odp"):
		return "presentation-opendocument"
	case strings.HasSuffix(lower, ".rtf"):
		return "rich-text"
	case strings.HasSuffix(lower, ".doc"):
		return "legacy-word"
	case strings.HasSuffix(lower, ".xls"):
		return "legacy-spreadsheet"
	case strings.HasSuffix(lower, ".ppt"):
		return "legacy-presentation"
	default:
		return "document"
	}
}

func zipDocumentPreviewText(data []byte, family string, maxBytes int) string {
	if len(data) == 0 || maxBytes <= 0 {
		return ""
	}
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "Safe document text preview could not read the archive structure. Download the original only if you trust this file."
	}
	patterns := zipDocumentPatterns(family)
	if len(patterns) == 0 {
		return ""
	}
	var builder strings.Builder
	for _, file := range reader.File {
		if builder.Len() >= maxBytes {
			break
		}
		if !zipDocumentNameMatches(file.Name, patterns) {
			continue
		}
		if file.UncompressedSize64 > uint64(maxBytes*8) {
			continue
		}
		handle, err := file.Open()
		if err != nil {
			continue
		}
		chunk, _ := io.ReadAll(io.LimitReader(handle, int64(maxBytes-builder.Len()+1)))
		_ = handle.Close()
		if len(chunk) == 0 {
			continue
		}
		plain := xmlPreviewText(string(chunk))
		if strings.TrimSpace(plain) == "" {
			continue
		}
		if builder.Len() > 0 {
			builder.WriteByte('\n')
		}
		builder.WriteString(plain)
	}
	return builder.String()
}

func zipDocumentPatterns(family string) []string {
	switch family {
	case "word-ooxml":
		return []string{"word/document.xml", "word/header*.xml", "word/footer*.xml", "word/footnotes.xml", "word/endnotes.xml"}
	case "spreadsheet-ooxml":
		return []string{"xl/sharedStrings.xml", "xl/workbook.xml", "xl/worksheets/sheet*.xml"}
	case "presentation-ooxml":
		return []string{"ppt/slides/slide*.xml", "ppt/notesSlides/notesSlide*.xml"}
	case "word-opendocument", "spreadsheet-opendocument", "presentation-opendocument":
		return []string{"content.xml", "meta.xml", "styles.xml"}
	default:
		return nil
	}
}

func zipDocumentNameMatches(name string, patterns []string) bool {
	clean := strings.TrimLeft(strings.ReplaceAll(name, "\\", "/"), "/")
	for _, pattern := range patterns {
		matched, err := pathpkg.Match(pattern, clean)
		if err == nil && matched {
			return true
		}
	}
	return false
}

func xmlPreviewText(value string) string {
	var builder strings.Builder
	inTag := false
	for _, item := range value {
		switch item {
		case '<':
			inTag = true
			builder.WriteByte(' ')
		case '>':
			inTag = false
			builder.WriteByte(' ')
		default:
			if !inTag {
				builder.WriteRune(item)
			}
		}
	}
	return html.UnescapeString(builder.String())
}

func rtfPreviewText(data []byte, maxBytes int) string {
	value := strings.ToValidUTF8(string(data), "")
	var builder strings.Builder
	for index := 0; index < len(value); index++ {
		item := value[index]
		if item == '\\' {
			if strings.HasPrefix(value[index:], `\par`) {
				builder.WriteByte('\n')
				index += len(`\par`) - 1
				continue
			}
			if strings.HasPrefix(value[index:], `\tab`) {
				builder.WriteByte(' ')
				index += len(`\tab`) - 1
				continue
			}
			for index+1 < len(value) {
				next := value[index+1]
				if (next >= 'A' && next <= 'Z') || (next >= 'a' && next <= 'z') || (next >= '0' && next <= '9') || next == '-' {
					index++
					continue
				}
				if next == ' ' {
					index++
				}
				break
			}
			continue
		}
		if item == '{' || item == '}' {
			continue
		}
		builder.WriteByte(item)
		if builder.Len() >= maxBytes {
			break
		}
	}
	return builder.String()
}

func printableStringsFromBytes(data []byte, maxBytes int) string {
	if maxBytes <= 0 {
		return ""
	}
	var builder strings.Builder
	var run strings.Builder
	flush := func() {
		if run.Len() >= 4 {
			if builder.Len() > 0 {
				builder.WriteByte('\n')
			}
			builder.WriteString(run.String())
		}
		run.Reset()
	}
	for _, item := range data {
		if item == '\n' || item == '\r' || item == '\t' || (item >= 0x20 && item <= 0x7e) {
			run.WriteByte(item)
		} else {
			flush()
		}
		if builder.Len()+run.Len() >= maxBytes {
			break
		}
	}
	flush()
	return builder.String()
}

func sanitizeDerivedPreviewText(value string, maxBytes int) string {
	if maxBytes <= 0 {
		maxBytes = int(fileManagerPreviewDefaultBytes)
	}
	value = strings.ToValidUTF8(value, "")
	var builder strings.Builder
	spacePending := false
	lineBreakPending := false
	for _, item := range value {
		if builder.Len() >= maxBytes {
			break
		}
		switch item {
		case '\r', '\n':
			if builder.Len() > 0 {
				lineBreakPending = true
				spacePending = false
			}
			continue
		case '\t', ' ':
			spacePending = true
			continue
		}
		if item < 0x20 || item == 0x7f || isFileManagerBidiOrInvisibleControl(item) {
			continue
		}
		if lineBreakPending {
			builder.WriteByte('\n')
			lineBreakPending = false
		} else if spacePending && builder.Len() > 0 {
			builder.WriteByte(' ')
		}
		spacePending = false
		builder.WriteRune(item)
	}
	return strings.TrimSpace(builder.String())
}

func parseFileManagerPreviewLimit(value string, fallback int64, maxValue int64) int64 {
	parsed, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil || parsed <= 0 {
		return fallback
	}
	if parsed > maxValue {
		return maxValue
	}
	return parsed
}

func parseFileManagerPreviewOffset(value string) int64 {
	parsed, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil || parsed < 0 {
		return 0
	}
	return parsed
}

func parseFileManagerPreviewSizeHint(value string) int64 {
	parsed, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil || parsed < 0 {
		return 0
	}
	return parsed
}

func binaryControlRatio(data []byte) int {
	if len(data) == 0 {
		return 0
	}
	bad := 0
	for _, item := range data {
		if item == '\n' || item == '\r' || item == '\t' {
			continue
		}
		if item < 0x20 || item == 0x7f {
			bad++
		}
	}
	return bad * 100 / len(data)
}

func isFileManagerBidiOrInvisibleControl(r rune) bool {
	return (r >= '\u202a' && r <= '\u202e') || (r >= '\u2066' && r <= '\u2069') || r == '\u200b' || r == '\u200c' || r == '\u200d' || r == '\u2060'
}

func isFileManagerDocumentPath(path string) bool {
	lower := strings.ToLower(path)
	for _, suffix := range []string{".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".tsv", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".rtf"} {
		if strings.HasSuffix(lower, suffix) {
			return true
		}
	}
	return false
}

func fileManagerPreviewMime(path string, kind string) string {
	switch kind {
	case "text":
		return "text/plain; charset=utf-8"
	case "image":
		lower := strings.ToLower(path)
		switch {
		case strings.HasSuffix(lower, ".png"):
			return "image/png"
		case strings.HasSuffix(lower, ".jpg"), strings.HasSuffix(lower, ".jpeg"):
			return "image/jpeg"
		case strings.HasSuffix(lower, ".gif"):
			return "image/gif"
		case strings.HasSuffix(lower, ".webp"):
			return "image/webp"
		default:
			return "image/*"
		}
	case "pdf":
		return "application/pdf"
	case "document":
		return "application/octet-stream"
	case "spreadsheet":
		return "application/octet-stream"
	default:
		return "application/octet-stream"
	}
}

func streamCompressionPreferenceForPreviewRequest(r *http.Request, debugEnabled bool) string {
	if r == nil || !debugEnabled {
		return ""
	}
	return strings.TrimSpace(r.URL.Query().Get("stream_compression"))
}

func streamCompressionPreferenceForKnownSizePreviewRequest(r *http.Request, debugEnabled bool, sizeHint int64) string {
	if explicit := streamCompressionPreferenceForPreviewRequest(r, debugEnabled); strings.TrimSpace(explicit) != "" {
		return explicit
	}
	if sizeHint > 0 && sizeHint <= fileManagerPreviewNoCompressionMaxBytes {
		return "none"
	}
	return ""
}

func streamCompressionLevelForPreviewRequest(r *http.Request, debugEnabled bool) string {
	if r == nil || !debugEnabled {
		return ""
	}
	return strings.TrimSpace(r.URL.Query().Get("stream_compression_level"))
}

func fileManagerPreviewTransportFacts(kind string) map[string]any {
	return map[string]any{
		"backend_remote_transport": "raw worker binary stream from managed SSH server",
		"browser_transport":        "streaming NDJSON with UTF-8 text chunks and metadata events",
		"compression":              "remote stream may use zstd, gzip, or none; backend decodes before safety inspection; browser response uses standard HTTP compression when accepted",
		"binary_stream":            true,
		"base64_payload":           false,
		"streaming_inspection":     kind == "text",
	}
}

func detectFileManagerPreviewLanguage(path string, firstLine string) string {
	lowerPath := strings.ToLower(strings.ReplaceAll(path, "\\", "/"))
	base := filepath.Base(lowerPath)
	line := strings.ToLower(strings.TrimSpace(firstLine))
	if strings.HasPrefix(line, "#!") {
		switch {
		case strings.Contains(line, "python"):
			return "python"
		case strings.Contains(line, "node"), strings.Contains(line, "deno"):
			return "javascript"
		case strings.Contains(line, "pwsh"), strings.Contains(line, "powershell"):
			return "powershell"
		default:
			return "shell"
		}
	}
	switch {
	case strings.HasSuffix(base, ".sh"), base == ".bashrc", base == "bashrc", base == ".zshrc", base == "zshrc", base == ".profile", base == "profile":
		return "shell"
	case strings.HasSuffix(base, ".ps1"):
		return "powershell"
	case strings.HasSuffix(base, ".py"):
		return "python"
	case strings.HasSuffix(base, ".js"), strings.HasSuffix(base, ".jsx"), strings.HasSuffix(base, ".mjs"), strings.HasSuffix(base, ".cjs"):
		return "javascript"
	case strings.HasSuffix(base, ".ts"), strings.HasSuffix(base, ".tsx"):
		return "typescript"
	case strings.HasSuffix(base, ".json"), strings.HasSuffix(base, ".jsonc"):
		return "json"
	case strings.HasSuffix(base, ".yaml"), strings.HasSuffix(base, ".yml"):
		return "yaml"
	case strings.HasSuffix(base, ".md"), strings.HasSuffix(base, ".markdown"):
		return "markdown"
	case strings.HasSuffix(base, ".go"):
		return "go"
	case strings.HasSuffix(base, ".css"):
		return "css"
	case strings.HasSuffix(base, ".html"), strings.HasSuffix(base, ".htm"), strings.HasSuffix(base, ".jinja"), strings.HasSuffix(base, ".j2"):
		return "html"
	case strings.HasSuffix(base, ".toml"):
		return "toml"
	case strings.HasSuffix(base, ".xml"), strings.HasSuffix(base, ".plist"):
		return "xml"
	case strings.HasSuffix(base, ".ini"), strings.HasSuffix(base, ".cnf"), strings.HasSuffix(base, ".cfg"), strings.HasSuffix(base, ".conf"):
		return "ini"
	case strings.Contains(lowerPath, "/etc/sudoers"):
		return "sudoers"
	case strings.Contains(lowerPath, "/etc/cron") || base == "crontab":
		return "crontab"
	case strings.Contains(lowerPath, "/etc/systemd/") || strings.HasSuffix(base, ".service") || strings.HasSuffix(base, ".timer"):
		return "systemd"
	case strings.Contains(lowerPath, "/.ssh/config") || base == "ssh_config" || base == "sshd_config":
		return "sshconfig"
	case strings.Contains(lowerPath, "/.ssh/authorized_keys") || base == "authorized_keys" || base == "known_hosts":
		return "sshkeys"
	case base == "hosts":
		return "hosts"
	case base == "fstab":
		return "fstab"
	case base == "passwd" || base == "group" || base == "shadow":
		return "passwd"
	default:
		return "plaintext"
	}
}

func (a *App) fileManagerDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	if a.deps.Worker == nil {
		writeError(w, http.StatusServiceUnavailable, "SSH worker is not configured.")
		return
	}
	serverID := strings.TrimSpace(r.URL.Query().Get("server_id"))
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if serverID == "" || path == "" {
		writeError(w, http.StatusBadRequest, "server_id and path are required.")
		return
	}
	if strings.ContainsRune(path, '\x00') || strings.ContainsFunc(path, unicode.IsControl) || containsFileManagerBidiControl(path) {
		writeError(w, http.StatusBadRequest, "path contains unsafe control characters")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()
	response, err := a.openFileDownloadCompressedWithRetry(ctx, serverID, path, 30*time.Minute, "3")
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer response.Body.Close()
	name := filepath.Base(path)
	if name == "." || name == string(filepath.Separator) || strings.TrimSpace(name) == "" {
		name = "download.bin"
	}
	var headersWritten bool
	var writtenBytes int64
	writeDownloadHeaders := func() {
		if headersWritten {
			return
		}
		headersWritten = true
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", "attachment; filename="+strconv.Quote(name))
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
	}
	flusher, _ := w.(http.Flusher)
	processor := streampipeline.ProcessorHooks{
		ProcessorName: "file-manager-browser-download-writer",
		Chunk: func(ctx context.Context, chunk []byte, emit streampipeline.EventSink) (streampipeline.Decision, error) {
			if err := ctx.Err(); err != nil {
				return streampipeline.Decision{Stop: true, Reason: "download cancelled"}, err
			}
			writeDownloadHeaders()
			n, err := w.Write(chunk)
			if n > 0 {
				writtenBytes += int64(n)
			}
			if flusher != nil {
				flusher.Flush()
			}
			if err != nil {
				return streampipeline.Decision{}, err
			}
			if n != len(chunk) {
				return streampipeline.Decision{}, io.ErrShortWrite
			}
			return streampipeline.Decision{}, nil
		},
		Finish: func(ctx context.Context, stats streampipeline.Stats, emit streampipeline.EventSink) error {
			writeDownloadHeaders()
			if flusher != nil {
				flusher.Flush()
			}
			return nil
		},
	}
	pipeline := streampipeline.New(
		streampipeline.Source{
			Name:        "file-manager-browser-download",
			Kind:        streampipeline.StreamKindBytes,
			Reader:      response.Body,
			Compression: streampipeline.CompressionAuto,
		},
		nil,
		[]streampipeline.Processor{processor},
		streampipeline.Options{ApplicationName: "file_manager.browser_download", ChunkBytes: 64 << 10},
	)
	if _, err := pipeline.Run(ctx); err != nil {
		if !headersWritten {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		log.Printf("ShellOrchestra file manager browser download ended after streaming started server_id=%q path=%q bytes=%d err=%v", serverID, path, writtenBytes, err)
		return
	}
}

func (a *App) openFileDownloadCompressedWithRetry(ctx context.Context, serverID string, path string, timeout time.Duration, level string) (*http.Response, error) {
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		response, err := a.deps.Worker.OpenFileDownloadCompressedWithLevel(ctx, serverID, path, timeout, level)
		if err == nil {
			if attempt > 0 {
				log.Printf("ShellOrchestra file manager browser download recovered after retry server_id=%q path=%q", serverID, path)
			}
			return response, nil
		}
		lastErr = err
		if attempt > 0 || !isRetryableFileDownloadOpenError(err) {
			return nil, err
		}
		log.Printf("ShellOrchestra file manager browser download worker stream open failed with retryable transport error; retrying once server_id=%q path=%q err=%v", serverID, path, err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(150 * time.Millisecond):
		}
	}
	return nil, lastErr
}

func isRetryableFileDownloadOpenError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "status code 0") ||
		strings.Contains(message, "unexpected eof") ||
		strings.Contains(message, "connection aborted") ||
		strings.Contains(message, "connection closed") ||
		strings.Contains(message, "connection reset by peer") ||
		strings.Contains(message, "broken pipe") ||
		strings.Contains(message, "use of closed network connection")
}

func (a *App) loadFileUploadSession(w http.ResponseWriter, id string) (*fileUploadSession, bool) {
	value, ok := a.fileUploadSessions.Load(id)
	if !ok {
		writeError(w, http.StatusNotFound, "Upload session was not found or has expired.")
		return nil, false
	}
	session, ok := value.(*fileUploadSession)
	if !ok || time.Since(session.CreatedAt) > fileManagerUploadTTL {
		a.deleteFileUploadSession(id)
		writeError(w, http.StatusNotFound, "Upload session was not found or has expired.")
		return nil, false
	}
	return session, true
}

func (a *App) deleteFileUploadSession(id string) {
	value, ok := a.fileUploadSessions.LoadAndDelete(id)
	if !ok {
		return
	}
	if session, ok := value.(*fileUploadSession); ok && session.TempPath != "" {
		_ = os.Remove(session.TempPath)
	}
}

func (a *App) cleanupExpiredFileUploads() {
	now := time.Now()
	a.fileUploadSessions.Range(func(key any, value any) bool {
		session, ok := value.(*fileUploadSession)
		if !ok || now.Sub(session.CreatedAt) > fileManagerUploadTTL {
			if id, ok := key.(string); ok {
				a.deleteFileUploadSession(id)
			}
		}
		return true
	})
}
