// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package worker

import (
	"reflect"
	"strconv"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"shellorchestra/backend/internal/domain"
)

const terminalRenderHistoryLimit = 100

type terminalRenderService struct {
	mu     sync.Mutex
	states map[string]cachedTerminalRenderState
}

type cachedTerminalRenderState struct {
	revision int
	state    terminalRenderState
}

type terminalRenderState struct {
	Cols             int
	Rows             int
	Alternate        bool
	HistoryRows      []terminalVisualRow
	ScreenRows       []terminalVisualRow
	Cursor           terminalCursor
	Title            string
	CurrentDirectory string
	InputModes       map[string]any
	Status           string
	ExitStatus       *int
}

type terminalFrame struct {
	Cols             int                 `json:"cols"`
	Rows             int                 `json:"rows"`
	Alternate        bool                `json:"alternate_on"`
	Title            string              `json:"title"`
	CurrentDirectory string              `json:"current_directory,omitempty"`
	InputModes       map[string]any      `json:"input_modes"`
	Status           string              `json:"status"`
	ExitStatus       *int                `json:"exit_status,omitempty"`
	HistoryRows      []terminalVisualRow `json:"history_rows"`
	ScreenRows       []terminalVisualRow `json:"screen_rows"`
	Cursor           terminalCursor      `json:"cursor"`
}

type terminalVisualRow struct {
	Runs []terminalVisualRun `json:"runs"`
}

type terminalVisualRun struct {
	Col   int                 `json:"col"`
	Text  string              `json:"text"`
	Width int                 `json:"width"`
	Style terminalRenderStyle `json:"style"`
}

type terminalRenderStyle struct {
	FG        string `json:"fg,omitempty"`
	BG        string `json:"bg,omitempty"`
	Bold      bool   `json:"bold"`
	Dim       bool   `json:"dim"`
	Italic    bool   `json:"italic"`
	Underline bool   `json:"underline"`
	Inverse   bool   `json:"inverse"`
}

type terminalCursor struct {
	X       int  `json:"x"`
	Y       int  `json:"y"`
	Visible bool `json:"visible"`
}

type terminalPatchedRow struct {
	Row  int                 `json:"row"`
	Runs []terminalVisualRun `json:"runs"`
}

func newTerminalRenderService() *terminalRenderService {
	return &terminalRenderService{states: map[string]cachedTerminalRenderState{}}
}

func (s *terminalRenderService) reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.states = map[string]cachedTerminalRenderState{}
}

func (s *terminalRenderService) dropSession(sessionID string) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return
	}
	s.mu.Lock()
	delete(s.states, sessionID)
	s.mu.Unlock()
}

func (s *terminalRenderService) buildMessage(sessionID string, snapshot domain.TerminalSnapshot, forceFullSync bool) *terminalStreamServerMessage {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return nil
	}
	nextState := buildTerminalRenderState(snapshot)
	s.mu.Lock()
	defer s.mu.Unlock()
	previous, ok := s.states[sessionID]
	if !ok {
		current := cachedTerminalRenderState{revision: 1, state: nextState}
		s.states[sessionID] = current
		return terminalFullSyncMessage(sessionID, current)
	}
	current := previous
	if !reflect.DeepEqual(previous.state, nextState) {
		current = cachedTerminalRenderState{revision: previous.revision + 1, state: nextState}
		s.states[sessionID] = current
	}
	if forceFullSync {
		return terminalFullSyncMessage(sessionID, current)
	}
	if current.revision == previous.revision {
		return nil
	}
	if previous.state.Cols != current.state.Cols || previous.state.Rows != current.state.Rows {
		return terminalFullSyncMessage(sessionID, current)
	}
	if rows, ok := detectTerminalScrollAppend(previous.state, current.state); ok {
		return terminalAppendRowsMessage(sessionID, previous, current, rows)
	}
	if rows, ok := detectTerminalScreenPatch(previous.state, current.state); ok {
		return terminalPatchRowsMessage(sessionID, previous, current, rows)
	}
	return terminalFullSyncMessage(sessionID, current)
}

func terminalFullSyncMessage(sessionID string, cache cachedTerminalRenderState) *terminalStreamServerMessage {
	return &terminalStreamServerMessage{
		Type:      "full_sync",
		SessionID: sessionID,
		Revision:  cache.revision,
		Frame:     ptrTerminalFrame(terminalFrameFromState(cache.state)),
	}
}

func ptrTerminalFrame(frame terminalFrame) *terminalFrame {
	return &frame
}

func terminalAppendRowsMessage(sessionID string, previous cachedTerminalRenderState, current cachedTerminalRenderState, rows []terminalVisualRow) *terminalStreamServerMessage {
	return &terminalStreamServerMessage{
		Type:         "append_rows",
		SessionID:    sessionID,
		BaseRevision: previous.revision,
		Revision:     current.revision,
		Cols:         current.state.Cols,
		TerminalRows: current.state.Rows,
		Alternate:    current.state.Alternate,
		Title:        current.state.Title,
		Status:       current.state.Status,
		ExitStatus:   current.state.ExitStatus,
		InputModes:   cloneTerminalInputModes(current.state.InputModes),
		Rows:         rows,
		Cursor:       &current.state.Cursor,
	}
}

func terminalPatchRowsMessage(sessionID string, previous cachedTerminalRenderState, current cachedTerminalRenderState, rows []terminalPatchedRow) *terminalStreamServerMessage {
	return &terminalStreamServerMessage{
		Type:         "patch_rows",
		SessionID:    sessionID,
		BaseRevision: previous.revision,
		Revision:     current.revision,
		Cols:         current.state.Cols,
		TerminalRows: current.state.Rows,
		Alternate:    current.state.Alternate,
		Title:        current.state.Title,
		Status:       current.state.Status,
		ExitStatus:   current.state.ExitStatus,
		InputModes:   cloneTerminalInputModes(current.state.InputModes),
		Rows:         rows,
		Cursor:       &current.state.Cursor,
	}
}

func terminalFrameFromState(state terminalRenderState) terminalFrame {
	return terminalFrame{
		Cols:             state.Cols,
		Rows:             state.Rows,
		Alternate:        state.Alternate,
		Title:            state.Title,
		CurrentDirectory: state.CurrentDirectory,
		InputModes:       cloneTerminalInputModes(state.InputModes),
		Status:           state.Status,
		ExitStatus:       state.ExitStatus,
		HistoryRows:      cloneTerminalRows(state.HistoryRows),
		ScreenRows:       cloneTerminalRows(state.ScreenRows),
		Cursor:           state.Cursor,
	}
}

func buildTerminalRenderState(snapshot domain.TerminalSnapshot) terminalRenderState {
	rows := normalizeTerminalRows(snapshot.Session.Rows)
	cols := normalizeTerminalCols(snapshot.Session.Cols)
	if rows <= 0 {
		rows = 24
	}
	if cols <= 0 {
		cols = 80
	}
	parsedRows := parseTerminalCaptureRows(snapshot.Capture)
	if len(parsedRows) < rows {
		padded := make([]terminalVisualRow, 0, rows)
		missingRows := rows - len(parsedRows)
		for index := 0; index < missingRows; index++ {
			padded = append(padded, terminalVisualRow{})
		}
		parsedRows = append(padded, parsedRows...)
	}
	screenRows := parsedRows
	if len(screenRows) > rows {
		screenRows = screenRows[len(screenRows)-rows:]
	}
	historyRows := []terminalVisualRow{}
	if !snapshot.Alternate && len(parsedRows) > rows {
		historyRows = parsedRows[:len(parsedRows)-rows]
		if len(historyRows) > terminalRenderHistoryLimit {
			historyRows = historyRows[len(historyRows)-terminalRenderHistoryLimit:]
		}
	}
	status := strings.TrimSpace(snapshot.Session.State)
	if status == "" {
		status = "running"
	}
	cursor := terminalCursorFromSnapshot(snapshot, screenRows, rows, cols)
	return terminalRenderState{
		Cols:        cols,
		Rows:        rows,
		Alternate:   snapshot.Alternate,
		HistoryRows: cloneTerminalRows(historyRows),
		ScreenRows:  cloneTerminalRows(screenRows),
		Cursor:      cursor,
		Title:       snapshot.Session.Title,
		InputModes:  terminalInputModes(snapshot),
		Status:      status,
	}
}

func terminalInputModes(snapshot domain.TerminalSnapshot) map[string]any {
	modes := map[string]any{}
	if snapshot.Alternate || terminalProgramRequestsMouse(snapshot.CurrentCommand) || terminalCaptureLooksLikeMouseTUI(snapshot.Capture) {
		modes["mouse_tracking"] = true
	}
	return modes
}

func terminalProgramRequestsMouse(command string) bool {
	switch strings.ToLower(strings.TrimSpace(command)) {
	case "mc", "htop", "btop", "top", "vim", "nvim", "nano", "less", "more":
		return true
	default:
		return false
	}
}

func terminalCaptureLooksLikeMouseTUI(capture string) bool {
	normalized := strings.ToLower(capture)
	if strings.Contains(normalized, "hint: tab changes your current panel") {
		return true
	}
	if strings.Contains(normalized, "up--dir") && strings.Contains(normalized, "1help") && strings.Contains(normalized, "10quit") {
		return true
	}
	return false
}

func terminalCursorFromSnapshot(snapshot domain.TerminalSnapshot, screenRows []terminalVisualRow, rows int, cols int) terminalCursor {
	cursor := terminalCursor{
		X:       clampInt(snapshot.CursorX, 0, maxInt(cols-1, 0)),
		Y:       clampInt(snapshot.CursorY, 0, maxInt(rows-1, 0)),
		Visible: snapshot.CursorVisible,
	}
	if clampedX, ok := clampShellPromptEraseArtifactCursor(screenRows, cursor.Y, cursor.X, cols); ok {
		cursor.X = clampedX
		cursor.Visible = true
	}
	if snapshot.Alternate || cursor.X != 0 || cursor.Y != 0 {
		return cursor
	}
	if derivedX, derivedY, ok := derivePromptCursorFromScreenRows(screenRows, cols); ok {
		cursor.X = derivedX
		cursor.Y = derivedY
		cursor.Visible = true
	}
	return cursor
}

func clampShellPromptEraseArtifactCursor(screenRows []terminalVisualRow, cursorY int, cursorX int, cols int) (int, bool) {
	if cursorY < 0 || cursorY >= len(screenRows) || cursorX <= 0 {
		return 0, false
	}
	row := screenRows[cursorY]
	var rowText strings.Builder
	lastNonSpaceEnd := -1
	lastNonSpaceRune := rune(0)
	rowEnd := 0
	for _, run := range row.Runs {
		rowText.WriteString(run.Text)
		col := run.Col
		for _, r := range run.Text {
			width := terminalRuneWidth(r)
			if width <= 0 {
				continue
			}
			nextCol := col + width
			rowEnd = maxInt(rowEnd, nextCol)
			if !unicode.IsSpace(r) {
				lastNonSpaceEnd = nextCol
				lastNonSpaceRune = r
			}
			col = nextCol
		}
	}
	if lastNonSpaceEnd < 0 || !terminalPromptMarkerRune(lastNonSpaceRune) {
		return 0, false
	}
	if !terminalPromptLineContext(rowText.String()) {
		return 0, false
	}
	if rowEnd < lastNonSpaceEnd {
		return 0, false
	}
	promptCursorX := clampInt(lastNonSpaceEnd+2, 0, maxInt(cols-1, 0))
	if cursorX <= promptCursorX {
		return 0, false
	}
	return promptCursorX, true
}

func terminalPromptMarkerRune(r rune) bool {
	switch r {
	case '$', '#', '%', '>':
		return true
	default:
		return false
	}
}

func terminalPromptLineContext(value string) bool {
	trimmed := strings.TrimRightFunc(value, unicode.IsSpace)
	if trimmed == "" {
		return false
	}
	runes := []rune(trimmed)
	if len(runes) == 0 || !terminalPromptMarkerRune(runes[len(runes)-1]) {
		return false
	}
	prefix := strings.TrimSpace(string(runes[:len(runes)-1]))
	if prefix == "" {
		return true
	}
	return strings.ContainsAny(prefix, "@:~/\\")
}

func derivePromptCursorFromScreenRows(screenRows []terminalVisualRow, cols int) (int, int, bool) {
	for rowIndex := len(screenRows) - 1; rowIndex >= 0; rowIndex-- {
		row := screenRows[rowIndex]
		endCol := 0
		hasText := false
		for _, run := range row.Runs {
			if strings.TrimSpace(run.Text) == "" {
				continue
			}
			hasText = true
			endCol = maxInt(endCol, run.Col+maxInt(run.Width, terminalStringWidth(run.Text)))
		}
		if !hasText {
			continue
		}
		return clampInt(endCol, 0, maxInt(cols-1, 0)), clampInt(rowIndex, 0, maxInt(len(screenRows)-1, 0)), true
	}
	return 0, 0, false
}

func detectTerminalScrollAppend(previous terminalRenderState, current terminalRenderState) ([]terminalVisualRow, bool) {
	if previous.Alternate || current.Alternate {
		return nil, false
	}
	previousRows := append(cloneTerminalRows(previous.HistoryRows), previous.ScreenRows...)
	currentRows := append(cloneTerminalRows(current.HistoryRows), current.ScreenRows...)
	if len(previousRows) == 0 || len(previousRows) != len(currentRows) {
		return nil, false
	}
	for shift := 1; shift < len(previousRows); shift++ {
		if reflect.DeepEqual(previousRows[shift:], currentRows[:len(currentRows)-shift]) {
			return cloneTerminalRows(currentRows[len(currentRows)-shift:]), true
		}
	}
	return nil, false
}

func detectTerminalScreenPatch(previous terminalRenderState, current terminalRenderState) ([]terminalPatchedRow, bool) {
	if !reflect.DeepEqual(previous.HistoryRows, current.HistoryRows) {
		return nil, false
	}
	patches := make([]terminalPatchedRow, 0)
	maxRows := minInt(len(previous.ScreenRows), len(current.ScreenRows))
	for rowIndex := 0; rowIndex < maxRows; rowIndex++ {
		if reflect.DeepEqual(previous.ScreenRows[rowIndex], current.ScreenRows[rowIndex]) {
			continue
		}
		patches = append(patches, terminalPatchedRow{Row: rowIndex, Runs: cloneTerminalRuns(current.ScreenRows[rowIndex].Runs)})
	}
	if len(previous.ScreenRows) != len(current.ScreenRows) {
		return nil, false
	}
	if len(patches) == 0 && previous.Cursor == current.Cursor && terminalMetadataEqual(previous, current) {
		return []terminalPatchedRow{}, true
	}
	return patches, true
}

func terminalMetadataEqual(left terminalRenderState, right terminalRenderState) bool {
	return left.Cols == right.Cols &&
		left.Rows == right.Rows &&
		left.Alternate == right.Alternate &&
		left.Title == right.Title &&
		left.CurrentDirectory == right.CurrentDirectory &&
		left.Status == right.Status &&
		reflect.DeepEqual(left.ExitStatus, right.ExitStatus) &&
		reflect.DeepEqual(left.InputModes, right.InputModes)
}

func parseTerminalCaptureRows(capture string) []terminalVisualRow {
	normalized := strings.ReplaceAll(strings.ReplaceAll(capture, "\r\n", "\n"), "\r", "\n")
	lines := strings.Split(normalized, "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	rows := make([]terminalVisualRow, 0, len(lines))
	style := terminalRenderStyle{}
	for _, line := range lines {
		row, nextStyle := parseTerminalVisualRow(line, style)
		rows = append(rows, row)
		style = nextStyle
	}
	return rows
}

func parseTerminalVisualRow(line string, initialStyle terminalRenderStyle) (terminalVisualRow, terminalRenderStyle) {
	runs := make([]terminalVisualRun, 0)
	style := initialStyle
	var builder strings.Builder
	col := 0
	runStartCol := 0
	runWidth := 0
	runStyle := style
	flush := func() {
		if builder.Len() == 0 {
			return
		}
		runs = append(runs, terminalVisualRun{Col: runStartCol, Text: builder.String(), Width: runWidth, Style: runStyle})
		builder.Reset()
		runWidth = 0
	}
	appendRune := func(r rune) {
		if builder.Len() == 0 {
			runStartCol = col
			runStyle = style
		} else if runStyle != style {
			flush()
			runStartCol = col
			runStyle = style
		}
		builder.WriteRune(r)
		width := terminalRuneWidth(r)
		runWidth += width
		col += width
	}
	for index := 0; index < len(line); {
		if line[index] == '\x1b' {
			sequence, final, nextIndex := consumeTerminalEscape(line, index)
			if final == 'm' && strings.HasPrefix(sequence, "\x1b[") {
				flush()
				style = applyTerminalSGR(style, strings.TrimSuffix(strings.TrimPrefix(sequence, "\x1b["), "m"))
			}
			index = nextIndex
			continue
		}
		r, size := utf8.DecodeRuneInString(line[index:])
		if r == utf8.RuneError && size == 1 {
			index++
			continue
		}
		index += size
		if r == '\t' {
			spaces := 8 - (col % 8)
			for spaceIndex := 0; spaceIndex < spaces; spaceIndex++ {
				appendRune(' ')
			}
			continue
		}
		if terminalRuneAllowed(r) {
			appendRune(r)
		}
	}
	flush()
	return terminalVisualRow{Runs: runs}, style
}

func consumeTerminalEscape(value string, start int) (sequence string, final byte, next int) {
	if start >= len(value) || value[start] != '\x1b' {
		return "", 0, start + 1
	}
	if start+1 >= len(value) {
		return value[start:], 0, len(value)
	}
	switch value[start+1] {
	case '[':
		for index := start + 2; index < len(value); index++ {
			if value[index] >= 0x40 && value[index] <= 0x7e {
				return value[start : index+1], value[index], index + 1
			}
		}
		return value[start:], 0, len(value)
	case ']':
		return consumeTerminatedEscape(value, start, start+2)
	case 'P', '^', '_':
		return consumeTerminatedEscape(value, start, start+2)
	default:
		_, size := utf8.DecodeRuneInString(value[start+1:])
		if size <= 0 {
			size = 1
		}
		return value[start : start+1+size], 0, start + 1 + size
	}
}

func consumeTerminatedEscape(value string, start int, index int) (string, byte, int) {
	for index < len(value) {
		if value[index] == '\a' {
			return value[start : index+1], 0, index + 1
		}
		if value[index] == '\x1b' && index+1 < len(value) && value[index+1] == '\\' {
			return value[start : index+2], 0, index + 2
		}
		index++
	}
	return value[start:], 0, len(value)
}

func applyTerminalSGR(style terminalRenderStyle, params string) terminalRenderStyle {
	codes := parseSGRCodes(params)
	if len(codes) == 0 {
		codes = []int{0}
	}
	for index := 0; index < len(codes); index++ {
		code := codes[index]
		switch {
		case code == 0:
			style = terminalRenderStyle{}
		case code == 1:
			style.Bold = true
		case code == 2:
			style.Dim = true
		case code == 3:
			style.Italic = true
		case code == 4:
			style.Underline = true
		case code == 7:
			style.Inverse = true
		case code == 22:
			style.Bold = false
			style.Dim = false
		case code == 23:
			style.Italic = false
		case code == 24:
			style.Underline = false
		case code == 27:
			style.Inverse = false
		case code >= 30 && code <= 37:
			style.FG = terminalANSIColor(code - 30)
		case code == 39:
			style.FG = ""
		case code >= 40 && code <= 47:
			style.BG = terminalANSIColor(code - 40)
		case code == 49:
			style.BG = ""
		case code >= 90 && code <= 97:
			style.FG = terminalANSIColor(code - 82)
		case code >= 100 && code <= 107:
			style.BG = terminalANSIColor(code - 92)
		case code == 38 || code == 48:
			color, consumed := parseTerminalSGRColor(codes, index)
			if code == 38 {
				style.FG = color
			} else {
				style.BG = color
			}
			index += consumed
		}
	}
	return style
}

func parseSGRCodes(params string) []int {
	if strings.TrimSpace(params) == "" {
		return []int{0}
	}
	parts := strings.Split(params, ";")
	codes := make([]int, 0, len(parts))
	for _, part := range parts {
		if part == "" {
			codes = append(codes, 0)
			continue
		}
		code, err := strconv.Atoi(part)
		if err != nil {
			continue
		}
		codes = append(codes, code)
	}
	return codes
}

func parseTerminalSGRColor(codes []int, index int) (string, int) {
	if index+1 >= len(codes) {
		return "", 0
	}
	mode := codes[index+1]
	if mode == 2 && index+4 < len(codes) {
		return rgbHex(codes[index+2], codes[index+3], codes[index+4]), 4
	}
	if mode == 5 && index+2 < len(codes) {
		return terminalPalette256(codes[index+2]), 2
	}
	return "", 0
}

func terminalANSIColor(code int) string {
	colors := []string{
		"#0e0e0e", "#d44f4f", "#4be277", "#e6c66a",
		"#65b9ff", "#c792ea", "#96d59d", "#e5e2e1",
		"#596659", "#ff6b6b", "#6bff8f", "#f5d979",
		"#8fc7ff", "#e1adff", "#dbfcff", "#ffffff",
	}
	if code < 0 || code >= len(colors) {
		return ""
	}
	return colors[code]
}

func terminalPalette256(code int) string {
	if code < 0 {
		return ""
	}
	if code < 16 {
		return terminalANSIColor(code)
	}
	if code <= 231 {
		offset := code - 16
		red := offset / 36
		green := (offset % 36) / 6
		blue := offset % 6
		return rgbHex(cubeColorComponent(red), cubeColorComponent(green), cubeColorComponent(blue))
	}
	if code <= 255 {
		value := 8 + ((code - 232) * 10)
		return rgbHex(value, value, value)
	}
	return ""
}

func cubeColorComponent(value int) int {
	if value == 0 {
		return 0
	}
	return 55 + value*40
}

func rgbHex(red int, green int, blue int) string {
	return "#" + hexByte(red) + hexByte(green) + hexByte(blue)
}

func hexByte(value int) string {
	value = clampInt(value, 0, 255)
	const digits = "0123456789abcdef"
	return string([]byte{digits[value>>4], digits[value&0x0f]})
}

func terminalRuneAllowed(r rune) bool {
	if r == utf8.RuneError {
		return false
	}
	if r < 0x20 || (r >= 0x7f && r < 0xa0) {
		return false
	}
	if unicode.Is(unicode.Cc, r) || unicode.Is(unicode.Cf, r) {
		return false
	}
	return true
}

func terminalRuneWidth(r rune) int {
	if r == 0 || unicode.Is(unicode.Mn, r) || unicode.Is(unicode.Me, r) {
		return 0
	}
	if isWideTerminalRune(r) {
		return 2
	}
	return 1
}

func terminalStringWidth(value string) int {
	width := 0
	for _, r := range value {
		width += terminalRuneWidth(r)
	}
	return width
}

func isWideTerminalRune(r rune) bool {
	return (r >= 0x1100 && r <= 0x115f) ||
		(r >= 0x2329 && r <= 0x232a) ||
		(r >= 0x2e80 && r <= 0xa4cf) ||
		(r >= 0xac00 && r <= 0xd7a3) ||
		(r >= 0xf900 && r <= 0xfaff) ||
		(r >= 0xfe10 && r <= 0xfe19) ||
		(r >= 0xfe30 && r <= 0xfe6f) ||
		(r >= 0xff00 && r <= 0xff60) ||
		(r >= 0xffe0 && r <= 0xffe6) ||
		(r >= 0x1f300 && r <= 0x1faff)
}

func cloneTerminalInputModes(values map[string]any) map[string]any {
	if len(values) == 0 {
		return map[string]any{}
	}
	clone := make(map[string]any, len(values))
	for key, value := range values {
		clone[key] = value
	}
	return clone
}

func cloneTerminalRows(rows []terminalVisualRow) []terminalVisualRow {
	if len(rows) == 0 {
		return nil
	}
	clone := make([]terminalVisualRow, len(rows))
	for index, row := range rows {
		clone[index] = terminalVisualRow{Runs: cloneTerminalRuns(row.Runs)}
	}
	return clone
}

func cloneTerminalRuns(runs []terminalVisualRun) []terminalVisualRun {
	if len(runs) == 0 {
		return nil
	}
	clone := make([]terminalVisualRun, len(runs))
	copy(clone, runs)
	return clone
}

func clampInt(value int, minValue int, maxValue int) int {
	if value < minValue {
		return minValue
	}
	if value > maxValue {
		return maxValue
	}
	return value
}

func minInt(left int, right int) int {
	if left < right {
		return left
	}
	return right
}
