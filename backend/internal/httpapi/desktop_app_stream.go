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

func (a *App) desktopAppDataStream(w http.ResponseWriter, r *http.Request, appID string) {
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
	if desktopapps.PayloadMutatesServer(appID, "data", body.Args) || body.Confirmed {
		writeError(w, http.StatusBadRequest, "Desktop app data streams are read-only. Use the audited data endpoint for changes.")
		return
	}
	if a.deps.Worker == nil {
		writeError(w, http.StatusServiceUnavailable, "SSH worker is not configured.")
		return
	}
	plan, err := a.desktopAppService().ScriptDataStreamPlan(r.Context(), appID, desktopapps.DataRequest{
		ServerID:  body.ServerID,
		Args:      body.Args,
		Confirmed: body.Confirmed,
	})
	if err != nil {
		a.writeDesktopAppValidationError(w, r, desktopAppMutationAuditInput{
			EventType: "desktop_app.validation.failed",
			Operation: "data_stream",
			ServerID:  body.ServerID,
			AppID:     appID,
			Confirmed: body.Confirmed,
			Args:      body.Args,
			Err:       err,
		}, err)
		return
	}
	a.runDesktopAppDataStream(w, r, desktopAppDataStreamRequest{
		AppID:            appID,
		Plan:             plan,
		ApplicationName:  "desktop-app." + appID,
		ResultEventName:  "result",
		DefaultErrorText: "Desktop app data stream failed.",
	})
}

type desktopAppDataStreamRequest struct {
	AppID            string
	Plan             desktopapps.DataStreamPlan
	ApplicationName  string
	ResultEventName  string
	DefaultErrorText string
}

func (a *App) runDesktopAppDataStream(w http.ResponseWriter, r *http.Request, request desktopAppDataStreamRequest) {
	plan := request.Plan
	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	sink := streampipeline.NewNDJSONSink(w)

	ctx, cancel := context.WithTimeout(r.Context(), plan.Selected.Timeout+10*time.Second)
	defer cancel()
	response, err := a.deps.Worker.OpenCompressedJSONStreamServer(ctx, plan.Server, plan.Selected, plan.Args, plan.OutputEncoding)
	if err != nil {
		_ = emitDesktopAppDataStreamError(ctx, sink, request.DefaultErrorText, err)
		return
	}
	defer response.Body.Close()

	processor := newJSONResultStreamProcessor(request.AppID, plan.App, plan.MaxDecodedBytes, request.ResultEventName)
	pipeline := streampipeline.New(
		streampipeline.Source{
			Name:        strings.TrimSpace(request.AppID) + "-data",
			Kind:        streampipeline.StreamKindRecords,
			Reader:      response.Body,
			Compression: streampipeline.CompressionAuto,
		},
		sink,
		[]streampipeline.Processor{processor},
		streampipeline.Options{
			ApplicationName: request.ApplicationName,
			MaxDecodedBytes: plan.MaxDecodedBytes,
			ChunkBytes:      32 << 10,
		},
	)
	if _, err := pipeline.Run(ctx); err != nil {
		_ = emitDesktopAppDataStreamError(ctx, sink, request.DefaultErrorText, err)
	}
}

func emitDesktopAppDataStreamError(ctx context.Context, sink streampipeline.EventSink, fallback string, err error) error {
	ok := false
	message := strings.TrimSpace(fallback)
	if message == "" {
		message = "Desktop app data stream failed."
	}
	if err != nil && strings.TrimSpace(err.Error()) != "" {
		message = err.Error()
	}
	return sink.Emit(ctx, streampipeline.Event{Event: "error", OK: &ok, Error: message})
}
