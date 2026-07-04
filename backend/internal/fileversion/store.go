// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package fileversion

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
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

const MaxVersionContentBytes int64 = 64 << 20
const maxFileVersionKeyFileBytes int64 = 4096

type Store struct {
	db   *sql.DB
	aead cipher.AEAD
}

type Options struct {
	Path    string
	KeyPath string
}

type SaveInput struct {
	ServerID      string
	Path          string
	Role          string
	Content       []byte
	RemoteSHA256  string
	ActorDeviceID string
	ActorLabel    string
	AuditEventID  string
}

type VersionSummary struct {
	ID            string    `json:"id"`
	ServerID      string    `json:"server_id"`
	Path          string    `json:"path"`
	Role          string    `json:"role"`
	ContentSHA256 string    `json:"content_sha256"`
	RemoteSHA256  string    `json:"remote_sha256"`
	SizeBytes     int64     `json:"size_bytes"`
	ActorDeviceID string    `json:"actor_device_id"`
	ActorLabel    string    `json:"actor_label"`
	AuditEventID  string    `json:"audit_event_id"`
	CreatedAt     time.Time `json:"created_at"`
}

type VersionContent struct {
	VersionSummary
	Content  string `json:"content"`
	Encoding string `json:"encoding"`
}

func Open(options Options) (*Store, error) {
	path := strings.TrimSpace(options.Path)
	if path == "" {
		return nil, fmt.Errorf("file version database path is required")
	}
	keyPath := strings.TrimSpace(options.KeyPath)
	if keyPath == "" {
		keyPath = strings.TrimSuffix(path, filepath.Ext(path)) + ".key"
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	key, err := loadOrCreateKey(keyPath)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	store := &Store{db: db, aead: aead}
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
		`CREATE TABLE IF NOT EXISTS files (
			id TEXT PRIMARY KEY,
			server_id TEXT NOT NULL,
			path_hash TEXT NOT NULL,
			path TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE(server_id, path_hash)
		)`,
		`CREATE TABLE IF NOT EXISTS versions (
			id TEXT PRIMARY KEY,
			file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
			role TEXT NOT NULL,
			content_sha256 TEXT NOT NULL,
			remote_sha256 TEXT NOT NULL DEFAULT '',
			size_bytes INTEGER NOT NULL,
			compression TEXT NOT NULL,
			encryption TEXT NOT NULL,
			nonce_b64 TEXT NOT NULL,
			blob BLOB NOT NULL,
			actor_device_id TEXT NOT NULL DEFAULT '',
			actor_label TEXT NOT NULL DEFAULT '',
			audit_event_id TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_versions_file_created ON versions(file_id, created_at DESC)`,
	}
	for _, stmt := range statements {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) Save(ctx context.Context, input SaveInput) (VersionSummary, error) {
	serverID := strings.TrimSpace(input.ServerID)
	path := strings.TrimSpace(input.Path)
	if serverID == "" || path == "" {
		return VersionSummary{}, fmt.Errorf("server id and path are required for file versioning")
	}
	role := strings.TrimSpace(input.Role)
	if role == "" {
		role = "snapshot"
	}
	content := append([]byte(nil), input.Content...)
	contentHash := sha256Hex(content)
	compressed, err := gzipBytes(content)
	if err != nil {
		return VersionSummary{}, err
	}
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return VersionSummary{}, err
	}
	sealed := s.aead.Seal(nil, nonce, compressed, []byte(serverID+"\n"+path+"\n"+contentHash))
	now := time.Now().UTC()
	pathHash := sha256Hex([]byte(path))
	fileID := uuid.NewString()
	versionID := uuid.NewString()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return VersionSummary{}, err
	}
	defer tx.Rollback()
	var existingFileID string
	err = tx.QueryRowContext(ctx, `SELECT id FROM files WHERE server_id = ? AND path_hash = ?`, serverID, pathHash).Scan(&existingFileID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return VersionSummary{}, err
	}
	if existingFileID == "" {
		_, err = tx.ExecContext(ctx, `INSERT INTO files (id, server_id, path_hash, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, fileID, serverID, pathHash, path, formatTime(now), formatTime(now))
		if err != nil {
			return VersionSummary{}, err
		}
	} else {
		fileID = existingFileID
		_, err = tx.ExecContext(ctx, `UPDATE files SET path = ?, updated_at = ? WHERE id = ?`, path, formatTime(now), fileID)
		if err != nil {
			return VersionSummary{}, err
		}
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO versions (id, file_id, role, content_sha256, remote_sha256, size_bytes, compression, encryption, nonce_b64, blob, actor_device_id, actor_label, audit_event_id, created_at)
		VALUES (?, ?, ?, ?, ?, ?, 'gzip', 'aes-256-gcm', ?, ?, ?, ?, ?, ?)
	`, versionID, fileID, role, contentHash, strings.TrimSpace(input.RemoteSHA256), int64(len(content)), base64.StdEncoding.EncodeToString(nonce), sealed, strings.TrimSpace(input.ActorDeviceID), strings.TrimSpace(input.ActorLabel), strings.TrimSpace(input.AuditEventID), formatTime(now))
	if err != nil {
		return VersionSummary{}, err
	}
	if err := tx.Commit(); err != nil {
		return VersionSummary{}, err
	}
	return VersionSummary{ID: versionID, ServerID: serverID, Path: path, Role: role, ContentSHA256: contentHash, RemoteSHA256: strings.TrimSpace(input.RemoteSHA256), SizeBytes: int64(len(content)), ActorDeviceID: strings.TrimSpace(input.ActorDeviceID), ActorLabel: strings.TrimSpace(input.ActorLabel), AuditEventID: strings.TrimSpace(input.AuditEventID), CreatedAt: now}, nil
}

func (s *Store) List(ctx context.Context, serverID string, path string, limit int) ([]VersionSummary, error) {
	serverID = strings.TrimSpace(serverID)
	path = strings.TrimSpace(path)
	if serverID == "" || path == "" {
		return nil, fmt.Errorf("server id and path are required")
	}
	if limit <= 0 || limit > 200 {
		limit = 80
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT v.id, f.server_id, f.path, v.role, v.content_sha256, v.remote_sha256, v.size_bytes, v.actor_device_id, v.actor_label, v.audit_event_id, v.created_at
		FROM versions v JOIN files f ON f.id = v.file_id
		WHERE f.server_id = ? AND f.path_hash = ?
		ORDER BY v.created_at DESC
		LIMIT ?
	`, serverID, sha256Hex([]byte(path)), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []VersionSummary
	for rows.Next() {
		item, err := scanSummary(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) Content(ctx context.Context, versionID string) (VersionContent, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT v.id, f.server_id, f.path, v.role, v.content_sha256, v.remote_sha256, v.size_bytes, v.actor_device_id, v.actor_label, v.audit_event_id, v.created_at, v.nonce_b64, v.blob
		FROM versions v JOIN files f ON f.id = v.file_id
		WHERE v.id = ?
	`, strings.TrimSpace(versionID))
	summary, nonceB64, blob, err := scanContentRow(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return VersionContent{}, ErrNotFound
		}
		return VersionContent{}, err
	}
	nonce, err := base64.StdEncoding.DecodeString(nonceB64)
	if err != nil {
		return VersionContent{}, err
	}
	compressed, err := s.aead.Open(nil, nonce, blob, []byte(summary.ServerID+"\n"+summary.Path+"\n"+summary.ContentSHA256))
	if err != nil {
		return VersionContent{}, err
	}
	content, err := gunzipBytes(compressed)
	if err != nil {
		return VersionContent{}, err
	}
	if sha256Hex(content) != summary.ContentSHA256 {
		return VersionContent{}, fmt.Errorf("stored version content hash mismatch")
	}
	return VersionContent{VersionSummary: summary, Content: string(content), Encoding: "utf-8"}, nil
}

func (s *Store) AttachAuditEvent(ctx context.Context, versionID string, auditEventID string) error {
	versionID = strings.TrimSpace(versionID)
	auditEventID = strings.TrimSpace(auditEventID)
	if versionID == "" || auditEventID == "" {
		return nil
	}
	result, err := s.db.ExecContext(ctx, `UPDATE versions SET audit_event_id = ? WHERE id = ?`, auditEventID, versionID)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrNotFound
	}
	return nil
}

var ErrNotFound = errors.New("file version not found")

type summaryScanner interface{ Scan(dest ...any) error }

func scanSummary(rows *sql.Rows) (VersionSummary, error) {
	var item VersionSummary
	var createdRaw string
	if err := rows.Scan(&item.ID, &item.ServerID, &item.Path, &item.Role, &item.ContentSHA256, &item.RemoteSHA256, &item.SizeBytes, &item.ActorDeviceID, &item.ActorLabel, &item.AuditEventID, &createdRaw); err != nil {
		return VersionSummary{}, err
	}
	created, err := time.Parse(time.RFC3339Nano, createdRaw)
	if err != nil {
		return VersionSummary{}, err
	}
	item.CreatedAt = created
	return item, nil
}

func scanContentRow(row summaryScanner) (VersionSummary, string, []byte, error) {
	var item VersionSummary
	var createdRaw string
	var nonceB64 string
	var blob []byte
	if err := row.Scan(&item.ID, &item.ServerID, &item.Path, &item.Role, &item.ContentSHA256, &item.RemoteSHA256, &item.SizeBytes, &item.ActorDeviceID, &item.ActorLabel, &item.AuditEventID, &createdRaw, &nonceB64, &blob); err != nil {
		return VersionSummary{}, "", nil, err
	}
	created, err := time.Parse(time.RFC3339Nano, createdRaw)
	if err != nil {
		return VersionSummary{}, "", nil, err
	}
	item.CreatedAt = created
	return item, nonceB64, blob, nil
}

func gzipBytes(content []byte) ([]byte, error) {
	var buf bytes.Buffer
	writer := gzip.NewWriter(&buf)
	if _, err := writer.Write(content); err != nil {
		writer.Close()
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func gunzipBytes(content []byte) ([]byte, error) {
	return gunzipBytesLimited(content, MaxVersionContentBytes)
}

func gunzipBytesLimited(content []byte, limit int64) ([]byte, error) {
	if limit <= 0 || limit > MaxVersionContentBytes {
		limit = MaxVersionContentBytes
	}
	reader, err := gzip.NewReader(bytes.NewReader(content))
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	var buffer bytes.Buffer
	if _, err := io.Copy(&buffer, io.LimitReader(reader, limit+1)); err != nil {
		return nil, err
	}
	if int64(buffer.Len()) > limit {
		return nil, fmt.Errorf("stored file version content exceeds %d bytes", limit)
	}
	return buffer.Bytes(), nil
}

func loadOrCreateKey(path string) ([]byte, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if data, err := readKeyFile(path, maxFileVersionKeyFileBytes); err == nil {
		decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(data)))
		if err != nil {
			return nil, err
		}
		if len(decoded) != 32 {
			return nil, fmt.Errorf("file version encryption key has invalid length")
		}
		return decoded, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, []byte(base64.StdEncoding.EncodeToString(key)+"\n"), 0o600); err != nil {
		return nil, err
	}
	return key, nil
}

func readKeyFile(path string, maxBytes int64) ([]byte, error) {
	if maxBytes <= 0 {
		return nil, fmt.Errorf("maxBytes must be positive")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("key file exceeds %d bytes: %s", maxBytes, path)
	}
	return data, nil
}

func sha256Hex(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

func formatTime(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }
