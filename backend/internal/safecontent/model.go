// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package safecontent

import (
	"path/filepath"
	"strings"
)

const Version = 1

type SourceFamily string

const (
	FamilyUnknown   SourceFamily = "unknown"
	FamilyText      SourceFamily = "text"
	FamilyMarkdown  SourceFamily = "markdown"
	FamilyPDF       SourceFamily = "pdf"
	FamilyDOCX      SourceFamily = "docx"
	FamilyODT       SourceFamily = "odt"
	FamilyRTF       SourceFamily = "rtf"
	FamilyPPTX      SourceFamily = "pptx"
	FamilyODP       SourceFamily = "odp"
	FamilyLegacyDoc SourceFamily = "legacy-doc"
	FamilyLegacyPPT SourceFamily = "legacy-ppt"
	FamilyCSV       SourceFamily = "csv"
	FamilyTSV       SourceFamily = "tsv"
	FamilyXLSX      SourceFamily = "xlsx"
	FamilyODS       SourceFamily = "ods"
	FamilyLegacyXLS SourceFamily = "legacy-xls"
)

type Warning struct {
	Code     string `json:"code"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
	Path     string `json:"path,omitempty"`
}

type Document struct {
	Version    int             `json:"version"`
	SourceKind SourceFamily    `json:"source_kind"`
	Title      string          `json:"title,omitempty"`
	Warnings   []Warning       `json:"warnings,omitempty"`
	Blocks     []DocumentBlock `json:"blocks"`
	Truncated  bool            `json:"truncated,omitempty"`
}

func (d Document) Chunk(start int, limit int) (Document, bool) {
	if start < 0 {
		start = 0
	}
	if limit <= 0 {
		limit = 200
	}
	if start > len(d.Blocks) {
		start = len(d.Blocks)
	}
	end := start + limit
	if end > len(d.Blocks) {
		end = len(d.Blocks)
	}
	next := d
	next.Blocks = append([]DocumentBlock(nil), d.Blocks[start:end]...)
	hasMore := end < len(d.Blocks)
	next.Truncated = d.Truncated || hasMore
	return next, hasMore
}

type DocumentBlock struct {
	Type     string             `json:"type"`
	Level    int                `json:"level,omitempty"`
	Language string             `json:"language,omitempty"`
	Text     []DocumentInline   `json:"text,omitempty"`
	Rows     []DocumentTableRow `json:"rows,omitempty"`
}

type DocumentInline struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type DocumentTableRow struct {
	Cells []DocumentTableCell `json:"cells"`
}

type DocumentTableCell struct {
	Blocks []DocumentBlock `json:"blocks,omitempty"`
	Text   string          `json:"text,omitempty"`
}

type Workbook struct {
	Version    int          `json:"version"`
	SourceKind SourceFamily `json:"source_kind"`
	Warnings   []Warning    `json:"warnings,omitempty"`
	Sheets     []Sheet      `json:"sheets"`
	Chunks     []RowsChunk  `json:"chunks,omitempty"`
	Truncated  bool         `json:"truncated,omitempty"`
}

func (w Workbook) MetadataOnly() Workbook {
	next := w
	next.Chunks = nil
	return next
}

func (w Workbook) Rows(sheetID string, start int, limit int) (RowsChunk, bool) {
	if start < 0 {
		start = 0
	}
	if limit <= 0 {
		limit = 1000
	}
	if strings.TrimSpace(sheetID) == "" && len(w.Sheets) > 0 {
		sheetID = w.Sheets[0].ID
	}
	for _, chunk := range w.Chunks {
		if chunk.SheetID != sheetID {
			continue
		}
		rows := chunk.Rows
		if start > len(rows) {
			start = len(rows)
		}
		end := start + limit
		if end > len(rows) {
			end = len(rows)
		}
		return RowsChunk{
			Version:   Version,
			SheetID:   sheetID,
			StartRow:  start,
			Rows:      cloneRows(rows[start:end]),
			Truncated: chunk.Truncated || end < len(rows),
		}, end < len(rows) || chunk.Truncated
	}
	return RowsChunk{Version: Version, SheetID: sheetID, StartRow: start}, false
}

type Sheet struct {
	ID          string                 `json:"id"`
	Name        string                 `json:"name"`
	RowCount    int                    `json:"row_count,omitempty"`
	ColumnCount int                    `json:"column_count,omitempty"`
	Warnings    []Warning              `json:"warnings,omitempty"`
	Truncated   bool                   `json:"truncated,omitempty"`
	Header      *HeaderInference       `json:"header,omitempty"`
	Interactive InteractiveEligibility `json:"interactive"`
	Columns     []ColumnSummary        `json:"columns,omitempty"`
}

type RowsChunk struct {
	Version   int      `json:"version"`
	SheetID   string   `json:"sheet_id"`
	StartRow  int      `json:"start_row"`
	Rows      [][]Cell `json:"rows"`
	Truncated bool     `json:"truncated,omitempty"`
}

type Cell struct {
	Type         string   `json:"type"`
	Value        string   `json:"value,omitempty"`
	Display      string   `json:"display,omitempty"`
	NumberValue  *float64 `json:"number_value,omitempty"`
	BooleanValue *bool    `json:"boolean_value,omitempty"`
	DateValue    string   `json:"date_value,omitempty"`
	Flags        []string `json:"flags,omitempty"`
}

type HeaderInference struct {
	Detected   bool    `json:"detected"`
	Confidence float64 `json:"confidence"`
	RowIndex   int     `json:"row_index"`
	Reason     string  `json:"reason,omitempty"`
}

type InteractiveEligibility struct {
	Eligible       bool   `json:"eligible"`
	DisabledReason string `json:"disabled_reason,omitempty"`
	MaxRows        int    `json:"max_rows"`
	MaxColumns     int    `json:"max_columns"`
	MaxBytes       int    `json:"max_bytes"`
}

type ColumnSummary struct {
	Index        int     `json:"index"`
	Label        string  `json:"label"`
	InferredType string  `json:"inferred_type"`
	Confidence   float64 `json:"confidence"`
}

type Options struct {
	MaxInputBytes        int
	MaxOutputBytes       int
	MaxLineBytes         int
	MaxZipEntries        int
	MaxZipEntryBytes     int
	MaxZipTotalBytes     int
	MaxZipCompressionX   int
	MaxXMLDepth          int
	MaxBlocks            int
	MaxTableRows         int
	MaxTableCells        int
	MaxSheets            int
	MaxRowsPerSheet      int
	MaxColumnsPerSheet   int
	MaxCells             int
	MaxSharedStrings     int
	MaxCellTextBytes     int
	AllowImagePlaceholds bool
}

func DefaultOptions() Options {
	return Options{
		MaxInputBytes:        32 << 20,
		MaxOutputBytes:       2 << 20,
		MaxLineBytes:         64 << 10,
		MaxZipEntries:        512,
		MaxZipEntryBytes:     8 << 20,
		MaxZipTotalBytes:     64 << 20,
		MaxZipCompressionX:   100,
		MaxXMLDepth:          128,
		MaxBlocks:            5000,
		MaxTableRows:         2000,
		MaxTableCells:        50000,
		MaxSheets:            64,
		MaxRowsPerSheet:      5000,
		MaxColumnsPerSheet:   512,
		MaxCells:             100000,
		MaxSharedStrings:     200000,
		MaxCellTextBytes:     32 << 10,
		AllowImagePlaceholds: true,
	}
}

func normalizeOptions(options Options) Options {
	defaults := DefaultOptions()
	if options.MaxInputBytes <= 0 {
		options.MaxInputBytes = defaults.MaxInputBytes
	}
	if options.MaxOutputBytes <= 0 {
		options.MaxOutputBytes = defaults.MaxOutputBytes
	}
	if options.MaxLineBytes <= 0 {
		options.MaxLineBytes = defaults.MaxLineBytes
	}
	if options.MaxZipEntries <= 0 {
		options.MaxZipEntries = defaults.MaxZipEntries
	}
	if options.MaxZipEntryBytes <= 0 {
		options.MaxZipEntryBytes = defaults.MaxZipEntryBytes
	}
	if options.MaxZipTotalBytes <= 0 {
		options.MaxZipTotalBytes = defaults.MaxZipTotalBytes
	}
	if options.MaxZipCompressionX <= 0 {
		options.MaxZipCompressionX = defaults.MaxZipCompressionX
	}
	if options.MaxXMLDepth <= 0 {
		options.MaxXMLDepth = defaults.MaxXMLDepth
	}
	if options.MaxBlocks <= 0 {
		options.MaxBlocks = defaults.MaxBlocks
	}
	if options.MaxTableRows <= 0 {
		options.MaxTableRows = defaults.MaxTableRows
	}
	if options.MaxTableCells <= 0 {
		options.MaxTableCells = defaults.MaxTableCells
	}
	if options.MaxSheets <= 0 {
		options.MaxSheets = defaults.MaxSheets
	}
	if options.MaxRowsPerSheet <= 0 {
		options.MaxRowsPerSheet = defaults.MaxRowsPerSheet
	}
	if options.MaxColumnsPerSheet <= 0 {
		options.MaxColumnsPerSheet = defaults.MaxColumnsPerSheet
	}
	if options.MaxCells <= 0 {
		options.MaxCells = defaults.MaxCells
	}
	if options.MaxSharedStrings <= 0 {
		options.MaxSharedStrings = defaults.MaxSharedStrings
	}
	if options.MaxCellTextBytes <= 0 {
		options.MaxCellTextBytes = defaults.MaxCellTextBytes
	}
	return options
}

func DocumentFamilyForPath(path string) SourceFamily {
	ext := strings.ToLower(filepath.Ext(strings.ReplaceAll(path, "\\", "/")))
	switch ext {
	case ".md", ".markdown":
		return FamilyMarkdown
	case ".txt", ".log":
		return FamilyText
	case ".pdf":
		return FamilyPDF
	case ".docx":
		return FamilyDOCX
	case ".odt":
		return FamilyODT
	case ".rtf":
		return FamilyRTF
	case ".pptx":
		return FamilyPPTX
	case ".odp":
		return FamilyODP
	case ".doc":
		return FamilyLegacyDoc
	case ".ppt":
		return FamilyLegacyPPT
	default:
		return FamilyText
	}
}

func SpreadsheetFamilyForPath(path string) SourceFamily {
	ext := strings.ToLower(filepath.Ext(strings.ReplaceAll(path, "\\", "/")))
	switch ext {
	case ".csv":
		return FamilyCSV
	case ".tsv":
		return FamilyTSV
	case ".xlsx":
		return FamilyXLSX
	case ".ods":
		return FamilyODS
	case ".xls":
		return FamilyLegacyXLS
	default:
		return FamilyUnknown
	}
}

func IsSpreadsheetPath(path string) bool {
	return SpreadsheetFamilyForPath(path) != FamilyUnknown
}

func IsDocumentPath(path string) bool {
	family := DocumentFamilyForPath(path)
	return family != FamilyText || strings.EqualFold(filepath.Ext(path), ".txt") || strings.EqualFold(filepath.Ext(path), ".log")
}

func warning(code, message string) Warning {
	return Warning{Code: strings.TrimSpace(code), Severity: "warning", Message: strings.TrimSpace(message)}
}

func cloneRows(rows [][]Cell) [][]Cell {
	out := make([][]Cell, 0, len(rows))
	for _, row := range rows {
		out = append(out, append([]Cell(nil), row...))
	}
	return out
}

func textInline(value string) []DocumentInline {
	if value == "" {
		return nil
	}
	return []DocumentInline{{Type: "text", Text: value}}
}
