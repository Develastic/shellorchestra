// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"shellorchestra/backend/internal/streampipeline"
)

func collectJSONFromRemoteStream(ctx context.Context, name string, reader io.Reader, maxDecodedBytes int64) (map[string]any, streampipeline.Stats, error) {
	if maxDecodedBytes <= 0 {
		maxDecodedBytes = 32 << 20
	}
	result, stats, err := streampipeline.CollectJSONObject(ctx,
		streampipeline.Source{
			Name:        name,
			Kind:        streampipeline.StreamKindRecords,
			Reader:      reader,
			Compression: streampipeline.CompressionAuto,
		},
		streampipeline.Options{
			ApplicationName: name,
			MaxDecodedBytes: maxDecodedBytes,
			ChunkBytes:      32 << 10,
		},
	)
	if err != nil {
		return nil, stats, err
	}
	result["_shellorchestra_transport"] = streamTransportFacts(stats.CompressionIn)
	return result, stats, nil
}

type jsonResultStreamProcessor struct {
	name            string
	app             map[string]any
	maxDecodedBytes int64
	resultEventName string
	buffer          bytes.Buffer
	mode            jsonResultStreamMode
	pendingLine     string
}

type jsonResultStreamMode string

const (
	jsonResultStreamModeUnknown jsonResultStreamMode = ""
	jsonResultStreamModeObject  jsonResultStreamMode = "object"
	jsonResultStreamModeEvents  jsonResultStreamMode = "events"
)

func newJSONResultStreamProcessor(name string, app map[string]any, maxDecodedBytes int64, resultEventName string) *jsonResultStreamProcessor {
	if maxDecodedBytes <= 0 {
		maxDecodedBytes = 32 << 20
	}
	if strings.TrimSpace(resultEventName) == "" {
		resultEventName = "result"
	}
	return &jsonResultStreamProcessor{
		name:            strings.TrimSpace(name),
		app:             copyStreamMap(app),
		maxDecodedBytes: maxDecodedBytes,
		resultEventName: resultEventName,
	}
}

func (p *jsonResultStreamProcessor) Name() string {
	if p == nil || p.name == "" {
		return "json-result-stream-processor"
	}
	return p.name + "-json-result-stream-processor"
}

func (p *jsonResultStreamProcessor) OnStart(context.Context, streampipeline.Source, streampipeline.EventSink) error {
	return nil
}

func (p *jsonResultStreamProcessor) OnChunk(ctx context.Context, chunk []byte, emit streampipeline.EventSink) (streampipeline.Decision, error) {
	if p == nil {
		return streampipeline.Decision{Stop: true, Reason: "JSON result stream processor is unavailable"}, nil
	}
	if p.mode == jsonResultStreamModeEvents {
		return streampipeline.Decision{}, p.processEventChunk(ctx, chunk, emit)
	}
	if int64(p.buffer.Len()+len(chunk)) > p.maxDecodedBytes {
		return streampipeline.Decision{Stop: true, Reason: "decoded JSON limit reached"}, fmt.Errorf("remote %s decoded JSON exceeded %d bytes", p.name, p.maxDecodedBytes)
	}
	if _, err := p.buffer.Write(chunk); err != nil {
		return streampipeline.Decision{}, err
	}
	if p.mode == jsonResultStreamModeObject {
		return streampipeline.Decision{}, nil
	}
	eventMode, known, err := detectRemoteEventStream(p.buffer.Bytes())
	if err != nil {
		return streampipeline.Decision{}, err
	}
	if !known {
		return streampipeline.Decision{}, nil
	}
	if !eventMode {
		p.mode = jsonResultStreamModeObject
		return streampipeline.Decision{}, nil
	}
	p.mode = jsonResultStreamModeEvents
	buffered := append([]byte(nil), p.buffer.Bytes()...)
	p.buffer.Reset()
	return streampipeline.Decision{}, p.processEventChunk(ctx, buffered, emit)
}

func (p *jsonResultStreamProcessor) OnFinish(ctx context.Context, stats streampipeline.Stats, emit streampipeline.EventSink) error {
	if p == nil {
		return nil
	}
	if p.mode == jsonResultStreamModeEvents {
		if strings.TrimSpace(p.pendingLine) != "" {
			if err := p.emitRemoteEventLine(ctx, p.pendingLine, emit); err != nil {
				return err
			}
		}
		return nil
	}
	var payload map[string]any
	if err := json.Unmarshal(p.buffer.Bytes(), &payload); err != nil {
		return fmt.Errorf("remote %s stream did not return a JSON object: %w", p.name, err)
	}
	transport := streamTransportFacts(stats.CompressionIn)
	payload["_shellorchestra_transport"] = transport
	ok := true
	return emit.Emit(ctx, streampipeline.Event{
		Event: p.resultEventName,
		OK:    &ok,
		Data: map[string]any{
			"app":       p.app,
			"result":    payload,
			"transport": transport,
		},
	})
}

func (p *jsonResultStreamProcessor) processEventChunk(ctx context.Context, chunk []byte, emit streampipeline.EventSink) error {
	if len(chunk) == 0 {
		return nil
	}
	p.pendingLine += string(chunk)
	if int64(len(p.pendingLine)) > p.maxDecodedBytes {
		return fmt.Errorf("remote %s event line exceeded %d bytes", p.name, p.maxDecodedBytes)
	}
	for {
		newline := strings.IndexByte(p.pendingLine, '\n')
		if newline < 0 {
			return nil
		}
		line := p.pendingLine[:newline]
		p.pendingLine = p.pendingLine[newline+1:]
		if err := p.emitRemoteEventLine(ctx, line, emit); err != nil {
			return err
		}
	}
}

func (p *jsonResultStreamProcessor) emitRemoteEventLine(ctx context.Context, line string, emit streampipeline.EventSink) error {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return nil
	}
	var raw map[string]any
	if err := json.Unmarshal([]byte(trimmed), &raw); err != nil {
		return fmt.Errorf("remote %s stream returned invalid NDJSON event: %w", p.name, err)
	}
	eventName := strings.TrimSpace(streamStringFromAny(raw["event"]))
	if !isAllowedRemoteStreamEvent(eventName) {
		return fmt.Errorf("remote %s stream returned unsupported event %q", p.name, eventName)
	}
	data, _ := raw["data"].(map[string]any)
	if data == nil {
		data = mapWithoutStreamEnvelope(raw)
	}
	if transport, ok := raw["transport"].(map[string]any); ok {
		data = copyStreamMap(data)
		data["transport"] = transport
	}
	okValue, hasOK := raw["ok"].(bool)
	var okPointer *bool
	if hasOK {
		okPointer = &okValue
	}
	return emit.Emit(ctx, streampipeline.Event{
		Event: eventName,
		OK:    okPointer,
		Name:  streamStringFromAny(raw["name"]),
		Data:  data,
		Error: streamStringFromAny(raw["error"]),
	})
}

func detectRemoteEventStream(buffer []byte) (eventMode bool, known bool, err error) {
	for {
		newline := bytes.IndexByte(buffer, '\n')
		if newline < 0 {
			return false, false, nil
		}
		line := strings.TrimSpace(string(buffer[:newline]))
		buffer = buffer[newline+1:]
		if line == "" {
			continue
		}
		var raw map[string]any
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			return false, true, nil
		}
		eventName := strings.TrimSpace(streamStringFromAny(raw["event"]))
		if eventName == "" {
			return false, true, nil
		}
		if !isAllowedRemoteStreamEvent(eventName) {
			return false, true, fmt.Errorf("remote stream returned unsupported event %q", eventName)
		}
		return true, true, nil
	}
}

func isAllowedRemoteStreamEvent(eventName string) bool {
	switch eventName {
	case "meta", "row", "chunk", "done", "error":
		return true
	default:
		return false
	}
}

func mapWithoutStreamEnvelope(raw map[string]any) map[string]any {
	if raw == nil {
		return nil
	}
	data := make(map[string]any, len(raw))
	for key, value := range raw {
		switch key {
		case "event", "ok", "name", "error", "stats", "transport":
			continue
		default:
			data[key] = value
		}
	}
	return data
}

func streamStringFromAny(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func streamTransportFacts(compression streampipeline.Compression) map[string]any {
	return map[string]any{
		"backend_remote_transport": "raw worker stdout stream from the managed SSH server",
		"browser_transport":        "streaming NDJSON with result and metadata events",
		"compression":              string(compression),
		"binary_stream":            true,
		"base64_payload":           false,
		"streaming_inspection":     true,
	}
}

func copyStreamMap(values map[string]any) map[string]any {
	if values == nil {
		return nil
	}
	copied := make(map[string]any, len(values))
	for key, value := range values {
		copied[key] = value
	}
	return copied
}
