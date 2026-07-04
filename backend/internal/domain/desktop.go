// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package domain

import (
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
)

const (
	VirtualDesktopTaskbarHeight = 52
	VirtualDesktopAnimationMS   = 180
)

var virtualDesktopWindowKinds = map[string]struct{}{
	"terminal":         {},
	"package_manager":  {},
	"process_monitor":  {},
	"file_manager":     {},
	"containers":       {},
	"logs":             {},
	"services":         {},
	"custom_shortcuts": {},
	"firewall":         {},
	"disks":            {},
	"speed_test":       {},
	"editor":           {},
}

type VirtualDesktopState struct {
	ServerID  string                 `json:"server_id"`
	Wallpaper string                 `json:"wallpaper,omitempty"`
	Revision  int64                  `json:"revision"`
	Windows   []VirtualDesktopWindow `json:"windows"`
	UpdatedAt time.Time              `json:"updated_at"`
}

type VirtualDesktopWallpaper struct {
	ID          string    `json:"id"`
	Label       string    `json:"label"`
	ContentType string    `json:"content_type"`
	Source      string    `json:"source"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type VirtualDesktopWindow struct {
	ID                string            `json:"id"`
	AppID             string            `json:"app_id,omitempty"`
	PluginID          string            `json:"plugin_id,omitempty"`
	FrontendModule    string            `json:"frontend_module,omitempty"`
	Kind              string            `json:"kind"`
	Title             string            `json:"title"`
	X                 int               `json:"x"`
	Y                 int               `json:"y"`
	Width             int               `json:"width"`
	Height            int               `json:"height"`
	Minimized         bool              `json:"minimized"`
	Maximized         bool              `json:"maximized"`
	ZIndex            int               `json:"z_index"`
	TerminalSessionID string            `json:"terminal_session_id,omitempty"`
	Metadata          map[string]string `json:"metadata,omitempty"`
}

type VirtualDesktopWindows []VirtualDesktopWindow

func (w VirtualDesktopWindow) Normalize(index int) VirtualDesktopWindow {
	w = migrateLegacyVirtualDesktopWindow(w)
	w.ID = sanitizeVirtualDesktopToken(w.ID, 128)
	if w.ID == "" {
		w.ID = uuid.NewString()
	}
	w.AppID = sanitizeVirtualDesktopToken(w.AppID, 128)
	w.PluginID = sanitizeVirtualDesktopToken(w.PluginID, 128)
	w.FrontendModule = sanitizeVirtualDesktopToken(w.FrontendModule, 128)
	w.Kind = sanitizeVirtualDesktopToken(w.Kind, 64)
	if w.Kind == "" {
		w.Kind = "terminal"
	}
	if w.FrontendModule == "" {
		w.FrontendModule = w.Kind
	}
	w.Title = SanitizeDisplayLabel(w.Title, 120)
	if w.Title == "" {
		w.Title = VirtualDesktopWindowTitle(w.Kind)
	}
	if w.Width < 240 {
		w.Width = 240
	}
	if w.Height < 160 {
		w.Height = 160
	}
	if w.X < 0 {
		w.X = 0
	}
	if w.Y < 0 {
		w.Y = 0
	}
	if w.ZIndex <= 0 {
		w.ZIndex = index + 1
	}
	w.TerminalSessionID = sanitizeVirtualDesktopToken(w.TerminalSessionID, 128)
	w.Metadata = sanitizeVirtualDesktopMetadata(w.Metadata)
	return w
}

func migrateLegacyVirtualDesktopWindow(w VirtualDesktopWindow) VirtualDesktopWindow {
	appID := strings.TrimSpace(w.AppID)
	title := strings.ToLower(strings.TrimSpace(w.Title))
	if appID != "docker_ps" && title != "docker watch" {
		return w
	}
	metadata := map[string]string{}
	for key, value := range w.Metadata {
		metadata[key] = value
	}
	metadata["data_refresh_interval_seconds"] = "5"
	w.AppID = "containers"
	w.PluginID = "builtin"
	w.FrontendModule = "containers"
	w.Kind = "containers"
	w.Title = "Containers"
	w.TerminalSessionID = ""
	w.Metadata = metadata
	return w
}

func (w VirtualDesktopWindow) IsSupported() bool {
	_, ok := virtualDesktopWindowKinds[strings.TrimSpace(w.Kind)]
	return ok
}

func (windows VirtualDesktopWindows) Normalize() VirtualDesktopWindows {
	normalized := make(VirtualDesktopWindows, 0, len(windows))
	for index, window := range windows {
		normalized = append(normalized, window.Normalize(index))
	}
	return normalized
}

func (windows VirtualDesktopWindows) BringToFront(id string) VirtualDesktopWindows {
	id = strings.TrimSpace(id)
	maxZ := 0
	for _, window := range windows {
		if window.ZIndex > maxZ {
			maxZ = window.ZIndex
		}
	}
	next := make(VirtualDesktopWindows, 0, len(windows))
	for _, window := range windows {
		if window.ID == id {
			window.ZIndex = maxZ + 1
		}
		next = append(next, window)
	}
	return next
}

func (windows VirtualDesktopWindows) ActiveWindowID() string {
	var active VirtualDesktopWindow
	found := false
	for _, window := range windows {
		if window.Minimized {
			continue
		}
		if !found || window.ZIndex > active.ZIndex {
			active = window
			found = true
		}
	}
	if !found {
		return ""
	}
	return active.ID
}

func VirtualDesktopWindowTitle(kind string) string {
	switch strings.TrimSpace(kind) {
	case "terminal":
		return "Terminal"
	case "package_manager":
		return "Package Manager"
	case "process_monitor":
		return "Task Manager"
	case "file_manager":
		return "File Manager"
	case "containers":
		return "Containers"
	case "logs":
		return "Logs"
	case "services":
		return "Services"
	case "custom_shortcuts":
		return "Custom Shortcuts"
	case "firewall":
		return "Firewall"
	case "disks":
		return "Disks"
	case "speed_test":
		return "Test Speed"
	case "editor":
		return "Editor"
	default:
		return "Window"
	}
}

type TerminalSession struct {
	ID          string    `json:"id"`
	ServerID    string    `json:"server_id"`
	Title       string    `json:"title"`
	State       string    `json:"state"`
	Rows        int       `json:"rows"`
	Cols        int       `json:"cols"`
	WindowID    string    `json:"-"`
	PaneID      string    `json:"-"`
	BundleDir   string    `json:"-"`
	BridgeToken string    `json:"-"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func sanitizeVirtualDesktopToken(value string, maxLen int) string {
	var builder strings.Builder
	for _, r := range strings.TrimSpace(value) {
		if r == '-' || r == '_' || unicode.IsLetter(r) || unicode.IsDigit(r) {
			builder.WriteRune(r)
		}
		if builder.Len() >= maxLen {
			break
		}
	}
	return builder.String()
}

func SanitizeDisplayLabel(value string, maxLen int) string {
	trimmed := strings.TrimSpace(value)
	var builder strings.Builder
	lastSpace := false
	for _, r := range trimmed {
		if r == '\n' || r == '\r' || r == '\t' {
			r = ' '
		}
		if unicode.IsControl(r) {
			continue
		}
		if unicode.IsSpace(r) {
			if lastSpace {
				continue
			}
			lastSpace = true
			builder.WriteByte(' ')
		} else {
			lastSpace = false
			builder.WriteRune(r)
		}
		if builder.Len() >= maxLen {
			break
		}
	}
	return strings.TrimSpace(builder.String())
}

func sanitizeVirtualDesktopMetadata(values map[string]string) map[string]string {
	if len(values) == 0 {
		return nil
	}
	clean := make(map[string]string, len(values))
	for key, value := range values {
		cleanKey := sanitizeVirtualDesktopToken(key, 64)
		cleanValue := sanitizeVirtualDesktopMetadataValue(value, 1024)
		if cleanKey == "" || cleanValue == "" {
			continue
		}
		clean[cleanKey] = cleanValue
	}
	if len(clean) == 0 {
		return nil
	}
	return clean
}

func sanitizeVirtualDesktopMetadataValue(value string, maxLen int) string {
	trimmed := strings.TrimSpace(value)
	var builder strings.Builder
	for _, r := range trimmed {
		if r == '\n' || r == '\r' || r == '\t' {
			r = ' '
		}
		if unicode.IsControl(r) {
			continue
		}
		builder.WriteRune(r)
		if builder.Len() >= maxLen {
			break
		}
	}
	return strings.TrimSpace(builder.String())
}

type TerminalSnapshot struct {
	Session        TerminalSession `json:"session"`
	Capture        string          `json:"capture"`
	CursorX        int             `json:"cursor_x"`
	CursorY        int             `json:"cursor_y"`
	CursorVisible  bool            `json:"cursor_visible"`
	Alternate      bool            `json:"alternate"`
	CurrentCommand string          `json:"current_command,omitempty"`
}
