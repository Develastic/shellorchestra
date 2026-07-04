// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package httpapi

import (
	"context"
	"net/http"
	"strings"
	"time"

	"shellorchestra/backend/internal/desktopapps"
	"shellorchestra/backend/internal/streampipeline"
)

func (a *App) logsStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	if a.deps.Worker == nil {
		writeError(w, http.StatusServiceUnavailable, "SSH worker is not configured.")
		return
	}
	serverID := strings.TrimSpace(r.URL.Query().Get("server_id"))
	if serverID == "" {
		writeError(w, http.StatusBadRequest, "server_id is required.")
		return
	}
	plan, err := a.desktopAppService().ScriptDataStreamPlan(r.Context(), "logs", desktopapps.DataRequest{
		ServerID: serverID,
		Args:     logsStreamArgsFromQuery(r),
	})
	if err != nil {
		writeDesktopAppError(w, err)
		return
	}

	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	sink := streampipeline.NewNDJSONSink(w)

	ctx, cancel := context.WithTimeout(r.Context(), plan.Selected.Timeout+10*time.Second)
	defer cancel()
	response, err := a.deps.Worker.OpenCompressedJSONStreamServer(ctx, plan.Server, plan.Selected, plan.Args, plan.OutputEncoding)
	if err != nil {
		_ = emitLogsStreamError(ctx, sink, err)
		return
	}
	defer response.Body.Close()

	processor := newJSONResultStreamProcessor("logs", plan.App, plan.MaxDecodedBytes, "result")
	pipeline := streampipeline.New(
		streampipeline.Source{
			Name:        "logs-data",
			Kind:        streampipeline.StreamKindRecords,
			Reader:      response.Body,
			Compression: streampipeline.CompressionAuto,
		},
		sink,
		[]streampipeline.Processor{processor},
		streampipeline.Options{
			ApplicationName: "logs.viewer",
			MaxDecodedBytes: plan.MaxDecodedBytes,
			ChunkBytes:      32 << 10,
		},
	)
	if _, err := pipeline.Run(ctx); err != nil {
		_ = emitLogsStreamError(ctx, sink, err)
	}
}

func logsStreamArgsFromQuery(r *http.Request) map[string]string {
	query := r.URL.Query()
	args := map[string]string{
		"logs_source":           strings.TrimSpace(query.Get("source")),
		"logs_path":             strings.TrimSpace(query.Get("path")),
		"logs_query":            strings.TrimSpace(query.Get("query")),
		"logs_unit":             strings.TrimSpace(query.Get("unit")),
		"logs_priority":         strings.TrimSpace(query.Get("priority")),
		"logs_since":            strings.TrimSpace(query.Get("since")),
		"logs_until":            strings.TrimSpace(query.Get("until")),
		"logs_limit":            strings.TrimSpace(query.Get("limit")),
		"logs_follow":           strings.TrimSpace(query.Get("follow")),
		"logs_cursor":           strings.TrimSpace(query.Get("cursor")),
		"logs_live_limit":       strings.TrimSpace(query.Get("live_limit")),
		"logs_live_max_bytes":   strings.TrimSpace(query.Get("live_max_bytes")),
		"logs_container_id":     strings.TrimSpace(query.Get("container_id")),
		"logs_container_engine": strings.TrimSpace(query.Get("container_engine")),
		"logs_stream_format":    strings.TrimSpace(query.Get("stream_format")),
	}
	return args
}

func emitLogsStreamError(ctx context.Context, sink streampipeline.EventSink, err error) error {
	ok := false
	message := "Log Viewer stream failed."
	if err != nil && strings.TrimSpace(err.Error()) != "" {
		message = err.Error()
	}
	return sink.Emit(ctx, streampipeline.Event{Event: "error", OK: &ok, Error: message})
}
