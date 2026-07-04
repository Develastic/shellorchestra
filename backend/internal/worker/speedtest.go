// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package worker

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"shellorchestra/backend/internal/domain"
	"shellorchestra/backend/internal/scripts"
)

const (
	speedTestUploadCommand   = "speed_test_upload"
	speedTestDownloadCommand = "speed_test_download"
	defaultSpeedTestTimeout  = 180 * time.Second
)

func speedTestTimeout(payloadBytes int64) time.Duration {
	timeout := defaultSpeedTestTimeout
	if payloadBytes > 1024*1024*1024 {
		timeout = 600 * time.Second
	}
	return timeout
}

type SpeedTestResult struct {
	OK              bool                    `json:"ok"`
	ServerID        string                  `json:"server_id"`
	ServerName      string                  `json:"server_name"`
	Direction       string                  `json:"direction"`
	Streams         int                     `json:"streams"`
	PayloadBytes    int64                   `json:"payload_bytes"`
	TotalBytes      int64                   `json:"total_bytes"`
	DurationSeconds float64                 `json:"duration_seconds"`
	MegabitsSecond  float64                 `json:"megabits_second"`
	MebibytesSecond float64                 `json:"mebibytes_second"`
	Command         string                  `json:"command"`
	Variant         string                  `json:"variant"`
	Workers         []SpeedTestWorkerResult `json:"workers"`
	Error           string                  `json:"error,omitempty"`
}

type SpeedTestWorkerResult struct {
	Index           int     `json:"index"`
	Bytes           int64   `json:"bytes"`
	TargetBytes     int64   `json:"target_bytes"`
	DurationSeconds float64 `json:"duration_seconds"`
	MegabitsSecond  float64 `json:"megabits_second"`
	MebibytesSecond float64 `json:"mebibytes_second"`
	Error           string  `json:"error,omitempty"`
}

type SpeedTestWorkerProgress struct {
	Index           int     `json:"index"`
	State           string  `json:"state"`
	Bytes           int64   `json:"bytes"`
	TargetBytes     int64   `json:"target_bytes"`
	Percent         float64 `json:"percent"`
	DurationSeconds float64 `json:"duration_seconds"`
	MegabitsSecond  float64 `json:"megabits_second"`
	MebibytesSecond float64 `json:"mebibytes_second"`
	Error           string  `json:"error,omitempty"`
}

type SpeedTestJobSnapshot struct {
	OK                   bool                      `json:"ok"`
	JobID                string                    `json:"job_id"`
	State                string                    `json:"state"`
	ServerID             string                    `json:"server_id"`
	ServerName           string                    `json:"server_name"`
	Direction            string                    `json:"direction"`
	Streams              int                       `json:"streams"`
	PayloadBytes         int64                     `json:"payload_bytes"`
	TotalBytes           int64                     `json:"total_bytes"`
	TotalTargetBytes     int64                     `json:"total_target_bytes"`
	Percent              float64                   `json:"percent"`
	DurationSeconds      float64                   `json:"duration_seconds"`
	StartedAt            string                    `json:"started_at"`
	FinishedAt           string                    `json:"finished_at,omitempty"`
	Progress             []SpeedTestWorkerProgress `json:"progress"`
	Result               *SpeedTestResult          `json:"result,omitempty"`
	Error                string                    `json:"error,omitempty"`
	SupportsCancel       bool                      `json:"supports_cancel"`
	SupportsLiveProgress bool                      `json:"supports_live_progress"`
	ProgressSource       string                    `json:"progress_source"`
	ProgressPollMs       int                       `json:"progress_poll_ms"`
}

type speedTestRequest struct {
	ServerID     string `json:"server_id"`
	Direction    string `json:"direction"`
	Streams      int    `json:"streams"`
	PayloadBytes int64  `json:"payload_bytes"`
}

type speedTestJobRequest struct {
	JobID string `json:"job_id"`
}

func (s *Server) speedTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var body speedTestRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), speedTestTimeout(body.PayloadBytes))
	defer cancel()
	server, err := s.store.GetServer(ctx, strings.TrimSpace(body.ServerID))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	result, err := s.runSpeedTest(ctx, server, body.Direction, body.Streams, body.PayloadBytes)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) speedTestStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var body speedTestRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	server, err := s.store.GetServer(ctx, strings.TrimSpace(body.ServerID))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	snapshot, err := s.speedTests.Start(server, body.Direction, body.Streams, body.PayloadBytes)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, snapshot)
}

func (s *Server) speedTestStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var body speedTestJobRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	snapshot, ok := s.speedTests.Snapshot(strings.TrimSpace(body.JobID))
	if !ok {
		writeError(w, http.StatusNotFound, "Speed-test job was not found.")
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) speedTestCancel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.validInternalRequest(r) {
		writeError(w, http.StatusForbidden, "Internal authentication failed.")
		return
	}
	var body speedTestJobRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	snapshot, ok := s.speedTests.Cancel(strings.TrimSpace(body.JobID))
	if !ok {
		writeError(w, http.StatusNotFound, "Speed-test job was not found.")
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) runSpeedTest(ctx context.Context, server domain.Server, direction string, streams int, payloadBytes int64) (SpeedTestResult, error) {
	return s.runSpeedTestWithProgress(ctx, server, direction, streams, payloadBytes, nil)
}

func (s *Server) runSpeedTestWithProgress(ctx context.Context, server domain.Server, direction string, streams int, payloadBytes int64, tracker *speedTestProgressTracker) (SpeedTestResult, error) {
	direction = normalizeSpeedTestDirection(direction)
	if direction == "" {
		return SpeedTestResult{}, fmt.Errorf("speed test direction must be upload or download")
	}
	streams = normalizeSpeedTestStreams(streams, payloadBytes)
	payloadBytes, err := normalizeSpeedTestPayload(payloadBytes)
	if err != nil {
		return SpeedTestResult{}, err
	}
	commandName := speedTestUploadCommand
	if direction == "download" {
		commandName = speedTestDownloadCommand
	}
	selected, err := s.scripts.Select(commandName, targetFactsForServer(server))
	if err != nil {
		return SpeedTestResult{}, err
	}

	result := SpeedTestResult{
		ServerID:     server.ID,
		ServerName:   server.Name,
		Direction:    direction,
		Streams:      streams,
		PayloadBytes: payloadBytes,
		Command:      commandName,
		Variant:      selected.Variant.ID,
		Workers:      make([]SpeedTestWorkerResult, streams),
	}
	started := time.Now()
	var wg sync.WaitGroup
	for index := 0; index < streams; index++ {
		index := index
		streamBytes := speedTestStreamBytes(payloadBytes, streams, index)
		wg.Add(1)
		go func() {
			defer wg.Done()
			result.Workers[index] = s.runSpeedTestStream(ctx, server.ID, selected, direction, index, streamBytes, tracker)
		}()
	}
	wg.Wait()
	result.DurationSeconds = time.Since(started).Seconds()
	for _, workerResult := range result.Workers {
		result.TotalBytes += workerResult.Bytes
		if strings.TrimSpace(workerResult.Error) != "" {
			if result.Error == "" {
				result.Error = workerResult.Error
			}
			continue
		}
		result.OK = true
	}
	if result.DurationSeconds > 0 {
		result.MegabitsSecond = float64(result.TotalBytes*8) / result.DurationSeconds / (1024 * 1024)
		result.MebibytesSecond = float64(result.TotalBytes) / result.DurationSeconds / (1024 * 1024)
	}
	if !result.OK && result.Error == "" {
		result.Error = "All speed-test streams finished without transferring data."
	}
	return result, nil
}

func (s *Server) runSpeedTestStream(ctx context.Context, serverID string, selected scripts.SelectedScript, direction string, index int, payloadBytes int64, tracker *speedTestProgressTracker) SpeedTestWorkerResult {
	streamResult := SpeedTestWorkerResult{Index: index + 1, TargetBytes: payloadBytes}
	args := map[string]string{"bytes": strconv.FormatInt(payloadBytes, 10)}
	command, err := scripts.RemoteCommandForVariantWithArgs(selected, args)
	if err != nil {
		streamResult.Error = err.Error()
		if tracker != nil {
			tracker.finish(index, streamResult)
		}
		return streamResult
	}
	stderr := &limitedStringWriter{limit: 2000}
	started := time.Now()
	if tracker != nil {
		tracker.start(index)
	}
	if direction == "upload" {
		reader, readerErr := newRepeatingRandomReader(payloadBytes, tracker, index)
		if readerErr != nil {
			streamResult.Error = readerErr.Error()
			if tracker != nil {
				tracker.finish(index, streamResult)
			}
			return streamResult
		}
		err = s.runtime.RunStream(ctx, serverID, command, reader, io.Discard, stderr)
		streamResult.Bytes = reader.Count()
	} else {
		writer := newCountingDiscardWriter(tracker, index)
		err = s.runtime.RunStream(ctx, serverID, command, nil, writer, stderr)
		streamResult.Bytes = writer.Count()
	}
	streamResult.DurationSeconds = time.Since(started).Seconds()
	if streamResult.DurationSeconds > 0 {
		streamResult.MegabitsSecond = float64(streamResult.Bytes*8) / streamResult.DurationSeconds / (1024 * 1024)
		streamResult.MebibytesSecond = float64(streamResult.Bytes) / streamResult.DurationSeconds / (1024 * 1024)
	}
	if err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail != "" {
			streamResult.Error = fmt.Sprintf("%v: %s", err, detail)
		} else {
			streamResult.Error = err.Error()
		}
	}
	if tracker != nil {
		tracker.finish(index, streamResult)
	}
	return streamResult
}

func (c *Client) SpeedTest(ctx context.Context, serverID string, direction string, streams int, payloadBytes int64, timeout time.Duration) (SpeedTestResult, error) {
	if timeout <= 0 {
		timeout = defaultSpeedTestTimeout
	}
	var result SpeedTestResult
	err := c.do(ctx, http.MethodPost, "/internal/worker/speed-test", speedTestRequest{
		ServerID:     serverID,
		Direction:    direction,
		Streams:      streams,
		PayloadBytes: payloadBytes,
	}, &result, timeout+10*time.Second)
	return result, err
}

func (c *Client) StartSpeedTest(ctx context.Context, serverID string, direction string, streams int, payloadBytes int64) (SpeedTestJobSnapshot, error) {
	var result SpeedTestJobSnapshot
	err := c.do(ctx, http.MethodPost, "/internal/worker/speed-test/start", speedTestRequest{
		ServerID:     serverID,
		Direction:    direction,
		Streams:      streams,
		PayloadBytes: payloadBytes,
	}, &result, 15*time.Second)
	return result, err
}

func (c *Client) SpeedTestJob(ctx context.Context, jobID string) (SpeedTestJobSnapshot, error) {
	var result SpeedTestJobSnapshot
	err := c.do(ctx, http.MethodPost, "/internal/worker/speed-test/status", speedTestJobRequest{JobID: jobID}, &result, 15*time.Second)
	return result, err
}

func (c *Client) CancelSpeedTest(ctx context.Context, jobID string) (SpeedTestJobSnapshot, error) {
	var result SpeedTestJobSnapshot
	err := c.do(ctx, http.MethodPost, "/internal/worker/speed-test/cancel", speedTestJobRequest{JobID: jobID}, &result, 15*time.Second)
	return result, err
}

type SpeedTestManager struct {
	server *Server
	mu     sync.Mutex
	jobs   map[string]*speedTestJob
}

type speedTestJob struct {
	id           string
	cancel       context.CancelFunc
	tracker      *speedTestProgressTracker
	startedAt    time.Time
	serverID     string
	serverName   string
	direction    string
	streams      int
	payloadBytes int64

	mu         sync.Mutex
	state      string
	result     *SpeedTestResult
	errorText  string
	finishedAt time.Time
}

type speedTestProgressTracker struct {
	startedAt time.Time
	targets   []int64
	bytes     []atomic.Int64

	mu       sync.Mutex
	states   []string
	errors   []string
	finished []SpeedTestWorkerResult
}

func NewSpeedTestManager(server *Server) *SpeedTestManager {
	return &SpeedTestManager{server: server, jobs: map[string]*speedTestJob{}}
}

func (m *SpeedTestManager) Start(server domain.Server, direction string, streams int, payloadBytes int64) (SpeedTestJobSnapshot, error) {
	direction = normalizeSpeedTestDirection(direction)
	if direction == "" {
		return SpeedTestJobSnapshot{}, fmt.Errorf("speed test direction must be upload or download")
	}
	var err error
	payloadBytes, err = normalizeSpeedTestPayload(payloadBytes)
	if err != nil {
		return SpeedTestJobSnapshot{}, err
	}
	streams = normalizeSpeedTestStreams(streams, payloadBytes)
	commandName := speedTestUploadCommand
	if direction == "download" {
		commandName = speedTestDownloadCommand
	}
	if _, err := m.server.scripts.Select(commandName, targetFactsForServer(server)); err != nil {
		return SpeedTestJobSnapshot{}, err
	}
	targets := make([]int64, streams)
	for index := 0; index < streams; index++ {
		targets[index] = speedTestStreamBytes(payloadBytes, streams, index)
	}
	jobID, err := newSpeedTestJobID(server.ID)
	if err != nil {
		return SpeedTestJobSnapshot{}, err
	}
	timeout := speedTestTimeout(payloadBytes)
	ctx, cancel := context.WithTimeout(context.Background(), timeout+10*time.Second)
	job := &speedTestJob{
		id:           jobID,
		cancel:       cancel,
		tracker:      newSpeedTestProgressTracker(targets),
		startedAt:    time.Now(),
		serverID:     server.ID,
		serverName:   server.Name,
		direction:    direction,
		streams:      streams,
		payloadBytes: payloadBytes,
		state:        "running",
	}
	m.mu.Lock()
	m.pruneLocked(time.Now())
	m.jobs[jobID] = job
	m.mu.Unlock()
	go func() {
		defer cancel()
		result, err := m.server.runSpeedTestWithProgress(ctx, server, direction, streams, payloadBytes, job.tracker)
		job.mu.Lock()
		defer job.mu.Unlock()
		finishedAt := time.Now()
		job.finishedAt = finishedAt
		if err != nil {
			job.state = "failed"
			job.errorText = err.Error()
			return
		}
		if ctx.Err() == context.Canceled {
			job.state = "canceled"
			if result.Error == "" {
				result.Error = "The speed-test job was canceled."
			}
		} else if ctx.Err() == context.DeadlineExceeded {
			job.state = "failed"
			job.errorText = "The speed-test job timed out."
			if result.Error == "" {
				result.Error = job.errorText
			}
		} else if result.OK {
			job.state = "succeeded"
		} else {
			job.state = "failed"
			job.errorText = strings.TrimSpace(result.Error)
		}
		job.result = &result
	}()
	return job.snapshot(), nil
}

func (m *SpeedTestManager) Snapshot(jobID string) (SpeedTestJobSnapshot, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneLocked(time.Now())
	job, ok := m.jobs[jobID]
	if !ok {
		return SpeedTestJobSnapshot{}, false
	}
	return job.snapshot(), true
}

func (m *SpeedTestManager) Cancel(jobID string) (SpeedTestJobSnapshot, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	job, ok := m.jobs[jobID]
	if !ok {
		return SpeedTestJobSnapshot{}, false
	}
	job.mu.Lock()
	if job.state == "running" {
		job.state = "canceling"
		job.errorText = "Cancel requested."
		job.cancel()
	}
	job.mu.Unlock()
	return job.snapshot(), true
}

func (m *SpeedTestManager) pruneLocked(now time.Time) {
	for id, job := range m.jobs {
		job.mu.Lock()
		finished := !job.finishedAt.IsZero()
		tooOld := finished && now.Sub(job.finishedAt) > 30*time.Minute
		job.mu.Unlock()
		if tooOld {
			delete(m.jobs, id)
		}
	}
}

func (j *speedTestJob) snapshot() SpeedTestJobSnapshot {
	j.mu.Lock()
	state := j.state
	errorText := j.errorText
	finishedAt := j.finishedAt
	var result *SpeedTestResult
	if j.result != nil {
		copied := *j.result
		copied.Workers = append([]SpeedTestWorkerResult(nil), j.result.Workers...)
		result = &copied
	}
	j.mu.Unlock()
	progress := j.tracker.snapshot()
	totalBytes := int64(0)
	totalTarget := int64(0)
	for _, item := range progress {
		totalBytes += item.Bytes
		totalTarget += item.TargetBytes
	}
	duration := time.Since(j.startedAt).Seconds()
	if !finishedAt.IsZero() {
		duration = finishedAt.Sub(j.startedAt).Seconds()
	}
	percent := float64(0)
	if totalTarget > 0 {
		percent = float64(totalBytes) / float64(totalTarget) * 100
		if percent > 100 {
			percent = 100
		}
	}
	finishedAtText := ""
	if !finishedAt.IsZero() {
		finishedAtText = finishedAt.UTC().Format(time.RFC3339Nano)
	}
	if result != nil {
		totalBytes = result.TotalBytes
	}
	return SpeedTestJobSnapshot{
		OK:                   result != nil && result.OK,
		JobID:                j.id,
		State:                state,
		ServerID:             resultString(result, j.serverID, func(r *SpeedTestResult) string { return r.ServerID }),
		ServerName:           resultString(result, j.serverName, func(r *SpeedTestResult) string { return r.ServerName }),
		Direction:            resultString(result, j.direction, func(r *SpeedTestResult) string { return r.Direction }),
		Streams:              j.streams,
		PayloadBytes:         j.payloadBytes,
		TotalBytes:           totalBytes,
		TotalTargetBytes:     totalTarget,
		Percent:              percent,
		DurationSeconds:      duration,
		StartedAt:            j.startedAt.UTC().Format(time.RFC3339Nano),
		FinishedAt:           finishedAtText,
		Progress:             progress,
		Result:               result,
		Error:                firstNonEmptySpeedTestError(errorText, result),
		SupportsCancel:       state == "running" || state == "canceling",
		SupportsLiveProgress: true,
		ProgressSource:       "ssh-worker byte counters",
		ProgressPollMs:       250,
	}
}

func newSpeedTestProgressTracker(targets []int64) *speedTestProgressTracker {
	states := make([]string, len(targets))
	errors := make([]string, len(targets))
	finished := make([]SpeedTestWorkerResult, len(targets))
	bytes := make([]atomic.Int64, len(targets))
	for index := range states {
		states[index] = "queued"
	}
	return &speedTestProgressTracker{startedAt: time.Now(), targets: append([]int64(nil), targets...), bytes: bytes, states: states, errors: errors, finished: finished}
}

func (t *speedTestProgressTracker) start(index int) {
	t.setState(index, "running", "")
}

func (t *speedTestProgressTracker) addBytes(index int, value int64) {
	if index < 0 || index >= len(t.bytes) || value <= 0 {
		return
	}
	t.bytes[index].Add(value)
}

func (t *speedTestProgressTracker) finish(index int, result SpeedTestWorkerResult) {
	if index < 0 || index >= len(t.states) {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.finished[index] = result
	t.errors[index] = strings.TrimSpace(result.Error)
	if t.errors[index] != "" {
		t.states[index] = "failed"
	} else {
		t.states[index] = "succeeded"
	}
}

func (t *speedTestProgressTracker) setState(index int, state string, err string) {
	if index < 0 || index >= len(t.states) {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.states[index] = state
	t.errors[index] = strings.TrimSpace(err)
}

func (t *speedTestProgressTracker) snapshot() []SpeedTestWorkerProgress {
	t.mu.Lock()
	states := append([]string(nil), t.states...)
	errors := append([]string(nil), t.errors...)
	finished := append([]SpeedTestWorkerResult(nil), t.finished...)
	t.mu.Unlock()
	out := make([]SpeedTestWorkerProgress, len(t.targets))
	for index, target := range t.targets {
		bytes := t.bytes[index].Load()
		if finished[index].Bytes > bytes {
			bytes = finished[index].Bytes
		}
		duration := time.Since(t.startedAt).Seconds()
		if finished[index].DurationSeconds > 0 && states[index] != "running" {
			duration = finished[index].DurationSeconds
		}
		percent := float64(0)
		if target > 0 {
			percent = float64(bytes) / float64(target) * 100
			if percent > 100 {
				percent = 100
			}
		}
		megabits := float64(0)
		mebibytes := float64(0)
		if duration > 0 {
			megabits = float64(bytes*8) / duration / (1024 * 1024)
			mebibytes = float64(bytes) / duration / (1024 * 1024)
		}
		out[index] = SpeedTestWorkerProgress{
			Index:           index + 1,
			State:           states[index],
			Bytes:           bytes,
			TargetBytes:     target,
			Percent:         percent,
			DurationSeconds: duration,
			MegabitsSecond:  megabits,
			MebibytesSecond: mebibytes,
			Error:           errors[index],
		}
	}
	return out
}

func newSpeedTestJobID(serverID string) (string, error) {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	prefix := terminalIDPattern.ReplaceAllString(serverID, "-")
	return prefix + "-speed-" + strings.TrimRight(base64.RawURLEncoding.EncodeToString(raw), "="), nil
}

func resultString(result *SpeedTestResult, fallback string, pick func(*SpeedTestResult) string) string {
	if result == nil {
		return fallback
	}
	if value := strings.TrimSpace(pick(result)); value != "" {
		return value
	}
	return fallback
}

func firstNonEmptySpeedTestError(value string, result *SpeedTestResult) string {
	if strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	if result != nil {
		return strings.TrimSpace(result.Error)
	}
	return ""
}

type repeatingRandomReader struct {
	chunk       []byte
	remaining   int64
	count       int64
	offset      int
	tracker     *speedTestProgressTracker
	trackerSlot int
}

func newRepeatingRandomReader(total int64, tracker *speedTestProgressTracker, trackerSlot int) (*repeatingRandomReader, error) {
	chunkSize := int64(4 * 1024 * 1024)
	if total > 0 && total < chunkSize {
		chunkSize = total
	}
	if chunkSize < 32*1024 {
		chunkSize = 32 * 1024
	}
	chunk := make([]byte, chunkSize)
	if _, err := rand.Read(chunk); err != nil {
		return nil, fmt.Errorf("generate speed-test random payload: %w", err)
	}
	return &repeatingRandomReader{chunk: chunk, remaining: total, tracker: tracker, trackerSlot: trackerSlot}, nil
}

func (r *repeatingRandomReader) Read(p []byte) (int, error) {
	if r.remaining <= 0 {
		return 0, io.EOF
	}
	written := 0
	for written < len(p) && r.remaining > 0 {
		if r.offset >= len(r.chunk) {
			r.offset = 0
		}
		available := len(r.chunk) - r.offset
		if int64(available) > r.remaining {
			available = int(r.remaining)
		}
		if available > len(p)-written {
			available = len(p) - written
		}
		copy(p[written:written+available], r.chunk[r.offset:r.offset+available])
		written += available
		r.offset += available
		r.remaining -= int64(available)
		r.count += int64(available)
	}
	if written > 0 && r.tracker != nil {
		r.tracker.addBytes(r.trackerSlot, int64(written))
	}
	return written, nil
}

func (r *repeatingRandomReader) Count() int64 {
	return r.count
}

type countingDiscardWriter struct {
	count       int64
	tracker     *speedTestProgressTracker
	trackerSlot int
}

func newCountingDiscardWriter(tracker *speedTestProgressTracker, trackerSlot int) *countingDiscardWriter {
	return &countingDiscardWriter{tracker: tracker, trackerSlot: trackerSlot}
}

func (w *countingDiscardWriter) Write(p []byte) (int, error) {
	w.count += int64(len(p))
	if len(p) > 0 && w.tracker != nil {
		w.tracker.addBytes(w.trackerSlot, int64(len(p)))
	}
	return len(p), nil
}

func (w *countingDiscardWriter) Count() int64 {
	return w.count
}

type limitedStringWriter struct {
	limit     int
	builder   strings.Builder
	truncated int
}

func (w *limitedStringWriter) Write(p []byte) (int, error) {
	available := w.limit - w.builder.Len()
	if available < 0 {
		available = 0
	}
	writtenToBuffer := 0
	if available > 0 {
		if available > len(p) {
			available = len(p)
		}
		w.builder.Write(p[:available])
		writtenToBuffer = available
	}
	if len(p) > writtenToBuffer {
		w.truncated += len(p) - writtenToBuffer
	}
	return len(p), nil
}

func (w *limitedStringWriter) String() string {
	value := w.builder.String()
	if w.truncated > 0 {
		value += fmt.Sprintf("... (%d bytes truncated)", w.truncated)
	}
	return value
}

func normalizeSpeedTestDirection(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "upload", "backend_to_server", "to_server":
		return "upload"
	case "download", "server_to_backend", "from_server":
		return "download"
	default:
		return ""
	}
}

func normalizeSpeedTestStreams(streams int, payloadBytes int64) int {
	if streams < 1 {
		streams = 4
	}
	if streams > 16 {
		streams = 16
	}
	if payloadBytes > 0 && int64(streams) > payloadBytes {
		streams = int(payloadBytes)
	}
	if streams < 1 {
		streams = 1
	}
	return streams
}

func normalizeSpeedTestPayload(payloadBytes int64) (int64, error) {
	if payloadBytes <= 0 {
		payloadBytes = 100 * 1024 * 1024
	}
	if payloadBytes < 1024*1024 {
		return 0, fmt.Errorf("speed test payload must be at least 1 MiB")
	}
	if payloadBytes > 10*1024*1024*1024 {
		return 0, fmt.Errorf("speed test payload must not exceed 10 GiB")
	}
	return payloadBytes, nil
}

func speedTestStreamBytes(total int64, streams int, index int) int64 {
	base := total / int64(streams)
	if index == streams-1 {
		return base + total%int64(streams)
	}
	return base
}
