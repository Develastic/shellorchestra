// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"

	"shellorchestra/backend/internal/safecontent"
	"shellorchestra/backend/internal/streampipeline"
)

const (
	safeContentDefaultMaxBytes = 16 << 20
	safeContentMaxBytes        = 64 << 20
	safeContentDocumentBlocks  = 200
	safeContentRowsLimit       = 1000
	safeContentRowsLimitMax    = 5000
)

type safeContentTransportResponse struct {
	RemoteCompression string `json:"remote_compression"`
	DecodedBytes      int64  `json:"decoded_bytes"`
	Chunks            int64  `json:"chunks"`
	Truncated         bool   `json:"truncated,omitempty"`
}

type safeContentDocumentResponse struct {
	OK        bool                         `json:"ok"`
	Path      string                       `json:"path"`
	Document  safecontent.Document         `json:"document"`
	HTML      string                       `json:"html"`
	Text      string                       `json:"text"`
	Start     int                          `json:"start_block"`
	Limit     int                          `json:"block_limit"`
	HasMore   bool                         `json:"has_more"`
	Transport safeContentTransportResponse `json:"transport"`
}

type safeContentWorkbookResponse struct {
	OK        bool                         `json:"ok"`
	Path      string                       `json:"path"`
	Workbook  safecontent.Workbook         `json:"workbook"`
	Transport safeContentTransportResponse `json:"transport"`
}

type safeContentRowsResponse struct {
	OK        bool                         `json:"ok"`
	Path      string                       `json:"path"`
	Chunk     safecontent.RowsChunk        `json:"chunk"`
	HasMore   bool                         `json:"has_more"`
	Transport safeContentTransportResponse `json:"transport"`
}

func (a *App) safeContentDocument(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	serverID, path, ok := safeContentRequestTarget(w, r)
	if !ok {
		return
	}
	maxBytes := parseFileManagerPreviewLimit(r.URL.Query().Get("max_bytes"), safeContentDefaultMaxBytes, safeContentMaxBytes)
	start := parseBoundedInt(r.URL.Query().Get("start_block"), 0, 0, 1_000_000)
	limit := parseBoundedInt(r.URL.Query().Get("block_limit"), safeContentDocumentBlocks, 1, 1000)
	data, transport, ok := a.safeContentReadRemoteFile(w, r, serverID, path, maxBytes, false)
	if !ok {
		return
	}
	options := safeContentParserOptions(maxBytes)
	document, err := safecontent.ParseDocument(path, data, options)
	if err != nil {
		writeError(w, http.StatusUnsupportedMediaType, fmt.Sprintf("Safe document parser rejected this file: %v", err))
		return
	}
	chunk, hasMore := document.Chunk(start, limit)
	writeJSON(w, http.StatusOK, safeContentDocumentResponse{
		OK:        true,
		Path:      path,
		Document:  chunk,
		HTML:      safecontent.RenderDocumentHTML(chunk, int(maxBytes)),
		Text:      safecontent.RenderDocumentText(chunk, int(maxBytes)),
		Start:     start,
		Limit:     limit,
		HasMore:   hasMore,
		Transport: transport,
	})
}

func (a *App) safeContentSpreadsheetWorkbook(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	serverID, path, ok := safeContentRequestTarget(w, r)
	if !ok {
		return
	}
	maxBytes := parseFileManagerPreviewLimit(r.URL.Query().Get("max_bytes"), safeContentDefaultMaxBytes, safeContentMaxBytes)
	data, transport, ok := a.safeContentReadRemoteFile(w, r, serverID, path, maxBytes, true)
	if !ok {
		return
	}
	if transport.Truncated {
		data, _ = safecontent.TrimDelimitedSpreadsheetPrefix(path, data)
	}
	options := safeContentParserOptions(maxBytes)
	workbook, err := safecontent.ParseSpreadsheet(path, data, options)
	if err != nil {
		writeError(w, http.StatusUnsupportedMediaType, fmt.Sprintf("Safe spreadsheet parser rejected this file: %v", err))
		return
	}
	if transport.Truncated {
		workbook.Warnings = append(workbook.Warnings, safeContentPrefixWarning(maxBytes))
	}
	writeJSON(w, http.StatusOK, safeContentWorkbookResponse{OK: true, Path: path, Workbook: workbook.MetadataOnly(), Transport: transport})
}

func (a *App) safeContentSpreadsheetRows(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	serverID, path, ok := safeContentRequestTarget(w, r)
	if !ok {
		return
	}
	maxBytes := parseFileManagerPreviewLimit(r.URL.Query().Get("max_bytes"), safeContentDefaultMaxBytes, safeContentMaxBytes)
	sheetID := strings.TrimSpace(r.URL.Query().Get("sheet_id"))
	start := parseBoundedInt(r.URL.Query().Get("start_row"), 0, 0, 1_000_000)
	limit := parseBoundedInt(r.URL.Query().Get("row_limit"), safeContentRowsLimit, 1, safeContentRowsLimitMax)
	data, transport, ok := a.safeContentReadRemoteFile(w, r, serverID, path, maxBytes, true)
	if !ok {
		return
	}
	if transport.Truncated {
		data, _ = safecontent.TrimDelimitedSpreadsheetPrefix(path, data)
	}
	options := safeContentParserOptions(maxBytes)
	workbook, err := safecontent.ParseSpreadsheet(path, data, options)
	if err != nil {
		writeError(w, http.StatusUnsupportedMediaType, fmt.Sprintf("Safe spreadsheet parser rejected this file: %v", err))
		return
	}
	if transport.Truncated {
		workbook.Warnings = append(workbook.Warnings, safeContentPrefixWarning(maxBytes))
	}
	chunk, hasMore := workbook.Rows(sheetID, start, limit)
	writeJSON(w, http.StatusOK, safeContentRowsResponse{OK: true, Path: path, Chunk: chunk, HasMore: hasMore, Transport: transport})
}

func safeContentRequestTarget(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	serverID := strings.TrimSpace(r.URL.Query().Get("server_id"))
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if serverID == "" || path == "" {
		writeError(w, http.StatusBadRequest, "server_id and path are required.")
		return "", "", false
	}
	if strings.ContainsRune(path, '\x00') || strings.ContainsFunc(path, unicode.IsControl) || containsFileManagerBidiControl(path) {
		writeError(w, http.StatusBadRequest, "path contains unsafe control characters")
		return "", "", false
	}
	return serverID, path, true
}

func (a *App) safeContentReadRemoteFile(w http.ResponseWriter, r *http.Request, serverID string, path string, maxBytes int64, allowPrefix bool) ([]byte, safeContentTransportResponse, bool) {
	if a.deps.Worker == nil {
		writeError(w, http.StatusServiceUnavailable, "SSH worker is not configured.")
		return nil, safeContentTransportResponse{}, false
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	response, err := a.deps.Worker.OpenFileDownloadCompressedWithLevel(ctx, serverID, path, 2*time.Minute, "3")
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return nil, safeContentTransportResponse{}, false
	}
	defer response.Body.Close()
	source := streampipeline.Source{
		Name:        "safe-content-file",
		Kind:        streampipeline.StreamKindBytes,
		Reader:      response.Body,
		Compression: streampipeline.CompressionAuto,
	}
	options := streampipeline.Options{ApplicationName: "safe_content", MaxDecodedBytes: maxBytes, ChunkBytes: 32 << 10}
	var data []byte
	var stats streampipeline.Stats
	var truncated bool
	var collectErr error
	if allowPrefix {
		data, stats, truncated, collectErr = streampipeline.CollectBytesPrefix(ctx, source, options)
	} else {
		data, stats, collectErr = streampipeline.CollectBytes(ctx, source, options)
	}
	if collectErr != nil {
		writeError(w, http.StatusUnsupportedMediaType, collectErr.Error())
		return nil, safeContentTransportResponse{}, false
	}
	decodedBytes := stats.DecodedBytes
	if truncated {
		decodedBytes = int64(len(data))
	}
	return data, safeContentTransportResponse{RemoteCompression: string(stats.CompressionIn), DecodedBytes: decodedBytes, Chunks: stats.Chunks, Truncated: truncated}, true
}

func safeContentPrefixWarning(maxBytes int64) safecontent.Warning {
	return safecontent.Warning{
		Code:     "remote_file_prefix_truncated",
		Severity: "warning",
		Message:  fmt.Sprintf("Only the first %d bytes of this remote spreadsheet were loaded for the protected viewer.", maxBytes),
	}
}

func safeContentParserOptions(maxBytes int64) safecontent.Options {
	options := safecontent.DefaultOptions()
	options.MaxInputBytes = int(maxBytes)
	options.MaxOutputBytes = int(maxBytes)
	options.MaxZipEntryBytes = int(maxBytes)
	options.MaxZipTotalBytes = int(maxBytes * 8)
	return options
}

func parseBoundedInt(value string, fallback int, minValue int, maxValue int) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil {
		return fallback
	}
	if parsed < minValue {
		return minValue
	}
	if parsed > maxValue {
		return maxValue
	}
	return parsed
}
