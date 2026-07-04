// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package safecontent

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"html"
	"io"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

func ParseDocument(pathValue string, data []byte, options Options) (Document, error) {
	options = normalizeOptions(options)
	if len(data) > options.MaxInputBytes {
		return Document{}, fmt.Errorf("document input exceeds safe parser limit: %d > %d bytes", len(data), options.MaxInputBytes)
	}
	family := DocumentFamilyForPath(pathValue)
	doc := Document{Version: Version, SourceKind: family}
	var err error
	switch family {
	case FamilyMarkdown:
		doc, err = parseMarkdown(data, family, options)
	case FamilyPDF:
		doc, err = parsePDF(data, family, options)
	case FamilyDOCX, FamilyPPTX:
		doc, err = parseOOXMLDocument(data, family, options)
	case FamilyODT, FamilyODP:
		doc, err = parseOpenDocumentText(data, family, options)
	case FamilyRTF:
		doc, err = parseRTF(data, family, options)
	case FamilyLegacyDoc, FamilyLegacyPPT:
		doc, err = parsePrintableFallback(data, family, options, "Legacy binary Office files do not expose trusted paragraphs/headings to ShellOrchestra's safe parser yet. This view shows bounded printable text only.")
	default:
		doc, err = parsePlainTextDocument(data, family, options)
	}
	if err != nil {
		return Document{}, err
	}
	if len(doc.Blocks) == 0 {
		doc.Blocks = []DocumentBlock{{Type: "placeholder", Text: textInline("No readable text was found in the bounded safe preview.")}}
	}
	if doc.Version == 0 {
		doc.Version = Version
	}
	if doc.SourceKind == "" {
		doc.SourceKind = family
	}
	return doc, nil
}

func RenderDocumentText(doc Document, maxBytes int) string {
	if maxBytes <= 0 {
		maxBytes = DefaultOptions().MaxOutputBytes
	}
	var builder strings.Builder
	for _, block := range doc.Blocks {
		if builder.Len() >= maxBytes {
			break
		}
		line := blockPlainText(block)
		if strings.TrimSpace(line) == "" {
			continue
		}
		if builder.Len() > 0 {
			builder.WriteString("\n")
		}
		if block.Type == "heading" && block.Level > 0 {
			builder.WriteString(strings.Repeat("#", block.Level))
			builder.WriteByte(' ')
		}
		builder.WriteString(line)
	}
	return strings.TrimSpace(truncateStringBytes(builder.String(), maxBytes))
}

func RenderDocumentHTML(doc Document, maxBytes int) string {
	if maxBytes <= 0 {
		maxBytes = DefaultOptions().MaxOutputBytes
	}
	var builder strings.Builder
	builder.WriteString(`<article class="so-safe-document">`)
	for _, block := range doc.Blocks {
		if builder.Len() >= maxBytes {
			break
		}
		renderDocumentBlockHTML(&builder, block)
	}
	builder.WriteString(`</article>`)
	return truncateStringBytes(builder.String(), maxBytes)
}

func renderDocumentBlockHTML(builder *strings.Builder, block DocumentBlock) {
	text := html.EscapeString(blockPlainText(block))
	switch block.Type {
	case "heading":
		level := block.Level
		if level < 1 || level > 6 {
			level = 2
		}
		fmt.Fprintf(builder, "<h%d>%s</h%d>", level, text, level)
	case "pre":
		builder.WriteString(`<pre><code>`)
		builder.WriteString(text)
		builder.WriteString(`</code></pre>`)
	case "blockquote":
		builder.WriteString(`<blockquote>`)
		builder.WriteString(text)
		builder.WriteString(`</blockquote>`)
	case "list_item":
		builder.WriteString(`<p class="so-safe-document__list-item">• `)
		builder.WriteString(text)
		builder.WriteString(`</p>`)
	case "table":
		builder.WriteString(`<table><tbody>`)
		for _, row := range block.Rows {
			builder.WriteString(`<tr>`)
			for _, cell := range row.Cells {
				builder.WriteString(`<td>`)
				builder.WriteString(html.EscapeString(cellPlainText(cell)))
				builder.WriteString(`</td>`)
			}
			builder.WriteString(`</tr>`)
		}
		builder.WriteString(`</tbody></table>`)
	case "horizontal_rule":
		builder.WriteString(`<p class="so-safe-document__paragraph-gap"></p>`)
	case "page_break":
		builder.WriteString(`<hr class="so-safe-document__page-break" />`)
	case "slide_marker":
		builder.WriteString(`<section class="so-safe-document__slide-marker"><span>`)
		builder.WriteString(text)
		builder.WriteString(`</span></section>`)
	case "placeholder":
		builder.WriteString(`<p class="so-safe-document__placeholder">`)
		builder.WriteString(text)
		builder.WriteString(`</p>`)
	default:
		builder.WriteString(`<p>`)
		builder.WriteString(text)
		builder.WriteString(`</p>`)
	}
}

func blockPlainText(block DocumentBlock) string {
	if block.Type == "table" {
		var rows []string
		for _, row := range block.Rows {
			var cells []string
			for _, cell := range row.Cells {
				cells = append(cells, cellPlainText(cell))
			}
			rows = append(rows, strings.Join(cells, "\t"))
		}
		return strings.Join(rows, "\n")
	}
	var builder strings.Builder
	for _, inline := range block.Text {
		builder.WriteString(inline.Text)
	}
	return strings.TrimSpace(builder.String())
}

func cellPlainText(cell DocumentTableCell) string {
	if strings.TrimSpace(cell.Text) != "" {
		return strings.TrimSpace(cell.Text)
	}
	var parts []string
	for _, block := range cell.Blocks {
		if text := blockPlainText(block); text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, " ")
}

func parsePlainTextDocument(data []byte, family SourceFamily, options Options) (Document, error) {
	text, warnings, err := safeUTF8Text(data, options)
	if err != nil {
		return Document{}, err
	}
	blocks := textToParagraphBlocks(text, options)
	return Document{Version: Version, SourceKind: family, Warnings: warnings, Blocks: blocks}, nil
}

func parseMarkdown(data []byte, family SourceFamily, options Options) (Document, error) {
	text, warnings, err := safeUTF8Text(data, options)
	if err != nil {
		return Document{}, err
	}
	var blocks []DocumentBlock
	lines := strings.Split(text, "\n")
	var paragraph []string
	inFence := false
	var fence []string
	flushParagraph := func() {
		if len(paragraph) == 0 {
			return
		}
		blocks = appendBlock(blocks, DocumentBlock{Type: "paragraph", Text: textInline(strings.Join(paragraph, " "))}, options)
		paragraph = nil
	}
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			if inFence {
				blocks = appendBlock(blocks, DocumentBlock{Type: "pre", Text: textInline(strings.Join(fence, "\n"))}, options)
				fence = nil
				inFence = false
			} else {
				flushParagraph()
				inFence = true
			}
			continue
		}
		if inFence {
			fence = append(fence, line)
			continue
		}
		if trimmed == "" {
			flushParagraph()
			continue
		}
		if strings.HasPrefix(trimmed, "<") {
			flushParagraph()
			if block, ok := markdownRawHTMLBlock(trimmed); ok {
				warnings = append(warnings, warning("markdown_raw_html_sanitized", "Raw HTML in Markdown was reduced to safe text and basic document structure."))
				if block.Type != "" {
					blocks = appendBlock(blocks, block, options)
				}
				continue
			}
			warnings = append(warnings, warning("markdown_raw_html_removed", "Unsupported raw HTML in Markdown was removed from the safe document view."))
			continue
		}
		if level, title := markdownHeading(trimmed); level > 0 {
			flushParagraph()
			blocks = appendBlock(blocks, DocumentBlock{Type: "heading", Level: level, Text: textInline(title)}, options)
			continue
		}
		if markdownListItem(trimmed) != "" {
			flushParagraph()
			blocks = appendBlock(blocks, DocumentBlock{Type: "list_item", Text: textInline(markdownListItem(trimmed))}, options)
			continue
		}
		if strings.HasPrefix(trimmed, ">") {
			flushParagraph()
			blocks = appendBlock(blocks, DocumentBlock{Type: "blockquote", Text: textInline(strings.TrimSpace(strings.TrimPrefix(trimmed, ">")))}, options)
			continue
		}
		paragraph = append(paragraph, trimmed)
	}
	flushParagraph()
	if inFence {
		warnings = append(warnings, warning("markdown_unclosed_fence", "An unclosed Markdown code fence was shown as a bounded code block."))
		blocks = appendBlock(blocks, DocumentBlock{Type: "pre", Text: textInline(strings.Join(fence, "\n"))}, options)
	}
	return Document{Version: Version, SourceKind: family, Warnings: warnings, Blocks: blocks}, nil
}

func markdownHeading(line string) (int, string) {
	count := 0
	for count < len(line) && line[count] == '#' {
		count++
	}
	if count == 0 || count > 6 || count >= len(line) || line[count] != ' ' {
		return 0, ""
	}
	return count, strings.TrimSpace(line[count:])
}

var numberedListPattern = regexp.MustCompile(`^[0-9]{1,6}[.)]\s+(.+)$`)
var printableFallbackSectionPattern = regexp.MustCompile(`\s+([A-Z]\.)\s+`)

func markdownListItem(line string) string {
	for _, prefix := range []string{"- ", "* ", "+ "} {
		if strings.HasPrefix(line, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(line, prefix))
		}
	}
	if match := numberedListPattern.FindStringSubmatch(line); len(match) == 2 {
		return strings.TrimSpace(match[1])
	}
	return ""
}

func markdownRawHTMLBlock(line string) (DocumentBlock, bool) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || !strings.HasPrefix(trimmed, "<") || !strings.HasSuffix(trimmed, ">") {
		return DocumentBlock{}, false
	}
	if regexp.MustCompile(`(?is)^<\s*(?:script|style|iframe|object|embed|svg)\b`).MatchString(trimmed) {
		return DocumentBlock{}, true
	}
	if htmlOnlyContainerLine(trimmed) {
		return DocumentBlock{}, true
	}
	if level, text, ok := htmlHeadingLine(trimmed); ok {
		return DocumentBlock{Type: "heading", Level: level, Text: textInline(stripMarkdownHTMLText(text))}, true
	}
	if text, ok := htmlWrappedLine(trimmed, "p"); ok {
		return DocumentBlock{Type: "paragraph", Text: textInline(stripMarkdownHTMLText(text))}, true
	}
	if alt, ok := htmlAttributeValue(trimmed, "alt"); ok {
		alt = stripMarkdownHTMLText(alt)
		if alt != "" {
			return DocumentBlock{Type: "paragraph", Text: textInline(alt)}, true
		}
		return DocumentBlock{}, true
	}
	text := stripMarkdownHTMLText(trimmed)
	if text == "" {
		return DocumentBlock{}, true
	}
	return DocumentBlock{Type: "paragraph", Text: textInline(text)}, true
}

func htmlOnlyContainerLine(line string) bool {
	lower := strings.ToLower(strings.TrimSpace(line))
	if !strings.HasPrefix(lower, "<") {
		return false
	}
	for _, name := range []string{"div", "picture", "source", "span", "br", "hr", "center", "section", "article", "figure", "figcaption", "script", "style", "iframe", "object", "embed", "svg"} {
		if regexp.MustCompile(`^</?` + name + `(?:\s[^>]*)?/?>$`).MatchString(lower) {
			return true
		}
	}
	return false
}

func htmlHeadingLine(line string) (int, string, bool) {
	match := regexp.MustCompile(`(?is)^<h([1-6])\b[^>]*>(.*?)</h([1-6])>$`).FindStringSubmatch(line)
	if len(match) != 4 || match[1] != match[3] {
		return 0, "", false
	}
	level, _ := strconv.Atoi(match[1])
	return level, match[2], true
}

func htmlWrappedLine(line, tag string) (string, bool) {
	pattern := regexp.MustCompile(`(?is)^<` + regexp.QuoteMeta(tag) + `\b[^>]*>(.*?)</` + regexp.QuoteMeta(tag) + `>$`)
	match := pattern.FindStringSubmatch(line)
	if len(match) != 2 {
		return "", false
	}
	return match[1], true
}

func htmlAttributeValue(line, name string) (string, bool) {
	pattern := regexp.MustCompile(`(?is)\b` + regexp.QuoteMeta(name) + `\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`)
	match := pattern.FindStringSubmatch(line)
	if len(match) == 0 {
		return "", false
	}
	for _, value := range match[1:] {
		if value != "" {
			return value, true
		}
	}
	return "", true
}

func stripMarkdownHTMLText(value string) string {
	text := regexp.MustCompile(`(?is)<br\s*/?>`).ReplaceAllString(value, " ")
	text = regexp.MustCompile(`(?is)<[^>]{0,500}>`).ReplaceAllString(text, " ")
	text = html.UnescapeString(text)
	return strings.TrimSpace(strings.Join(strings.Fields(text), " "))
}

func parsePDF(data []byte, family SourceFamily, options Options) (Document, error) {
	text := extractPDFTextFragments(data, options)
	blocks := textToParagraphBlocks(text, options)
	warnings := []Warning{warning("pdf_simplified_text", "PDF is shown as safe extracted text only. Layout, images, forms, attachments, and compressed text may be omitted.")}
	return Document{Version: Version, SourceKind: family, Warnings: warnings, Blocks: blocks}, nil
}

func parsePrintableFallback(data []byte, family SourceFamily, options Options, message string) (Document, error) {
	blocks := textToParagraphBlocks(filterPrintableFallbackText(printableStringsFromBytes(data, options.MaxOutputBytes), options.MaxOutputBytes), options)
	return Document{Version: Version, SourceKind: family, Warnings: []Warning{warning("printable_text_fallback", message)}, Blocks: blocks}, nil
}

func extractPDFTextFragments(data []byte, options Options) string {
	maxBytes := options.MaxOutputBytes
	if maxBytes <= 0 {
		maxBytes = DefaultOptions().MaxOutputBytes
	}
	var output strings.Builder
	for index := 0; index < len(data) && output.Len() < maxBytes; index++ {
		if data[index] != '(' {
			continue
		}
		fragment, next, ok := readPDFLiteralString(data, index+1)
		if !ok {
			continue
		}
		index = next
		clean := sanitizeText(decodePDFTextBytes(fragment), maxBytes-output.Len())
		if !isHumanPDFTextFragment(clean) {
			continue
		}
		if output.Len() > 0 {
			output.WriteByte('\n')
		}
		output.WriteString(clean)
	}
	return output.String()
}

func readPDFLiteralString(data []byte, start int) ([]byte, int, bool) {
	var out []byte
	depth := 1
	for index := start; index < len(data); index++ {
		item := data[index]
		if item == '\\' {
			if index+1 >= len(data) {
				break
			}
			next := data[index+1]
			switch next {
			case 'n':
				out = append(out, '\n')
			case 'r':
				out = append(out, '\r')
			case 't':
				out = append(out, '\t')
			case 'b', 'f':
				out = append(out, ' ')
			case '(', ')', '\\':
				out = append(out, next)
			case '\n':
				// Escaped line continuation.
			case '\r':
				if index+2 < len(data) && data[index+2] == '\n' {
					index++
				}
			default:
				if next >= '0' && next <= '7' {
					value := int(next - '0')
					consumed := 1
					for consumed < 3 && index+1+consumed < len(data) {
						digit := data[index+1+consumed]
						if digit < '0' || digit > '7' {
							break
						}
						value = value*8 + int(digit-'0')
						consumed++
					}
					out = append(out, byte(value))
					index += consumed - 1
				} else {
					out = append(out, next)
				}
			}
			index++
			continue
		}
		if item == '(' {
			depth++
			out = append(out, item)
			continue
		}
		if item == ')' {
			depth--
			if depth == 0 {
				return out, index, true
			}
			out = append(out, item)
			continue
		}
		out = append(out, item)
	}
	return nil, start, false
}

func decodePDFTextBytes(data []byte) string {
	if len(data) >= 2 && data[0] == 0xfe && data[1] == 0xff {
		var builder strings.Builder
		for index := 2; index+1 < len(data); index += 2 {
			r := rune(data[index])<<8 | rune(data[index+1])
			if r == 0 {
				continue
			}
			builder.WriteRune(r)
		}
		return builder.String()
	}
	return strings.ToValidUTF8(string(data), "")
}

func isHumanPDFTextFragment(value string) bool {
	value = strings.TrimSpace(value)
	if len(value) < 3 {
		return false
	}
	var letters int
	var printable int
	for _, item := range value {
		if unicode.IsLetter(item) {
			letters++
		}
		if unicode.IsPrint(item) && !unicode.IsControl(item) {
			printable++
		}
	}
	if letters == 0 {
		return false
	}
	return printable >= 3
}

func parseRTF(data []byte, family SourceFamily, options Options) (Document, error) {
	value := strings.ToValidUTF8(string(data), "")
	var builder strings.Builder
	skipStack := []bool{false}
	skipping := func() bool { return skipStack[len(skipStack)-1] }
	setSkipping := func(value bool) { skipStack[len(skipStack)-1] = value }
	for index := 0; index < len(value) && builder.Len() < options.MaxOutputBytes; index++ {
		item := value[index]
		if item == '{' {
			skipStack = append(skipStack, skipping())
			continue
		}
		if item == '}' {
			if len(skipStack) > 1 {
				skipStack = skipStack[:len(skipStack)-1]
			}
			continue
		}
		if item == '\\' {
			if index+1 >= len(value) {
				continue
			}
			next := value[index+1]
			if next == '*' {
				setSkipping(true)
				index++
				continue
			}
			if next == '\\' || next == '{' || next == '}' {
				if !skipping() {
					builder.WriteByte(next)
				}
				index++
				continue
			}
			if next == '\'' && index+3 < len(value) {
				if !skipping() {
					if decoded, ok := decodeRTFHexByte(value[index+2 : index+4]); ok {
						builder.WriteByte(decoded)
					}
				}
				index += 3
				continue
			}
			word, number, hasNumber, consumed := readRTFControlWord(value[index+1:])
			if consumed == 0 {
				continue
			}
			index += consumed
			if isRTFDestinationToSkip(word) {
				setSkipping(true)
			}
			if skipping() {
				if word == "bin" && hasNumber && number > 0 {
					index += number
				}
				continue
			}
			switch word {
			case "par", "line":
				builder.WriteByte('\n')
			case "tab":
				builder.WriteByte(' ')
			case "u":
				if hasNumber {
					if number < 0 {
						number += 65536
					}
					if r := rune(number); r != utf8.RuneError && unicode.IsPrint(r) {
						builder.WriteRune(r)
					}
					if index+1 < len(value) && value[index+1] != '\\' && value[index+1] != '{' && value[index+1] != '}' {
						index++
					}
				}
			case "emdash":
				builder.WriteString("—")
			case "endash":
				builder.WriteString("–")
			case "bullet":
				builder.WriteString("• ")
			}
			continue
		}
		if skipping() {
			continue
		}
		if item == '\r' || item == '\n' {
			continue
		}
		builder.WriteByte(item)
	}
	blocks := textToParagraphBlocks(sanitizeText(builder.String(), options.MaxOutputBytes), options)
	return Document{Version: Version, SourceKind: family, Warnings: []Warning{warning("rtf_simplified_text", "RTF is shown through a limited safe text tokenizer.")}, Blocks: blocks}, nil
}

func readRTFControlWord(value string) (word string, number int, hasNumber bool, consumed int) {
	start := 0
	for start < len(value) && ((value[start] >= 'A' && value[start] <= 'Z') || (value[start] >= 'a' && value[start] <= 'z')) {
		start++
	}
	if start == 0 {
		return "", 0, false, 1
	}
	word = value[:start]
	index := start
	sign := 1
	if index < len(value) && value[index] == '-' {
		sign = -1
		index++
	}
	valueStart := index
	for index < len(value) && value[index] >= '0' && value[index] <= '9' {
		index++
	}
	if index > valueStart {
		hasNumber = true
		if parsed, err := strconv.Atoi(value[valueStart:index]); err == nil {
			number = parsed * sign
		}
	}
	if index < len(value) && value[index] == ' ' {
		index++
	}
	return word, number, hasNumber, index
}

func decodeRTFHexByte(value string) (byte, bool) {
	if len(value) != 2 {
		return 0, false
	}
	parsed, err := strconv.ParseUint(value, 16, 8)
	if err != nil {
		return 0, false
	}
	return byte(parsed), true
}

func isRTFDestinationToSkip(word string) bool {
	switch word {
	case "fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "datastore", "themedata", "generator", "xmlnstbl", "listtable", "listoverridetable":
		return true
	default:
		return false
	}
}

func parseOOXMLDocument(data []byte, family SourceFamily, options Options) (Document, error) {
	archive, warnings, err := safeZipFiles(data, options)
	if err != nil {
		return Document{}, err
	}
	patterns := []string{"word/document.xml", "word/header*.xml", "word/footer*.xml", "word/footnotes.xml", "word/endnotes.xml"}
	if family == FamilyPPTX {
		patterns = []string{"ppt/slides/slide*.xml", "ppt/notesSlides/notesSlide*.xml"}
	}
	var blocks []DocumentBlock
	slideIndex := 0
	for _, name := range matchingDocumentPartNames(archive, patterns, family) {
		if family == FamilyPPTX && strings.HasPrefix(name, "ppt/slides/slide") {
			slideIndex++
			blocks = appendBlock(blocks, slideMarkerBlock(slideIndex), options)
		}
		extracted, moreWarnings, err := parseWordLikeXML(archive[name], family, options)
		warnings = append(warnings, moreWarnings...)
		if err != nil {
			warnings = append(warnings, warning("xml_part_skipped", fmt.Sprintf("Skipped suspicious document XML part %s.", name)))
			continue
		}
		blocks = appendBlocks(blocks, extracted, options)
	}
	warnings = append(warnings, warning("document_images_omitted", "Embedded images, drawings, charts, and external objects were omitted from the safe preview."))
	return Document{Version: Version, SourceKind: family, Warnings: warnings, Blocks: blocks}, nil
}

func matchingDocumentPartNames(files map[string][]byte, patterns []string, family SourceFamily) []string {
	var names []string
	for _, name := range sortedZipNames(files) {
		if zipNameMatches(name, patterns) {
			names = append(names, name)
		}
	}
	if family == FamilyPPTX {
		sort.SliceStable(names, func(left, right int) bool {
			leftSlide, leftOK := slideNumberFromOOXMLPath(names[left])
			rightSlide, rightOK := slideNumberFromOOXMLPath(names[right])
			if leftOK && rightOK && leftSlide != rightSlide {
				return leftSlide < rightSlide
			}
			if leftOK != rightOK {
				return leftOK
			}
			return names[left] < names[right]
		})
	}
	return names
}

func slideNumberFromOOXMLPath(name string) (int, bool) {
	if !strings.HasPrefix(name, "ppt/slides/slide") || !strings.HasSuffix(name, ".xml") {
		return 0, false
	}
	value := strings.TrimSuffix(strings.TrimPrefix(name, "ppt/slides/slide"), ".xml")
	number, err := strconv.Atoi(value)
	if err != nil || number < 1 {
		return 0, false
	}
	return number, true
}

func slideMarkerBlock(index int) DocumentBlock {
	return DocumentBlock{Type: "slide_marker", Text: textInline(fmt.Sprintf("Slide %d", index))}
}

func parseOpenDocumentText(data []byte, family SourceFamily, options Options) (Document, error) {
	archive, warnings, err := safeZipFiles(data, options)
	if err != nil {
		return Document{}, err
	}
	var blocks []DocumentBlock
	for _, name := range []string{"content.xml", "meta.xml"} {
		payload, ok := archive[name]
		if !ok {
			continue
		}
		extracted, moreWarnings, err := parseOpenDocumentXML(payload, family, options)
		warnings = append(warnings, moreWarnings...)
		if err != nil {
			warnings = append(warnings, warning("xml_part_skipped", fmt.Sprintf("Skipped suspicious OpenDocument XML part %s.", name)))
			continue
		}
		blocks = appendBlocks(blocks, extracted, options)
	}
	warnings = append(warnings, warning("document_images_omitted", "Embedded images, drawings, charts, and external objects were omitted from the safe preview."))
	return Document{Version: Version, SourceKind: family, Warnings: warnings, Blocks: blocks}, nil
}

func parseWordLikeXML(data []byte, family SourceFamily, options Options) ([]DocumentBlock, []Warning, error) {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	var blocks []DocumentBlock
	var warnings []Warning
	var text strings.Builder
	var tableRows []DocumentTableRow
	var currentCells []DocumentTableCell
	var currentCell strings.Builder
	inParagraph := false
	inText := false
	inTable := false
	inCell := false
	headingLevel := 0
	depth := 0
	flushParagraph := func() {
		value := sanitizeText(text.String(), options.MaxOutputBytes)
		text.Reset()
		if strings.TrimSpace(value) == "" {
			headingLevel = 0
			return
		}
		blockType := "paragraph"
		level := 0
		if headingLevel > 0 {
			blockType = "heading"
			level = headingLevel
		}
		blocks = appendBlock(blocks, DocumentBlock{Type: blockType, Level: level, Text: textInline(value)}, options)
		headingLevel = 0
	}
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return blocks, warnings, err
		}
		switch item := token.(type) {
		case xml.StartElement:
			depth++
			if depth > options.MaxXMLDepth {
				return blocks, warnings, fmt.Errorf("XML depth exceeds safe limit")
			}
			switch item.Name.Local {
			case "tbl":
				flushParagraph()
				inTable = true
				tableRows = nil
			case "tr":
				if inTable {
					currentCells = nil
				}
			case "tc":
				if inTable {
					inCell = true
					currentCell.Reset()
				}
			case "p":
				inParagraph = true
			case "pStyle":
				if level := headingLevelFromAttrs(item.Attr); level > 0 {
					headingLevel = level
				}
			case "t":
				inText = true
			case "tab":
				if inCell {
					currentCell.WriteByte(' ')
				} else if inParagraph {
					text.WriteByte(' ')
				}
			case "br":
				if inCell {
					currentCell.WriteByte('\n')
				} else if inParagraph {
					text.WriteByte('\n')
				}
			case "drawing", "pict", "object", "oleObject":
				warnings = append(warnings, warning("embedded_object_omitted", "Embedded visual or object content was omitted."))
			}
		case xml.EndElement:
			switch item.Name.Local {
			case "t":
				inText = false
			case "p":
				inParagraph = false
				if inCell {
					if currentCell.Len() > 0 {
						currentCell.WriteByte('\n')
					}
					currentCell.WriteString(blockPlainText(DocumentBlock{Type: "paragraph", Text: textInline(sanitizeText(text.String(), options.MaxOutputBytes))}))
					text.Reset()
				} else {
					flushParagraph()
				}
			case "tc":
				if inCell {
					currentCells = append(currentCells, DocumentTableCell{Text: sanitizeText(currentCell.String(), options.MaxCellTextBytes)})
					inCell = false
				}
			case "tr":
				if inTable && len(currentCells) > 0 && len(tableRows) < options.MaxTableRows {
					tableRows = append(tableRows, DocumentTableRow{Cells: currentCells})
				}
			case "tbl":
				if inTable && len(tableRows) > 0 {
					blocks = appendBlock(blocks, DocumentBlock{Type: "table", Rows: tableRows}, options)
				}
				inTable = false
			}
			if depth > 0 {
				depth--
			}
		case xml.CharData:
			if inText {
				value := string([]byte(item))
				if inCell {
					currentCell.WriteString(value)
				} else if inParagraph {
					text.WriteString(value)
				}
			}
		}
		if len(blocks) >= options.MaxBlocks {
			warnings = append(warnings, warning("document_truncated", "Document preview reached the safe block limit."))
			break
		}
	}
	flushParagraph()
	return blocks, warnings, nil
}

func parseOpenDocumentXML(data []byte, family SourceFamily, options Options) ([]DocumentBlock, []Warning, error) {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	var blocks []DocumentBlock
	var warnings []Warning
	var text strings.Builder
	var currentCells []DocumentTableCell
	var tableRows []DocumentTableRow
	inTextBlock := false
	inTable := false
	inRow := false
	inCell := false
	blockType := "paragraph"
	headingLevel := 0
	slideIndex := 0
	depth := 0
	flushText := func() {
		value := sanitizeText(text.String(), options.MaxOutputBytes)
		text.Reset()
		if strings.TrimSpace(value) == "" {
			return
		}
		if inCell {
			currentCells = append(currentCells, DocumentTableCell{Text: value})
			return
		}
		blocks = appendBlock(blocks, DocumentBlock{Type: blockType, Level: headingLevel, Text: textInline(value)}, options)
		blockType = "paragraph"
		headingLevel = 0
	}
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return blocks, warnings, err
		}
		switch item := token.(type) {
		case xml.StartElement:
			depth++
			if depth > options.MaxXMLDepth {
				return blocks, warnings, fmt.Errorf("XML depth exceeds safe limit")
			}
			switch item.Name.Local {
			case "page":
				if family == FamilyODP {
					flushText()
					slideIndex++
					blocks = appendBlock(blocks, slideMarkerBlock(slideIndex), options)
				}
			case "h":
				inTextBlock = true
				blockType = "heading"
				headingLevel = intAttr(item.Attr, "outline-level", 2)
				if headingLevel < 1 || headingLevel > 6 {
					headingLevel = 2
				}
			case "p":
				inTextBlock = true
				blockType = "paragraph"
			case "line-break":
				text.WriteByte('\n')
			case "s", "tab":
				text.WriteByte(' ')
			case "table":
				flushText()
				inTable = true
				tableRows = nil
			case "table-row":
				if inTable {
					inRow = true
					currentCells = nil
				}
			case "table-cell":
				if inRow {
					inCell = true
					text.Reset()
				}
			case "image", "object", "plugin":
				warnings = append(warnings, warning("embedded_object_omitted", "Embedded visual or object content was omitted."))
			}
		case xml.EndElement:
			switch item.Name.Local {
			case "h", "p":
				if inTextBlock {
					flushText()
					inTextBlock = false
				}
			case "table-cell":
				if inCell {
					if text.Len() > 0 {
						flushText()
					}
					inCell = false
				}
			case "table-row":
				if inRow && len(currentCells) > 0 && len(tableRows) < options.MaxTableRows {
					tableRows = append(tableRows, DocumentTableRow{Cells: currentCells})
				}
				inRow = false
			case "table":
				if inTable && len(tableRows) > 0 {
					blocks = appendBlock(blocks, DocumentBlock{Type: "table", Rows: tableRows}, options)
				}
				inTable = false
			}
			if depth > 0 {
				depth--
			}
		case xml.CharData:
			if inTextBlock || inCell {
				text.Write([]byte(item))
			}
		}
		if len(blocks) >= options.MaxBlocks {
			warnings = append(warnings, warning("document_truncated", "Document preview reached the safe block limit."))
			break
		}
	}
	flushText()
	return blocks, warnings, nil
}

func headingLevelFromAttrs(attrs []xml.Attr) int {
	for _, attr := range attrs {
		if attr.Name.Local != "val" {
			continue
		}
		lower := strings.ToLower(attr.Value)
		if strings.HasPrefix(lower, "heading") {
			number := strings.TrimSpace(strings.TrimPrefix(lower, "heading"))
			if value, err := strconv.Atoi(number); err == nil && value >= 1 && value <= 6 {
				return value
			}
		}
	}
	return 0
}

func safeZipFiles(data []byte, options Options) (map[string][]byte, []Warning, error) {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, nil, fmt.Errorf("safe parser could not read ZIP archive structure")
	}
	if len(reader.File) > options.MaxZipEntries {
		return nil, nil, fmt.Errorf("ZIP entry count exceeds safe limit: %d > %d", len(reader.File), options.MaxZipEntries)
	}
	files := make(map[string][]byte)
	var warnings []Warning
	var total uint64
	for _, file := range reader.File {
		name, isDir, err := safeZipEntryName(file.Name)
		if err != nil {
			return nil, nil, fmt.Errorf("ZIP entry has unsafe name")
		}
		if isDir {
			continue
		}
		if _, exists := files[name]; exists {
			return nil, nil, fmt.Errorf("ZIP archive contains duplicate entry %q", name)
		}
		if file.UncompressedSize64 > uint64(options.MaxZipEntryBytes) {
			warnings = append(warnings, Warning{Code: "zip_entry_omitted", Severity: "warning", Message: "A large archive entry was omitted.", Path: name})
			continue
		}
		if file.CompressedSize64 > 0 && file.UncompressedSize64/file.CompressedSize64 > uint64(options.MaxZipCompressionX) {
			return nil, nil, fmt.Errorf("ZIP entry compression ratio exceeds safe limit")
		}
		total += file.UncompressedSize64
		if total > uint64(options.MaxZipTotalBytes) {
			return nil, nil, fmt.Errorf("ZIP total uncompressed size exceeds safe limit")
		}
		handle, err := file.Open()
		if err != nil {
			warnings = append(warnings, Warning{Code: "zip_entry_omitted", Severity: "warning", Message: "An unreadable archive entry was omitted.", Path: name})
			continue
		}
		payload, readErr := io.ReadAll(io.LimitReader(handle, int64(options.MaxZipEntryBytes)+1))
		_ = handle.Close()
		if readErr != nil {
			warnings = append(warnings, Warning{Code: "zip_entry_omitted", Severity: "warning", Message: "An archive entry failed while reading and was omitted.", Path: name})
			continue
		}
		if len(payload) > options.MaxZipEntryBytes {
			warnings = append(warnings, Warning{Code: "zip_entry_omitted", Severity: "warning", Message: "A large archive entry was omitted.", Path: name})
			continue
		}
		files[name] = payload
	}
	return files, warnings, nil
}

func safeZipEntryName(raw string) (string, bool, error) {
	if strings.TrimSpace(raw) == "" {
		return "", false, fmt.Errorf("empty ZIP entry name")
	}
	raw = strings.ReplaceAll(raw, "\\", "/")
	if strings.ContainsRune(raw, 0) || hasUnsafePathControl(raw) {
		return "", false, fmt.Errorf("unsafe ZIP entry control character")
	}
	if strings.HasPrefix(raw, "/") || looksLikeWindowsAbsolutePath(raw) {
		return "", false, fmt.Errorf("absolute ZIP entry path")
	}
	isDir := strings.HasSuffix(raw, "/")
	name := strings.TrimLeft(strings.TrimRight(raw, "/"), "/")
	if name == "" {
		return "", isDir, fmt.Errorf("empty ZIP entry name")
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." {
			return "", isDir, fmt.Errorf("unsafe ZIP entry path segment")
		}
	}
	clean := path.Clean(name)
	if clean == "." || strings.HasPrefix(clean, "../") || clean == ".." {
		return "", isDir, fmt.Errorf("unsafe ZIP entry path")
	}
	return clean, isDir, nil
}

func hasUnsafePathControl(value string) bool {
	for _, item := range value {
		if item < 0x20 || item == 0x7f || isBidiOrInvisibleControl(item) {
			return true
		}
	}
	return false
}

func looksLikeWindowsAbsolutePath(value string) bool {
	return len(value) >= 3 && ((value[0] >= 'a' && value[0] <= 'z') || (value[0] >= 'A' && value[0] <= 'Z')) && value[1] == ':' && (value[2] == '/' || value[2] == '\\')
}

func sortedZipNames(files map[string][]byte) []string {
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func zipNameMatches(name string, patterns []string) bool {
	clean := strings.TrimLeft(strings.ReplaceAll(name, "\\", "/"), "/")
	for _, pattern := range patterns {
		matched, err := path.Match(pattern, clean)
		if err == nil && matched {
			return true
		}
	}
	return false
}

func safeUTF8Text(data []byte, options Options) (string, []Warning, error) {
	if bytes.IndexByte(data, 0) >= 0 {
		return "", nil, fmt.Errorf("text contains NUL bytes")
	}
	if !utf8.Valid(data) {
		return "", nil, fmt.Errorf("text is not valid UTF-8")
	}
	var warnings []Warning
	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
		if len([]byte(line)) > options.MaxLineBytes {
			return "", nil, fmt.Errorf("text line exceeds safe limit: %d bytes", options.MaxLineBytes)
		}
	}
	value := sanitizeText(string(data), options.MaxOutputBytes)
	if len(value) < len(string(data)) {
		warnings = append(warnings, warning("text_truncated", "Text preview reached the safe output limit."))
	}
	return value, warnings, nil
}

func textToParagraphBlocks(text string, options Options) []DocumentBlock {
	var blocks []DocumentBlock
	paragraphs := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	var current []string
	flush := func() {
		if len(current) == 0 {
			return
		}
		blocks = appendBlock(blocks, DocumentBlock{Type: "paragraph", Text: textInline(strings.Join(current, "\n"))}, options)
		current = nil
	}
	for _, line := range paragraphs {
		if strings.TrimSpace(line) == "" {
			flush()
			continue
		}
		current = append(current, strings.TrimRight(line, " \t"))
	}
	flush()
	return blocks
}

func appendBlock(blocks []DocumentBlock, block DocumentBlock, options Options) []DocumentBlock {
	if len(blocks) >= options.MaxBlocks {
		return blocks
	}
	return append(blocks, block)
}

func appendBlocks(blocks []DocumentBlock, more []DocumentBlock, options Options) []DocumentBlock {
	for _, block := range more {
		blocks = appendBlock(blocks, block, options)
		if len(blocks) >= options.MaxBlocks {
			break
		}
	}
	return blocks
}

func sanitizeText(value string, maxBytes int) string {
	if maxBytes <= 0 {
		maxBytes = DefaultOptions().MaxOutputBytes
	}
	value = strings.ToValidUTF8(value, "")
	var builder strings.Builder
	spacePending := false
	lineBreakPending := false
	for _, item := range value {
		if builder.Len() >= maxBytes {
			break
		}
		switch item {
		case '\r', '\n':
			if builder.Len() > 0 {
				lineBreakPending = true
				spacePending = false
			}
			continue
		case '\t', ' ':
			spacePending = true
			continue
		}
		if item < 0x20 || item == 0x7f || isBidiOrInvisibleControl(item) {
			continue
		}
		if lineBreakPending {
			builder.WriteByte('\n')
			lineBreakPending = false
		} else if spacePending && builder.Len() > 0 {
			builder.WriteByte(' ')
		}
		spacePending = false
		builder.WriteRune(item)
	}
	return strings.TrimSpace(builder.String())
}

func isBidiOrInvisibleControl(r rune) bool {
	return (r >= '\u202a' && r <= '\u202e') || (r >= '\u2066' && r <= '\u2069') || r == '\u200b' || r == '\u200c' || r == '\u200d' || r == '\u2060'
}

func printableStringsFromBytes(data []byte, maxBytes int) string {
	if maxBytes <= 0 {
		return ""
	}
	var builder strings.Builder
	var run strings.Builder
	flush := func() {
		if run.Len() >= 4 {
			if builder.Len() > 0 {
				builder.WriteByte('\n')
			}
			builder.WriteString(run.String())
		}
		run.Reset()
	}
	for _, item := range data {
		if item == '\n' || item == '\r' || item == '\t' || (item >= 0x20 && item <= 0x7e) {
			run.WriteByte(item)
		} else {
			flush()
		}
		if builder.Len()+run.Len() >= maxBytes {
			break
		}
	}
	flush()
	return sanitizeText(builder.String(), maxBytes)
}

func filterPrintableFallbackText(value string, maxBytes int) string {
	if maxBytes <= 0 {
		maxBytes = DefaultOptions().MaxOutputBytes
	}
	var builder strings.Builder
	for _, rawLine := range strings.Split(value, "\n") {
		if builder.Len() >= maxBytes {
			break
		}
		line := cleanPrintableFallbackLine(rawLine)
		if !looksHumanReadableLine(line) {
			continue
		}
		for _, paragraph := range printableFallbackParagraphs(line) {
			if !looksHumanReadableLine(paragraph) {
				continue
			}
			if builder.Len() > 0 {
				builder.WriteString("\n\n")
			}
			builder.WriteString(paragraph)
			if builder.Len() >= maxBytes {
				break
			}
		}
	}
	return truncateStringBytes(builder.String(), maxBytes)
}

func printableFallbackParagraphs(line string) []string {
	line = strings.TrimSpace(line)
	if line == "" {
		return nil
	}
	marked := printableFallbackSectionPattern.ReplaceAllString(line, "\n$1 ")
	var out []string
	for _, part := range strings.Split(marked, "\n") {
		out = append(out, splitLongPrintableFallbackParagraph(strings.TrimSpace(part))...)
	}
	if len(out) == 0 {
		return []string{line}
	}
	return out
}

func splitLongPrintableFallbackParagraph(line string) []string {
	if len(line) <= 260 {
		if line == "" {
			return nil
		}
		return []string{line}
	}
	var out []string
	start := 0
	for index := 0; index < len(line); index++ {
		item := line[index]
		if item != '?' && item != '!' && item != '.' {
			continue
		}
		threshold := 180
		if item == '?' || item == '!' {
			threshold = 60
		}
		if index-start < threshold || index+1 >= len(line) || line[index+1] != ' ' {
			continue
		}
		segment := strings.TrimSpace(line[start : index+1])
		if len(segment) >= 20 {
			out = append(out, segment)
			start = index + 1
			for start < len(line) && line[start] == ' ' {
				start++
			}
		}
	}
	tail := strings.TrimSpace(line[start:])
	if tail != "" {
		out = append(out, tail)
	}
	return out
}

func cleanPrintableFallbackLine(value string) string {
	line := strings.TrimSpace(value)
	lower := strings.ToLower(line)
	cut := len(line)
	for _, marker := range []string{
		"[content_types].xml",
		"_rels/",
		".rels",
		"theme/",
		"word/",
		"ppt/",
		"xl/",
		"<?xml",
		"xmlns:",
		"schemas.openxmlformats.org",
		"microsoft word 97-2003",
		"word.document.",
		"ole",
		"normal.dot",
		"pk\x03",
	} {
		if index := strings.Index(lower, marker); index >= 0 && index < cut {
			cut = index
		}
	}
	if cut < len(line) {
		line = strings.TrimSpace(line[:cut])
	}
	var tokens []string
	for _, token := range strings.Fields(line) {
		if printableFallbackTechnicalToken(token) {
			continue
		}
		tokens = append(tokens, token)
	}
	return sanitizeText(strings.Join(tokens, " "), DefaultOptions().MaxOutputBytes)
}

func printableFallbackTechnicalToken(token string) bool {
	trimmed := strings.TrimSpace(token)
	if trimmed == "" {
		return true
	}
	lower := strings.ToLower(trimmed)
	for _, marker := range []string{"xml", "rels", "content_types", "theme", "xmlns", "schemas.", "word.document", "normal.dot", "ole"} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	var letters, digits, symbols int
	for _, item := range trimmed {
		switch {
		case unicode.IsLetter(item):
			letters++
		case unicode.IsDigit(item):
			digits++
		case unicode.IsPunct(item) || unicode.IsSymbol(item):
			symbols++
		}
	}
	alnum := letters + digits
	if alnum == 0 {
		return true
	}
	if len([]rune(trimmed)) <= 8 && symbols > alnum {
		return true
	}
	return false
}

func looksHumanReadableLine(value string) bool {
	value = strings.TrimSpace(value)
	if len(value) < 8 {
		return false
	}
	var letters, printable int
	for _, item := range value {
		if unicode.IsLetter(item) {
			letters++
		}
		if unicode.IsPrint(item) && !unicode.IsControl(item) {
			printable++
		}
	}
	return letters >= 3 && printable >= 8
}

func intAttr(attrs []xml.Attr, localName string, fallback int) int {
	for _, attr := range attrs {
		if attr.Name.Local != localName {
			continue
		}
		value, err := strconv.Atoi(strings.TrimSpace(attr.Value))
		if err == nil {
			return value
		}
	}
	return fallback
}

func truncateStringBytes(value string, maxBytes int) string {
	if maxBytes <= 0 || len(value) <= maxBytes {
		return value
	}
	for maxBytes > 0 && !utf8.ValidString(value[:maxBytes]) {
		maxBytes--
	}
	return value[:maxBytes]
}

func normalizeSpace(value string) string {
	return strings.Join(strings.FieldsFunc(value, unicode.IsSpace), " ")
}
