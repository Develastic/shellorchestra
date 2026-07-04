// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package feedback

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"
)

type Store struct {
	db *sql.DB
}

type Options struct {
	Path string
}

type TicketInput struct {
	DeviceID              string
	DeviceLabel           string
	DeviceKind            string
	PageURL               string
	UserAgent             string
	Message               string
	ScreenshotContentType string
	ScreenshotPNG         []byte
}

type Ticket struct {
	ID                    string    `json:"id"`
	DeviceID              string    `json:"device_id"`
	DeviceLabel           string    `json:"device_label"`
	DeviceKind            string    `json:"device_kind"`
	PageURL               string    `json:"page_url"`
	UserAgent             string    `json:"user_agent"`
	Message               string    `json:"message"`
	ResolutionReport      string    `json:"resolution_report"`
	ScreenshotContentType string    `json:"screenshot_content_type"`
	ScreenshotBytes       int64     `json:"screenshot_bytes"`
	Status                string    `json:"status"`
	CreatedAt             time.Time `json:"created_at"`
	UpdatedAt             time.Time `json:"updated_at"`
	ProcessedAt           string    `json:"processed_at"`
}

type TicketDetails struct {
	Ticket
	ScreenshotPNG []byte
}

func Open(options Options) (*Store, error) {
	path := strings.TrimSpace(options.Path)
	if path == "" {
		return nil, fmt.Errorf("feedback database path is required")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	store := &Store{db: db}
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
		`CREATE TABLE IF NOT EXISTS feedback_tickets (
			id TEXT PRIMARY KEY,
			device_id TEXT NOT NULL,
			device_label TEXT NOT NULL,
			device_kind TEXT NOT NULL,
			page_url TEXT NOT NULL,
			user_agent TEXT NOT NULL,
			message TEXT NOT NULL,
			screenshot_content_type TEXT NOT NULL,
			screenshot_png BLOB NOT NULL,
			status TEXT NOT NULL DEFAULT 'open',
			resolution_report TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			processed_at TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_feedback_tickets_status_created ON feedback_tickets(status, created_at DESC)`,
	}
	for _, stmt := range statements {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	if err := s.ensureColumn(ctx, "resolution_report", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	if err := s.ensureColumn(ctx, "processed_at", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	return nil
}

func (s *Store) ensureColumn(ctx context.Context, column string, ddl string) error {
	rows, err := s.db.QueryContext(ctx, `PRAGMA table_info(feedback_tickets)`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name string
		var columnType string
		var notNull int
		var defaultValue sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &pk); err != nil {
			return err
		}
		if name == column {
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, fmt.Sprintf(`ALTER TABLE feedback_tickets ADD COLUMN %s %s`, column, ddl))
	return err
}

func (s *Store) Create(ctx context.Context, input TicketInput) (Ticket, error) {
	message := strings.TrimSpace(input.Message)
	if message == "" {
		return Ticket{}, fmt.Errorf("feedback message is required")
	}
	screenshot := append([]byte(nil), input.ScreenshotPNG...)
	if len(screenshot) == 0 {
		return Ticket{}, fmt.Errorf("feedback screenshot is required")
	}
	now := time.Now().UTC()
	ticket := Ticket{
		ID:                    uuid.NewString(),
		DeviceID:              strings.TrimSpace(input.DeviceID),
		DeviceLabel:           strings.TrimSpace(input.DeviceLabel),
		DeviceKind:            strings.TrimSpace(input.DeviceKind),
		PageURL:               strings.TrimSpace(input.PageURL),
		UserAgent:             strings.TrimSpace(input.UserAgent),
		Message:               message,
		ScreenshotContentType: strings.TrimSpace(input.ScreenshotContentType),
		ScreenshotBytes:       int64(len(screenshot)),
		Status:                "open",
		CreatedAt:             now,
		UpdatedAt:             now,
	}
	if ticket.ScreenshotContentType == "" {
		ticket.ScreenshotContentType = "image/png"
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO feedback_tickets (id, device_id, device_label, device_kind, page_url, user_agent, message, screenshot_content_type, screenshot_png, status, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, ticket.ID, ticket.DeviceID, ticket.DeviceLabel, ticket.DeviceKind, ticket.PageURL, ticket.UserAgent, ticket.Message, ticket.ScreenshotContentType, screenshot, ticket.Status, formatTime(ticket.CreatedAt), formatTime(ticket.UpdatedAt))
	if err != nil {
		return Ticket{}, err
	}
	return ticket, nil
}

func (s *Store) ListOpen(ctx context.Context, limit int) ([]Ticket, error) {
	return s.List(ctx, "open", limit)
}

func (s *Store) List(ctx context.Context, status string, limit int) ([]Ticket, error) {
	if limit <= 0 || limit > 200 {
		limit = 80
	}
	status = strings.TrimSpace(strings.ToLower(status))
	query := `
		SELECT id, device_id, device_label, device_kind, page_url, user_agent, message, resolution_report, screenshot_content_type, length(screenshot_png), status, created_at, updated_at, processed_at
		FROM feedback_tickets
	`
	args := []any{}
	if status != "" && status != "all" {
		query += ` WHERE status = ?`
		args = append(args, status)
	}
	if status == "open" {
		query += `
			ORDER BY created_at ASC
			LIMIT ?
		`
	} else {
		query += `
			ORDER BY created_at DESC
			LIMIT ?
		`
	}
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tickets []Ticket
	for rows.Next() {
		var ticket Ticket
		var createdRaw string
		var updatedRaw string
		var processedRaw string
		if err := rows.Scan(&ticket.ID, &ticket.DeviceID, &ticket.DeviceLabel, &ticket.DeviceKind, &ticket.PageURL, &ticket.UserAgent, &ticket.Message, &ticket.ResolutionReport, &ticket.ScreenshotContentType, &ticket.ScreenshotBytes, &ticket.Status, &createdRaw, &updatedRaw, &processedRaw); err != nil {
			return nil, err
		}
		ticket.CreatedAt = parseTime(createdRaw)
		ticket.UpdatedAt = parseTime(updatedRaw)
		ticket.ProcessedAt = strings.TrimSpace(processedRaw)
		tickets = append(tickets, ticket)
	}
	return tickets, rows.Err()
}

func (s *Store) Get(ctx context.Context, id string) (TicketDetails, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return TicketDetails{}, fmt.Errorf("feedback ticket id is required")
	}
	var ticket TicketDetails
	var createdRaw string
	var updatedRaw string
	var processedRaw string
	err := s.db.QueryRowContext(ctx, `
		SELECT id, device_id, device_label, device_kind, page_url, user_agent, message, resolution_report, screenshot_content_type, screenshot_png, status, created_at, updated_at, processed_at
		FROM feedback_tickets
		WHERE id = ?
	`, id).Scan(&ticket.ID, &ticket.DeviceID, &ticket.DeviceLabel, &ticket.DeviceKind, &ticket.PageURL, &ticket.UserAgent, &ticket.Message, &ticket.ResolutionReport, &ticket.ScreenshotContentType, &ticket.ScreenshotPNG, &ticket.Status, &createdRaw, &updatedRaw, &processedRaw)
	if err != nil {
		return TicketDetails{}, err
	}
	ticket.ScreenshotBytes = int64(len(ticket.ScreenshotPNG))
	ticket.CreatedAt = parseTime(createdRaw)
	ticket.UpdatedAt = parseTime(updatedRaw)
	ticket.ProcessedAt = strings.TrimSpace(processedRaw)
	return ticket, nil
}

func (s *Store) Update(ctx context.Context, id string, message *string, status *string, resolutionReport *string) (Ticket, error) {
	current, err := s.Get(ctx, id)
	if err != nil {
		return Ticket{}, err
	}
	nextMessage := current.Message
	if message != nil {
		nextMessage = strings.TrimSpace(*message)
		if nextMessage == "" {
			return Ticket{}, fmt.Errorf("feedback message is required")
		}
	}
	nextStatus := current.Status
	if status != nil {
		nextStatus = strings.TrimSpace(strings.ToLower(*status))
		if nextStatus == "" {
			return Ticket{}, fmt.Errorf("feedback status is required")
		}
		switch nextStatus {
		case "open", "processed", "answered", "archived":
		default:
			return Ticket{}, fmt.Errorf("unsupported feedback status: %s", nextStatus)
		}
	}
	nextResolutionReport := current.ResolutionReport
	if resolutionReport != nil {
		nextResolutionReport = strings.TrimSpace(*resolutionReport)
	}
	if nextStatus != "open" && strings.TrimSpace(nextResolutionReport) == "" {
		return Ticket{}, fmt.Errorf("resolution report or answer is required before closing a feedback ticket")
	}
	now := time.Now().UTC()
	processedAt := strings.TrimSpace(current.ProcessedAt)
	if nextStatus == "open" {
		processedAt = ""
	} else if strings.TrimSpace(processedAt) == "" {
		processedAt = formatTime(now)
	}
	if _, err := s.db.ExecContext(ctx, `
		UPDATE feedback_tickets
		SET message = ?, resolution_report = ?, status = ?, updated_at = ?, processed_at = ?
		WHERE id = ?
	`, nextMessage, nextResolutionReport, nextStatus, formatTime(now), processedAt, current.ID); err != nil {
		return Ticket{}, err
	}
	updated, err := s.Get(ctx, current.ID)
	if err != nil {
		return Ticket{}, err
	}
	updated.ScreenshotPNG = nil
	return updated.Ticket, nil
}

// Delete is intentionally a soft archive operation. Debug feedback tickets are
// retained for audit, agent follow-up reports, and future regression context.
func (s *Store) Delete(ctx context.Context, id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return fmt.Errorf("feedback ticket id is required")
	}
	now := formatTime(time.Now().UTC())
	result, err := s.db.ExecContext(ctx, `
		UPDATE feedback_tickets
		SET status = 'archived', updated_at = ?, processed_at = CASE WHEN processed_at = '' THEN ? ELSE processed_at END
		WHERE id = ?
	`, now, now, id)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func formatTime(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}

func parseTime(raw string) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return time.Time{}
	}
	return parsed
}
