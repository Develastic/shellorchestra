// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package batchoutput

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const (
	PreviewBytes        = 256 << 10
	DefaultMaxBytes     = 256 << 10
	MinimumMaxBytes     = 16 << 10
	MaximumMaxBytes     = 256 << 20
	outputFilePerm      = 0o600
	outputDirectoryPerm = 0o700
)

type Store struct {
	root string
}

type Result struct {
	Preview   string
	Truncated bool
	Ref       string
	Bytes     int64
}

type Capture struct {
	mu        sync.Mutex
	store     Store
	ref       string
	tmpPath   string
	finalPath string
	file      *os.File
	limit     int64
	preview   boundedPreview
	bytes     int64
	truncated bool
	closed    bool
}

func RootForDatabase(databasePath string) string {
	base := filepath.Dir(filepath.Clean(databasePath))
	if strings.TrimSpace(base) == "." || strings.TrimSpace(base) == "" {
		base = "."
	}
	return filepath.Join(base, "batch-script-output")
}

func New(root string) Store {
	return Store{root: filepath.Clean(root)}
}

func (s Store) NewCapture(runID string, serverID string, stream string, maxBytes int64) (*Capture, error) {
	if strings.TrimSpace(s.root) == "" {
		return nil, fmt.Errorf("batch output root is required")
	}
	runToken, err := safeToken(runID)
	if err != nil {
		return nil, fmt.Errorf("invalid batch run id: %w", err)
	}
	serverToken, err := safeToken(serverID)
	if err != nil {
		return nil, fmt.Errorf("invalid batch target id: %w", err)
	}
	streamToken, err := safeStreamToken(stream)
	if err != nil {
		return nil, err
	}
	maxBytes = NormalizeMaxBytes(maxBytes)
	ref := filepath.ToSlash(filepath.Join("runs", runToken, serverToken, streamToken+".log"))
	finalPath, err := s.safePath(ref)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(finalPath), outputDirectoryPerm); err != nil {
		return nil, err
	}
	tmpDir := filepath.Join(s.root, "tmp")
	if err := os.MkdirAll(tmpDir, outputDirectoryPerm); err != nil {
		return nil, err
	}
	file, err := os.CreateTemp(tmpDir, streamToken+"-*.tmp")
	if err != nil {
		return nil, err
	}
	if err := file.Chmod(outputFilePerm); err != nil {
		_ = file.Close()
		_ = os.Remove(file.Name())
		return nil, err
	}
	return &Capture{store: s, ref: ref, tmpPath: file.Name(), finalPath: finalPath, file: file, limit: maxBytes, preview: boundedPreview{limit: PreviewBytes}}, nil
}

func NormalizeMaxBytes(value int64) int64 {
	if value <= 0 {
		return DefaultMaxBytes
	}
	if value < MinimumMaxBytes {
		return MinimumMaxBytes
	}
	if value > MaximumMaxBytes {
		return MaximumMaxBytes
	}
	return value
}

func (c *Capture) Write(data []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return 0, io.ErrClosedPipe
	}
	_ = c.preview.Write(data)
	if c.bytes >= c.limit {
		c.truncated = true
		return len(data), nil
	}
	remaining := c.limit - c.bytes
	chunk := data
	if int64(len(chunk)) > remaining {
		chunk = data[:remaining]
		c.truncated = true
	}
	if len(chunk) > 0 {
		written, err := c.file.Write(chunk)
		c.bytes += int64(written)
		if err != nil {
			return written, err
		}
	}
	return len(data), nil
}

func (c *Capture) Finish() (Result, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return Result{}, io.ErrClosedPipe
	}
	c.closed = true
	if err := c.file.Close(); err != nil {
		_ = os.Remove(c.tmpPath)
		return Result{}, err
	}
	result := Result{Preview: c.preview.Text(), Truncated: c.truncated, Bytes: c.bytes}
	if c.bytes == 0 {
		_ = os.Remove(c.tmpPath)
		return result, nil
	}
	if err := os.Rename(c.tmpPath, c.finalPath); err != nil {
		_ = os.Remove(c.tmpPath)
		return Result{}, err
	}
	result.Ref = c.ref
	return result, nil
}

func (c *Capture) Abort() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.closed = true
	_ = c.file.Close()
	_ = os.Remove(c.tmpPath)
}

func (s Store) Open(ref string) (*os.File, error) {
	path, err := s.safePath(ref)
	if err != nil {
		return nil, err
	}
	return os.Open(path)
}

func (s Store) DeleteRefs(refs []string) {
	seen := map[string]bool{}
	for _, ref := range refs {
		ref = strings.TrimSpace(ref)
		if ref == "" || seen[ref] {
			continue
		}
		seen[ref] = true
		path, err := s.safePath(ref)
		if err != nil {
			continue
		}
		_ = os.Remove(path)
	}
}

func (s Store) safePath(ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return "", fmt.Errorf("batch output ref is required")
	}
	if filepath.IsAbs(ref) || strings.Contains(ref, "\\") {
		return "", fmt.Errorf("batch output ref is not safe")
	}
	clean := filepath.Clean(filepath.FromSlash(ref))
	if clean == "." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || clean == ".." {
		return "", fmt.Errorf("batch output ref escapes storage")
	}
	root := filepath.Clean(s.root)
	path := filepath.Join(root, clean)
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("batch output ref escapes storage")
	}
	return path, nil
}

type boundedPreview struct {
	limit     int
	data      bytes.Buffer
	truncated bool
}

func (w *boundedPreview) Write(data []byte) error {
	if w.limit <= 0 {
		w.truncated = true
		return nil
	}
	remaining := w.limit - w.data.Len()
	if remaining <= 0 {
		w.truncated = true
		return nil
	}
	if len(data) > remaining {
		_, _ = w.data.Write(data[:remaining])
		w.truncated = true
		return nil
	}
	_, _ = w.data.Write(data)
	return nil
}

func (w *boundedPreview) Text() string {
	return w.data.String()
}

func safeToken(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", fmt.Errorf("empty token")
	}
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			continue
		}
		return "", fmt.Errorf("token contains unsupported character %q", r)
	}
	return value, nil
}

func safeStreamToken(value string) (string, error) {
	value = strings.TrimSpace(value)
	switch value {
	case "stdout", "stderr", "preflight-stdout", "preflight-stderr":
		return value, nil
	default:
		return "", fmt.Errorf("unsupported batch output stream %q", value)
	}
}
