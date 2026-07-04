// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package auditlog

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"
)

type Store struct {
	db         sqlDB
	publicKey  ed25519.PublicKey
	privateKey ed25519.PrivateKey
}

const maxAuditSigningKeyFileBytes int64 = 4096

type sqlDB interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	BeginTx(ctx context.Context, opts *sql.TxOptions) (*sql.Tx, error)
	Close() error
}

type Options struct {
	Path    string
	KeyPath string
}

type EventInput struct {
	Type          string            `json:"type"`
	ActorDeviceID string            `json:"actor_device_id"`
	ActorLabel    string            `json:"actor_label"`
	ClientIP      string            `json:"client_ip"`
	ServerID      string            `json:"server_id"`
	Operation     string            `json:"operation"`
	Path          string            `json:"path"`
	BeforeHash    string            `json:"before_hash"`
	AfterHash     string            `json:"after_hash"`
	VersionID     string            `json:"version_id"`
	RequestID     string            `json:"request_id"`
	Metadata      map[string]string `json:"metadata,omitempty"`
}

type Event struct {
	ID            string            `json:"id"`
	Sequence      int64             `json:"sequence"`
	Type          string            `json:"type"`
	ActorDeviceID string            `json:"actor_device_id"`
	ActorLabel    string            `json:"actor_label"`
	ClientIP      string            `json:"client_ip"`
	ServerID      string            `json:"server_id"`
	Operation     string            `json:"operation"`
	PathHash      string            `json:"path_hash"`
	Path          string            `json:"path"`
	BeforeHash    string            `json:"before_hash"`
	AfterHash     string            `json:"after_hash"`
	VersionID     string            `json:"version_id"`
	RequestID     string            `json:"request_id"`
	Metadata      map[string]string `json:"metadata,omitempty"`
	PrevHash      string            `json:"prev_hash"`
	Hash          string            `json:"hash"`
	Signature     string            `json:"signature"`
	CreatedAt     time.Time         `json:"created_at"`
}

type Head struct {
	Sequence  int64     `json:"sequence"`
	Hash      string    `json:"hash"`
	Signature string    `json:"signature"`
	PublicKey string    `json:"public_key"`
	CreatedAt time.Time `json:"created_at"`
}

type VerifyResult struct {
	OK        bool   `json:"ok"`
	Events    int64  `json:"events"`
	HeadHash  string `json:"head_hash"`
	PublicKey string `json:"public_key"`
	Message   string `json:"message"`
}

func Open(options Options) (*Store, error) {
	path := strings.TrimSpace(options.Path)
	if path == "" {
		return nil, fmt.Errorf("audit database path is required")
	}
	keyPath := strings.TrimSpace(options.KeyPath)
	if keyPath == "" {
		keyPath = strings.TrimSuffix(path, filepath.Ext(path)) + ".signing.key"
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	pub, priv, err := loadOrCreateSigningKey(keyPath)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	store := &Store{db: db, publicKey: pub, privateKey: priv}
	if err := store.migrate(context.Background()); err != nil {
		db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate(ctx context.Context) error {
	statements := []string{
		`PRAGMA journal_mode = WAL`,
		`PRAGMA busy_timeout = 5000`,
		`CREATE TABLE IF NOT EXISTS audit_events (
			id TEXT PRIMARY KEY,
			sequence INTEGER NOT NULL UNIQUE,
			type TEXT NOT NULL,
			actor_device_id TEXT NOT NULL DEFAULT '',
			actor_label TEXT NOT NULL DEFAULT '',
			client_ip TEXT NOT NULL DEFAULT '',
			server_id TEXT NOT NULL DEFAULT '',
			operation TEXT NOT NULL DEFAULT '',
			path_hash TEXT NOT NULL DEFAULT '',
			path TEXT NOT NULL DEFAULT '',
			before_hash TEXT NOT NULL DEFAULT '',
			after_hash TEXT NOT NULL DEFAULT '',
			version_id TEXT NOT NULL DEFAULT '',
			request_id TEXT NOT NULL DEFAULT '',
			metadata_json TEXT NOT NULL DEFAULT '{}',
			prev_hash TEXT NOT NULL DEFAULT '',
			hash TEXT NOT NULL,
			signature TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_server_created ON audit_events(server_id, created_at DESC)`,
	}
	for _, stmt := range statements {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) Append(ctx context.Context, input EventInput) (Event, error) {
	input = normalizeEventInput(input)
	if input.Type == "" {
		return Event{}, fmt.Errorf("audit event type is required")
	}
	now := time.Now().UTC()
	metadata := input.Metadata
	metadataJSON, err := json.Marshal(metadata)
	if err != nil {
		return Event{}, err
	}
	path := input.Path
	event := Event{
		ID: uuid.NewString(), Type: input.Type, ActorDeviceID: input.ActorDeviceID, ActorLabel: input.ActorLabel, ClientIP: input.ClientIP, ServerID: input.ServerID, Operation: input.Operation, Path: path, PathHash: hashString(path), BeforeHash: input.BeforeHash, AfterHash: input.AfterHash, VersionID: input.VersionID, RequestID: input.RequestID, Metadata: metadata, CreatedAt: now,
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Event{}, err
	}
	defer tx.Rollback()
	var prevSequence sql.NullInt64
	var prevHash sql.NullString
	var prevCreated sql.NullString
	err = tx.QueryRowContext(ctx, `SELECT sequence, hash, created_at FROM audit_events ORDER BY sequence DESC LIMIT 1`).Scan(&prevSequence, &prevHash, &prevCreated)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return Event{}, err
	}
	if prevSequence.Valid {
		event.Sequence = prevSequence.Int64 + 1
		event.PrevHash = prevHash.String
	} else {
		event.Sequence = 1
	}
	canonical, err := canonicalEvent(event, metadataJSON)
	if err != nil {
		return Event{}, err
	}
	sum := sha256.Sum256(canonical)
	event.Hash = hex.EncodeToString(sum[:])
	event.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(s.privateKey, []byte(event.Hash)))
	_, err = tx.ExecContext(ctx, `
		INSERT INTO audit_events (id, sequence, type, actor_device_id, actor_label, client_ip, server_id, operation, path_hash, path, before_hash, after_hash, version_id, request_id, metadata_json, prev_hash, hash, signature, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, event.ID, event.Sequence, event.Type, event.ActorDeviceID, event.ActorLabel, event.ClientIP, event.ServerID, event.Operation, event.PathHash, event.Path, event.BeforeHash, event.AfterHash, event.VersionID, event.RequestID, string(metadataJSON), event.PrevHash, event.Hash, event.Signature, formatTime(event.CreatedAt))
	if err != nil {
		return Event{}, err
	}
	if err := tx.Commit(); err != nil {
		return Event{}, err
	}
	return event, nil
}

func normalizeEventInput(input EventInput) EventInput {
	return EventInput{
		Type:          auditSafeMetadataString(input.Type, maxAuditEventTypeRunes),
		ActorDeviceID: auditSafeMetadataString(input.ActorDeviceID, maxAuditEventIDRunes),
		ActorLabel:    auditSafeMetadataString(input.ActorLabel, maxAuditEventLabelRunes),
		ClientIP:      auditSafeMetadataString(input.ClientIP, maxAuditEventIDRunes),
		ServerID:      auditSafeMetadataString(input.ServerID, maxAuditEventIDRunes),
		Operation:     auditSafeMetadataString(input.Operation, maxAuditEventIDRunes),
		Path:          auditSafeMetadataString(input.Path, maxAuditEventPathRunes),
		BeforeHash:    auditSafeMetadataString(input.BeforeHash, maxAuditEventHashRunes),
		AfterHash:     auditSafeMetadataString(input.AfterHash, maxAuditEventHashRunes),
		VersionID:     auditSafeMetadataString(input.VersionID, maxAuditEventIDRunes),
		RequestID:     auditSafeMetadataString(input.RequestID, maxAuditEventIDRunes),
		Metadata:      normalizeMetadata(input.Metadata),
	}
}

func (s *Store) Head(ctx context.Context) (Head, error) {
	row := s.db.QueryRowContext(ctx, `SELECT sequence, hash, signature, created_at FROM audit_events ORDER BY sequence DESC LIMIT 1`)
	var head Head
	var createdRaw string
	if err := row.Scan(&head.Sequence, &head.Hash, &head.Signature, &createdRaw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Head{PublicKey: base64.StdEncoding.EncodeToString(s.publicKey)}, nil
		}
		return Head{}, err
	}
	created, err := time.Parse(time.RFC3339Nano, createdRaw)
	if err != nil {
		return Head{}, err
	}
	head.CreatedAt = created
	head.PublicKey = base64.StdEncoding.EncodeToString(s.publicKey)
	return head, nil
}

func (s *Store) Verify(ctx context.Context) (VerifyResult, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, sequence, type, actor_device_id, actor_label, client_ip, server_id, operation, path_hash, path, before_hash, after_hash, version_id, request_id, metadata_json, prev_hash, hash, signature, created_at
		FROM audit_events
		ORDER BY sequence ASC
	`)
	if err != nil {
		return VerifyResult{}, err
	}
	defer rows.Close()
	result := VerifyResult{OK: true, PublicKey: base64.StdEncoding.EncodeToString(s.publicKey), Message: "Audit chain is valid."}
	expectedSequence := int64(1)
	previousHash := ""
	for rows.Next() {
		var event Event
		var metadataRaw string
		var createdRaw string
		if err := rows.Scan(&event.ID, &event.Sequence, &event.Type, &event.ActorDeviceID, &event.ActorLabel, &event.ClientIP, &event.ServerID, &event.Operation, &event.PathHash, &event.Path, &event.BeforeHash, &event.AfterHash, &event.VersionID, &event.RequestID, &metadataRaw, &event.PrevHash, &event.Hash, &event.Signature, &createdRaw); err != nil {
			return VerifyResult{}, err
		}
		created, err := time.Parse(time.RFC3339Nano, createdRaw)
		if err != nil {
			return VerifyResult{}, err
		}
		event.CreatedAt = created
		if event.Sequence != expectedSequence {
			return invalidVerify(result, fmt.Sprintf("Audit sequence gap: expected %d, got %d.", expectedSequence, event.Sequence)), nil
		}
		if event.PrevHash != previousHash {
			return invalidVerify(result, fmt.Sprintf("Audit chain break at sequence %d.", event.Sequence)), nil
		}
		var metadata map[string]string
		if err := json.Unmarshal([]byte(metadataRaw), &metadata); err != nil {
			return invalidVerify(result, fmt.Sprintf("Audit metadata is invalid JSON at sequence %d.", event.Sequence)), nil
		}
		event.Metadata = metadata
		canonical, err := canonicalEvent(event, []byte(metadataRaw))
		if err != nil {
			return VerifyResult{}, err
		}
		sum := sha256.Sum256(canonical)
		if hex.EncodeToString(sum[:]) != event.Hash {
			return invalidVerify(result, fmt.Sprintf("Audit hash mismatch at sequence %d.", event.Sequence)), nil
		}
		signature, err := base64.StdEncoding.DecodeString(event.Signature)
		if err != nil || !ed25519.Verify(s.publicKey, []byte(event.Hash), signature) {
			return invalidVerify(result, fmt.Sprintf("Audit signature mismatch at sequence %d.", event.Sequence)), nil
		}
		result.Events = event.Sequence
		result.HeadHash = event.Hash
		previousHash = event.Hash
		expectedSequence++
	}
	if err := rows.Err(); err != nil {
		return VerifyResult{}, err
	}
	if result.Events == 0 {
		result.Message = "Audit chain has no events yet."
	}
	return result, nil
}

func invalidVerify(result VerifyResult, message string) VerifyResult {
	result.OK = false
	result.Message = message
	return result
}

func canonicalEvent(event Event, metadataJSON []byte) ([]byte, error) {
	payload := map[string]any{
		"id": event.ID, "sequence": event.Sequence, "type": event.Type, "actor_device_id": event.ActorDeviceID, "actor_label": event.ActorLabel, "client_ip": event.ClientIP, "server_id": event.ServerID, "operation": event.Operation, "path_hash": event.PathHash, "path": event.Path, "before_hash": event.BeforeHash, "after_hash": event.AfterHash, "version_id": event.VersionID, "request_id": event.RequestID, "metadata": json.RawMessage(metadataJSON), "prev_hash": event.PrevHash, "created_at": formatTime(event.CreatedAt),
	}
	return json.Marshal(payload)
}

func normalizeMetadata(values map[string]string) map[string]string {
	out := map[string]string{}
	for key, value := range values {
		key = auditSafeMetadataString(key, maxAuditMetadataKeyRunes)
		if key == "" {
			continue
		}
		out[key] = auditSafeMetadataString(value, maxAuditMetadataValueRunes)
	}
	return out
}

const (
	maxAuditMetadataKeyRunes   = 80
	maxAuditMetadataValueRunes = 500
	maxAuditEventTypeRunes     = 128
	maxAuditEventIDRunes       = 256
	maxAuditEventLabelRunes    = 256
	maxAuditEventHashRunes     = 256
	maxAuditEventPathRunes     = 4096
)

func auditSafeMetadataString(value string, maxRunes int) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || maxRunes <= 0 {
		return ""
	}
	var builder strings.Builder
	runes := 0
	truncated := false
	for _, r := range trimmed {
		if runes >= maxRunes {
			truncated = true
			break
		}
		switch {
		case r < 0x20 || r == 0x7f || (r >= 0x80 && r <= 0x9f):
			fmt.Fprintf(&builder, "\\u%04x", r)
		default:
			builder.WriteRune(r)
		}
		runes++
	}
	if truncated {
		builder.WriteString("…")
	}
	return builder.String()
}

func loadOrCreateSigningKey(path string) (ed25519.PublicKey, ed25519.PrivateKey, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, nil, err
	}
	if data, err := readSigningKeyFile(path); err == nil {
		decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(data)))
		if err != nil {
			return nil, nil, err
		}
		if len(decoded) != ed25519.PrivateKeySize {
			return nil, nil, fmt.Errorf("audit signing key has invalid length")
		}
		priv := ed25519.PrivateKey(decoded)
		pub := priv.Public().(ed25519.PublicKey)
		return pub, priv, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, nil, err
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	if err := os.WriteFile(path, []byte(base64.StdEncoding.EncodeToString(priv)+"\n"), 0o600); err != nil {
		return nil, nil, err
	}
	return pub, priv, nil
}

func readSigningKeyFile(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxAuditSigningKeyFileBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxAuditSigningKeyFileBytes {
		return nil, fmt.Errorf("audit signing key file exceeds %d bytes: %s", maxAuditSigningKeyFileBytes, path)
	}
	return data, nil
}

func hashString(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
func formatTime(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }
