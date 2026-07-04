// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package worker

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"shellorchestra/backend/internal/domain"
	"shellorchestra/backend/internal/runtime"
	"shellorchestra/backend/internal/store"
)

const (
	terminalPTYTerm                   = "xterm-256color"
	terminalPTYColorTerm              = "truecolor"
	terminalPOSIXBootstrapMarker      = "# shellorchestra-terminal-posix-bootstrap"
	terminalTmuxSessionName           = "shellorchestra"
	terminalInitialOutputWait         = 2 * time.Second
	maxInteractiveTerminalsPerDesktop = 7
)

var terminalIDPattern = regexp.MustCompile(`[^A-Za-z0-9_-]+`)

type TerminalManager struct {
	server           *Server
	mu               sync.RWMutex
	sessions         map[string]*terminalSession
	pendingSessions  map[string]int
	tokens           map[string]terminalBridgeRequest
	streams          map[string]*terminalStreamHub
	redrawTimers     map[string]*time.Timer
	streamTimers     map[string]*time.Timer
	streamDirty      map[string]bool
	renderer         *terminalRenderService
	listener         net.Listener
	bridgeSocketPath string
	tmuxServerReady  bool
	tmuxServerLock   sync.Mutex
	closed           chan struct{}
}

type terminalSession struct {
	ID                    string
	ServerID              string
	Title                 string
	State                 string
	Rows                  int
	Cols                  int
	WindowID              string
	PaneID                string
	BundleDir             string
	BridgeToken           string
	CreatedAt             time.Time
	UpdatedAt             time.Time
	PendingInitialCommand string
	InitialCommandMinCols int
	InitialCommandMinRows int
	InitialCommandSent    bool
	InitialResizeHandled  bool
	ResizeSeq             int
	InputMu               sync.Mutex
	ResizeCh              chan runtime.TerminalSize
}

type terminalBridgeRequest struct {
	SessionID string
	ServerID  string
	Rows      int
	Cols      int
	ExpiresAt time.Time
}

type terminalStreamHub struct {
	subscribers map[*terminalStreamSubscriber]struct{}
}

type terminalStreamSubscriber struct {
	ch chan terminalStreamServerMessage
}

type terminalCreateRequest struct {
	ServerID       string `json:"server_id"`
	Title          string `json:"title"`
	Rows           int    `json:"rows"`
	Cols           int    `json:"cols"`
	InitialCommand string `json:"initial_command"`
}

type terminalSessionRequest struct {
	SessionID string `json:"session_id"`
}

type terminalInputRequest struct {
	SessionID string `json:"session_id"`
	Data      string `json:"data"`
}

type terminalResizeRequest struct {
	SessionID string `json:"session_id"`
	Rows      int    `json:"rows"`
	Cols      int    `json:"cols"`
}

func NewTerminalManager(server *Server) *TerminalManager {
	baseDir := filepath.Dir(server.cfg.Database.Path)
	manager := &TerminalManager{
		server:           server,
		sessions:         map[string]*terminalSession{},
		pendingSessions:  map[string]int{},
		tokens:           map[string]terminalBridgeRequest{},
		streams:          map[string]*terminalStreamHub{},
		redrawTimers:     map[string]*time.Timer{},
		streamTimers:     map[string]*time.Timer{},
		streamDirty:      map[string]bool{},
		renderer:         newTerminalRenderService(),
		bridgeSocketPath: filepath.Join(baseDir, "terminals", "bridge.sock"),
		closed:           make(chan struct{}),
	}
	manager.resetPersistedDesktopRuntime(context.Background())
	return manager
}

func (m *TerminalManager) Snapshot() map[string]any {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return map[string]any{"sessions": len(m.sessions), "tmux_socket": m.server.cfg.Runtime.TmuxSocketPath}
}

func (m *TerminalManager) Close() {
	select {
	case <-m.closed:
	default:
		close(m.closed)
	}
	m.mu.Lock()
	listener := m.listener
	m.listener = nil
	m.sessions = map[string]*terminalSession{}
	m.pendingSessions = map[string]int{}
	m.tokens = map[string]terminalBridgeRequest{}
	streams := m.streams
	m.streams = map[string]*terminalStreamHub{}
	redrawTimers := m.redrawTimers
	m.redrawTimers = map[string]*time.Timer{}
	streamTimers := m.streamTimers
	m.streamTimers = map[string]*time.Timer{}
	m.streamDirty = map[string]bool{}
	m.renderer.reset()
	m.mu.Unlock()
	if listener != nil {
		_ = listener.Close()
	}
	for _, hub := range streams {
		for subscriber := range hub.subscribers {
			close(subscriber.ch)
		}
	}
	for _, timer := range redrawTimers {
		timer.Stop()
	}
	for _, timer := range streamTimers {
		timer.Stop()
	}
}

func (m *TerminalManager) resetPersistedDesktopRuntime(ctx context.Context) {
	m.killShellOrchestraTmuxSessions(ctx)
	if err := m.server.store.DeleteAllTerminalSessions(ctx); err != nil {
		log.Printf("failed to reset persisted terminal sessions after worker startup: %v", err)
	}
	if count, err := m.server.store.DeleteAllVirtualDesktopWindows(ctx); err != nil {
		log.Printf("failed to reset virtual desktop windows after worker startup: %v", err)
	} else if count > 0 {
		log.Printf("removed %d virtual desktop windows after worker startup reset", count)
	}
	baseDir := filepath.Join(filepath.Dir(m.server.cfg.Database.Path), "terminals")
	if err := os.RemoveAll(baseDir); err != nil {
		log.Printf("failed to reset terminal bridge bundles after worker startup: %v", err)
	}
}

func (m *TerminalManager) Create(ctx context.Context, request terminalCreateRequest) (domain.TerminalSnapshot, error) {
	server, err := m.server.store.GetServer(ctx, strings.TrimSpace(request.ServerID))
	if err != nil {
		return domain.TerminalSnapshot{}, err
	}
	slotReserved := false
	if err := m.reserveInteractiveTerminalSlot(server.ID); err != nil {
		return domain.TerminalSnapshot{}, err
	}
	slotReserved = true
	defer func() {
		if slotReserved {
			m.releaseInteractiveTerminalSlot(server.ID)
		}
	}()
	connectTimeout := time.Duration(m.server.cfg.Runtime.ConnectTimeoutSeconds)*time.Second + 10*time.Second
	connectCtx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	status, connectErr := m.server.runtime.Connect(connectCtx, server)
	if status.State != domain.StatusConnected {
		message := strings.TrimSpace(status.LastError)
		if message == "" && connectErr != nil {
			message = connectErr.Error()
		}
		if message == "" {
			message = fmt.Sprintf("server connection state is %s", status.State)
		}
		return domain.TerminalSnapshot{}, fmt.Errorf("could not establish the managed SSH connection before opening a terminal: %s", message)
	}
	if connectErr != nil {
		return domain.TerminalSnapshot{}, connectErr
	}
	if err := m.ensureBridgeListener(); err != nil {
		return domain.TerminalSnapshot{}, err
	}
	if err := m.ensureTmuxServer(ctx); err != nil {
		return domain.TerminalSnapshot{}, err
	}
	rows := normalizeTerminalRows(request.Rows)
	cols := normalizeTerminalCols(request.Cols)
	sessionID := newTerminalSessionID(server.ID)
	title := domain.SanitizeDisplayLabel(request.Title, 120)
	if title == "" {
		title = "Terminal"
	}
	bundle, err := m.prepareProxyBundle(sessionID, server.ID, rows, cols)
	if err != nil {
		return domain.TerminalSnapshot{}, err
	}
	windowID, paneID, err := m.createTmuxWindow(ctx, sessionID, bundle.LauncherPath, cols, rows)
	if err != nil {
		_ = os.RemoveAll(bundle.Dir)
		return domain.TerminalSnapshot{}, err
	}
	now := time.Now().UTC()
	pendingInitialCommand := strings.TrimRight(strings.TrimSpace(request.InitialCommand), "\r\n")
	initialCommandMinCols, initialCommandMinRows := terminalInitialCommandMinimumSize(pendingInitialCommand)
	session := &terminalSession{
		ID:                    sessionID,
		ServerID:              server.ID,
		Title:                 title,
		State:                 "running",
		Rows:                  rows,
		Cols:                  cols,
		WindowID:              windowID,
		PaneID:                paneID,
		BundleDir:             bundle.Dir,
		BridgeToken:           bundle.Token,
		CreatedAt:             now,
		UpdatedAt:             now,
		PendingInitialCommand: pendingInitialCommand,
		InitialCommandMinCols: initialCommandMinCols,
		InitialCommandMinRows: initialCommandMinRows,
		ResizeCh:              make(chan runtime.TerminalSize, 8),
	}
	m.mu.Lock()
	if existing := m.sessions[sessionID]; existing != nil {
		if existing.ResizeCh == nil {
			existing.ResizeCh = session.ResizeCh
		}
		existing.ServerID = session.ServerID
		existing.Title = session.Title
		existing.State = session.State
		existing.Rows = session.Rows
		existing.Cols = session.Cols
		existing.WindowID = session.WindowID
		existing.PaneID = session.PaneID
		existing.BundleDir = session.BundleDir
		existing.BridgeToken = session.BridgeToken
		existing.CreatedAt = session.CreatedAt
		existing.UpdatedAt = session.UpdatedAt
		existing.PendingInitialCommand = session.PendingInitialCommand
		existing.InitialCommandMinCols = session.InitialCommandMinCols
		existing.InitialCommandMinRows = session.InitialCommandMinRows
		existing.InitialCommandSent = session.InitialCommandSent
		existing.InitialResizeHandled = session.InitialResizeHandled
		session = existing
	} else {
		m.sessions[sessionID] = session
	}
	if slotReserved {
		m.releaseInteractiveTerminalSlotLocked(server.ID)
		slotReserved = false
	}
	m.mu.Unlock()
	if err := m.waitForPaneInitialOutput(ctx, paneID, terminalInitialOutputWait); err != nil {
		_ = m.CloseSession(context.Background(), sessionID)
		return domain.TerminalSnapshot{}, err
	}
	if err := m.server.store.UpsertTerminalSession(ctx, session.domain()); err != nil {
		_ = m.CloseSession(context.Background(), sessionID)
		return domain.TerminalSnapshot{}, err
	}
	return m.SnapshotSession(ctx, sessionID)
}

func (m *TerminalManager) reserveInteractiveTerminalSlot(serverID string) error {
	serverID = strings.TrimSpace(serverID)
	m.pruneUnattachedInteractiveTerminalSessions(context.Background(), serverID, 10*time.Second)
	m.mu.Lock()
	defer m.mu.Unlock()
	count := m.pendingSessions[serverID]
	for _, session := range m.sessions {
		if session != nil && session.ServerID == serverID {
			count++
		}
	}
	if count >= maxInteractiveTerminalsPerDesktop {
		return fmt.Errorf("This virtual desktop already has %d interactive terminal windows. Close one terminal window before opening another.", maxInteractiveTerminalsPerDesktop)
	}
	m.pendingSessions[serverID]++
	return nil
}

func (m *TerminalManager) pruneUnattachedInteractiveTerminalSessions(ctx context.Context, serverID string, gracePeriod time.Duration) {
	serverID = strings.TrimSpace(serverID)
	if serverID == "" {
		return
	}
	state, err := m.server.store.GetVirtualDesktopState(ctx, serverID)
	if err != nil {
		return
	}
	referenced := make(map[string]struct{}, len(state.Windows))
	for _, window := range state.Windows {
		sessionID := strings.TrimSpace(window.TerminalSessionID)
		if sessionID != "" {
			referenced[sessionID] = struct{}{}
		}
	}
	cutoff := time.Now().UTC().Add(-gracePeriod)
	orphanIDs := make([]string, 0)
	m.mu.RLock()
	for sessionID, session := range m.sessions {
		if session == nil || session.ServerID != serverID {
			continue
		}
		if _, ok := referenced[sessionID]; ok {
			continue
		}
		if !session.CreatedAt.IsZero() && session.CreatedAt.After(cutoff) {
			continue
		}
		orphanIDs = append(orphanIDs, sessionID)
	}
	m.mu.RUnlock()
	for _, sessionID := range orphanIDs {
		if err := m.CloseSession(ctx, sessionID); err != nil && !errors.Is(err, store.ErrNotFound) {
			log.Printf("failed to prune unattached terminal session %s for server %s: %v", sessionID, serverID, err)
		}
	}
}

func (m *TerminalManager) releaseInteractiveTerminalSlot(serverID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.releaseInteractiveTerminalSlotLocked(serverID)
}

func (m *TerminalManager) releaseInteractiveTerminalSlotLocked(serverID string) {
	serverID = strings.TrimSpace(serverID)
	if m.pendingSessions[serverID] <= 1 {
		delete(m.pendingSessions, serverID)
		return
	}
	m.pendingSessions[serverID]--
}

func (m *TerminalManager) waitForPaneInitialOutput(ctx context.Context, paneID string, timeout time.Duration) error {
	if strings.TrimSpace(paneID) == "" || timeout <= 0 {
		return nil
	}
	waitCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		metadata, metadataErr := m.paneMetadata(waitCtx, paneID)
		if metadataErr == nil && metadata.dead {
			capture, _ := m.tmux(waitCtx, "capture-pane", "-p", "-e", "-N", "-S", "-20", "-E", "-", "-t", paneID)
			message := strings.TrimSpace(capture.stdout)
			if message == "" {
				message = "the remote shell exited before the terminal became interactive"
			}
			return fmt.Errorf("terminal shell exited before it became interactive: %s", message)
		}
		capture, err := m.tmux(waitCtx, "capture-pane", "-p", "-e", "-N", "-S", "-80", "-E", "-", "-t", paneID)
		if err == nil && strings.TrimSpace(capture.stdout) != "" {
			return nil
		}
		select {
		case <-waitCtx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func (m *TerminalManager) waitForSessionSnapshotOutput(ctx context.Context, sessionID string, timeout time.Duration) (domain.TerminalSnapshot, error) {
	if timeout <= 0 {
		return m.SnapshotSession(ctx, sessionID)
	}
	waitCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	ticker := time.NewTicker(75 * time.Millisecond)
	defer ticker.Stop()
	var snapshot domain.TerminalSnapshot
	for {
		next, err := m.SnapshotSession(waitCtx, sessionID)
		if err != nil {
			return domain.TerminalSnapshot{}, err
		}
		snapshot = next
		if strings.TrimSpace(snapshot.Capture) != "" {
			return snapshot, nil
		}
		select {
		case <-waitCtx.Done():
			return snapshot, nil
		case <-ticker.C:
		}
	}
}

func (m *TerminalManager) SnapshotSession(ctx context.Context, sessionID string) (domain.TerminalSnapshot, error) {
	session, err := m.lookup(ctx, sessionID)
	if err != nil {
		return domain.TerminalSnapshot{}, err
	}
	metadata, err := m.paneMetadata(ctx, session.PaneID)
	if err != nil {
		return domain.TerminalSnapshot{}, m.sessionPaneError(session, err)
	}
	if metadata.dead {
		return domain.TerminalSnapshot{}, m.sessionPaneError(session, fmt.Errorf("terminal session has exited; open a new terminal window"))
	}
	if metadata.cols > 0 {
		session.Cols = metadata.cols
	}
	if metadata.rows > 0 {
		session.Rows = metadata.rows
	}
	var capture tmuxCommandResult
	if metadata.alternate {
		capture, err = m.tmux(ctx, "capture-pane", "-p", "-e", "-N", "-q", "-t", session.PaneID)
	} else {
		capture, err = m.tmux(ctx, "capture-pane", "-p", "-e", "-N", "-S", fmt.Sprintf("-%d", m.server.cfg.Runtime.TmuxCaptureLines), "-E", "-", "-t", session.PaneID)
	}
	if err != nil {
		return domain.TerminalSnapshot{}, err
	}
	session.UpdatedAt = time.Now().UTC()
	if err := m.server.store.UpsertTerminalSession(ctx, session.domain()); err != nil {
		return domain.TerminalSnapshot{}, err
	}
	return domain.TerminalSnapshot{Session: session.domain(), Capture: capture.stdout, CursorX: metadata.cursorX, CursorY: metadata.cursorY, CursorVisible: metadata.cursorVisible, Alternate: metadata.alternate, CurrentCommand: metadata.currentCommand}, nil
}

func (m *TerminalManager) Stream(w http.ResponseWriter, r *http.Request, sessionID string) {
	ws, err := acceptWebSocket(w, r)
	if err != nil {
		log.Printf("terminal websocket accept failed for %s: %v", sessionID, err)
		return
	}
	defer ws.Close()

	session, err := m.lookup(r.Context(), sessionID)
	if err != nil {
		_, message := terminalSessionHTTPError(err)
		_ = ws.WriteJSON(terminalStreamServerMessage{Type: "error", Message: message})
		return
	}
	if err := m.ensureSessionPane(r.Context(), session); err != nil {
		_, message := terminalSessionHTTPError(m.sessionPaneError(session, err))
		_ = ws.WriteJSON(terminalStreamServerMessage{Type: "error", Message: message})
		return
	}

	subscriber := m.subscribeStream(sessionID)
	defer m.unsubscribeStream(sessionID, subscriber)

	if err := m.ensureOutputPipe(r.Context(), session); err != nil {
		_ = ws.WriteJSON(terminalStreamServerMessage{Type: "error", Message: err.Error()})
		return
	}
	m.refreshAlternateScreenBeforeAttachSnapshot(r.Context(), session)
	snapshot, err := m.waitForSessionSnapshotOutput(r.Context(), sessionID, terminalInitialOutputWait)
	if err != nil {
		_ = ws.WriteJSON(terminalStreamServerMessage{Type: "error", Message: err.Error()})
		return
	}
	initialMessage := m.renderer.buildMessage(sessionID, snapshot, true)
	if initialMessage == nil {
		initialMessage = &terminalStreamServerMessage{Type: "error", Message: "Terminal renderer could not build the initial frame."}
	}
	if err := ws.WriteJSON(*initialMessage); err != nil {
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	writerDone := make(chan error, 1)
	go func() {
		for {
			select {
			case <-ctx.Done():
				writerDone <- ctx.Err()
				return
			case data, ok := <-subscriber.ch:
				if !ok {
					writerDone <- io.EOF
					return
				}
				if err := ws.WriteJSON(data); err != nil {
					writerDone <- err
					return
				}
			}
		}
	}()

	readerDone := make(chan error, 1)
	go func() {
		readerDone <- m.readTerminalStreamMessages(ctx, ws, sessionID)
	}()

	select {
	case <-writerDone:
		cancel()
	case <-readerDone:
		cancel()
	}
}

type terminalStreamClientMessage struct {
	Type      string `json:"type"`
	Data      string `json:"data,omitempty"`
	Cols      int    `json:"cols,omitempty"`
	Rows      int    `json:"rows,omitempty"`
	ResizeSeq int    `json:"resize_seq,omitempty"`
}

type terminalStreamServerMessage struct {
	Type         string          `json:"type"`
	Message      string          `json:"message,omitempty"`
	SessionID    string          `json:"session_id,omitempty"`
	BaseRevision int             `json:"base_revision,omitempty"`
	Revision     int             `json:"revision,omitempty"`
	ResizeSeq    int             `json:"resize_seq,omitempty"`
	Frame        *terminalFrame  `json:"frame,omitempty"`
	Cols         int             `json:"cols,omitempty"`
	TerminalRows int             `json:"terminal_rows,omitempty"`
	Alternate    bool            `json:"alternate_on"`
	Title        string          `json:"title,omitempty"`
	Status       string          `json:"status,omitempty"`
	ExitStatus   *int            `json:"exit_status,omitempty"`
	InputModes   map[string]any  `json:"input_modes,omitempty"`
	Rows         any             `json:"rows,omitempty"`
	Cursor       *terminalCursor `json:"cursor,omitempty"`
}

func (m *TerminalManager) readTerminalStreamMessages(ctx context.Context, ws *webSocketConn, sessionID string) error {
	for {
		opcode, payload, err := ws.ReadMessage()
		if err != nil {
			return err
		}
		if opcode != webSocketOpcodeText {
			continue
		}
		var message terminalStreamClientMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			_ = ws.WriteJSON(terminalStreamServerMessage{Type: "error", Message: "Terminal control message was not valid JSON."})
			continue
		}
		switch strings.TrimSpace(message.Type) {
		case "input":
			if message.Data == "" {
				continue
			}
			commandCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := m.SendInput(commandCtx, sessionID, message.Data)
			cancel()
			if err != nil {
				_ = ws.WriteJSON(terminalStreamServerMessage{Type: "error", Message: err.Error()})
			}
		case "paste":
			if message.Data == "" {
				continue
			}
			commandCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := m.PasteInput(commandCtx, sessionID, message.Data)
			cancel()
			if err != nil {
				_ = ws.WriteJSON(terminalStreamServerMessage{Type: "error", Message: err.Error()})
			}
		case "resize":
			commandCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			_, err := m.Resize(commandCtx, sessionID, message.Cols, message.Rows, message.ResizeSeq)
			if err == nil {
				err = m.handleInitialTerminalResize(commandCtx, sessionID)
			}
			if err == nil {
				m.scheduleStreamFullSync(sessionID, 140*time.Millisecond, 420*time.Millisecond, 950*time.Millisecond)
			}
			cancel()
			if err != nil {
				_ = ws.WriteJSON(terminalStreamServerMessage{Type: "error", Message: err.Error()})
			} else {
				_ = ws.WriteJSON(terminalStreamServerMessage{Type: "resize_ack", ResizeSeq: m.currentTerminalResizeSeq(sessionID)})
			}
		case "redraw":
			commandCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := m.Redraw(commandCtx, sessionID)
			cancel()
			if err != nil {
				_ = ws.WriteJSON(terminalStreamServerMessage{Type: "error", Message: err.Error()})
			}
		default:
			_ = ws.WriteJSON(terminalStreamServerMessage{Type: "error", Message: "Terminal control message type is not supported."})
		}
	}
}

func (m *TerminalManager) SendInput(ctx context.Context, sessionID string, data string) error {
	session, err := m.lookup(ctx, sessionID)
	if err != nil {
		return err
	}
	if data == "" {
		return nil
	}
	if err := m.ensureSessionPane(ctx, session); err != nil {
		return m.sessionPaneError(session, err)
	}
	session.InputMu.Lock()
	defer session.InputMu.Unlock()
	if err := m.sendTerminalInput(ctx, session.PaneID, data); err != nil {
		return err
	}
	session.UpdatedAt = time.Now().UTC()
	return m.server.store.UpsertTerminalSession(ctx, session.domain())
}

func (m *TerminalManager) PasteInput(ctx context.Context, sessionID string, data string) error {
	session, err := m.lookup(ctx, sessionID)
	if err != nil {
		return err
	}
	if data == "" {
		return nil
	}
	if err := m.ensureSessionPane(ctx, session); err != nil {
		return m.sessionPaneError(session, err)
	}
	session.InputMu.Lock()
	defer session.InputMu.Unlock()
	if err := m.pasteTerminalInput(ctx, session.PaneID, data); err != nil {
		return err
	}
	session.UpdatedAt = time.Now().UTC()
	return m.server.store.UpsertTerminalSession(ctx, session.domain())
}

func (m *TerminalManager) handleInitialTerminalResize(ctx context.Context, sessionID string) error {
	session, err := m.lookup(ctx, sessionID)
	if err != nil {
		return err
	}
	if session.InitialResizeHandled && (session.PendingInitialCommand == "" || session.InitialCommandSent) {
		return nil
	}
	if err := m.ensureSessionPane(ctx, session); err != nil {
		return m.sessionPaneError(session, err)
	}
	session.InputMu.Lock()
	defer session.InputMu.Unlock()
	changed := false
	redrawAfterInitialCommand := false
	if !session.InitialResizeHandled {
		session.InitialResizeHandled = true
		changed = true
	}
	command := strings.TrimRight(session.PendingInitialCommand, "\r\n")
	if command != "" && !session.InitialCommandSent {
		if session.InitialCommandMinCols > 0 && session.Cols < session.InitialCommandMinCols {
			session.UpdatedAt = time.Now().UTC()
			return m.server.store.UpsertTerminalSession(ctx, session.domain())
		}
		if session.InitialCommandMinRows > 0 && session.Rows < session.InitialCommandMinRows {
			session.UpdatedAt = time.Now().UTC()
			return m.server.store.UpsertTerminalSession(ctx, session.domain())
		}
		time.Sleep(150 * time.Millisecond)
		if terminalInitialCommandNeedsNoEcho(command) {
			if err := m.sendTerminalInput(ctx, session.PaneID, "stty -echo 2>/dev/null || true\n"); err != nil {
				return err
			}
			time.Sleep(150 * time.Millisecond)
		}
		initialCommand := terminalSizedInitialCommand(command, session.Cols, session.Rows) + "\n"
		if terminalInitialCommandNeedsNoEcho(command) {
			if err := m.sendTerminalInput(ctx, session.PaneID, initialCommand); err != nil {
				return err
			}
		} else if err := m.pasteTerminalInput(ctx, session.PaneID, initialCommand); err != nil {
			return err
		}
		session.InitialCommandSent = true
		session.PendingInitialCommand = ""
		changed = true
		redrawAfterInitialCommand = true
	}
	if !changed {
		return nil
	}
	session.UpdatedAt = time.Now().UTC()
	err = m.server.store.UpsertTerminalSession(ctx, session.domain())
	if err == nil && redrawAfterInitialCommand {
		m.scheduleAlternateScreenRedrawBurst(session.ID, session.PaneID)
	}
	return err
}

func terminalInitialCommandNeedsNoEcho(command string) bool {
	trimmed := strings.TrimSpace(command)
	return strings.HasPrefix(trimmed, "/bin/sh <<") || strings.HasPrefix(trimmed, terminalPOSIXBootstrapMarker)
}

func terminalInitialCommandMinimumSize(command string) (int, int) {
	command = strings.TrimSpace(command)
	if command == "" || strings.HasPrefix(command, terminalPOSIXBootstrapMarker) {
		return 0, 0
	}
	return 100, 30
}

func terminalSizedInitialCommand(command string, cols int, rows int) string {
	command = strings.TrimRight(command, "\r\n")
	if !terminalInitialCommandNeedsNoEcho(command) {
		return command
	}
	if strings.HasPrefix(strings.TrimSpace(command), terminalPOSIXBootstrapMarker) {
		return terminalSizedPOSIXBootstrapCommand(cols, rows)
	}
	body, ok := terminalInitialPOSIXScriptBody(command)
	if !ok {
		body = command
	}
	cols = normalizeTerminalCols(cols)
	rows = normalizeTerminalRows(rows)
	terminalSizeExports := "export COLUMNS=" + strconv.Itoa(cols) + " LINES=" + strconv.Itoa(rows) + "\n"
	sizedBody := "stty echo 2>/dev/null || true\nstty rows " + strconv.Itoa(rows) + " cols " + strconv.Itoa(cols) + " 2>/dev/null || true\n" + terminalSizeExports + "printf '\\033[2J\\033[H' 2>/dev/null || true\n" + terminalEnvironmentPOSIXExports() + body
	return fmt.Sprintf("stty rows %d cols %d 2>/dev/null || true\n%s%s\nexec /bin/sh -c %s", rows, cols, terminalEnvironmentPOSIXExports(), terminalSizeExports, posixSingleQuotedString(sizedBody))
}

func terminalPOSIXBootstrapCommand() string {
	return terminalPOSIXBootstrapMarker + "\n"
}

func terminalSizedPOSIXBootstrapCommand(cols int, rows int) string {
	cols = normalizeTerminalCols(cols)
	rows = normalizeTerminalRows(rows)
	return strings.Join([]string{
		terminalPOSIXBootstrapMarker,
		fmt.Sprintf("stty rows %d cols %d 2>/dev/null || true", rows, cols),
		fmt.Sprintf("export COLUMNS=%d LINES=%d", cols, rows),
		terminalEnvironmentPOSIXExports(),
		"shellorchestra_shell_name=$(basename \"${SHELL:-/bin/sh}\" 2>/dev/null || printf sh)",
		"case \"$shellorchestra_shell_name\" in",
		"  sh|dash|ash)",
		"    if command -v bash >/dev/null 2>&1; then",
		"      SHELL=$(command -v bash)",
		"      export SHELL",
		"    elif command -v zsh >/dev/null 2>&1; then",
		"      SHELL=$(command -v zsh)",
		"      export SHELL",
		"    fi",
		"    ;;",
		"esac",
		"unset shellorchestra_shell_name",
		"stty echo 2>/dev/null || true",
		"printf '\\033[2J\\033[H' 2>/dev/null || true",
	}, "\n")
}

func serverUsesPOSIXTerminalBootstrap(server domain.Server) bool {
	platformOS := strings.ToLower(strings.TrimSpace(firstNonEmptyString(server.DetectedPlatformOS, server.OverrideOS, server.DetectedOS, server.OSHint)))
	shell := strings.ToLower(strings.TrimSpace(firstNonEmptyString(server.OverrideShell, server.DetectedShell, server.ShellHint)))
	if strings.Contains(platformOS, "windows") || strings.Contains(shell, "powershell") || strings.Contains(shell, "pwsh") || strings.Contains(shell, "cmd.exe") {
		return false
	}
	switch platformOS {
	case "linux", "darwin", "freebsd", "openbsd", "netbsd":
		return true
	}
	return strings.HasPrefix(shell, "/") || strings.Contains(shell, "bash") || strings.Contains(shell, "zsh") || strings.Contains(shell, "fish") || strings.Contains(shell, "sh")
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func terminalInitialPOSIXScriptBody(command string) (string, bool) {
	command = strings.TrimRight(command, "\r\n")
	firstLine, rest, ok := strings.Cut(command, "\n")
	if !ok {
		return "", false
	}
	firstLine = strings.TrimSpace(firstLine)
	if !strings.HasPrefix(firstLine, "/bin/sh <<") {
		return "", false
	}
	delimiter := strings.TrimSpace(strings.TrimPrefix(firstLine, "/bin/sh <<"))
	delimiter = strings.Trim(delimiter, "'\"")
	if delimiter == "" {
		return "", false
	}
	lines := strings.Split(rest, "\n")
	for index, line := range lines {
		if strings.TrimSpace(line) == delimiter {
			return strings.Join(lines[:index], "\n"), true
		}
	}
	return "", false
}

func terminalEnvironment() map[string]string {
	return map[string]string{
		"TERM":      terminalPTYTerm,
		"COLORTERM": terminalPTYColorTerm,
	}
}

func terminalEnvironmentPOSIXExports() string {
	return "export TERM='" + terminalPTYTerm + "'\nexport COLORTERM='" + terminalPTYColorTerm + "'\n"
}

func posixSingleQuotedString(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func (m *TerminalManager) sendTerminalInput(ctx context.Context, paneID string, data string) error {
	var literal strings.Builder
	flushLiteral := func() error {
		if literal.Len() == 0 {
			return nil
		}
		text := literal.String()
		literal.Reset()
		return m.sendTerminalBytes(ctx, paneID, []byte(text))
	}
	sendKey := func(key string) error {
		if err := flushLiteral(); err != nil {
			return err
		}
		_, err := m.tmux(ctx, "send-keys", "-t", paneID, key)
		return err
	}
	for _, event := range terminalInputEvents(data) {
		if event.literal != "" {
			literal.WriteString(event.literal)
			continue
		}
		if event.key != "" {
			if err := sendKey(event.key); err != nil {
				return err
			}
		}
	}
	return flushLiteral()
}

func (m *TerminalManager) sendTerminalBytes(ctx context.Context, paneID string, raw []byte) error {
	const chunkSize = 96
	for index := 0; index < len(raw); index += chunkSize {
		end := index + chunkSize
		if end > len(raw) {
			end = len(raw)
		}
		args := []string{"send-keys", "-H", "-t", paneID}
		for _, value := range raw[index:end] {
			args = append(args, fmt.Sprintf("%02x", value))
		}
		if _, err := m.tmux(ctx, args...); err != nil {
			return err
		}
	}
	return nil
}

func (m *TerminalManager) pasteTerminalInput(ctx context.Context, paneID string, data string) error {
	bufferName := "shellorchestra-" + terminalIDPattern.ReplaceAllString(paneID, "-")
	if _, err := m.tmux(ctx, "set-buffer", "-b", bufferName, "--", data); err != nil {
		return err
	}
	_, err := m.tmux(ctx, "paste-buffer", "-d", "-b", bufferName, "-t", paneID)
	return err
}

func (m *TerminalManager) subscribeStream(sessionID string) *terminalStreamSubscriber {
	sessionID = strings.TrimSpace(sessionID)
	subscriber := &terminalStreamSubscriber{ch: make(chan terminalStreamServerMessage, 512)}
	m.mu.Lock()
	hub := m.streams[sessionID]
	if hub == nil {
		hub = &terminalStreamHub{subscribers: map[*terminalStreamSubscriber]struct{}{}}
		m.streams[sessionID] = hub
	}
	hub.subscribers[subscriber] = struct{}{}
	m.mu.Unlock()
	return subscriber
}

func (m *TerminalManager) unsubscribeStream(sessionID string, subscriber *terminalStreamSubscriber) {
	sessionID = strings.TrimSpace(sessionID)
	m.mu.Lock()
	hub := m.streams[sessionID]
	if hub != nil {
		if _, ok := hub.subscribers[subscriber]; ok {
			delete(hub.subscribers, subscriber)
			close(subscriber.ch)
		}
		if len(hub.subscribers) == 0 {
			delete(m.streams, sessionID)
		}
	}
	m.mu.Unlock()
}

func (m *TerminalManager) broadcastStreamMessage(sessionID string, message terminalStreamServerMessage) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" || strings.TrimSpace(message.Type) == "" {
		return
	}
	m.mu.Lock()
	hub := m.streams[sessionID]
	if hub == nil {
		m.mu.Unlock()
		return
	}
	for subscriber := range hub.subscribers {
		select {
		case subscriber.ch <- message:
		default:
			delete(hub.subscribers, subscriber)
			close(subscriber.ch)
		}
	}
	if len(hub.subscribers) == 0 {
		delete(m.streams, sessionID)
	}
	m.mu.Unlock()
}

func (m *TerminalManager) requestStreamRefresh(sessionID string) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return
	}
	m.mu.Lock()
	select {
	case <-m.closed:
		m.mu.Unlock()
		return
	default:
	}
	if m.streams[sessionID] == nil {
		m.mu.Unlock()
		return
	}
	m.streamDirty[sessionID] = true
	if m.streamTimers[sessionID] != nil {
		m.mu.Unlock()
		return
	}
	timer := time.AfterFunc(12*time.Millisecond, func() {
		m.flushStreamRefresh(sessionID)
	})
	m.streamTimers[sessionID] = timer
	m.mu.Unlock()
}

func (m *TerminalManager) flushStreamRefresh(sessionID string) {
	for {
		m.mu.Lock()
		select {
		case <-m.closed:
			delete(m.streamTimers, sessionID)
			delete(m.streamDirty, sessionID)
			m.mu.Unlock()
			return
		default:
		}
		if !m.streamDirty[sessionID] {
			delete(m.streamTimers, sessionID)
			delete(m.streamDirty, sessionID)
			m.mu.Unlock()
			return
		}
		m.streamDirty[sessionID] = false
		m.mu.Unlock()

		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		if err := m.publishStreamSnapshot(ctx, sessionID, false); err != nil {
			log.Printf("terminal stream refresh failed for %s: %v", sessionID, err)
		}
		cancel()

		time.Sleep(12 * time.Millisecond)
	}
}

func (m *TerminalManager) publishStreamSnapshot(ctx context.Context, sessionID string, forceFullSync bool) error {
	snapshot, err := m.SnapshotSession(ctx, sessionID)
	if err != nil {
		if !terminalPaneErrorIsTransient(err) {
			_, message := terminalSessionHTTPError(err)
			m.broadcastStreamMessage(sessionID, terminalStreamServerMessage{Type: "error", Message: message})
		}
		return err
	}
	message := m.renderer.buildMessage(sessionID, snapshot, forceFullSync)
	if message == nil {
		return nil
	}
	message.ResizeSeq = m.currentTerminalResizeSeq(sessionID)
	m.broadcastStreamMessage(sessionID, *message)
	return nil
}

func (m *TerminalManager) currentTerminalResizeSeq(sessionID string) int {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return 0
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	session := m.sessions[sessionID]
	if session == nil {
		return 0
	}
	return session.ResizeSeq
}

func (m *TerminalManager) scheduleStreamFullSync(sessionID string, delays ...time.Duration) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return
	}
	if len(delays) == 0 {
		delays = []time.Duration{180 * time.Millisecond}
	}
	for _, delay := range delays {
		if delay < 0 {
			delay = 0
		}
		go func(delay time.Duration) {
			timer := time.NewTimer(delay)
			select {
			case <-m.closed:
				timer.Stop()
				return
			case <-timer.C:
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			if err := m.publishStreamSnapshot(ctx, sessionID, true); err != nil {
				log.Printf("terminal scheduled full sync failed for %s: %v", sessionID, err)
			}
			cancel()
		}(delay)
	}
}

func (m *TerminalManager) ensureOutputPipe(ctx context.Context, session *terminalSession) error {
	if session == nil {
		return fmt.Errorf("terminal session was not found")
	}
	if strings.TrimSpace(session.BundleDir) == "" {
		return fmt.Errorf("terminal session bridge bundle is missing")
	}
	tokenPath := filepath.Join(session.BundleDir, "bridge-token")
	if _, err := os.Stat(tokenPath); err != nil {
		return fmt.Errorf("terminal bridge token is unavailable: %w", err)
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	command := fmt.Sprintf("%s --role terminal-output-proxy --terminal-socket %s --terminal-token-file %s", shellQuote(exe), shellQuote(m.bridgeSocketPath), shellQuote(tokenPath))
	_, err = m.tmux(ctx, "pipe-pane", "-O", "-t", session.PaneID, command)
	return err
}

type terminalInputEvent struct {
	literal string
	key     string
}

func terminalInputEvents(data string) []terminalInputEvent {
	events := make([]terminalInputEvent, 0, len(data))
	appendLiteral := func(value string) {
		if value == "" {
			return
		}
		if len(events) > 0 && events[len(events)-1].key == "" {
			events[len(events)-1].literal += value
			return
		}
		events = append(events, terminalInputEvent{literal: value})
	}
	appendKey := func(value string) {
		if value != "" {
			events = append(events, terminalInputEvent{key: value})
		}
	}
	for index := 0; index < len(data); {
		switch data[index] {
		case '\r', '\n':
			appendKey("Enter")
			index++
		case '\t':
			appendKey("Tab")
			index++
		case '\b', '\x7f':
			appendLiteral(data[index : index+1])
			index++
		case '\x03', '\x04':
			appendLiteral(data[index : index+1])
			index++
		case '\x1b':
			sequence, key, ok := terminalEscapeSequence(data[index:])
			if !ok {
				appendKey("Escape")
				index++
				continue
			}
			if key != "" {
				appendKey(key)
			} else {
				appendLiteral(sequence)
			}
			index += len(sequence)
		default:
			if data[index] >= 0x01 && data[index] <= 0x1a {
				appendLiteral(data[index : index+1])
				index++
				continue
			}
			r, size := utf8.DecodeRuneInString(data[index:])
			if r == utf8.RuneError && size == 1 {
				appendLiteral(data[index : index+1])
				index++
				continue
			}
			appendLiteral(data[index : index+size])
			index += size
		}
	}
	return events
}

func terminalEscapeSequence(data string) (sequence string, key string, ok bool) {
	if data == "" || data[0] != '\x1b' {
		return "", "", false
	}
	if len(data) == 1 {
		return "", "", false
	}
	switch data[1] {
	case '[':
		for index := 2; index < len(data); index++ {
			if data[index] >= 0x40 && data[index] <= 0x7e {
				sequence = data[:index+1]
				return sequence, terminalCSIKey(sequence), true
			}
		}
		return "", "", false
	case 'O':
		if len(data) < 3 {
			return "", "", false
		}
		sequence = data[:3]
		return sequence, terminalSS3Key(sequence), true
	default:
		_, size := utf8.DecodeRuneInString(data[1:])
		if size <= 0 {
			size = 1
		}
		return data[:1+size], "", true
	}
}

func terminalCSIKey(sequence string) string {
	if len(sequence) < 3 || sequence[0] != '\x1b' || sequence[1] != '[' {
		return ""
	}
	body := sequence[2:]
	final := body[len(body)-1]
	params := body[:len(body)-1]
	switch final {
	case 'A', 'B', 'C', 'D', 'F', 'H':
		base := map[byte]string{'A': "Up", 'B': "Down", 'C': "Right", 'D': "Left", 'F': "End", 'H': "Home"}[final]
		return terminalModifiedKey(base, terminalCSIParam(params, 1))
	case 'Z':
		if params == "" {
			return "BTab"
		}
		return ""
	case '~':
		parts := strings.Split(params, ";")
		base := terminalTildeKey(parts[0])
		if base == "" {
			return ""
		}
		modifier := ""
		if len(parts) > 1 {
			modifier = parts[1]
		}
		return terminalModifiedKey(base, modifier)
	default:
		return ""
	}
}

func terminalSS3Key(sequence string) string {
	if len(sequence) != 3 || sequence[0] != '\x1b' || sequence[1] != 'O' {
		return ""
	}
	switch sequence[2] {
	case 'A':
		return "Up"
	case 'B':
		return "Down"
	case 'C':
		return "Right"
	case 'D':
		return "Left"
	case 'F':
		return "End"
	case 'H':
		return "Home"
	case 'P':
		return "F1"
	case 'Q':
		return "F2"
	case 'R':
		return "F3"
	case 'S':
		return "F4"
	default:
		return ""
	}
}

func terminalTildeKey(value string) string {
	switch value {
	case "1", "7":
		return "Home"
	case "2":
		return "IC"
	case "3":
		return "DC"
	case "4", "8":
		return "End"
	case "5":
		return "PPage"
	case "6":
		return "NPage"
	case "11":
		return "F1"
	case "12":
		return "F2"
	case "13":
		return "F3"
	case "14":
		return "F4"
	case "15":
		return "F5"
	case "17":
		return "F6"
	case "18":
		return "F7"
	case "19":
		return "F8"
	case "20":
		return "F9"
	case "21":
		return "F10"
	case "23":
		return "F11"
	case "24":
		return "F12"
	default:
		return ""
	}
}

func terminalModifiedKey(base string, modifier string) string {
	switch strings.TrimSpace(modifier) {
	case "", "1":
		return base
	case "2":
		return "S-" + base
	case "3":
		return "M-" + base
	case "4":
		return "M-S-" + base
	case "5":
		return "C-" + base
	case "6":
		return "C-S-" + base
	case "7":
		return "C-M-" + base
	case "8":
		return "C-M-S-" + base
	default:
		return base
	}
}

func terminalControlKey(value byte) string {
	if value < 0x01 || value > 0x1a {
		return ""
	}
	return "C-" + string(rune('a'+value-1))
}

func terminalCSIParam(params string, position int) string {
	if position < 0 {
		return ""
	}
	parts := strings.Split(params, ";")
	if position >= len(parts) {
		return ""
	}
	return parts[position]
}

func (m *TerminalManager) Resize(ctx context.Context, sessionID string, cols int, rows int, resizeSeq ...int) (domain.TerminalSnapshot, error) {
	session, err := m.lookup(ctx, sessionID)
	if err != nil {
		return domain.TerminalSnapshot{}, err
	}
	if err := m.ensureSessionPane(ctx, session); err != nil {
		return domain.TerminalSnapshot{}, m.sessionPaneError(session, err)
	}
	session.Cols = normalizeTerminalCols(cols)
	session.Rows = normalizeTerminalRows(rows)
	if len(resizeSeq) > 0 && resizeSeq[0] > session.ResizeSeq {
		session.ResizeSeq = resizeSeq[0]
	}
	session.UpdatedAt = time.Now().UTC()
	if session.WindowID != "" {
		_, err = m.tmux(ctx, "resize-window", "-t", session.WindowID, "-x", fmt.Sprintf("%d", session.Cols), "-y", fmt.Sprintf("%d", session.Rows))
	}
	if err == nil {
		_, err = m.tmux(ctx, "resize-pane", "-t", session.PaneID, "-x", fmt.Sprintf("%d", session.Cols), "-y", fmt.Sprintf("%d", session.Rows))
	}
	if err != nil {
		return domain.TerminalSnapshot{}, err
	}
	m.waitForPaneSize(ctx, session.PaneID, session.Cols, session.Rows, 250*time.Millisecond)
	m.updateBridgeRequestSize(session)
	session.queueResize(runtime.TerminalSize{Cols: session.Cols, Rows: session.Rows})
	m.scheduleRemoteResizeBurst(session.ID)
	m.scheduleAlternateScreenRedraw(session.ID, session.PaneID)
	m.scheduleAlternateScreenRedrawBurst(session.ID, session.PaneID)
	return m.SnapshotSession(ctx, sessionID)
}

func (m *TerminalManager) Redraw(ctx context.Context, sessionID string) error {
	session, err := m.lookup(ctx, sessionID)
	if err != nil {
		return err
	}
	if err := m.ensureSessionPane(ctx, session); err != nil {
		return m.sessionPaneError(session, err)
	}
	metadata, err := m.paneMetadata(ctx, session.PaneID)
	if err == nil && metadata.alternate {
		session.queueResize(runtime.TerminalSize{Cols: session.Cols, Rows: session.Rows})
	}
	return m.publishStreamSnapshot(ctx, sessionID, true)
}

func (m *TerminalManager) scheduleAlternateScreenRedraw(sessionID string, paneID string) {
	sessionID = strings.TrimSpace(sessionID)
	paneID = strings.TrimSpace(paneID)
	if sessionID == "" || paneID == "" {
		return
	}
	m.mu.Lock()
	if existing := m.redrawTimers[sessionID]; existing != nil {
		existing.Stop()
	}
	var timer *time.Timer
	timer = time.AfterFunc(360*time.Millisecond, func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		m.redrawAlternateScreen(ctx, sessionID, paneID)
		m.mu.Lock()
		if m.redrawTimers[sessionID] == timer {
			delete(m.redrawTimers, sessionID)
		}
		m.mu.Unlock()
	})
	m.redrawTimers[sessionID] = timer
	m.mu.Unlock()
}

func (m *TerminalManager) scheduleAlternateScreenRedrawBurst(sessionID string, paneID string) {
	sessionID = strings.TrimSpace(sessionID)
	paneID = strings.TrimSpace(paneID)
	if sessionID == "" || paneID == "" {
		return
	}
	go func() {
		for _, delay := range []time.Duration{420 * time.Millisecond, 900 * time.Millisecond, 1600 * time.Millisecond} {
			timer := time.NewTimer(delay)
			select {
			case <-m.closed:
				timer.Stop()
				return
			case <-timer.C:
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			m.redrawAlternateScreen(ctx, sessionID, paneID)
			cancel()
		}
	}()
}

func (m *TerminalManager) redrawAlternateScreen(ctx context.Context, sessionID string, paneID string) {
	session, err := m.lookup(ctx, sessionID)
	if err != nil || strings.TrimSpace(session.PaneID) != paneID {
		return
	}
	metadata, err := m.paneMetadata(ctx, paneID)
	if err != nil || !metadata.alternate {
		return
	}
	session.queueResize(runtime.TerminalSize{Cols: session.Cols, Rows: session.Rows})
	session.InputMu.Lock()
	_ = m.sendTerminalInput(ctx, paneID, "\x0c")
	session.InputMu.Unlock()
	timer := time.NewTimer(180 * time.Millisecond)
	select {
	case <-ctx.Done():
		timer.Stop()
		return
	case <-timer.C:
	}
	m.scheduleStreamFullSync(sessionID, 180*time.Millisecond, 520*time.Millisecond)
}

func (m *TerminalManager) scheduleRemoteResizeBurst(sessionID string) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return
	}
	go func() {
		for _, delay := range []time.Duration{120 * time.Millisecond, 420 * time.Millisecond, 950 * time.Millisecond} {
			timer := time.NewTimer(delay)
			select {
			case <-m.closed:
				timer.Stop()
				return
			case <-timer.C:
			}
			m.mu.RLock()
			session := m.sessions[sessionID]
			if session != nil {
				session.queueResize(runtime.TerminalSize{Cols: session.Cols, Rows: session.Rows})
			}
			m.mu.RUnlock()
		}
	}()
}

func (m *TerminalManager) refreshAlternateScreenBeforeAttachSnapshot(ctx context.Context, session *terminalSession) {
	if session == nil || strings.TrimSpace(session.PaneID) == "" {
		return
	}
	metadata, err := m.paneMetadata(ctx, session.PaneID)
	if err != nil || !metadata.alternate {
		return
	}
	session.queueResize(runtime.TerminalSize{Cols: session.Cols, Rows: session.Rows})
	timer := time.NewTimer(520 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}

func (m *TerminalManager) waitForPaneSize(ctx context.Context, paneID string, cols int, rows int, timeout time.Duration) {
	if strings.TrimSpace(paneID) == "" || cols <= 0 || rows <= 0 || timeout <= 0 {
		return
	}
	waitCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		metadata, err := m.paneMetadata(waitCtx, paneID)
		if err == nil && metadata.cols == cols && metadata.rows == rows {
			return
		}
		select {
		case <-waitCtx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (m *TerminalManager) CloseSession(ctx context.Context, sessionID string) error {
	sessionID = strings.TrimSpace(sessionID)
	m.mu.Lock()
	session := m.sessions[sessionID]
	delete(m.sessions, sessionID)
	if timer := m.redrawTimers[sessionID]; timer != nil {
		timer.Stop()
		delete(m.redrawTimers, sessionID)
	}
	if timer := m.streamTimers[sessionID]; timer != nil {
		timer.Stop()
		delete(m.streamTimers, sessionID)
	}
	delete(m.streamDirty, sessionID)
	m.mu.Unlock()
	m.renderer.dropSession(sessionID)
	if session == nil {
		persisted, err := m.server.store.GetTerminalSession(ctx, sessionID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return nil
			}
			return err
		}
		session = terminalSessionFromDomain(persisted)
	}
	_ = m.killWindow(ctx, session.WindowID)
	_ = m.killTmuxSession(ctx, terminalTmuxSessionForTerminal(session.ID))
	if strings.TrimSpace(session.BundleDir) != "" {
		_ = os.RemoveAll(session.BundleDir)
	}
	if err := m.server.store.DeleteTerminalSession(ctx, sessionID); err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	return nil
}

func (m *TerminalManager) lookup(ctx context.Context, sessionID string) (*terminalSession, error) {
	sessionID = strings.TrimSpace(sessionID)
	if err := m.ensureBridgeListener(); err != nil {
		return nil, err
	}
	m.mu.RLock()
	session := m.sessions[sessionID]
	m.mu.RUnlock()
	if session != nil {
		return session, nil
	}
	persisted, err := m.server.store.GetTerminalSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	session = terminalSessionFromDomain(persisted)
	m.mu.Lock()
	if existing := m.sessions[sessionID]; existing != nil {
		session = existing
	} else {
		m.sessions[sessionID] = session
	}
	m.mu.Unlock()
	return session, nil
}

func (m *TerminalManager) ensureSessionPane(ctx context.Context, session *terminalSession) error {
	if session == nil || strings.TrimSpace(session.PaneID) == "" {
		return fmt.Errorf("terminal session pane is missing")
	}
	metadata, err := m.paneMetadata(ctx, session.PaneID)
	if err != nil {
		return err
	}
	if metadata.dead {
		return fmt.Errorf("terminal session has exited; open a new terminal window")
	}
	return nil
}

func (m *TerminalManager) sessionPaneError(session *terminalSession, cause error) error {
	if terminalPaneErrorIsTransient(cause) {
		return cause
	}
	m.forgetStaleSession(context.Background(), session, cause)
	return store.ErrNotFound
}

func terminalPaneErrorIsTransient(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "context canceled") || strings.Contains(message, "deadline exceeded")
}

func (m *TerminalManager) forgetStaleSession(ctx context.Context, session *terminalSession, cause error) {
	if session == nil {
		return
	}
	m.mu.Lock()
	delete(m.sessions, session.ID)
	if timer := m.redrawTimers[session.ID]; timer != nil {
		timer.Stop()
		delete(m.redrawTimers, session.ID)
	}
	m.mu.Unlock()
	if strings.TrimSpace(session.BundleDir) != "" {
		_ = os.RemoveAll(session.BundleDir)
	}
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := m.server.store.DeleteTerminalSession(cleanupCtx, session.ID); err != nil && !errors.Is(err, store.ErrNotFound) {
		log.Printf("failed to delete stale terminal session %s: %v", session.ID, err)
	}
	log.Printf("removed stale terminal session %s pane=%s: %v", session.ID, session.PaneID, cause)
}

func (s *terminalSession) domain() domain.TerminalSession {
	return domain.TerminalSession{ID: s.ID, ServerID: s.ServerID, Title: s.Title, State: s.State, Rows: s.Rows, Cols: s.Cols, WindowID: s.WindowID, PaneID: s.PaneID, BundleDir: s.BundleDir, BridgeToken: s.BridgeToken, CreatedAt: s.CreatedAt, UpdatedAt: s.UpdatedAt}
}

func terminalSessionFromDomain(session domain.TerminalSession) *terminalSession {
	return &terminalSession{
		ID:          session.ID,
		ServerID:    session.ServerID,
		Title:       session.Title,
		State:       session.State,
		Rows:        session.Rows,
		Cols:        session.Cols,
		WindowID:    session.WindowID,
		PaneID:      session.PaneID,
		BundleDir:   session.BundleDir,
		BridgeToken: session.BridgeToken,
		CreatedAt:   session.CreatedAt,
		UpdatedAt:   session.UpdatedAt,
		ResizeCh:    make(chan runtime.TerminalSize, 8),
	}
}

func (m *TerminalManager) activeTerminalSession(sessionID string) *terminalSession {
	sessionID = strings.TrimSpace(sessionID)
	m.mu.Lock()
	defer m.mu.Unlock()
	session := m.sessions[sessionID]
	if session == nil {
		session = &terminalSession{ID: sessionID, State: "running", ResizeCh: make(chan runtime.TerminalSize, 8)}
		m.sessions[sessionID] = session
		return session
	}
	if session.ResizeCh == nil {
		session.ResizeCh = make(chan runtime.TerminalSize, 8)
	}
	return session
}

func (m *TerminalManager) updateBridgeRequestSize(session *terminalSession) {
	if session == nil || strings.TrimSpace(session.BridgeToken) == "" {
		return
	}
	m.mu.Lock()
	request := m.tokens[session.BridgeToken]
	request.SessionID = session.ID
	request.ServerID = session.ServerID
	request.Rows = session.Rows
	request.Cols = session.Cols
	m.tokens[session.BridgeToken] = request
	m.mu.Unlock()
}

func (s *terminalSession) queueResize(size runtime.TerminalSize) {
	if s == nil || s.ResizeCh == nil {
		return
	}
	for {
		select {
		case <-s.ResizeCh:
			continue
		default:
		}
		break
	}
	select {
	case s.ResizeCh <- size:
	default:
	}
}

type proxyBundle struct {
	Dir          string
	LauncherPath string
	Token        string
}

func (m *TerminalManager) prepareProxyBundle(sessionID string, serverID string, rows int, cols int) (proxyBundle, error) {
	baseDir := filepath.Join(filepath.Dir(m.server.cfg.Database.Path), "terminals", sessionID)
	if err := os.RemoveAll(baseDir); err != nil {
		return proxyBundle{}, err
	}
	if err := os.MkdirAll(baseDir, 0o700); err != nil {
		return proxyBundle{}, err
	}
	token, err := randomTerminalToken()
	if err != nil {
		return proxyBundle{}, err
	}
	m.mu.Lock()
	m.tokens[token] = terminalBridgeRequest{SessionID: sessionID, ServerID: serverID, Rows: rows, Cols: cols}
	m.mu.Unlock()
	tokenPath := filepath.Join(baseDir, "bridge-token")
	launcherPath := filepath.Join(baseDir, "launch.sh")
	if err := os.WriteFile(tokenPath, []byte(token), 0o600); err != nil {
		return proxyBundle{}, err
	}
	exe, err := os.Executable()
	if err != nil {
		return proxyBundle{}, err
	}
	launcher := fmt.Sprintf(`#!/bin/sh
exec %s --role terminal-proxy --terminal-socket %s --terminal-token-file %s
`, shellQuote(exe), shellQuote(m.bridgeSocketPath), shellQuote(tokenPath))
	if err := os.WriteFile(launcherPath, []byte(launcher), 0o700); err != nil {
		return proxyBundle{}, err
	}
	return proxyBundle{Dir: baseDir, LauncherPath: launcherPath, Token: token}, nil
}

func (m *TerminalManager) ensureBridgeListener() error {
	m.mu.Lock()
	if m.listener != nil {
		m.mu.Unlock()
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(m.bridgeSocketPath), 0o700); err != nil {
		m.mu.Unlock()
		return err
	}
	_ = os.Remove(m.bridgeSocketPath)
	listener, err := net.Listen("unix", m.bridgeSocketPath)
	if err != nil {
		m.mu.Unlock()
		return err
	}
	m.listener = listener
	m.mu.Unlock()
	go m.acceptBridgeLoop(listener)
	return nil
}

func (m *TerminalManager) acceptBridgeLoop(listener net.Listener) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			select {
			case <-m.closed:
				return
			default:
				log.Printf("terminal bridge accept failed: %v", err)
				return
			}
		}
		go m.handleBridgeConn(conn)
	}
}

func (m *TerminalManager) handleBridgeConn(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
	reader := bufio.NewReader(conn)
	token, err := reader.ReadString('\n')
	if err != nil {
		_, _ = conn.Write([]byte("ShellOrchestra terminal bridge failed: missing token\r\n"))
		return
	}
	token = strings.TrimSpace(token)
	if outputToken, ok := strings.CutPrefix(token, "output "); ok {
		m.handleOutputBridgeConn(conn, reader, strings.TrimSpace(outputToken))
		return
	}
	m.mu.RLock()
	request, ok := m.tokens[token]
	m.mu.RUnlock()
	if !ok {
		session, err := m.server.store.GetTerminalSessionByBridgeToken(context.Background(), token)
		if err != nil {
			_, _ = conn.Write([]byte("ShellOrchestra terminal bridge failed: unknown terminal token\r\n"))
			return
		}
		if session.State == "closed" {
			_, _ = conn.Write([]byte("ShellOrchestra terminal bridge failed: terminal session is closed\r\n"))
			return
		}
		request = terminalBridgeRequest{SessionID: session.ID, ServerID: session.ServerID, Rows: session.Rows, Cols: session.Cols}
		m.mu.Lock()
		m.tokens[token] = request
		if existing := m.sessions[session.ID]; existing == nil {
			m.sessions[session.ID] = terminalSessionFromDomain(session)
		}
		m.mu.Unlock()
	}
	if !request.ExpiresAt.IsZero() && time.Now().UTC().After(request.ExpiresAt) {
		_, _ = conn.Write([]byte("ShellOrchestra terminal bridge failed: expired terminal token\r\n"))
		return
	}
	_ = conn.SetDeadline(time.Time{})
	ctx := context.Background()
	stdin := io.MultiReader(reader, conn)
	session := m.activeTerminalSession(request.SessionID)
	server, err := m.server.store.GetServer(ctx, request.ServerID)
	if err != nil {
		_, _ = conn.Write([]byte("ShellOrchestra terminal bridge failed: server profile was not found\r\n"))
		return
	}
	err = m.server.runtime.ShellServer(ctx, server, runtime.ShellOptions{Term: terminalPTYTerm, Env: terminalEnvironment(), Rows: request.Rows, Cols: request.Cols, Stdin: stdin, Stdout: conn, Stderr: conn, Resize: session.ResizeCh})
	if err != nil && !errors.Is(err, io.EOF) {
		log.Printf("terminal bridge shell ended for session %s on server %s: %v", request.SessionID, request.ServerID, err)
	}
}

func (m *TerminalManager) handleOutputBridgeConn(conn net.Conn, reader *bufio.Reader, token string) {
	request, ok := m.bridgeRequestForToken(token)
	if !ok {
		_, _ = conn.Write([]byte("ShellOrchestra terminal output bridge failed: unknown terminal token\r\n"))
		return
	}
	if !request.ExpiresAt.IsZero() && time.Now().UTC().After(request.ExpiresAt) {
		_, _ = conn.Write([]byte("ShellOrchestra terminal output bridge failed: expired terminal token\r\n"))
		return
	}
	_ = conn.SetDeadline(time.Time{})
	input := io.MultiReader(reader, conn)
	buffer := make([]byte, 8192)
	for {
		n, err := input.Read(buffer)
		if n > 0 {
			m.requestStreamRefresh(request.SessionID)
		}
		if err != nil {
			return
		}
	}
}

func (m *TerminalManager) bridgeRequestForToken(token string) (terminalBridgeRequest, bool) {
	token = strings.TrimSpace(token)
	if token == "" {
		return terminalBridgeRequest{}, false
	}
	m.mu.RLock()
	request, ok := m.tokens[token]
	m.mu.RUnlock()
	if ok {
		return request, true
	}
	session, err := m.server.store.GetTerminalSessionByBridgeToken(context.Background(), token)
	if err != nil || session.State == "closed" {
		return terminalBridgeRequest{}, false
	}
	request = terminalBridgeRequest{SessionID: session.ID, ServerID: session.ServerID, Rows: session.Rows, Cols: session.Cols}
	m.mu.Lock()
	m.tokens[token] = request
	if existing := m.sessions[session.ID]; existing == nil {
		m.sessions[session.ID] = terminalSessionFromDomain(session)
	}
	m.mu.Unlock()
	return request, true
}

func (m *TerminalManager) ensureTmuxServer(ctx context.Context) error {
	m.tmuxServerLock.Lock()
	defer m.tmuxServerLock.Unlock()
	if m.tmuxServerReady {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(m.server.cfg.Runtime.TmuxSocketPath), 0o700); err != nil {
		return err
	}
	if !m.tmuxSessionExists(ctx, terminalTmuxSessionName) {
		if _, err := m.tmux(ctx, "new-session", "-d", "-s", terminalTmuxSessionName, "-n", "bootstrap", "-x", "80", "-y", "24", "sleep 31536000"); err != nil {
			return err
		}
	}
	commands := [][]string{
		{"set-option", "-g", "history-limit", fmt.Sprintf("%d", m.server.cfg.Runtime.TmuxHistoryLimitLines)},
		{"set-option", "-g", "window-size", "latest"},
		{"set-option", "-g", "status", "off"},
		{"set-option", "-g", "allow-rename", "off"},
		{"set-option", "-g", "automatic-rename", "off"},
		{"set-option", "-g", "default-terminal", "tmux-256color"},
		{"set-option", "-ga", "terminal-features", ",*:RGB"},
		{"set-option", "-g", "extended-keys", "on"},
		{"set-option", "-g", "focus-events", "on"},
		{"set-option", "-g", "mouse", "on"},
		{"set-option", "-g", "set-clipboard", "off"},
		{"set-option", "-g", "prefix", "C-\\"},
		{"set-option", "-g", "prefix2", "None"},
		{"unbind-key", "-a", "-T", "prefix"},
		{"unbind-key", "-a", "-T", "root"},
	}
	for _, args := range commands {
		if _, err := m.tmux(ctx, args...); err != nil {
			log.Printf("tmux setup command failed (%s): %v", strings.Join(args, " "), err)
		}
	}
	m.tmuxServerReady = true
	return nil
}

func (m *TerminalManager) createTmuxWindow(ctx context.Context, sessionID string, launcherPath string, cols int, rows int) (string, string, error) {
	format := "#{window_id}|#{pane_id}"
	tmuxSessionName := terminalTmuxSessionForTerminal(sessionID)
	if m.tmuxSessionExists(ctx, tmuxSessionName) {
		if err := m.killTmuxSession(ctx, tmuxSessionName); err != nil {
			return "", "", err
		}
	}
	result, err := m.tmux(ctx, "new-session", "-d", "-P", "-F", format, "-s", tmuxSessionName, "-n", "terminal", "-x", fmt.Sprintf("%d", cols), "-y", fmt.Sprintf("%d", rows), launcherPath)
	if err != nil {
		return "", "", err
	}
	parts := strings.Split(strings.TrimSpace(result.stdout), "|")
	if len(parts) != 2 {
		return "", "", fmt.Errorf("tmux did not return window and pane ids")
	}
	_, _ = m.tmux(ctx, "resize-window", "-t", parts[0], "-x", fmt.Sprintf("%d", cols), "-y", fmt.Sprintf("%d", rows))
	_, _ = m.tmux(ctx, "resize-pane", "-t", parts[1], "-x", fmt.Sprintf("%d", cols), "-y", fmt.Sprintf("%d", rows))
	_, _ = m.tmux(ctx, "set-window-option", "-t", parts[0], "remain-on-exit", "on")
	_, _ = m.tmux(ctx, "set-window-option", "-t", parts[0], "automatic-rename", "off")
	return parts[0], parts[1], nil
}

func (m *TerminalManager) tmuxSessionExists(ctx context.Context, name string) bool {
	result, err := m.tmux(ctx, "has-session", "-t", tmuxExactTarget(name))
	return err == nil && result.code == 0
}

func (m *TerminalManager) killShellOrchestraTmuxSessions(ctx context.Context) {
	result, err := m.tmux(ctx, "list-sessions", "-F", "#{session_name}")
	if err != nil {
		return
	}
	for _, line := range strings.Split(result.stdout, "\n") {
		name := strings.TrimSpace(line)
		if name == "" {
			continue
		}
		if name != terminalTmuxSessionName && !strings.HasPrefix(name, terminalTmuxSessionName+"-") {
			continue
		}
		if err := m.killTmuxSession(ctx, name); err != nil {
			log.Printf("failed to kill stale ShellOrchestra tmux session %s: %v", name, err)
		}
	}
}

func (m *TerminalManager) killTmuxSession(ctx context.Context, name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil
	}
	_, err := m.tmux(ctx, "kill-session", "-t", tmuxExactTarget(name))
	return err
}

func (m *TerminalManager) killWindow(ctx context.Context, windowID string) error {
	if strings.TrimSpace(windowID) == "" {
		return nil
	}
	_, err := m.tmux(ctx, "kill-window", "-t", windowID)
	return err
}

func terminalTmuxSessionForTerminal(sessionID string) string {
	name := terminalIDPattern.ReplaceAllString(strings.TrimSpace(sessionID), "-")
	name = strings.Trim(name, "-_")
	if name == "" {
		name = newTerminalSessionID("terminal")
	}
	if len(name) > 80 {
		name = name[:80]
	}
	return terminalTmuxSessionName + "-" + name
}

func tmuxExactTarget(name string) string {
	name = strings.TrimSpace(name)
	if name == "" || strings.HasPrefix(name, "=") {
		return name
	}
	return "=" + name
}

type tmuxCommandResult struct {
	stdout string
	stderr string
	code   int
}

func (m *TerminalManager) tmux(ctx context.Context, args ...string) (tmuxCommandResult, error) {
	commandArgs := append([]string{"-S", m.server.cfg.Runtime.TmuxSocketPath}, args...)
	commandCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(commandCtx, m.server.cfg.Runtime.TmuxBinary, commandArgs...)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	result := tmuxCommandResult{stdout: stdout.String(), stderr: stderr.String()}
	if cmd.ProcessState != nil {
		result.code = cmd.ProcessState.ExitCode()
	}
	if err != nil {
		if commandCtx.Err() != nil {
			return result, fmt.Errorf("tmux %s canceled: %w", strings.Join(args, " "), commandCtx.Err())
		}
		return result, fmt.Errorf("tmux %s failed: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(result.stderr))
	}
	return result, nil
}

type paneMetadata struct {
	dead           bool
	alternate      bool
	currentCommand string
	cursorX        int
	cursorY        int
	cursorVisible  bool
	cols           int
	rows           int
}

func (m *TerminalManager) paneMetadata(ctx context.Context, paneID string) (paneMetadata, error) {
	result, err := m.tmux(ctx, "display-message", "-p", "-t", paneID, "#{alternate_on}\t#{pane_dead}\t#{cursor_x}\t#{cursor_y}\t#{cursor_flag}\t#{pane_width}\t#{pane_height}\t#{pane_current_command}")
	if err != nil {
		return paneMetadata{}, err
	}
	parts := strings.Split(strings.TrimSpace(result.stdout), "\t")
	if len(parts) < 7 {
		return paneMetadata{}, nil
	}
	return paneMetadata{
		alternate:      parts[0] == "1",
		dead:           parts[1] == "1",
		cursorX:        maxInt(0, atoiDefault(parts[2], 0)),
		cursorY:        maxInt(0, atoiDefault(parts[3], 0)),
		cursorVisible:  parts[4] == "1",
		cols:           atoiDefault(parts[5], 0),
		rows:           atoiDefault(parts[6], 0),
		currentCommand: strings.TrimSpace(firstAvailablePart(parts, 7)),
	}, nil
}

func firstAvailablePart(parts []string, index int) string {
	if index < 0 || index >= len(parts) {
		return ""
	}
	return parts[index]
}

func newTerminalSessionID(serverID string) string {
	raw := make([]byte, 9)
	_, _ = rand.Read(raw)
	prefix := terminalIDPattern.ReplaceAllString(serverID, "-")
	return prefix + "-" + strings.TrimRight(base64.RawURLEncoding.EncodeToString(raw), "=")
}

func randomTerminalToken() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func normalizeTerminalCols(value int) int {
	if value < 20 {
		return 80
	}
	if value > 400 {
		return 400
	}
	return value
}

func normalizeTerminalRows(value int) int {
	if value < 5 {
		return 24
	}
	if value > 200 {
		return 200
	}
	return value
}

func atoiDefault(value string, fallback int) int {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	var out int
	if _, err := fmt.Sscanf(value, "%d", &out); err != nil {
		return fallback
	}
	return out
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func terminalHTTPError(err error) (int, string) {
	if errors.Is(err, store.ErrNotFound) {
		return 404, "Server was not found."
	}
	return 400, err.Error()
}

func terminalSessionHTTPError(err error) (int, string) {
	if errors.Is(err, store.ErrNotFound) {
		return 404, "Terminal session was not found."
	}
	return 400, err.Error()
}

func maxInt(left int, right int) int {
	if left > right {
		return left
	}
	return right
}
