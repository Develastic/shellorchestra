// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package streampipeline

import (
	"bytes"
	"context"
	"fmt"
)

const defaultCollectBytesLimit int64 = 64 << 20

type bytesCollectProcessor struct {
	name            string
	maxDecodedBytes int64
	buffer          bytes.Buffer
}

type bytesPrefixCollectProcessor struct {
	name            string
	maxDecodedBytes int64
	buffer          bytes.Buffer
	truncated       bool
}

func CollectBytes(ctx context.Context, source Source, options Options) ([]byte, Stats, error) {
	if options.MaxDecodedBytes <= 0 {
		options.MaxDecodedBytes = defaultCollectBytesLimit
	}
	processor := &bytesCollectProcessor{name: source.Name, maxDecodedBytes: options.MaxDecodedBytes}
	stats, err := New(source, nil, []Processor{processor}, options).Run(ctx)
	if err != nil {
		return nil, stats, err
	}
	return append([]byte(nil), processor.buffer.Bytes()...), stats, nil
}

func CollectBytesPrefix(ctx context.Context, source Source, options Options) ([]byte, Stats, bool, error) {
	if options.MaxDecodedBytes <= 0 {
		options.MaxDecodedBytes = defaultCollectBytesLimit
	}
	chunkSize := options.ChunkBytes
	if chunkSize <= 0 {
		chunkSize = 32 << 10
	}
	processor := &bytesPrefixCollectProcessor{name: source.Name, maxDecodedBytes: options.MaxDecodedBytes}
	runOptions := options
	runOptions.MaxDecodedBytes = options.MaxDecodedBytes + int64(chunkSize)
	stats, err := New(source, nil, []Processor{processor}, runOptions).Run(ctx)
	if err != nil {
		return nil, stats, processor.truncated, err
	}
	return append([]byte(nil), processor.buffer.Bytes()...), stats, processor.truncated, nil
}

func (p *bytesCollectProcessor) Name() string {
	if p == nil || p.name == "" {
		return "bytes-collect-processor"
	}
	return p.name + "-bytes-collect-processor"
}

func (p *bytesCollectProcessor) OnStart(context.Context, Source, EventSink) error {
	return nil
}

func (p *bytesCollectProcessor) OnChunk(_ context.Context, chunk []byte, _ EventSink) (Decision, error) {
	if p == nil {
		return Decision{Stop: true, Reason: "bytes collect stream processor is unavailable"}, nil
	}
	if int64(p.buffer.Len()+len(chunk)) > p.maxDecodedBytes {
		return Decision{Stop: true, Reason: "decoded byte limit reached"}, fmt.Errorf("remote %s decoded bytes exceeded %d bytes", p.name, p.maxDecodedBytes)
	}
	_, err := p.buffer.Write(chunk)
	return Decision{}, err
}

func (p *bytesCollectProcessor) OnFinish(context.Context, Stats, EventSink) error {
	return nil
}

func (p *bytesPrefixCollectProcessor) Name() string {
	if p == nil || p.name == "" {
		return "bytes-prefix-collect-processor"
	}
	return p.name + "-bytes-prefix-collect-processor"
}

func (p *bytesPrefixCollectProcessor) OnStart(context.Context, Source, EventSink) error {
	return nil
}

func (p *bytesPrefixCollectProcessor) OnChunk(_ context.Context, chunk []byte, _ EventSink) (Decision, error) {
	if p == nil {
		return Decision{Stop: true, Reason: "bytes prefix collect stream processor is unavailable"}, nil
	}
	remaining := int(p.maxDecodedBytes) - p.buffer.Len()
	if remaining <= 0 {
		p.truncated = true
		return Decision{Stop: true, Reason: "decoded byte prefix limit reached"}, nil
	}
	if len(chunk) > remaining {
		if remaining > 0 {
			if _, err := p.buffer.Write(chunk[:remaining]); err != nil {
				return Decision{}, err
			}
		}
		p.truncated = true
		return Decision{Stop: true, Reason: "decoded byte prefix limit reached"}, nil
	}
	_, err := p.buffer.Write(chunk)
	return Decision{}, err
}

func (p *bytesPrefixCollectProcessor) OnFinish(context.Context, Stats, EventSink) error {
	return nil
}
