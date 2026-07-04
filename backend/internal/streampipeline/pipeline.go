// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package streampipeline

import (
	"bufio"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/klauspost/compress/zstd"
)

type Compression string

const (
	CompressionAuto Compression = "auto"
	CompressionNone Compression = "none"
	CompressionZstd Compression = "zstd"
	CompressionGzip Compression = "gzip"
)

type StreamKind string

const (
	StreamKindBytes   StreamKind = "bytes"
	StreamKindRecords StreamKind = "records"
	StreamKindText    StreamKind = "text"
	StreamKindAsset   StreamKind = "asset"
)

type Source struct {
	Name        string
	Kind        StreamKind
	Reader      io.Reader
	Compression Compression
}

type Stats struct {
	StartedAt       time.Time   `json:"started_at"`
	FinishedAt      time.Time   `json:"finished_at"`
	DecodedBytes    int64       `json:"decoded_bytes"`
	Chunks          int64       `json:"chunks"`
	Stopped         bool        `json:"stopped"`
	StopReason      string      `json:"stop_reason,omitempty"`
	Compression     Compression `json:"compression"`
	CompressionIn   Compression `json:"compression_in"`
	ApplicationName string      `json:"application_name,omitempty"`
}

type Event struct {
	Event string         `json:"event"`
	OK    *bool          `json:"ok,omitempty"`
	Name  string         `json:"name,omitempty"`
	Data  map[string]any `json:"data,omitempty"`
	Error string         `json:"error,omitempty"`
	Stats *Stats         `json:"stats,omitempty"`
}

type EventSink interface {
	Emit(ctx context.Context, event Event) error
}

type Emitter func(ctx context.Context, event Event) error

func (e Emitter) Emit(ctx context.Context, event Event) error {
	if e == nil {
		return nil
	}
	return e(ctx, event)
}

type Decision struct {
	Stop   bool
	Reason string
}

type Processor interface {
	Name() string
	OnStart(ctx context.Context, source Source, emit EventSink) error
	OnChunk(ctx context.Context, chunk []byte, emit EventSink) (Decision, error)
	OnFinish(ctx context.Context, stats Stats, emit EventSink) error
}

type ProcessorHooks struct {
	ProcessorName string
	Start         func(ctx context.Context, source Source, emit EventSink) error
	Chunk         func(ctx context.Context, chunk []byte, emit EventSink) (Decision, error)
	Finish        func(ctx context.Context, stats Stats, emit EventSink) error
}

func (p ProcessorHooks) Name() string {
	if strings.TrimSpace(p.ProcessorName) == "" {
		return "processor"
	}
	return p.ProcessorName
}

func (p ProcessorHooks) OnStart(ctx context.Context, source Source, emit EventSink) error {
	if p.Start == nil {
		return nil
	}
	return p.Start(ctx, source, emit)
}

func (p ProcessorHooks) OnChunk(ctx context.Context, chunk []byte, emit EventSink) (Decision, error) {
	if p.Chunk == nil {
		return Decision{}, nil
	}
	return p.Chunk(ctx, chunk, emit)
}

func (p ProcessorHooks) OnFinish(ctx context.Context, stats Stats, emit EventSink) error {
	if p.Finish == nil {
		return nil
	}
	return p.Finish(ctx, stats, emit)
}

type Options struct {
	ApplicationName string
	MaxDecodedBytes int64
	ChunkBytes      int
}

type Pipeline struct {
	source     Source
	sink       EventSink
	processors []Processor
	options    Options
}

func New(source Source, sink EventSink, processors []Processor, options Options) *Pipeline {
	return &Pipeline{source: source, sink: sink, processors: processors, options: options}
}

func (p *Pipeline) Run(ctx context.Context) (Stats, error) {
	if p == nil {
		return Stats{}, errors.New("stream pipeline is nil")
	}
	if p.source.Reader == nil {
		return Stats{}, errors.New("stream pipeline source reader is required")
	}
	stats := Stats{
		StartedAt:       time.Now().UTC(),
		Compression:     normalizedCompression(p.source.Compression),
		ApplicationName: p.options.ApplicationName,
	}
	reader, compressionIn, closeReader, err := decodedReader(p.source.Reader, p.source.Compression)
	if err != nil {
		return stats, err
	}
	stats.CompressionIn = compressionIn
	defer closeReader()
	for _, processor := range p.processors {
		if processor == nil {
			continue
		}
		if err := processor.OnStart(ctx, p.source, p.sink); err != nil {
			return finishStats(stats), fmt.Errorf("%s start failed: %w", processor.Name(), err)
		}
	}
	chunkSize := p.options.ChunkBytes
	if chunkSize <= 0 {
		chunkSize = 32 << 10
	}
	buffer := make([]byte, chunkSize)
	for {
		if err := ctx.Err(); err != nil {
			return finishStats(stats), err
		}
		n, readErr := reader.Read(buffer)
		if n > 0 {
			stats.DecodedBytes += int64(n)
			stats.Chunks++
			if p.options.MaxDecodedBytes > 0 && stats.DecodedBytes > p.options.MaxDecodedBytes {
				stats.Stopped = true
				stats.StopReason = "decoded byte limit exceeded"
				return finishStats(stats), fmt.Errorf("stream pipeline decoded byte limit exceeded: %d > %d", stats.DecodedBytes, p.options.MaxDecodedBytes)
			}
			chunk := buffer[:n]
			for _, processor := range p.processors {
				if processor == nil {
					continue
				}
				decision, err := processor.OnChunk(ctx, chunk, p.sink)
				if err != nil {
					return finishStats(stats), fmt.Errorf("%s chunk failed: %w", processor.Name(), err)
				}
				if decision.Stop {
					stats.Stopped = true
					stats.StopReason = strings.TrimSpace(decision.Reason)
					if stats.StopReason == "" {
						stats.StopReason = processor.Name()
					}
					if err := p.finish(ctx, stats); err != nil {
						return finishStats(stats), err
					}
					return finishStats(stats), nil
				}
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return finishStats(stats), readErr
		}
	}
	if err := p.finish(ctx, stats); err != nil {
		return finishStats(stats), err
	}
	return finishStats(stats), nil
}

func (p *Pipeline) finish(ctx context.Context, stats Stats) error {
	stats = finishStats(stats)
	for _, processor := range p.processors {
		if processor == nil {
			continue
		}
		if err := processor.OnFinish(ctx, stats, p.sink); err != nil {
			return fmt.Errorf("%s finish failed: %w", processor.Name(), err)
		}
	}
	if p.sink != nil {
		ok := true
		if err := p.sink.Emit(ctx, Event{Event: "stream_stats", OK: &ok, Stats: &stats}); err != nil {
			return err
		}
	}
	return nil
}

func finishStats(stats Stats) Stats {
	if stats.FinishedAt.IsZero() {
		stats.FinishedAt = time.Now().UTC()
	}
	return stats
}

type NDJSONSink struct {
	mu      sync.Mutex
	writer  *bufio.Writer
	flusher interface{ Flush() }
}

func NewNDJSONSink(writer io.Writer) *NDJSONSink {
	sink := &NDJSONSink{writer: bufio.NewWriter(writer)}
	if flusher, ok := writer.(interface{ Flush() }); ok {
		sink.flusher = flusher
	}
	return sink
}

func (s *NDJSONSink) Emit(ctx context.Context, event Event) error {
	if s == nil || s.writer == nil {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if _, err := s.writer.Write(payload); err != nil {
		return err
	}
	if err := s.writer.WriteByte('\n'); err != nil {
		return err
	}
	if err := s.writer.Flush(); err != nil {
		return err
	}
	if s.flusher != nil {
		s.flusher.Flush()
	}
	return nil
}

type EncodedWriteCloser struct {
	io.Writer
	close func() error
}

func (w *EncodedWriteCloser) Close() error {
	if w == nil || w.close == nil {
		return nil
	}
	return w.close()
}

func NewEncodedWriter(writer io.Writer, compression Compression) (*EncodedWriteCloser, Compression, error) {
	switch normalizedCompression(compression) {
	case CompressionNone:
		return &EncodedWriteCloser{Writer: writer}, CompressionNone, nil
	case CompressionZstd:
		encoded, err := zstd.NewWriter(writer, zstd.WithEncoderLevel(zstd.SpeedFastest))
		if err != nil {
			return nil, "", err
		}
		return &EncodedWriteCloser{Writer: encoded, close: encoded.Close}, CompressionZstd, nil
	case CompressionGzip:
		encoded, err := gzip.NewWriterLevel(writer, gzip.BestSpeed)
		if err != nil {
			return nil, "", err
		}
		return &EncodedWriteCloser{Writer: encoded, close: encoded.Close}, CompressionGzip, nil
	default:
		return nil, "", fmt.Errorf("unsupported stream compression %q", compression)
	}
}

func decodedReader(reader io.Reader, compression Compression) (io.Reader, Compression, func() error, error) {
	buffered := bufio.NewReader(reader)
	closeReader := func() error { return nil }
	normalized := normalizedCompression(compression)
	if normalized == CompressionAuto {
		normalized = detectCompression(buffered)
	}
	switch normalized {
	case CompressionNone:
		return buffered, CompressionNone, closeReader, nil
	case CompressionZstd:
		decoded, err := zstd.NewReader(buffered)
		if err != nil {
			return nil, "", closeReader, fmt.Errorf("stream is not valid zstd: %w", err)
		}
		return decoded, CompressionZstd, func() error { decoded.Close(); return nil }, nil
	case CompressionGzip:
		decoded, err := gzip.NewReader(buffered)
		if err != nil {
			return nil, "", closeReader, fmt.Errorf("stream is not valid gzip: %w", err)
		}
		return decoded, CompressionGzip, decoded.Close, nil
	default:
		return nil, "", closeReader, fmt.Errorf("unsupported stream compression %q", compression)
	}
}

func normalizedCompression(compression Compression) Compression {
	switch strings.ToLower(strings.TrimSpace(string(compression))) {
	case "", "auto":
		return CompressionAuto
	case "none", "identity", "plain":
		return CompressionNone
	case "zstd":
		return CompressionZstd
	case "gzip", "gz":
		return CompressionGzip
	default:
		return compression
	}
}

func detectCompression(reader *bufio.Reader) Compression {
	if reader == nil {
		return CompressionNone
	}
	header, _ := reader.Peek(4)
	if len(header) >= 4 && header[0] == 0x28 && header[1] == 0xb5 && header[2] == 0x2f && header[3] == 0xfd {
		return CompressionZstd
	}
	if len(header) >= 2 && header[0] == 0x1f && header[1] == 0x8b {
		return CompressionGzip
	}
	return CompressionNone
}
