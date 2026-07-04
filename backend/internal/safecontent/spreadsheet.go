// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package safecontent

import (
	"bytes"
	"encoding/csv"
	"encoding/xml"
	"fmt"
	"io"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	interactiveSpreadsheetMaxRows     = 300
	interactiveSpreadsheetMaxColumns  = 30
	interactiveSpreadsheetMaxBytes    = 10 << 20
	interactiveSpreadsheetMaxCellText = 8 << 10
)

func ParseSpreadsheet(pathValue string, data []byte, options Options) (Workbook, error) {
	options = normalizeOptions(options)
	if len(data) > options.MaxInputBytes {
		return Workbook{}, fmt.Errorf("spreadsheet input exceeds safe parser limit: %d > %d bytes", len(data), options.MaxInputBytes)
	}
	family := SpreadsheetFamilyForPath(pathValue)
	switch family {
	case FamilyCSV:
		return parseDelimitedSpreadsheet(data, family, ',', options)
	case FamilyTSV:
		return parseDelimitedSpreadsheet(data, family, '\t', options)
	case FamilyXLSX:
		return parseXLSX(data, family, options)
	case FamilyODS:
		return parseODS(data, family, options)
	case FamilyLegacyXLS:
		doc, err := parsePrintableFallback(data, family, options, "Legacy binary Excel format is shown as best-effort printable text only. Structured Spreadsheet Viewer support is not enabled for this file family yet.")
		if err != nil {
			return Workbook{}, err
		}
		rows := documentBlocksAsRows(doc.Blocks, options)
		return workbookFromRows(family, "Legacy preview", rows, doc.Warnings, false), nil
	default:
		return Workbook{}, fmt.Errorf("unsupported spreadsheet family")
	}
}

func TrimDelimitedSpreadsheetPrefix(pathValue string, data []byte) ([]byte, bool) {
	family := SpreadsheetFamilyForPath(pathValue)
	if family != FamilyCSV && family != FamilyTSV {
		return data, false
	}
	index := bytes.LastIndexByte(data, '\n')
	if index <= 0 || index >= len(data)-1 {
		return data, false
	}
	return append([]byte(nil), data[:index+1]...), true
}

func RenderSpreadsheetText(workbook Workbook, maxBytes int) string {
	if maxBytes <= 0 {
		maxBytes = DefaultOptions().MaxOutputBytes
	}
	var builder strings.Builder
	for _, warning := range workbook.Warnings {
		if strings.TrimSpace(warning.Message) == "" {
			continue
		}
		if builder.Len() > 0 {
			builder.WriteByte('\n')
		}
		builder.WriteString("[")
		builder.WriteString(warning.Code)
		builder.WriteString("] ")
		builder.WriteString(warning.Message)
	}
	for _, chunk := range workbook.Chunks {
		if builder.Len() >= maxBytes {
			break
		}
		if builder.Len() > 0 {
			builder.WriteString("\n\n")
		}
		builder.WriteString("# ")
		builder.WriteString(sheetNameForChunk(workbook, chunk.SheetID))
		builder.WriteByte('\n')
		for _, row := range chunk.Rows {
			if builder.Len() >= maxBytes {
				break
			}
			var cells []string
			for _, cell := range row {
				cells = append(cells, cell.Value)
			}
			builder.WriteString(strings.Join(cells, "\t"))
			builder.WriteByte('\n')
		}
	}
	value := strings.TrimSpace(builder.String())
	if value == "" {
		return "No readable spreadsheet cells were found in the bounded safe preview."
	}
	return truncateStringBytes(value, maxBytes)
}

func sheetNameForChunk(workbook Workbook, sheetID string) string {
	for _, sheet := range workbook.Sheets {
		if sheet.ID == sheetID {
			return firstNonEmpty(sheet.Name, sheet.ID)
		}
	}
	return firstNonEmpty(sheetID, "Sheet")
}

func parseDelimitedSpreadsheet(data []byte, family SourceFamily, comma rune, options Options) (Workbook, error) {
	text, warnings, err := safeDelimitedUTF8Text(data, options)
	if err != nil {
		return Workbook{}, err
	}
	if comma == '\t' {
		return parseTSVSpreadsheet(text, family, warnings, options), nil
	}
	reader := csv.NewReader(strings.NewReader(text))
	reader.Comma = comma
	reader.FieldsPerRecord = -1
	reader.ReuseRecord = true
	reader.LazyQuotes = true
	reader.TrimLeadingSpace = true
	var rows [][]Cell
	cellCount := 0
	for {
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return Workbook{}, fmt.Errorf("delimited spreadsheet parse failed: %w", err)
		}
		if len(rows) >= options.MaxRowsPerSheet {
			warnings = append(warnings, warning("spreadsheet_truncated", "Spreadsheet reached the safe row limit."))
			break
		}
		row := make([]Cell, 0, minInt(len(record), options.MaxColumnsPerSheet))
		for index, value := range record {
			if index >= options.MaxColumnsPerSheet {
				warnings = append(warnings, warning("spreadsheet_columns_truncated", "Spreadsheet reached the safe column limit."))
				break
			}
			row = append(row, classifyCellText(value, options))
			cellCount++
			if cellCount >= options.MaxCells {
				warnings = append(warnings, warning("spreadsheet_truncated", "Spreadsheet reached the safe cell limit."))
				break
			}
		}
		rows = append(rows, row)
		if cellCount >= options.MaxCells {
			break
		}
	}
	return workbookFromRows(family, "Sheet1", rows, warnings, false), nil
}

func safeDelimitedUTF8Text(data []byte, options Options) (string, []Warning, error) {
	if bytes.IndexByte(data, 0) >= 0 {
		return "", nil, fmt.Errorf("spreadsheet text contains NUL bytes")
	}
	if !utf8.Valid(data) {
		return "", nil, fmt.Errorf("spreadsheet text is not valid UTF-8")
	}
	return strings.ReplaceAll(string(data), "\r\n", "\n"), nil, nil
}

func parseTSVSpreadsheet(text string, family SourceFamily, warnings []Warning, options Options) Workbook {
	var rows [][]Cell
	cellCount := 0
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	for lineIndex, line := range lines {
		if len(rows) >= options.MaxRowsPerSheet {
			warnings = append(warnings, warning("spreadsheet_truncated", "Spreadsheet reached the safe row limit."))
			break
		}
		if line == "" && lineIndex == len(lines)-1 {
			break
		}
		record := strings.Split(strings.TrimSuffix(line, "\r"), "\t")
		row := make([]Cell, 0, minInt(len(record), options.MaxColumnsPerSheet))
		for index, value := range record {
			if index >= options.MaxColumnsPerSheet {
				warnings = append(warnings, warning("spreadsheet_columns_truncated", "Spreadsheet reached the safe column limit."))
				break
			}
			row = append(row, classifyCellText(value, options))
			cellCount++
			if cellCount >= options.MaxCells {
				warnings = append(warnings, warning("spreadsheet_truncated", "Spreadsheet reached the safe cell limit."))
				break
			}
		}
		rows = append(rows, row)
		if cellCount >= options.MaxCells {
			break
		}
	}
	return workbookFromRows(family, "Sheet1", rows, warnings, false)
}

func parseXLSX(data []byte, family SourceFamily, options Options) (Workbook, error) {
	archive, warnings, err := safeZipFiles(data, options)
	if err != nil {
		return Workbook{}, err
	}
	sharedStrings, sharedWarnings, err := parseXLSXSharedStrings(archive["xl/sharedStrings.xml"], options)
	warnings = append(warnings, sharedWarnings...)
	if err != nil {
		warnings = append(warnings, warning("xlsx_shared_strings_skipped", "Shared strings were suspicious or unreadable and were skipped."))
		sharedStrings = nil
	}
	sheetNames := parseXLSXWorkbookSheetNames(archive["xl/workbook.xml"], options)
	var chunks []RowsChunk
	var sheets []Sheet
	cellCount := 0
	worksheetNames := xlsxWorksheetNames(archive)
	for sheetIndex, name := range worksheetNames {
		if len(sheets) >= options.MaxSheets || cellCount >= options.MaxCells {
			warnings = append(warnings, warning("spreadsheet_sheets_truncated", "Workbook reached the safe sheet or cell limit."))
			break
		}
		rows, rowWarnings, err := parseXLSXWorksheet(archive[name], sharedStrings, options, &cellCount)
		warnings = append(warnings, rowWarnings...)
		if err != nil {
			warnings = append(warnings, Warning{Code: "xlsx_sheet_skipped", Severity: "warning", Message: "A worksheet was skipped because its XML was suspicious or unreadable.", Path: name})
			continue
		}
		sheetID := fmt.Sprintf("sheet-%d", len(sheets)+1)
		sheetName := firstNonEmpty(sheetNames[sheetIndex], fmt.Sprintf("Sheet%d", sheetIndex+1))
		sheets = append(sheets, sheetFromRows(sheetID, sheetName, rows, len(rows) >= options.MaxRowsPerSheet))
		chunks = append(chunks, RowsChunk{Version: Version, SheetID: sheetID, StartRow: 0, Rows: rows, Truncated: len(rows) >= options.MaxRowsPerSheet})
	}
	if len(sheets) == 0 {
		sheets = []Sheet{{ID: "sheet-1", Name: "Workbook", Warnings: []Warning{warning("spreadsheet_empty", "No readable worksheet rows were found.")}}}
	}
	return Workbook{Version: Version, SourceKind: family, Warnings: warnings, Sheets: sheets, Chunks: chunks}, nil
}

func parseXLSXSharedStrings(data []byte, options Options) ([]string, []Warning, error) {
	if len(data) == 0 {
		return nil, nil, nil
	}
	decoder := xml.NewDecoder(bytes.NewReader(data))
	var stringsOut []string
	var warnings []Warning
	var builder strings.Builder
	inText := false
	depth := 0
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return stringsOut, warnings, err
		}
		switch item := token.(type) {
		case xml.StartElement:
			depth++
			if depth > options.MaxXMLDepth {
				return stringsOut, warnings, fmt.Errorf("XML depth exceeds safe limit")
			}
			if item.Name.Local == "t" {
				inText = true
			}
		case xml.EndElement:
			if item.Name.Local == "t" {
				inText = false
			}
			if item.Name.Local == "si" {
				if len(stringsOut) >= options.MaxSharedStrings {
					warnings = append(warnings, warning("shared_strings_truncated", "Shared string table reached the safe item limit."))
					return stringsOut, warnings, nil
				}
				stringsOut = append(stringsOut, sanitizeText(builder.String(), options.MaxCellTextBytes))
				builder.Reset()
			}
			if depth > 0 {
				depth--
			}
		case xml.CharData:
			if inText {
				builder.Write([]byte(item))
			}
		}
	}
	return stringsOut, warnings, nil
}

func parseXLSXWorkbookSheetNames(data []byte, options Options) []string {
	if len(data) == 0 {
		return nil
	}
	decoder := xml.NewDecoder(bytes.NewReader(data))
	var names []string
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return names
		}
		if start, ok := token.(xml.StartElement); ok && start.Name.Local == "sheet" {
			for _, attr := range start.Attr {
				if attr.Name.Local == "name" {
					names = append(names, sanitizeText(attr.Value, options.MaxCellTextBytes))
					break
				}
			}
		}
	}
	return names
}

func xlsxWorksheetNames(files map[string][]byte) []string {
	var names []string
	for name := range files {
		if matched, _ := path.Match("xl/worksheets/sheet*.xml", name); matched {
			names = append(names, name)
		}
	}
	sort.Slice(names, func(i, j int) bool { return naturalSheetNameLess(names[i], names[j]) })
	return names
}

var sheetNumberPattern = regexp.MustCompile(`sheet([0-9]+)\.xml$`)

func naturalSheetNameLess(a, b string) bool {
	ma := sheetNumberPattern.FindStringSubmatch(a)
	mb := sheetNumberPattern.FindStringSubmatch(b)
	if len(ma) == 2 && len(mb) == 2 {
		ia, _ := strconv.Atoi(ma[1])
		ib, _ := strconv.Atoi(mb[1])
		return ia < ib
	}
	return a < b
}

func parseXLSXWorksheet(data []byte, sharedStrings []string, options Options, cellCount *int) ([][]Cell, []Warning, error) {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	var rows [][]Cell
	var warnings []Warning
	var currentRow []Cell
	var currentCellRef string
	var currentCellType string
	var currentFormula string
	var value strings.Builder
	inValue := false
	inInlineText := false
	depth := 0
	flushCell := func() {
		if currentCellRef == "" && currentCellType == "" && value.Len() == 0 && currentFormula == "" {
			return
		}
		col := columnIndexFromCellRef(currentCellRef)
		if col < 0 {
			col = len(currentRow)
		}
		for len(currentRow) < col && len(currentRow) < options.MaxColumnsPerSheet {
			currentRow = append(currentRow, blankCell())
		}
		if len(currentRow) < options.MaxColumnsPerSheet {
			currentRow = append(currentRow, xlsxCellValue(currentCellType, value.String(), currentFormula, sharedStrings, options))
			if cellCount != nil {
				*cellCount++
			}
		}
		currentCellRef = ""
		currentCellType = ""
		currentFormula = ""
		value.Reset()
	}
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return rows, warnings, err
		}
		switch item := token.(type) {
		case xml.StartElement:
			depth++
			if depth > options.MaxXMLDepth {
				return rows, warnings, fmt.Errorf("XML depth exceeds safe limit")
			}
			switch item.Name.Local {
			case "row":
				currentRow = nil
			case "c":
				currentCellRef = attrValue(item.Attr, "r")
				currentCellType = attrValue(item.Attr, "t")
				value.Reset()
			case "v":
				inValue = true
			case "f":
				currentFormula = "formula"
			case "t":
				if currentCellType == "inlineStr" || currentCellType == "str" {
					inInlineText = true
				}
			}
		case xml.EndElement:
			switch item.Name.Local {
			case "v":
				inValue = false
			case "t":
				inInlineText = false
			case "c":
				flushCell()
			case "row":
				if len(rows) >= options.MaxRowsPerSheet {
					warnings = append(warnings, warning("spreadsheet_rows_truncated", "Worksheet reached the safe row limit."))
					return rows, warnings, nil
				}
				if currentRow == nil {
					currentRow = []Cell{}
				}
				rows = append(rows, currentRow)
				if cellCount != nil && *cellCount >= options.MaxCells {
					warnings = append(warnings, warning("spreadsheet_cells_truncated", "Workbook reached the safe cell limit."))
					return rows, warnings, nil
				}
			}
			if depth > 0 {
				depth--
			}
		case xml.CharData:
			if inValue || inInlineText {
				value.Write([]byte(item))
			}
		}
	}
	return rows, warnings, nil
}

func xlsxCellValue(cellType string, raw string, formula string, sharedStrings []string, options Options) Cell {
	raw = sanitizeText(raw, options.MaxCellTextBytes)
	if formula != "" && raw == "" {
		return formulaCell("formula", false)
	}
	if formula != "" {
		if cellType == "s" {
			index, err := strconv.Atoi(strings.TrimSpace(raw))
			if err == nil && index >= 0 && index < len(sharedStrings) {
				return formulaCell(sharedStrings[index], true)
			}
		}
		return formulaCell(raw, true)
	}
	switch cellType {
	case "s":
		index, err := strconv.Atoi(strings.TrimSpace(raw))
		if err == nil && index >= 0 && index < len(sharedStrings) {
			return classifyCellText(sharedStrings[index], options)
		}
		return errorCell("invalid shared string reference")
	case "b":
		if raw == "1" || strings.EqualFold(raw, "true") {
			return booleanCell(true)
		}
		return booleanCell(false)
	case "e":
		return errorCell(raw)
	case "inlineStr", "str":
		return classifyCellText(raw, options)
	default:
		if strings.TrimSpace(raw) == "" {
			return blankCell()
		}
		return numberCell(raw)
	}
}

func parseODS(data []byte, family SourceFamily, options Options) (Workbook, error) {
	archive, warnings, err := safeZipFiles(data, options)
	if err != nil {
		return Workbook{}, err
	}
	content := archive["content.xml"]
	if len(content) == 0 {
		return Workbook{}, fmt.Errorf("ODS content.xml was not found")
	}
	decoder := xml.NewDecoder(bytes.NewReader(content))
	var sheets []Sheet
	var chunks []RowsChunk
	var currentRows [][]Cell
	var currentRow []Cell
	var currentCell strings.Builder
	var sheetName string
	currentRowRepeat := 1
	currentCellRepeat := 1
	inTable := false
	inRow := false
	inCell := false
	inText := false
	depth := 0
	cellCount := 0
	flushCell := func(repeat int) {
		value := sanitizeText(currentCell.String(), options.MaxCellTextBytes)
		currentCell.Reset()
		if repeat <= 0 {
			repeat = 1
		}
		for i := 0; i < repeat && len(currentRow) < options.MaxColumnsPerSheet; i++ {
			currentRow = append(currentRow, classifyCellText(value, options))
			cellCount++
			if cellCount >= options.MaxCells {
				break
			}
		}
	}
	flushSheet := func() {
		if !inTable && len(currentRows) == 0 {
			return
		}
		sheetID := fmt.Sprintf("sheet-%d", len(sheets)+1)
		name := firstNonEmpty(sheetName, fmt.Sprintf("Sheet%d", len(sheets)+1))
		sheets = append(sheets, sheetFromRows(sheetID, name, currentRows, len(currentRows) >= options.MaxRowsPerSheet))
		chunks = append(chunks, RowsChunk{Version: Version, SheetID: sheetID, StartRow: 0, Rows: currentRows, Truncated: len(currentRows) >= options.MaxRowsPerSheet})
		currentRows = nil
		sheetName = ""
	}
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return Workbook{}, err
		}
		switch item := token.(type) {
		case xml.StartElement:
			depth++
			if depth > options.MaxXMLDepth {
				return Workbook{}, fmt.Errorf("XML depth exceeds safe limit")
			}
			switch item.Name.Local {
			case "table":
				if inTable {
					flushSheet()
				}
				if len(sheets) >= options.MaxSheets {
					warnings = append(warnings, warning("spreadsheet_sheets_truncated", "Workbook reached the safe sheet limit."))
					return Workbook{Version: Version, SourceKind: family, Warnings: warnings, Sheets: sheets, Chunks: chunks, Truncated: true}, nil
				}
				inTable = true
				sheetName = sanitizeText(attrValue(item.Attr, "name"), options.MaxCellTextBytes)
			case "table-row":
				if inTable {
					inRow = true
					currentRow = nil
					currentRowRepeat = boundedRepeatAttr(item.Attr, "number-rows-repeated", options.MaxRowsPerSheet)
				}
			case "table-cell":
				if inRow {
					inCell = true
					currentCell.Reset()
					currentCellRepeat = boundedRepeatAttr(item.Attr, "number-columns-repeated", options.MaxColumnsPerSheet)
				}
			case "p":
				if inCell {
					inText = true
				}
			}
		case xml.EndElement:
			switch item.Name.Local {
			case "p":
				inText = false
			case "table-cell":
				if inCell {
					flushCell(currentCellRepeat)
					inCell = false
					currentCellRepeat = 1
				}
			case "table-row":
				if inRow {
					for repeat := 0; repeat < currentRowRepeat; repeat++ {
						if len(currentRows) >= options.MaxRowsPerSheet {
							warnings = append(warnings, warning("spreadsheet_rows_truncated", "Sheet reached the safe row limit."))
							break
						}
						currentRows = append(currentRows, cloneCells(currentRow))
					}
					inRow = false
					currentRowRepeat = 1
				}
			case "table":
				flushSheet()
				inTable = false
			}
			if depth > 0 {
				depth--
			}
		case xml.CharData:
			if inText {
				currentCell.Write([]byte(item))
			}
		}
		if cellCount >= options.MaxCells {
			warnings = append(warnings, warning("spreadsheet_cells_truncated", "Workbook reached the safe cell limit."))
			break
		}
	}
	if inTable {
		flushSheet()
	}
	if len(sheets) == 0 {
		sheets = []Sheet{{ID: "sheet-1", Name: "Workbook", Warnings: []Warning{warning("spreadsheet_empty", "No readable spreadsheet rows were found.")}}}
	}
	return Workbook{Version: Version, SourceKind: family, Warnings: warnings, Sheets: sheets, Chunks: chunks, Truncated: cellCount >= options.MaxCells}, nil
}

func boundedRepeatAttr(attrs []xml.Attr, localName string, maxValue int) int {
	value := intAttr(attrs, localName, 1)
	if value <= 0 {
		return 1
	}
	if maxValue > 0 && value > maxValue {
		return maxValue
	}
	return value
}

func cloneCells(row []Cell) []Cell {
	if len(row) == 0 {
		return []Cell{}
	}
	out := make([]Cell, len(row))
	copy(out, row)
	return out
}

func workbookFromRows(family SourceFamily, sheetName string, rows [][]Cell, warnings []Warning, truncated bool) Workbook {
	sheet := sheetFromRows("sheet-1", sheetName, rows, truncated)
	return Workbook{Version: Version, SourceKind: family, Warnings: warnings, Sheets: []Sheet{sheet}, Chunks: []RowsChunk{{Version: Version, SheetID: sheet.ID, StartRow: 0, Rows: rows, Truncated: truncated}}, Truncated: truncated}
}

func sheetFromRows(id string, name string, rows [][]Cell, truncated bool) Sheet {
	cols := 0
	for _, row := range rows {
		if len(row) > cols {
			cols = len(row)
		}
	}
	header := inferHeader(rows)
	return Sheet{
		ID:          id,
		Name:        firstNonEmpty(name, "Sheet"),
		RowCount:    len(rows),
		ColumnCount: cols,
		Truncated:   truncated,
		Header:      header,
		Interactive: interactiveEligibility(rows, cols, truncated),
		Columns:     inferColumns(rows, cols, header),
	}
}

func classifyCellText(value string, options Options) Cell {
	value = sanitizeText(value, options.MaxCellTextBytes)
	if value == "" {
		return blankCell()
	}
	trimmed := strings.TrimSpace(value)
	if isFormulaMarkerText(trimmed) && !isSignedNumericLiteral(trimmed) {
		return stringCell(value, "formula_marker")
	}
	if _, err := strconv.ParseFloat(trimmed, 64); err == nil {
		return numberCell(trimmed)
	}
	lower := strings.ToLower(trimmed)
	if lower == "true" || lower == "false" {
		return booleanCell(lower == "true")
	}
	if dateValue, ok := parseSafeDateText(trimmed); ok {
		return Cell{Type: "date_text", Value: value, DateValue: dateValue}
	}
	return stringCell(value)
}

func blankCell() Cell {
	return Cell{Type: "blank"}
}

func stringCell(value string, flags ...string) Cell {
	cell := Cell{Type: "string", Value: value}
	if len(flags) > 0 {
		cell.Flags = append([]string(nil), flags...)
	}
	return cell
}

func numberCell(value string) Cell {
	number, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	if err != nil {
		return stringCell(value)
	}
	return Cell{Type: "number", Value: strings.TrimSpace(value), NumberValue: &number}
}

func booleanCell(value bool) Cell {
	text := "false"
	if value {
		text = "true"
	}
	return Cell{Type: "boolean", Value: text, BooleanValue: &value}
}

func formulaCell(value string, cached bool) Cell {
	cell := Cell{Type: "formula_text", Value: value}
	if cached {
		cell.Flags = []string{"formula_cached_value"}
	}
	return cell
}

func errorCell(value string) Cell {
	return Cell{Type: "error", Value: value}
}

func isFormulaMarkerText(value string) bool {
	return strings.HasPrefix(value, "=") || strings.HasPrefix(value, "+") || strings.HasPrefix(value, "-") || strings.HasPrefix(value, "@")
}

func isSignedNumericLiteral(value string) bool {
	if len(value) < 2 {
		return false
	}
	if value[0] != '+' && value[0] != '-' {
		return false
	}
	_, err := strconv.ParseFloat(value, 64)
	return err == nil
}

var safeDateLayouts = []string{
	time.RFC3339,
	"2006-01-02",
	"2006-1-2",
	"2006/01/02",
	"2006/1/2",
	"2006-01-02 15:04",
	"2006-01-02 15:04:05",
	"2006/01/02 15:04",
	"2006/01/02 15:04:05",
	"02.01.2006",
	"2.1.2006",
	"02.01.2006 15:04",
	"2.1.2006 15:04",
}

func parseSafeDateText(value string) (string, bool) {
	if len(value) < len("2006-1-1") {
		return "", false
	}
	for _, layout := range safeDateLayouts {
		parsed, err := time.Parse(layout, value)
		if err == nil {
			if parsed.Hour() == 0 && parsed.Minute() == 0 && parsed.Second() == 0 && parsed.Nanosecond() == 0 {
				return parsed.Format("2006-01-02"), true
			}
			return parsed.Format(time.RFC3339), true
		}
	}
	return "", false
}

func interactiveEligibility(rows [][]Cell, columns int, truncated bool) InteractiveEligibility {
	result := InteractiveEligibility{
		MaxRows:    interactiveSpreadsheetMaxRows,
		MaxColumns: interactiveSpreadsheetMaxColumns,
		MaxBytes:   interactiveSpreadsheetMaxBytes,
	}
	switch {
	case truncated:
		result.DisabledReason = "The sheet was truncated by safe parser limits."
	case len(rows) > interactiveSpreadsheetMaxRows:
		result.DisabledReason = fmt.Sprintf("The sheet has %d rows; interactive mode allows at most %d.", len(rows), interactiveSpreadsheetMaxRows)
	case columns > interactiveSpreadsheetMaxColumns:
		result.DisabledReason = fmt.Sprintf("The sheet uses %d columns; interactive mode allows at most %d.", columns, interactiveSpreadsheetMaxColumns)
	case estimateInteractiveBytes(rows) > interactiveSpreadsheetMaxBytes:
		result.DisabledReason = "The typed sheet model is larger than the interactive mode limit."
	case hasInteractiveCellTextOverflow(rows):
		result.DisabledReason = "At least one cell is too large for interactive tools."
	default:
		result.Eligible = true
	}
	return result
}

func estimateInteractiveBytes(rows [][]Cell) int {
	total := 256
	for _, row := range rows {
		total += 16
		for _, cell := range row {
			total += 48 + len(cell.Value) + len(cell.Display) + len(cell.DateValue)
			for _, flag := range cell.Flags {
				total += len(flag) + 4
			}
		}
	}
	return total
}

func hasInteractiveCellTextOverflow(rows [][]Cell) bool {
	for _, row := range rows {
		for _, cell := range row {
			if len(cell.Value) > interactiveSpreadsheetMaxCellText || len(cell.Display) > interactiveSpreadsheetMaxCellText {
				return true
			}
		}
	}
	return false
}

func inferHeader(rows [][]Cell) *HeaderInference {
	inference := &HeaderInference{Detected: false, RowIndex: 0, Reason: "not enough rows to compare"}
	if len(rows) < 2 || len(rows[0]) == 0 {
		return inference
	}
	first := rows[0]
	nonBlank := 0
	textLike := 0
	unique := map[string]struct{}{}
	for _, cell := range first {
		if cell.Type == "blank" || strings.TrimSpace(cell.Value) == "" {
			continue
		}
		nonBlank++
		if cell.Type == "string" || cell.Type == "date_text" {
			textLike++
		}
		unique[strings.ToLower(strings.TrimSpace(cell.Value))] = struct{}{}
	}
	if nonBlank == 0 {
		inference.Reason = "first row is empty"
		return inference
	}
	dataTyped := 0
	dataNonBlank := 0
	sampleRows := minInt(len(rows), 16)
	for rowIndex := 1; rowIndex < sampleRows; rowIndex++ {
		for columnIndex := 0; columnIndex < len(first) && columnIndex < len(rows[rowIndex]); columnIndex++ {
			cell := rows[rowIndex][columnIndex]
			if cell.Type == "blank" || strings.TrimSpace(cell.Value) == "" {
				continue
			}
			dataNonBlank++
			if cell.Type == "number" || cell.Type == "boolean" || cell.Type == "date_text" {
				dataTyped++
			}
		}
	}
	textRatio := float64(textLike) / float64(nonBlank)
	uniqueRatio := float64(len(unique)) / float64(nonBlank)
	dataTypedRatio := 0.0
	if dataNonBlank > 0 {
		dataTypedRatio = float64(dataTyped) / float64(dataNonBlank)
	}
	confidence := 0.15 + textRatio*0.45 + uniqueRatio*0.25 + dataTypedRatio*0.15
	if nonBlank == 1 {
		confidence -= 0.15
	}
	if confidence < 0 {
		confidence = 0
	}
	if confidence > 1 {
		confidence = 1
	}
	inference.Confidence = roundConfidence(confidence)
	inference.Detected = confidence >= 0.68
	inference.Reason = fmt.Sprintf("text %.0f%%, unique %.0f%%, typed data %.0f%%", textRatio*100, uniqueRatio*100, dataTypedRatio*100)
	return inference
}

func inferColumns(rows [][]Cell, columns int, header *HeaderInference) []ColumnSummary {
	if columns <= 0 {
		return nil
	}
	out := make([]ColumnSummary, 0, columns)
	headerRow := []Cell(nil)
	if header != nil && header.Detected && len(rows) > header.RowIndex {
		headerRow = rows[header.RowIndex]
	}
	for columnIndex := 0; columnIndex < columns; columnIndex++ {
		label := columnNameForIndex(columnIndex)
		if columnIndex < len(headerRow) && strings.TrimSpace(headerRow[columnIndex].Value) != "" {
			label = strings.TrimSpace(headerRow[columnIndex].Value)
		}
		inferredType, confidence := inferColumnType(rows, columnIndex, header)
		out = append(out, ColumnSummary{Index: columnIndex, Label: label, InferredType: inferredType, Confidence: confidence})
	}
	return out
}

func inferColumnType(rows [][]Cell, columnIndex int, header *HeaderInference) (string, float64) {
	counts := map[string]int{}
	total := 0
	startRow := 0
	if header != nil && header.Detected {
		startRow = header.RowIndex + 1
	}
	for rowIndex := startRow; rowIndex < len(rows); rowIndex++ {
		if columnIndex >= len(rows[rowIndex]) {
			continue
		}
		cell := rows[rowIndex][columnIndex]
		if cell.Type == "blank" || strings.TrimSpace(cell.Value) == "" {
			continue
		}
		kind := cell.Type
		if kind == "formula_text" || kind == "error" {
			kind = "string"
		}
		counts[kind]++
		total++
	}
	if total == 0 {
		return "blank", 1
	}
	bestKind := "string"
	bestCount := 0
	for kind, count := range counts {
		if count > bestCount {
			bestKind = kind
			bestCount = count
		}
	}
	confidence := roundConfidence(float64(bestCount) / float64(total))
	if confidence < 0.6 {
		return "mixed", confidence
	}
	return bestKind, confidence
}

func columnNameForIndex(index int) string {
	value := index + 1
	name := ""
	for value > 0 {
		remainder := (value - 1) % 26
		name = string(rune('A'+remainder)) + name
		value = (value - 1) / 26
	}
	return name
}

func roundConfidence(value float64) float64 {
	rounded := float64(int(value*100+0.5)) / 100
	if rounded < 0 {
		return 0
	}
	if rounded > 1 {
		return 1
	}
	return rounded
}

func columnIndexFromCellRef(ref string) int {
	if ref == "" {
		return -1
	}
	col := 0
	seen := false
	for _, item := range ref {
		if item >= 'A' && item <= 'Z' {
			col = col*26 + int(item-'A'+1)
			seen = true
			continue
		}
		if item >= 'a' && item <= 'z' {
			col = col*26 + int(item-'a'+1)
			seen = true
			continue
		}
		break
	}
	if !seen {
		return -1
	}
	return col - 1
}

func attrValue(attrs []xml.Attr, localName string) string {
	for _, attr := range attrs {
		if attr.Name.Local == localName {
			return attr.Value
		}
	}
	return ""
}

func documentBlocksAsRows(blocks []DocumentBlock, options Options) [][]Cell {
	var rows [][]Cell
	for _, block := range blocks {
		if len(rows) >= options.MaxRowsPerSheet {
			break
		}
		for _, line := range strings.Split(blockPlainText(block), "\n") {
			if strings.TrimSpace(line) == "" {
				continue
			}
			rows = append(rows, []Cell{stringCell(sanitizeText(line, options.MaxCellTextBytes))})
		}
	}
	return rows
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
