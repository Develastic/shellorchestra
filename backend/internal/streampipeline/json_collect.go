// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package streampipeline

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
)

type jsonObjectCollectProcessor struct {
	name            string
	maxDecodedBytes int64
	buffer          bytes.Buffer
	result          map[string]any
}

func CollectJSONObject(ctx context.Context, source Source, options Options) (map[string]any, Stats, error) {
	if options.MaxDecodedBytes <= 0 {
		options.MaxDecodedBytes = 32 << 20
	}
	processor := &jsonObjectCollectProcessor{name: source.Name, maxDecodedBytes: options.MaxDecodedBytes}
	stats, err := New(source, nil, []Processor{processor}, options).Run(ctx)
	if err != nil {
		return nil, stats, err
	}
	if processor.result == nil {
		return nil, stats, fmt.Errorf("remote %s stream finished without a JSON object", source.Name)
	}
	return processor.result, stats, nil
}

func (p *jsonObjectCollectProcessor) Name() string {
	if p == nil || p.name == "" {
		return "json-object-collect-processor"
	}
	return p.name + "-json-object-collect-processor"
}

func (p *jsonObjectCollectProcessor) OnStart(context.Context, Source, EventSink) error {
	return nil
}

func (p *jsonObjectCollectProcessor) OnChunk(_ context.Context, chunk []byte, _ EventSink) (Decision, error) {
	if p == nil {
		return Decision{Stop: true, Reason: "json collect stream processor is unavailable"}, nil
	}
	if int64(p.buffer.Len()+len(chunk)) > p.maxDecodedBytes {
		return Decision{Stop: true, Reason: "decoded JSON limit reached"}, fmt.Errorf("remote %s decoded JSON exceeded %d bytes", p.name, p.maxDecodedBytes)
	}
	_, err := p.buffer.Write(chunk)
	return Decision{}, err
}

func (p *jsonObjectCollectProcessor) OnFinish(_ context.Context, _ Stats, _ EventSink) error {
	if p == nil {
		return nil
	}
	if err := json.Unmarshal(p.buffer.Bytes(), &p.result); err != nil {
		return fmt.Errorf("remote %s stream did not return a JSON object: %w", p.name, err)
	}
	return nil
}
