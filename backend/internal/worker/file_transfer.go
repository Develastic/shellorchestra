// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package worker

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"shellorchestra/backend/internal/domain"
	"shellorchestra/backend/internal/internaljson"
	runtimepkg "shellorchestra/backend/internal/runtime"
	"shellorchestra/backend/internal/scripts"
)

const (
	fileManagerUploadStreamCommand          = "file_manager_upload_stream"
	fileManagerDownloadStreamCommand        = "file_manager_download_stream"
	fileManagerArchiveDownloadStreamCommand = "file_manager_archive_download_stream"
	fileManagerArchiveUploadStreamCommand   = "file_manager_archive_upload_stream"
	fileTransferHeaderServerID              = "X-ShellOrchestra-Server-ID"
	fileTransferHeaderPathB64               = "X-ShellOrchestra-Remote-Path-B64"
	fileTransferHeaderSourceParentB64       = "X-ShellOrchestra-Source-Parent-B64"
	fileTransferHeaderSourceNamesB64        = "X-ShellOrchestra-Source-Names-B64"
	fileTransferHeaderOverwrite             = "X-ShellOrchestra-Overwrite"
	fileTransferHeaderCompression           = "X-ShellOrchestra-Stream-Compression"
	fileTransferHeaderCompressionLvl        = "X-ShellOrchestra-Stream-Compression-Level"
	maxFileTransferPathBytes                = 32 << 10
	maxFileTransferNameListBytes            = 128 << 10
	maxFileTransferJSONResponseBytes        = 1 << 20
)

const (
	streamCompressionNone         = "none"
	streamCompressionPreference   = "zstd,gzip,none"
	streamCompressionDefaultLevel = "3"
)

func (s *Server) fileUploadStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	serverID := strings.TrimSpace(r.Header.Get(fileTransferHeaderServerID))
	path, err := fileTransferPathFromHeader(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	server, selected, err := s.fileTransferScript(r.Context(), serverID, fileManagerUploadStreamCommand)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	command, err := scripts.RemoteStreamCommandForVariantWithArgs(selected, map[string]string{
		"file_manager_path":      path,
		"file_manager_overwrite": normalizeBoolHeader(r.Header.Get(fileTransferHeaderOverwrite)),
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	stdout := limitedBytesWriter{limit: 1 << 20}
	stderr := &limitedStringWriter{limit: 4000}
	ctx, cancel := context.WithTimeout(r.Context(), selected.Timeout+30*time.Second)
	defer cancel()
	if err := s.runtime.RunStreamServer(ctx, server, command, r.Body, &stdout, stderr); err != nil {
		writeError(w, http.StatusBadGateway, fileTransferError(err, stderr.String()))
		return
	}
	if err := stdout.Err("stdout"); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	var result map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		writeError(w, http.StatusBadGateway, "Upload finished, but the remote helper returned invalid JSON.")
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) fileDownloadStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	serverID := strings.TrimSpace(r.Header.Get(fileTransferHeaderServerID))
	path, err := fileTransferPathFromHeader(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	server, selected, err := s.fileTransferScript(r.Context(), serverID, fileManagerDownloadStreamCommand)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	compression := normalizeStreamCompressionPreference(r.Header.Get(fileTransferHeaderCompression))
	compressionLevel := normalizeStreamCompressionLevel(r.Header.Get(fileTransferHeaderCompressionLvl))
	command, err := scripts.RemoteStreamCommandForVariantWithArgs(selected, map[string]string{
		"file_manager_path":                path,
		"stream_output_compression":        compression,
		"stream_compression_preferences":   compression,
		"stream_output_compression_level":  compressionLevel,
		"stream_compression_default_level": compressionLevel,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	stderr := &limitedStringWriter{limit: 4000}
	ctx, cancel := context.WithTimeout(r.Context(), selected.Timeout+30*time.Second)
	defer cancel()
	stream := &safeHTTPStreamWriter{w: w}
	if flusher, ok := w.(http.Flusher); ok {
		stream.flusher = flusher
	}
	if err := s.runtime.RunStreamServer(ctx, server, command, nil, stream, stderr); err != nil {
		detail := fileTransferError(err, stderr.String())
		if stream.Wrote() || stream.Err() != nil {
			if errors.Is(err, context.Canceled) {
				return
			}
			log.Printf("ShellOrchestra worker file download stream ended after response streaming started server_id=%q path=%q err=%v write_err=%v", serverID, path, detail, stream.Err())
			return
		}
		log.Printf("ShellOrchestra worker file download stream failed before response streaming server_id=%q path=%q err=%v", serverID, path, detail)
		http.Error(w, detail, http.StatusBadGateway)
		return
	}
	if err := stream.Err(); err != nil {
		log.Printf("ShellOrchestra worker file download stream write failed server_id=%q path=%q err=%v", serverID, path, err)
	}
}

func (s *Server) fileArchiveDownloadStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	serverID := strings.TrimSpace(r.Header.Get(fileTransferHeaderServerID))
	sourceParent, err := fileTransferPathFromNamedHeader(r, fileTransferHeaderSourceParentB64, "source parent")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	sourceNames, err := fileTransferNamesFromHeader(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	server, selected, err := s.fileTransferScript(r.Context(), serverID, fileManagerArchiveDownloadStreamCommand)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	compression := normalizeStreamCompressionPreference(r.Header.Get(fileTransferHeaderCompression))
	compressionLevel := normalizeStreamCompressionLevel(r.Header.Get(fileTransferHeaderCompressionLvl))
	execution, err := scripts.RemoteExecutionForVariantWithArgs(selected, map[string]string{
		"file_manager_source_parent":        sourceParent,
		"file_manager_source_names_b64":     sourceNames,
		"stream_output_compression":         compression,
		"stream_compression_preferences":    compression,
		"stream_output_compression_level":   compressionLevel,
		"stream_compression_default_level":  compressionLevel,
		"archive_stream_compression_level":  compressionLevel,
		"archive_stream_compression_policy": compression,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var stdin io.Reader
	if execution.StdinEnabled {
		stdin = strings.NewReader(execution.Stdin)
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	stderr := &limitedStringWriter{limit: 4000}
	ctx, cancel := context.WithTimeout(r.Context(), selected.Timeout+30*time.Second)
	defer cancel()
	stream := &safeHTTPStreamWriter{w: w}
	if flusher, ok := w.(http.Flusher); ok {
		stream.flusher = flusher
	}
	if err := s.runtime.RunStreamServer(ctx, server, execution.Command, stdin, stream, stderr); err != nil {
		detail := fileTransferError(err, stderr.String())
		if stream.Wrote() || stream.Err() != nil {
			if errors.Is(err, context.Canceled) {
				return
			}
			log.Printf("ShellOrchestra worker archive download stream ended after response streaming started server_id=%q parent=%q err=%v write_err=%v", serverID, sourceParent, detail, stream.Err())
			return
		}
		log.Printf("ShellOrchestra worker archive download stream failed before response streaming server_id=%q parent=%q err=%v", serverID, sourceParent, detail)
		http.Error(w, detail, http.StatusBadGateway)
		return
	}
	if err := stream.Err(); err != nil {
		log.Printf("ShellOrchestra worker archive download stream write failed server_id=%q parent=%q err=%v", serverID, sourceParent, err)
	}
}

func (s *Server) fileArchiveUploadStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	serverID := strings.TrimSpace(r.Header.Get(fileTransferHeaderServerID))
	path, err := fileTransferPathFromHeader(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	server, selected, err := s.fileTransferScript(r.Context(), serverID, fileManagerArchiveUploadStreamCommand)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	command, err := scripts.RemoteStreamCommandForVariantWithArgs(selected, map[string]string{
		"file_manager_path":      path,
		"file_manager_overwrite": normalizeBoolHeader(r.Header.Get(fileTransferHeaderOverwrite)),
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	stdout := limitedBytesWriter{limit: 1 << 20}
	stderr := &limitedStringWriter{limit: 4000}
	ctx, cancel := context.WithTimeout(r.Context(), selected.Timeout+30*time.Second)
	defer cancel()
	if err := s.runtime.RunStreamServer(ctx, server, command, r.Body, &stdout, stderr); err != nil {
		writeError(w, http.StatusBadGateway, fileTransferError(err, stderr.String()))
		return
	}
	if err := stdout.Err("stdout"); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	var result map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		writeError(w, http.StatusBadGateway, "Archive transfer finished, but the remote helper returned invalid JSON.")
		return
	}
	writeJSON(w, http.StatusOK, result)
}

type safeHTTPStreamWriter struct {
	mu      sync.Mutex
	w       http.ResponseWriter
	flusher http.Flusher
	wrote   bool
	err     error
}

func (w *safeHTTPStreamWriter) Write(data []byte) (n int, err error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.err != nil {
		return 0, w.err
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("HTTP stream write failed after the receiver closed the response: %v", recovered)
			w.err = err
			n = 0
		}
	}()
	n, err = w.w.Write(data)
	if n > 0 {
		w.wrote = true
		if w.flusher != nil {
			w.flusher.Flush()
		}
	}
	if err != nil {
		w.err = err
	}
	return n, err
}

func (w *safeHTTPStreamWriter) Wrote() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.wrote
}

func (w *safeHTTPStreamWriter) Err() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.err
}

func (s *Server) fileTransferScript(ctx context.Context, serverID string, commandName string) (domain.Server, scripts.SelectedScript, error) {
	server, err := s.store.GetServer(ctx, strings.TrimSpace(serverID))
	if err != nil {
		return domain.Server{}, scripts.SelectedScript{}, err
	}
	selected, err := s.scripts.Select(commandName, targetFactsForServer(server))
	if err != nil {
		return domain.Server{}, scripts.SelectedScript{}, err
	}
	if err := validateFileTransferManifest(selected.Command, commandName); err != nil {
		return domain.Server{}, scripts.SelectedScript{}, err
	}
	return server, selected, nil
}

func validateFileTransferManifest(command scripts.CommandManifest, commandName string) error {
	expectedPolicy := ""
	switch commandName {
	case fileManagerUploadStreamCommand:
		expectedPolicy = "binary_upload"
	case fileManagerDownloadStreamCommand:
		expectedPolicy = "binary_download"
	case fileManagerArchiveUploadStreamCommand:
		expectedPolicy = "binary_upload"
	case fileManagerArchiveDownloadStreamCommand:
		expectedPolicy = "binary_download"
	default:
		return fmt.Errorf("unsupported file transfer command %q", commandName)
	}
	if strings.ToLower(strings.TrimSpace(command.StreamPolicy)) != expectedPolicy {
		return fmt.Errorf("file transfer command %q has stream_policy %q but backend policy expected %q", commandName, command.StreamPolicy, expectedPolicy)
	}
	if strings.ToLower(strings.TrimSpace(command.AppRole)) != "data" {
		return fmt.Errorf("file transfer command %q has app_role %q but backend policy expected data", commandName, command.AppRole)
	}
	for _, appID := range command.AppIDs {
		if strings.TrimSpace(appID) == "file_manager" {
			return nil
		}
	}
	return fmt.Errorf("file transfer command %q is not registered for the file_manager app", commandName)
}

func fileTransferPathFromHeader(r *http.Request) (string, error) {
	return fileTransferPathFromNamedHeader(r, fileTransferHeaderPathB64, "remote path")
}

func fileTransferPathFromNamedHeader(r *http.Request, header string, label string) (string, error) {
	raw := strings.TrimSpace(r.Header.Get(header))
	if raw == "" {
		return "", fmt.Errorf("%s is required", label)
	}
	if len(raw) > base64.RawURLEncoding.EncodedLen(maxFileTransferPathBytes) {
		return "", fmt.Errorf("%s header is too large", label)
	}
	data, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return "", fmt.Errorf("%s header is not valid", label)
	}
	if len(data) > maxFileTransferPathBytes {
		return "", fmt.Errorf("%s is too large", label)
	}
	if bytes.Contains(data, []byte{0}) {
		return "", fmt.Errorf("%s contains a NUL byte", label)
	}
	path := string(data)
	if path == "" {
		return "", fmt.Errorf("%s is required", label)
	}
	return path, nil
}

func fileTransferNamesFromHeader(r *http.Request) (string, error) {
	raw := strings.TrimSpace(r.Header.Get(fileTransferHeaderSourceNamesB64))
	if raw == "" {
		return "", fmt.Errorf("source names are required")
	}
	if len(raw) > base64.RawURLEncoding.EncodedLen(maxFileTransferNameListBytes) {
		return "", fmt.Errorf("source name list header is too large")
	}
	data, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return "", fmt.Errorf("source name list header is not valid")
	}
	if len(data) > maxFileTransferNameListBytes {
		return "", fmt.Errorf("source name list is too large")
	}
	if bytes.Contains(data, []byte{0}) {
		return "", fmt.Errorf("source name list contains a NUL byte")
	}
	if !utf8.Valid(data) {
		return "", fmt.Errorf("source name list must be valid UTF-8")
	}
	return base64.StdEncoding.EncodeToString(data), nil
}

func normalizeBoolHeader(value string) string {
	if strings.EqualFold(strings.TrimSpace(value), "true") || strings.TrimSpace(value) == "1" {
		return "true"
	}
	return "false"
}

func fileTransferError(err error, stderr string) string {
	errText := sanitizeRemoteFileTransferErrorText(err.Error(), "Remote file transfer failed.")
	detail := sanitizeRemoteFileTransferErrorText(stderr, "")
	if detail == "" {
		return errText
	}
	if strings.Contains(errText, detail) {
		return errText
	}
	return fmt.Sprintf("%s: %s", errText, detail)
}

type limitedBytesWriter struct {
	buffer bytes.Buffer
	limit  int64
	excess bool
}

func (w *limitedBytesWriter) Write(data []byte) (int, error) {
	remaining := w.limit - int64(w.buffer.Len())
	if remaining <= 0 {
		w.excess = true
		return 0, fmt.Errorf("remote command output exceeded %d bytes", w.limit)
	}
	if int64(len(data)) > remaining {
		w.buffer.Write(data[:remaining])
		w.excess = true
		return int(remaining), fmt.Errorf("remote command output exceeded %d bytes", w.limit)
	}
	return w.buffer.Write(data)
}

func (w *limitedBytesWriter) Bytes() []byte {
	return w.buffer.Bytes()
}

func (w *limitedBytesWriter) Err(label string) error {
	if w.excess {
		return fmt.Errorf("remote command %s exceeded %d bytes", label, w.limit)
	}
	return nil
}

func (c *Client) UploadFile(ctx context.Context, serverID string, path string, overwrite bool, content io.Reader, timeout time.Duration) (map[string]any, error) {
	if timeout <= 0 {
		timeout = 30 * time.Minute
	}
	requestURL := c.baseURL.ResolveReference(&url.URL{Path: "/internal/worker/file-manager/upload-stream"})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, requestURL.String(), content)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-ShellOrchestra-Internal-Secret", c.internalSecret)
	req.Header.Set(fileTransferHeaderServerID, serverID)
	req.Header.Set(fileTransferHeaderPathB64, base64.RawURLEncoding.EncodeToString([]byte(path)))
	req.Header.Set(fileTransferHeaderOverwrite, fmt.Sprintf("%t", overwrite))
	req.Header.Set("Content-Type", "application/octet-stream")
	client := *c.client
	client.Timeout = timeout
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, responseError(resp)
	}
	var result map[string]any
	if err := internaljson.DecodeStrictResponse(resp.Body, maxFileTransferJSONResponseBytes, &result, "file transfer response"); err != nil {
		return nil, err
	}
	return result, nil
}

func (c *Client) UploadArchive(ctx context.Context, serverID string, destinationPath string, overwrite bool, content io.Reader, timeout time.Duration) (map[string]any, error) {
	if timeout <= 0 {
		timeout = 30 * time.Minute
	}
	requestURL := c.baseURL.ResolveReference(&url.URL{Path: "/internal/worker/file-manager/archive-upload-stream"})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, requestURL.String(), content)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-ShellOrchestra-Internal-Secret", c.internalSecret)
	req.Header.Set(fileTransferHeaderServerID, serverID)
	req.Header.Set(fileTransferHeaderPathB64, base64.RawURLEncoding.EncodeToString([]byte(destinationPath)))
	req.Header.Set(fileTransferHeaderOverwrite, fmt.Sprintf("%t", overwrite))
	req.Header.Set("Content-Type", "application/octet-stream")
	client := *c.client
	client.Timeout = timeout
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, responseError(resp)
	}
	var result map[string]any
	if err := internaljson.DecodeStrictResponse(resp.Body, maxFileTransferJSONResponseBytes, &result, "archive transfer response"); err != nil {
		return nil, err
	}
	return result, nil
}

func (c *Client) OpenFileDownload(ctx context.Context, serverID string, path string, timeout time.Duration) (*http.Response, error) {
	return c.openFileDownload(ctx, serverID, path, timeout, streamCompressionNone, streamCompressionDefaultLevel)
}

func (c *Client) OpenFileDownloadCompressed(ctx context.Context, serverID string, path string, timeout time.Duration) (*http.Response, error) {
	return c.OpenFileDownloadCompressedWithLevel(ctx, serverID, path, timeout, streamCompressionDefaultLevel)
}

func (c *Client) OpenFileDownloadCompressedWithLevel(ctx context.Context, serverID string, path string, timeout time.Duration, level string) (*http.Response, error) {
	return c.OpenFileDownloadCompressedWithOptions(ctx, serverID, path, timeout, streamCompressionPreference, level)
}

func (c *Client) OpenFileDownloadCompressedWithOptions(ctx context.Context, serverID string, path string, timeout time.Duration, compression string, level string) (*http.Response, error) {
	return c.openFileDownload(ctx, serverID, path, timeout, compression, level)
}

func (c *Client) OpenFileArchiveDownloadCompressedWithOptions(ctx context.Context, serverID string, sourceParent string, sourceNames []string, timeout time.Duration, compression string, level string) (*http.Response, error) {
	if timeout <= 0 {
		timeout = 30 * time.Minute
	}
	requestURL := c.baseURL.ResolveReference(&url.URL{Path: "/internal/worker/file-manager/archive-download-stream"})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, requestURL.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-ShellOrchestra-Internal-Secret", c.internalSecret)
	req.Header.Set(fileTransferHeaderServerID, serverID)
	req.Header.Set(fileTransferHeaderSourceParentB64, base64.RawURLEncoding.EncodeToString([]byte(sourceParent)))
	req.Header.Set(fileTransferHeaderSourceNamesB64, base64.RawURLEncoding.EncodeToString([]byte(strings.Join(sourceNames, "\n"))))
	req.Header.Set(fileTransferHeaderCompression, normalizeStreamCompressionPreference(compression))
	req.Header.Set(fileTransferHeaderCompressionLvl, normalizeStreamCompressionLevel(level))
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

func (c *Client) openFileDownload(ctx context.Context, serverID string, path string, timeout time.Duration, compression string, compressionLevel string) (*http.Response, error) {
	if timeout <= 0 {
		timeout = 30 * time.Minute
	}
	requestURL := c.baseURL.ResolveReference(&url.URL{Path: "/internal/worker/file-manager/download-stream"})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, requestURL.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-ShellOrchestra-Internal-Secret", c.internalSecret)
	req.Header.Set(fileTransferHeaderServerID, serverID)
	req.Header.Set(fileTransferHeaderPathB64, base64.RawURLEncoding.EncodeToString([]byte(path)))
	req.Header.Set(fileTransferHeaderCompression, normalizeStreamCompressionPreference(compression))
	req.Header.Set(fileTransferHeaderCompressionLvl, normalizeStreamCompressionLevel(compressionLevel))
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

func normalizeStreamCompressionPreference(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" {
		return streamCompressionNone
	}
	parts := strings.Split(normalized, ",")
	allowed := make([]string, 0, len(parts))
	seen := map[string]bool{}
	for _, part := range parts {
		item := strings.TrimSpace(part)
		switch item {
		case "zstd", "gzip", streamCompressionNone:
			if !seen[item] {
				allowed = append(allowed, item)
				seen[item] = true
			}
		}
	}
	if len(allowed) == 0 {
		return streamCompressionNone
	}
	if !seen[streamCompressionNone] {
		allowed = append(allowed, streamCompressionNone)
	}
	return strings.Join(allowed, ",")
}

func normalizeStreamCompressionLevel(value string) string {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed <= 0 {
		return streamCompressionDefaultLevel
	}
	if parsed > 19 {
		parsed = 19
	}
	return strconv.Itoa(parsed)
}

func responseError(resp *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	var payload struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(bytes.NewReader(body)).Decode(&payload)
	message := ""
	if payload.Error != "" {
		message = sanitizeRemoteFileTransferErrorText(payload.Error, "")
	}
	if message == "" {
		message = sanitizeRemoteFileTransferErrorBody(body, resp.Status)
	}
	if message == "" {
		message = resp.Status
	}
	return fmt.Errorf("%s", message)
}

const maxRemoteFileTransferErrorTextBytes = 2000

func sanitizeRemoteFileTransferErrorBody(body []byte, fallback string) string {
	if len(body) == 0 {
		return fallback
	}
	if bytes.IndexByte(body, 0) >= 0 || looksLikeCompressedPayload(body) || !utf8.Valid(body) {
		return fallback
	}
	return sanitizeRemoteFileTransferErrorText(string(body), fallback)
}

func sanitizeRemoteFileTransferErrorText(value string, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	if !utf8.ValidString(value) {
		return fallback
	}
	value = runtimepkg.SanitizeRemoteCommandDetail(value)
	value = strings.TrimSpace(value)
	if value == "" || strings.Contains(value, "<Objs ") || strings.Contains(value, "#< CLIXML") {
		return fallback
	}
	var builder strings.Builder
	controlCount := 0
	printableCount := 0
	for _, item := range value {
		switch item {
		case '\n', '\t':
			builder.WriteRune(item)
			printableCount++
			continue
		case '\r':
			continue
		}
		if item < 0x20 || item == 0x7f {
			controlCount++
			continue
		}
		if !unicode.IsPrint(item) {
			controlCount++
			continue
		}
		builder.WriteRune(item)
		printableCount++
	}
	cleaned := strings.TrimSpace(builder.String())
	if cleaned == "" {
		return fallback
	}
	if printableCount == 0 || controlCount > printableCount/8 {
		return fallback
	}
	return trimRemoteFileTransferErrorText(cleaned)
}

func trimRemoteFileTransferErrorText(value string) string {
	if len(value) <= maxRemoteFileTransferErrorTextBytes {
		return value
	}
	limit := maxRemoteFileTransferErrorTextBytes
	for limit > 0 && !utf8.RuneStart(value[limit]) {
		limit--
	}
	if limit <= 0 {
		return "Remote file transfer failed."
	}
	return strings.TrimSpace(value[:limit]) + "..."
}

func looksLikeCompressedPayload(body []byte) bool {
	if len(body) >= 4 && body[0] == 0x28 && body[1] == 0xb5 && body[2] == 0x2f && body[3] == 0xfd {
		return true
	}
	return len(body) >= 2 && body[0] == 0x1f && body[1] == 0x8b
}
