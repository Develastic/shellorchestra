// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package vulnscanner

import (
	"archive/zip"
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	defaultOSVAllURL                 = "https://storage.googleapis.com/osv-vulnerabilities/all.zip"
	defaultOSVModifiedIDURL          = "https://storage.googleapis.com/osv-vulnerabilities/modified_id.csv"
	defaultOSVRecordBaseURL          = "https://storage.googleapis.com/osv-vulnerabilities"
	maxVulnerabilityFeedBytes        = int64(8 * 1024 * 1024 * 1024)
	maxVulnerabilityModifiedCSVBytes = int64(256 * 1024 * 1024)
	maxVulnerabilityRecordBytes      = int64(32 * 1024 * 1024)
	maxIncrementalOSVRecords         = 20000
	vulnerabilityUpdateConcurrency   = 10
	vulnerabilityUpdateHTTPTimeout   = 90 * time.Minute
)

var severityWordPattern = regexp.MustCompile(`(?i)\b(critical|high|medium|moderate|low)\b`)

type osvDocument struct {
	ID               string         `json:"id"`
	Summary          string         `json:"summary"`
	Details          string         `json:"details"`
	Aliases          []string       `json:"aliases"`
	Withdrawn        string         `json:"withdrawn"`
	Severity         []osvSeverity  `json:"severity"`
	Affected         []osvAffected  `json:"affected"`
	References       []osvReference `json:"references"`
	DatabaseSpecific map[string]any `json:"database_specific"`
}

type osvSeverity struct {
	Type  string `json:"type"`
	Score string `json:"score"`
}

type osvAffected struct {
	Package           osvPackage     `json:"package"`
	Ranges            []osvRange     `json:"ranges"`
	Versions          []string       `json:"versions"`
	EcosystemSpecific map[string]any `json:"ecosystem_specific"`
	DatabaseSpecific  map[string]any `json:"database_specific"`
}

type osvPackage struct {
	Name      string `json:"name"`
	Ecosystem string `json:"ecosystem"`
	PURL      string `json:"purl"`
}

type osvRange struct {
	Type   string     `json:"type"`
	Events []osvEvent `json:"events"`
}

type osvEvent struct {
	Introduced   string `json:"introduced"`
	Fixed        string `json:"fixed"`
	LastAffected string `json:"last_affected"`
	Limit        string `json:"limit"`
}

type osvReference struct {
	Type string `json:"type"`
	URL  string `json:"url"`
}

type directUpdateMode string

const (
	directUpdateAuto        directUpdateMode = "auto"
	directUpdateFullRebuild directUpdateMode = "full_rebuild"
)

type osvSyncMetadata struct {
	Checkpoint             time.Time
	LastFullRebuild        time.Time
	LastIncremental        time.Time
	LastUpdateKind         string
	LastSourceURL          string
	LastModifiedFeedURL    string
	LastChangedRecordCount int
}

type osvModifiedEntry struct {
	Modified time.Time
	Path     string
}

func (s *server) startUpdate(mode directUpdateMode) bool {
	if !s.beginUpdate("Preparing vulnerability database update.") {
		return false
	}

	go func() {
		count, updateErr := s.updateDatabaseFromFeeds(mode)
		s.finishUpdate(count, updateErr)
	}()
	return true
}

func (s *server) beginUpdate(message string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db.Updating {
		return false
	}
	s.db.Updating = true
	s.db.State = "updating"
	s.db.Progress = 1
	s.db.Message = message
	return true
}

func (s *server) finishUpdate(count int, updateErr error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if updateErr != nil {
		s.db.State = "failed"
		s.db.Progress = 100
		s.db.Message = updateErr.Error()
	} else {
		s.db.State = "ready"
		s.db.Progress = 100
		s.db.Message = fmt.Sprintf("Vulnerability database is ready with %d normalized advisories.", count)
		s.count = count
	}
	s.db.Updating = false
	s.db.LastUpdated = time.Now().UTC()
}

func (s *server) updateDatabaseFromFeeds(mode directUpdateMode) (int, error) {
	root := s.databaseDir
	if root == "" {
		root = vulnerabilityDatabaseDir()
	}
	s.setUpdateProgress(5, "Checking local vulnerability database workspace.")
	if err := s.prepareWorkspace(root); err != nil {
		return 0, err
	}
	switch mode {
	case "", directUpdateAuto:
		return s.updateDatabaseAuto(root)
	case directUpdateFullRebuild:
		return s.updateDatabaseFullRebuild(root, "backend_direct_full_rebuild")
	default:
		return 0, fmt.Errorf("Unsupported vulnerability database update mode %q", mode)
	}
}

func (s *server) updateDatabaseAuto(root string) (int, error) {
	dbPath := advisorySQLitePath(root)
	if !fileExists(dbPath) {
		s.setUpdateProgress(6, "No local vulnerability database exists yet; running the initial full OSV import.")
		return s.updateDatabaseFullRebuild(root, "backend_direct_initial_full_import")
	}
	metadata, err := loadOSVSyncMetadata(dbPath)
	if err != nil {
		return 0, err
	}
	if metadata.Checkpoint.IsZero() {
		return 0, fmt.Errorf("The local vulnerability database has no OSV incremental checkpoint. Run Rebuild database once; ShellOrchestra will use incremental updates after that full rebuild completes.")
	}
	return s.updateDatabaseIncremental(root, metadata)
}

func (s *server) updateDatabaseFullRebuild(root string, updateKind string) (int, error) {
	modifiedCSVPath := filepath.Join(root, "sources", "modified_id.csv")
	s.setUpdateProgress(7, "Reading OSV incremental checkpoint before full import.")
	checkpoint, err := s.downloadOSVNewestModifiedCheckpoint(modifiedCSVPath)
	if err != nil {
		return 0, err
	}
	osvURL := osvAllURL()
	osvZipPath := filepath.Join(root, "sources", "osv-all.zip")
	s.setUpdateProgress(10, "Downloading OSV vulnerability metadata.")
	if err := downloadFile(osvURL, osvZipPath, maxVulnerabilityFeedBytes, func(downloaded int64, total int64) {
		if total > 0 {
			progress := 10 + int(float64(downloaded)/float64(total)*40)
			if progress > 50 {
				progress = 50
			}
			s.setUpdateProgress(progress, fmt.Sprintf("Downloading OSV vulnerability metadata: %s of %s.", bytesLabel(downloaded), bytesLabel(total)))
		} else {
			s.setUpdateProgress(25, fmt.Sprintf("Downloading OSV vulnerability metadata: %s received.", bytesLabel(downloaded)))
		}
	}); err != nil {
		return 0, err
	}

	count, err := s.normalizeDatabaseFromZip(osvZipPath, 55)
	if err != nil {
		return 0, err
	}
	if err := setOSVSyncMetadata(advisorySQLitePath(root), osvSyncMetadata{
		Checkpoint:          checkpoint,
		LastFullRebuild:     time.Now().UTC(),
		LastUpdateKind:      updateKind,
		LastSourceURL:       osvURL,
		LastModifiedFeedURL: osvModifiedIDURL(),
	}); err != nil {
		return 0, err
	}
	return count, nil
}

func (s *server) updateDatabaseIncremental(root string, metadata osvSyncMetadata) (int, error) {
	modifiedCSVPath := filepath.Join(root, "sources", "modified_id.csv")
	s.setUpdateProgress(10, "Checking OSV modified advisory feed for incremental updates.")
	entries, newestCheckpoint, err := s.downloadOSVModifiedEntries(modifiedCSVPath, metadata.Checkpoint, maxIncrementalOSVRecords)
	if err != nil {
		return 0, err
	}
	if len(entries) == 0 {
		count, err := s.loadAdvisoryCount()
		if err != nil {
			return 0, err
		}
		if !newestCheckpoint.IsZero() && newestCheckpoint.After(metadata.Checkpoint) {
			metadata.Checkpoint = newestCheckpoint
		}
		metadata.LastIncremental = time.Now().UTC()
		metadata.LastUpdateKind = "backend_direct_incremental_no_changes"
		metadata.LastSourceURL = osvModifiedIDURL()
		metadata.LastModifiedFeedURL = osvModifiedIDURL()
		metadata.LastChangedRecordCount = 0
		if err := setOSVSyncMetadata(advisorySQLitePath(root), metadata); err != nil {
			return 0, err
		}
		return count, nil
	}
	s.setUpdateProgress(15, fmt.Sprintf("Downloading %d changed OSV advisory record(s).", len(entries)))
	docs, err := downloadOSVDocumentsConcurrently(entries, vulnerabilityUpdateConcurrency, func(done int, total int) {
		if done == total || done%25 == 0 {
			progress := 15 + int(float64(done)/float64(total)*50)
			if progress > 65 {
				progress = 65
			}
			s.setUpdateProgress(progress, fmt.Sprintf("Downloaded %d of %d changed OSV advisory record(s).", done, total))
		}
	})
	if err != nil {
		return 0, err
	}
	s.setUpdateProgress(70, "Applying changed OSV advisories to the local SQLite index.")
	count, err := upsertOSVDocumentsIntoSQLite(advisorySQLitePath(root), docs, osvSyncMetadata{
		Checkpoint:             newestCheckpoint,
		LastFullRebuild:        metadata.LastFullRebuild,
		LastIncremental:        time.Now().UTC(),
		LastUpdateKind:         "backend_direct_incremental",
		LastSourceURL:          osvModifiedIDURL(),
		LastModifiedFeedURL:    osvModifiedIDURL(),
		LastChangedRecordCount: len(entries),
	})
	if err != nil {
		return 0, err
	}
	return count, nil
}

func (s *server) completeUpdateFromZip(zipPath string, progressStart int) {
	count, err := s.normalizeDatabaseFromZip(zipPath, progressStart)
	if err == nil {
		err = setOSVSyncMetadata(advisorySQLitePath(s.databaseRoot()), osvSyncMetadata{
			LastFullRebuild: time.Now().UTC(),
			LastUpdateKind:  "browser_manual_full_upload",
			LastSourceURL:   defaultOSVAllURL,
		})
	}
	s.finishUpdate(count, err)
}

func (s *server) normalizeDatabaseFromZip(osvZipPath string, progressStart int) (int, error) {
	root := s.databaseDir
	if root == "" {
		root = vulnerabilityDatabaseDir()
	}
	if progressStart < 1 {
		progressStart = 55
	}
	normalizeStart := progressStart
	normalizeSpan := 35
	if normalizeStart < 55 {
		normalizeSpan = 45
	}
	target := advisorySQLitePath(root)
	s.setUpdateProgress(normalizeStart, "Normalizing OSV advisories for Linux package managers.")
	written, err := writeAdvisorySQLiteFromOSVZip(osvZipPath, target, func(done int, total int) {
		if total <= 0 {
			return
		}
		progress := normalizeStart + int(float64(done)/float64(total)*float64(normalizeSpan))
		if progress > 90 {
			progress = 90
		}
		s.setUpdateProgress(progress, fmt.Sprintf("Normalizing OSV advisories: %d of %d records.", done, total))
	})
	if err != nil {
		return 0, err
	}

	s.setUpdateProgress(96, fmt.Sprintf("Loading %d normalized advisories.", written))
	count, err := s.loadAdvisoryCount()
	if err != nil {
		return 0, err
	}
	s.mu.Lock()
	s.count = count
	s.advisoryDB = target
	s.mu.Unlock()
	return count, nil
}

func (s *server) prepareWorkspace(root string) error {
	if err := os.MkdirAll(filepath.Join(root, "sources"), 0o700); err != nil {
		return fmt.Errorf("Could not prepare vulnerability feed cache: %w", err)
	}
	if err := os.MkdirAll(filepath.Join(root, "advisories.d"), 0o700); err != nil {
		return fmt.Errorf("Could not prepare normalized advisory database: %w", err)
	}
	return nil
}

func (s *server) databaseRoot() string {
	if s.databaseDir != "" {
		return s.databaseDir
	}
	return vulnerabilityDatabaseDir()
}

func (s *server) downloadOSVModifiedEntries(target string, stopAt time.Time, maxChanged int) ([]osvModifiedEntry, time.Time, error) {
	if err := downloadFile(osvModifiedIDURL(), target, maxVulnerabilityModifiedCSVBytes, func(downloaded int64, total int64) {
		if total > 0 {
			progress := 7 + int(float64(downloaded)/float64(total)*6)
			if progress > 13 {
				progress = 13
			}
			s.setUpdateProgress(progress, fmt.Sprintf("Downloading OSV modified advisory index: %s of %s.", bytesLabel(downloaded), bytesLabel(total)))
			return
		}
		s.setUpdateProgress(10, fmt.Sprintf("Downloading OSV modified advisory index: %s received.", bytesLabel(downloaded)))
	}); err != nil {
		return nil, time.Time{}, err
	}
	file, err := os.Open(target)
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("Could not read OSV modified advisory index: %w", err)
	}
	defer file.Close()
	return parseOSVModifiedEntries(file, stopAt, maxChanged)
}

func (s *server) downloadOSVNewestModifiedCheckpoint(target string) (time.Time, error) {
	if err := downloadFile(osvModifiedIDURL(), target, maxVulnerabilityModifiedCSVBytes, func(downloaded int64, total int64) {
		if total > 0 {
			progress := 7 + int(float64(downloaded)/float64(total)*6)
			if progress > 13 {
				progress = 13
			}
			s.setUpdateProgress(progress, fmt.Sprintf("Downloading OSV modified advisory index: %s of %s.", bytesLabel(downloaded), bytesLabel(total)))
			return
		}
		s.setUpdateProgress(10, fmt.Sprintf("Downloading OSV modified advisory index: %s received.", bytesLabel(downloaded)))
	}); err != nil {
		return time.Time{}, err
	}
	file, err := os.Open(target)
	if err != nil {
		return time.Time{}, fmt.Errorf("Could not read OSV modified advisory index: %w", err)
	}
	defer file.Close()
	return parseOSVModifiedNewestCheckpoint(file)
}

func parseOSVModifiedNewestCheckpoint(reader io.Reader) (time.Time, error) {
	csvReader := csv.NewReader(reader)
	csvReader.FieldsPerRecord = 2
	record, err := csvReader.Read()
	if err == io.EOF {
		return time.Time{}, nil
	}
	if err != nil {
		return time.Time{}, fmt.Errorf("Could not parse OSV modified advisory index: %w", err)
	}
	modified, err := parseOSVModifiedTime(record[0])
	if err != nil {
		return time.Time{}, err
	}
	if err := validateOSVRecordPath(strings.TrimSpace(record[1])); err != nil {
		return time.Time{}, err
	}
	return modified, nil
}

func parseOSVModifiedEntries(reader io.Reader, stopAt time.Time, maxChanged int) ([]osvModifiedEntry, time.Time, error) {
	csvReader := csv.NewReader(reader)
	csvReader.FieldsPerRecord = 2
	var out []osvModifiedEntry
	var newest time.Time
	for {
		record, err := csvReader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, time.Time{}, fmt.Errorf("Could not parse OSV modified advisory index: %w", err)
		}
		modified, err := parseOSVModifiedTime(record[0])
		if err != nil {
			return nil, time.Time{}, err
		}
		if newest.IsZero() {
			newest = modified
		}
		if !stopAt.IsZero() && !modified.After(stopAt) {
			break
		}
		path := strings.TrimSpace(record[1])
		if err := validateOSVRecordPath(path); err != nil {
			return nil, time.Time{}, err
		}
		out = append(out, osvModifiedEntry{Modified: modified, Path: path})
		if maxChanged > 0 && len(out) > maxChanged {
			return nil, time.Time{}, fmt.Errorf("OSV reports more than %d changed advisory records since the last checkpoint. Run Rebuild database instead of an incremental update.", maxChanged)
		}
	}
	return out, newest, nil
}

func parseOSVModifiedTime(value string) (time.Time, error) {
	value = strings.TrimSpace(value)
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("Could not parse OSV modified timestamp %q", value)
}

func validateOSVRecordPath(path string) error {
	path = strings.TrimSpace(path)
	if path == "" || strings.Contains(path, "\\") || strings.Contains(path, "..") || strings.HasPrefix(path, "/") || strings.HasSuffix(path, "/") {
		return fmt.Errorf("OSV modified advisory index returned an unsafe record path %q", path)
	}
	parts := strings.Split(path, "/")
	if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" || strings.TrimSpace(parts[1]) == "" {
		return fmt.Errorf("OSV modified advisory index returned unexpected record path %q", path)
	}
	return nil
}

func downloadOSVDocument(path string) (osvDocument, error) {
	recordURL, err := osvRecordURL(path)
	if err != nil {
		return osvDocument{}, err
	}
	request, err := http.NewRequest(http.MethodGet, recordURL, nil)
	if err != nil {
		return osvDocument{}, fmt.Errorf("Could not prepare OSV advisory request: %w", err)
	}
	client := &http.Client{Timeout: vulnerabilityUpdateHTTPTimeout}
	response, err := client.Do(request)
	if err != nil {
		return osvDocument{}, fmt.Errorf("Could not download OSV advisory %s: %w", path, err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return osvDocument{}, fmt.Errorf("Could not download OSV advisory %s: HTTP %d", path, response.StatusCode)
	}
	if response.ContentLength > maxVulnerabilityRecordBytes {
		return osvDocument{}, fmt.Errorf("OSV advisory %s is too large", path)
	}
	var doc osvDocument
	if err := json.NewDecoder(io.LimitReader(response.Body, maxVulnerabilityRecordBytes)).Decode(&doc); err != nil {
		return osvDocument{}, fmt.Errorf("Could not parse OSV advisory %s: %w", path, err)
	}
	return doc, nil
}

type osvDocumentDownloadResult struct {
	index int
	doc   osvDocument
	err   error
}

func downloadOSVDocumentsConcurrently(entries []osvModifiedEntry, concurrency int, onProgress func(done int, total int)) ([]osvDocument, error) {
	total := len(entries)
	if total == 0 {
		return nil, nil
	}
	workers := boundedWorkerCount(total, concurrency)
	jobs := make(chan int)
	results := make(chan osvDocumentDownloadResult, workers)
	var wg sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range jobs {
				doc, err := downloadOSVDocument(entries[index].Path)
				results <- osvDocumentDownloadResult{index: index, doc: doc, err: err}
			}
		}()
	}
	go func() {
		for index := range entries {
			jobs <- index
		}
		close(jobs)
		wg.Wait()
		close(results)
	}()

	docs := make([]osvDocument, total)
	done := 0
	var firstErr error
	for result := range results {
		done++
		if result.err != nil && firstErr == nil {
			firstErr = result.err
		}
		docs[result.index] = result.doc
		if onProgress != nil {
			onProgress(done, total)
		}
	}
	if firstErr != nil {
		return nil, firstErr
	}
	return docs, nil
}

func osvRecordURL(path string) (string, error) {
	if err := validateOSVRecordPath(path); err != nil {
		return "", err
	}
	parts := strings.Split(path, "/")
	recordID := strings.TrimSuffix(parts[1], ".json")
	return strings.TrimRight(osvRecordBaseURL(), "/") + "/" + url.PathEscape(parts[0]) + "/" + url.PathEscape(recordID) + ".json", nil
}

func (s *server) receiveUploadedFeed(body io.Reader, contentLength int64) (string, error) {
	root := s.databaseDir
	if root == "" {
		root = vulnerabilityDatabaseDir()
	}
	s.setUpdateProgress(5, "Checking local vulnerability database workspace.")
	if err := s.prepareWorkspace(root); err != nil {
		return "", err
	}
	target := filepath.Join(root, "sources", "osv-all.zip")
	tmp, err := os.CreateTemp(filepath.Join(root, "sources"), ".upload-*.zip")
	if err != nil {
		return "", fmt.Errorf("Could not create vulnerability upload cache file: %w", err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	buf := make([]byte, 1024*1024)
	var written int64
	lastProgress := time.Now().Add(-time.Second)
	for {
		read, readErr := body.Read(buf)
		if read > 0 {
			written += int64(read)
			if written > maxVulnerabilityFeedBytes {
				_ = tmp.Close()
				return "", fmt.Errorf("Vulnerability metadata feed exceeded the %s safety limit", bytesLabel(maxVulnerabilityFeedBytes))
			}
			if _, err := tmp.Write(buf[:read]); err != nil {
				_ = tmp.Close()
				return "", fmt.Errorf("Could not write vulnerability upload cache: %w", err)
			}
			if time.Since(lastProgress) >= 500*time.Millisecond {
				s.setUploadProgress(written, contentLength)
				lastProgress = time.Now()
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			_ = tmp.Close()
			return "", fmt.Errorf("Could not read vulnerability upload stream: %w", readErr)
		}
	}
	s.setUploadProgress(written, contentLength)
	if written == 0 {
		_ = tmp.Close()
		return "", fmt.Errorf("Uploaded vulnerability metadata feed is empty")
	}
	if err := tmp.Close(); err != nil {
		return "", fmt.Errorf("Could not finalize vulnerability upload cache: %w", err)
	}
	if err := os.Rename(tmpName, target); err != nil {
		return "", fmt.Errorf("Could not replace vulnerability metadata cache: %w", err)
	}
	s.setUpdateProgress(42, "Vulnerability metadata upload received. Preparing normalization.")
	return target, nil
}

func (s *server) setUploadProgress(downloaded int64, total int64) {
	if total > 0 {
		progress := 5 + int(float64(downloaded)/float64(total)*35)
		if progress > 40 {
			progress = 40
		}
		s.setUpdateProgress(progress, fmt.Sprintf("Receiving vulnerability metadata from browser: %s of %s.", bytesLabel(downloaded), bytesLabel(total)))
		return
	}
	s.setUpdateProgress(25, fmt.Sprintf("Receiving vulnerability metadata from browser: %s received.", bytesLabel(downloaded)))
}

func (s *server) setUpdateProgress(progress int, message string) {
	if progress < 1 {
		progress = 1
	}
	if progress > 99 {
		progress = 99
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.db.Progress = progress
	s.db.Message = message
}

func downloadFile(url string, target string, maxBytes int64, onProgress func(downloaded int64, total int64)) error {
	request, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("Could not prepare vulnerability metadata request: %w", err)
	}
	client := &http.Client{Timeout: vulnerabilityUpdateHTTPTimeout}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("Could not download vulnerability metadata from %s: %w", url, err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return fmt.Errorf("Could not download vulnerability metadata from %s: HTTP %d", url, response.StatusCode)
	}
	if response.ContentLength > maxBytes {
		return fmt.Errorf("Vulnerability metadata feed is too large: %s exceeds %s", bytesLabel(response.ContentLength), bytesLabel(maxBytes))
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return fmt.Errorf("Could not prepare vulnerability metadata cache: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(target), ".download-*.tmp")
	if err != nil {
		return fmt.Errorf("Could not create vulnerability metadata cache file: %w", err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	buf := make([]byte, 1024*1024)
	var downloaded int64
	lastProgress := time.Now().Add(-time.Second)
	for {
		read, readErr := response.Body.Read(buf)
		if read > 0 {
			downloaded += int64(read)
			if downloaded > maxBytes {
				_ = tmp.Close()
				return fmt.Errorf("Vulnerability metadata feed exceeded the %s safety limit", bytesLabel(maxBytes))
			}
			if _, err := tmp.Write(buf[:read]); err != nil {
				_ = tmp.Close()
				return fmt.Errorf("Could not write vulnerability metadata cache: %w", err)
			}
			if onProgress != nil && time.Since(lastProgress) >= 500*time.Millisecond {
				onProgress(downloaded, response.ContentLength)
				lastProgress = time.Now()
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			_ = tmp.Close()
			return fmt.Errorf("Could not read vulnerability metadata response: %w", readErr)
		}
	}
	if onProgress != nil {
		onProgress(downloaded, response.ContentLength)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("Could not finalize vulnerability metadata cache: %w", err)
	}
	if err := os.Rename(tmpName, target); err != nil {
		return fmt.Errorf("Could not replace vulnerability metadata cache: %w", err)
	}
	return nil
}

func normalizeOSVZip(path string, onProgress func(done int, total int)) ([]advisory, error) {
	reader, err := zip.OpenReader(path)
	if err != nil {
		return nil, fmt.Errorf("Could not open OSV vulnerability metadata: %w", err)
	}
	defer reader.Close()
	files := make([]*zip.File, 0, len(reader.File))
	for _, file := range reader.File {
		if file.FileInfo().IsDir() || !strings.HasSuffix(strings.ToLower(file.Name), ".json") {
			continue
		}
		files = append(files, file)
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })
	advisoryByKey := map[string]advisory{}
	for index, file := range files {
		if file.UncompressedSize64 > uint64(maxVulnerabilityRecordBytes) {
			return nil, fmt.Errorf("OSV record %s is too large", file.Name)
		}
		record, err := file.Open()
		if err != nil {
			return nil, fmt.Errorf("Could not read OSV record %s: %w", file.Name, err)
		}
		var doc osvDocument
		decodeErr := json.NewDecoder(io.LimitReader(record, maxVulnerabilityRecordBytes)).Decode(&doc)
		_ = record.Close()
		if decodeErr != nil {
			return nil, fmt.Errorf("Could not parse OSV record %s: %w", file.Name, decodeErr)
		}
		for _, item := range normalizeOSVDocument(doc) {
			key := strings.Join([]string{item.ID, item.PackageManager, item.Ecosystem, item.PackageName, item.FixedVersion}, "\x00")
			advisoryByKey[key] = item
		}
		if onProgress != nil && (index == len(files)-1 || index%250 == 0) {
			onProgress(index+1, len(files))
		}
	}
	out := make([]advisory, 0, len(advisoryByKey))
	for _, item := range advisoryByKey {
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool {
		left := strings.Join([]string{out[i].Ecosystem, out[i].PackageName, out[i].ID}, "\x00")
		right := strings.Join([]string{out[j].Ecosystem, out[j].PackageName, out[j].ID}, "\x00")
		return left < right
	})
	return out, nil
}

func writeNormalizedAdvisoriesFromOSVZip(zipPath string, targetPath string, onProgress func(done int, total int)) (int, error) {
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o700); err != nil {
		return 0, fmt.Errorf("Could not prepare normalized advisory database directory: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(targetPath), ".advisories-*.json")
	if err != nil {
		return 0, fmt.Errorf("Could not create normalized advisory database file: %w", err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()

	writer := normalizedAdvisoryWriter{writer: tmp}
	count, writeErr := writeNormalizedAdvisoriesFromOSVZipToWriter(zipPath, &writer, onProgress)
	if closeErr := tmp.Close(); closeErr != nil && writeErr == nil {
		writeErr = fmt.Errorf("Could not finalize normalized advisory database: %w", closeErr)
	}
	if writeErr != nil {
		return 0, writeErr
	}
	if err := os.Rename(tmpName, targetPath); err != nil {
		return 0, fmt.Errorf("Could not replace normalized advisory database: %w", err)
	}
	return count, nil
}

type normalizedAdvisoryWriter struct {
	writer io.Writer
	first  bool
	count  int
}

func (w *normalizedAdvisoryWriter) begin() error {
	w.first = true
	_, err := io.WriteString(w.writer, "[\n")
	return err
}

func (w *normalizedAdvisoryWriter) write(item advisory) error {
	if !w.first {
		if _, err := io.WriteString(w.writer, ",\n"); err != nil {
			return err
		}
	}
	w.first = false
	encoded, err := json.Marshal(item)
	if err != nil {
		return err
	}
	if _, err := w.writer.Write(encoded); err != nil {
		return err
	}
	w.count++
	return nil
}

func (w *normalizedAdvisoryWriter) end() error {
	_, err := io.WriteString(w.writer, "\n]\n")
	return err
}

func writeNormalizedAdvisoriesFromOSVZipToWriter(zipPath string, writer *normalizedAdvisoryWriter, onProgress func(done int, total int)) (int, error) {
	reader, err := zip.OpenReader(zipPath)
	if err != nil {
		return 0, fmt.Errorf("Could not open OSV vulnerability metadata: %w", err)
	}
	defer reader.Close()
	files := make([]*zip.File, 0, len(reader.File))
	for _, file := range reader.File {
		if file.FileInfo().IsDir() || !strings.HasSuffix(strings.ToLower(file.Name), ".json") {
			continue
		}
		files = append(files, file)
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })

	if err := writer.begin(); err != nil {
		return 0, fmt.Errorf("Could not write normalized advisory database: %w", err)
	}
	for index, file := range files {
		if file.UncompressedSize64 > uint64(maxVulnerabilityRecordBytes) {
			return 0, fmt.Errorf("OSV record %s is too large", file.Name)
		}
		record, err := file.Open()
		if err != nil {
			return 0, fmt.Errorf("Could not read OSV record %s: %w", file.Name, err)
		}
		var doc osvDocument
		decodeErr := json.NewDecoder(io.LimitReader(record, maxVulnerabilityRecordBytes)).Decode(&doc)
		_ = record.Close()
		if decodeErr != nil {
			return 0, fmt.Errorf("Could not parse OSV record %s: %w", file.Name, decodeErr)
		}
		for _, item := range normalizeOSVDocument(doc) {
			if err := writer.write(item); err != nil {
				return 0, fmt.Errorf("Could not write normalized advisory database: %w", err)
			}
		}
		if onProgress != nil && (index == len(files)-1 || index%250 == 0) {
			onProgress(index+1, len(files))
		}
	}
	if err := writer.end(); err != nil {
		return 0, fmt.Errorf("Could not write normalized advisory database: %w", err)
	}
	return writer.count, nil
}

func advisorySQLitePath(root string) string {
	return filepath.Join(root, "advisories.d", "osv.sqlite")
}

func writeAdvisorySQLiteFromOSVZip(zipPath string, targetPath string, onProgress func(done int, total int)) (int, error) {
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o700); err != nil {
		return 0, fmt.Errorf("Could not prepare normalized advisory database directory: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(targetPath), ".advisories-*.sqlite")
	if err != nil {
		return 0, fmt.Errorf("Could not create normalized advisory database file: %w", err)
	}
	tmpName := tmp.Name()
	_ = tmp.Close()
	defer func() { _ = os.Remove(tmpName) }()

	db, err := sql.Open("sqlite", tmpName)
	if err != nil {
		return 0, fmt.Errorf("Could not open normalized advisory database file: %w", err)
	}
	defer db.Close()
	if _, err := db.Exec(`
PRAGMA journal_mode=OFF;
PRAGMA synchronous=OFF;
PRAGMA temp_store=MEMORY;
CREATE TABLE advisories (
  id TEXT NOT NULL,
  severity TEXT NOT NULL,
  summary TEXT NOT NULL,
  package_name TEXT NOT NULL,
  package_manager TEXT NOT NULL,
  ecosystem TEXT NOT NULL,
  affected_versions_json TEXT NOT NULL,
  fixed_version TEXT NOT NULL,
  references_json TEXT NOT NULL
);
CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`); err != nil {
		return 0, fmt.Errorf("Could not initialize normalized advisory database: %w", err)
	}
	count, err := writeAdvisorySQLiteRowsFromOSVZip(db, zipPath, onProgress)
	if err != nil {
		return 0, err
	}
	if _, err := db.Exec(`
CREATE INDEX idx_advisories_package ON advisories(package_name, package_manager);
CREATE INDEX idx_advisories_id ON advisories(id);
PRAGMA optimize;
`); err != nil {
		return 0, fmt.Errorf("Could not index normalized advisory database: %w", err)
	}
	if err := db.Close(); err != nil {
		return 0, fmt.Errorf("Could not finalize normalized advisory database: %w", err)
	}
	if err := os.Rename(tmpName, targetPath); err != nil {
		return 0, fmt.Errorf("Could not replace normalized advisory database: %w", err)
	}
	return count, nil
}

func writeAdvisorySQLiteRowsFromOSVZip(db *sql.DB, zipPath string, onProgress func(done int, total int)) (int, error) {
	reader, err := zip.OpenReader(zipPath)
	if err != nil {
		return 0, fmt.Errorf("Could not open OSV vulnerability metadata: %w", err)
	}
	defer reader.Close()
	files := make([]*zip.File, 0, len(reader.File))
	for _, file := range reader.File {
		if file.FileInfo().IsDir() || !strings.HasSuffix(strings.ToLower(file.Name), ".json") {
			continue
		}
		files = append(files, file)
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })

	tx, err := db.Begin()
	if err != nil {
		return 0, fmt.Errorf("Could not start normalized advisory database write: %w", err)
	}
	stmt, err := tx.Prepare(`
INSERT INTO advisories (id, severity, summary, package_name, package_manager, ecosystem, affected_versions_json, fixed_version, references_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
	if err != nil {
		_ = tx.Rollback()
		return 0, fmt.Errorf("Could not prepare normalized advisory database write: %w", err)
	}
	defer stmt.Close()

	count := 0
	done := 0
	var firstErr error
	for result := range normalizeOSVZipFilesConcurrently(files, vulnerabilityUpdateConcurrency) {
		done++
		if result.err != nil {
			if firstErr == nil {
				firstErr = result.err
			}
			if onProgress != nil && (done == len(files) || done%250 == 0) {
				onProgress(done, len(files))
			}
			continue
		}
		if firstErr == nil {
			for _, item := range result.items {
				if err := insertAdvisorySQLiteRow(stmt, item); err != nil {
					firstErr = err
					break
				}
				count++
			}
		}
		if onProgress != nil && (done == len(files) || done%250 == 0) {
			onProgress(done, len(files))
		}
	}
	if firstErr != nil {
		_ = tx.Rollback()
		return 0, firstErr
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("Could not commit normalized advisory database: %w", err)
	}
	return count, nil
}

type normalizedOSVZipResult struct {
	fileName string
	items    []advisory
	err      error
}

func normalizeOSVZipFilesConcurrently(files []*zip.File, concurrency int) <-chan normalizedOSVZipResult {
	results := make(chan normalizedOSVZipResult, boundedWorkerCount(len(files), concurrency))
	if len(files) == 0 {
		close(results)
		return results
	}
	jobs := make(chan *zip.File)
	var wg sync.WaitGroup
	workers := boundedWorkerCount(len(files), concurrency)
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for file := range jobs {
				items, err := normalizeOSVZipFile(file)
				results <- normalizedOSVZipResult{fileName: file.Name, items: items, err: err}
			}
		}()
	}
	go func() {
		for _, file := range files {
			jobs <- file
		}
		close(jobs)
		wg.Wait()
		close(results)
	}()
	return results
}

func normalizeOSVZipFile(file *zip.File) ([]advisory, error) {
	if file.UncompressedSize64 > uint64(maxVulnerabilityRecordBytes) {
		return nil, fmt.Errorf("OSV record %s is too large", file.Name)
	}
	record, err := file.Open()
	if err != nil {
		return nil, fmt.Errorf("Could not read OSV record %s: %w", file.Name, err)
	}
	var doc osvDocument
	decodeErr := json.NewDecoder(io.LimitReader(record, maxVulnerabilityRecordBytes)).Decode(&doc)
	_ = record.Close()
	if decodeErr != nil {
		return nil, fmt.Errorf("Could not parse OSV record %s: %w", file.Name, decodeErr)
	}
	return normalizeOSVDocument(doc), nil
}

func boundedWorkerCount(total int, requested int) int {
	if total <= 0 {
		return 1
	}
	if requested < 1 {
		return 1
	}
	if requested > total {
		return total
	}
	return requested
}

func loadOSVSyncMetadata(dbPath string) (osvSyncMetadata, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return osvSyncMetadata{}, fmt.Errorf("Could not open vulnerability advisory index: %w", err)
	}
	defer db.Close()
	rows, err := db.Query(`SELECT key, value FROM metadata`)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "no such table") {
			return osvSyncMetadata{}, nil
		}
		return osvSyncMetadata{}, fmt.Errorf("Could not read vulnerability database metadata: %w", err)
	}
	defer rows.Close()
	values := map[string]string{}
	for rows.Next() {
		var key string
		var value string
		if err := rows.Scan(&key, &value); err != nil {
			return osvSyncMetadata{}, fmt.Errorf("Could not read vulnerability database metadata: %w", err)
		}
		values[key] = value
	}
	if err := rows.Err(); err != nil {
		return osvSyncMetadata{}, fmt.Errorf("Could not read vulnerability database metadata: %w", err)
	}
	return osvSyncMetadata{
		Checkpoint:             parseMetadataTime(values["osv_checkpoint_at"]),
		LastFullRebuild:        parseMetadataTime(values["last_full_rebuild_at"]),
		LastIncremental:        parseMetadataTime(values["last_incremental_update_at"]),
		LastUpdateKind:         values["last_update_kind"],
		LastSourceURL:          values["last_source_url"],
		LastModifiedFeedURL:    values["last_modified_feed_url"],
		LastChangedRecordCount: parseMetadataInt(values["last_changed_record_count"]),
	}, nil
}

func setOSVSyncMetadata(dbPath string, metadata osvSyncMetadata) error {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return fmt.Errorf("Could not open vulnerability advisory index: %w", err)
	}
	defer db.Close()
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("Could not start vulnerability metadata update: %w", err)
	}
	if err := setOSVSyncMetadataTx(tx, metadata); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("Could not commit vulnerability metadata update: %w", err)
	}
	return nil
}

func setOSVSyncMetadataTx(tx *sql.Tx, metadata osvSyncMetadata) error {
	if _, err := tx.Exec(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)`); err != nil {
		return fmt.Errorf("Could not initialize vulnerability database metadata: %w", err)
	}
	values := map[string]string{
		"osv_checkpoint_at":          formatMetadataTime(metadata.Checkpoint),
		"last_full_rebuild_at":       formatMetadataTime(metadata.LastFullRebuild),
		"last_incremental_update_at": formatMetadataTime(metadata.LastIncremental),
		"last_update_kind":           metadata.LastUpdateKind,
		"last_source_url":            metadata.LastSourceURL,
		"last_modified_feed_url":     metadata.LastModifiedFeedURL,
		"last_changed_record_count":  fmt.Sprintf("%d", metadata.LastChangedRecordCount),
	}
	for key, value := range values {
		if _, err := tx.Exec(`INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value); err != nil {
			return fmt.Errorf("Could not write vulnerability database metadata %s: %w", key, err)
		}
	}
	return nil
}

func upsertOSVDocumentsIntoSQLite(dbPath string, docs []osvDocument, metadata osvSyncMetadata) (int, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return 0, fmt.Errorf("Could not open vulnerability advisory index: %w", err)
	}
	defer db.Close()
	tx, err := db.Begin()
	if err != nil {
		return 0, fmt.Errorf("Could not start incremental vulnerability update: %w", err)
	}
	deleteStmt, err := tx.Prepare(`DELETE FROM advisories WHERE id = ?`)
	if err != nil {
		_ = tx.Rollback()
		return 0, fmt.Errorf("Could not prepare incremental advisory delete: %w", err)
	}
	defer deleteStmt.Close()
	insertStmt, err := tx.Prepare(`
INSERT INTO advisories (id, severity, summary, package_name, package_manager, ecosystem, affected_versions_json, fixed_version, references_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
	if err != nil {
		_ = tx.Rollback()
		return 0, fmt.Errorf("Could not prepare incremental advisory write: %w", err)
	}
	defer insertStmt.Close()
	for _, doc := range docs {
		for _, id := range uniqueNonEmpty([]string{doc.ID, displayAdvisoryID(doc.ID, doc.Aliases)}, 4) {
			if _, err := deleteStmt.Exec(id); err != nil {
				_ = tx.Rollback()
				return 0, fmt.Errorf("Could not replace normalized advisory %s: %w", id, err)
			}
		}
		for _, item := range normalizeOSVDocument(doc) {
			if err := insertAdvisorySQLiteRow(insertStmt, item); err != nil {
				_ = tx.Rollback()
				return 0, err
			}
		}
	}
	if err := setOSVSyncMetadataTx(tx, metadata); err != nil {
		_ = tx.Rollback()
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("Could not commit incremental vulnerability update: %w", err)
	}
	count, err := queryAdvisorySQLiteCount(db)
	if err != nil {
		return 0, err
	}
	return count, nil
}

type advisoryExecStatement interface {
	Exec(args ...any) (sql.Result, error)
}

func insertAdvisorySQLiteRow(stmt advisoryExecStatement, item advisory) error {
	affected, err := json.Marshal(item.AffectedVersions)
	if err != nil {
		return fmt.Errorf("Could not encode affected versions for %s: %w", item.ID, err)
	}
	references, err := json.Marshal(item.References)
	if err != nil {
		return fmt.Errorf("Could not encode references for %s: %w", item.ID, err)
	}
	if _, err := stmt.Exec(
		item.ID,
		item.Severity,
		item.Summary,
		item.PackageName,
		item.PackageManager,
		item.Ecosystem,
		string(affected),
		item.FixedVersion,
		string(references),
	); err != nil {
		return fmt.Errorf("Could not write normalized advisory %s: %w", item.ID, err)
	}
	return nil
}

func queryAdvisorySQLiteCount(db *sql.DB) (int, error) {
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM advisories`).Scan(&count); err != nil {
		return 0, fmt.Errorf("Could not count normalized advisories: %w", err)
	}
	return count, nil
}

func parseMetadataTime(value string) time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}
	}
	return parsed.UTC()
}

func formatMetadataTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func parseMetadataInt(value string) int {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	var out int
	_, _ = fmt.Sscanf(value, "%d", &out)
	return out
}

func normalizeOSVDocument(doc osvDocument) []advisory {
	if strings.TrimSpace(doc.ID) == "" || strings.TrimSpace(doc.Withdrawn) != "" {
		return nil
	}
	refs := normalizeOSVReferences(doc.References)
	severity := normalizeSeverity(doc.DatabaseSpecific, nil, doc.Severity)
	summary := firstNonEmpty(doc.Summary, doc.Details, "Security advisory affects this package.")
	id := displayAdvisoryID(doc.ID, doc.Aliases)
	var out []advisory
	for _, affected := range doc.Affected {
		manager, ecosystem, ok := packageManagerForOSVEcosystem(affected.Package.Ecosystem)
		if !ok {
			continue
		}
		name := strings.TrimSpace(affected.Package.Name)
		if name == "" {
			continue
		}
		fixedVersions := fixedVersionsFromOSVRanges(affected.Ranges)
		affectedVersions := uniqueNonEmpty(affected.Versions, 20000)
		if len(fixedVersions) == 0 && len(affectedVersions) == 0 {
			continue
		}
		itemSeverity := normalizeSeverity(doc.DatabaseSpecific, affected.EcosystemSpecific, doc.Severity)
		if itemSeverity == "" {
			itemSeverity = severity
		}
		if itemSeverity == "" {
			itemSeverity = "unknown"
		}
		if len(fixedVersions) == 0 {
			out = append(out, advisory{
				ID:               id,
				Severity:         itemSeverity,
				Summary:          summary,
				PackageName:      name,
				PackageManager:   manager,
				Ecosystem:        ecosystem,
				AffectedVersions: affectedVersions,
				References:       refs,
			})
			continue
		}
		for _, fixed := range fixedVersions {
			out = append(out, advisory{
				ID:               id,
				Severity:         itemSeverity,
				Summary:          summary,
				PackageName:      name,
				PackageManager:   manager,
				Ecosystem:        ecosystem,
				AffectedVersions: affectedVersions,
				FixedVersion:     fixed,
				References:       refs,
			})
		}
	}
	return out
}

func writeNormalizedAdvisories(path string, advisories []advisory) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("Could not prepare normalized advisory database directory: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".advisories-*.json")
	if err != nil {
		return fmt.Errorf("Could not create normalized advisory database file: %w", err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	encoder := json.NewEncoder(tmp)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(advisories); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("Could not write normalized advisory database: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("Could not finalize normalized advisory database: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("Could not replace normalized advisory database: %w", err)
	}
	return nil
}

func packageManagerForOSVEcosystem(value string) (string, string, bool) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	switch {
	case strings.Contains(normalized, "debian"):
		return "apt", "debian", true
	case strings.Contains(normalized, "ubuntu"):
		return "apt", "ubuntu", true
	case strings.Contains(normalized, "alpine"):
		return "apk", "alpine", true
	case strings.Contains(normalized, "red hat") || strings.Contains(normalized, "redhat") || strings.Contains(normalized, "rhel") || strings.Contains(normalized, "rocky") || strings.Contains(normalized, "alma") || strings.Contains(normalized, "fedora"):
		return "dnf", normalized, true
	case strings.Contains(normalized, "suse") || strings.Contains(normalized, "opensuse"):
		return "zypper", normalized, true
	case strings.Contains(normalized, "arch"):
		return "pacman", "arch", true
	default:
		return "", "", false
	}
}

func fixedVersionsFromOSVRanges(ranges []osvRange) []string {
	var out []string
	for _, item := range ranges {
		if item.Type != "" && !strings.EqualFold(item.Type, "ECOSYSTEM") && !strings.EqualFold(item.Type, "SEMVER") {
			continue
		}
		for _, event := range item.Events {
			if fixed := strings.TrimSpace(event.Fixed); fixed != "" {
				out = append(out, fixed)
			}
		}
	}
	return uniqueNonEmpty(out, 100)
}

func normalizeOSVReferences(refs []osvReference) []string {
	out := make([]string, 0, len(refs))
	for _, ref := range refs {
		url := strings.TrimSpace(ref.URL)
		if strings.HasPrefix(url, "http://") || strings.HasPrefix(url, "https://") {
			out = append(out, url)
		}
	}
	return uniqueNonEmpty(out, 100)
}

func normalizeSeverity(databaseSpecific map[string]any, ecosystemSpecific map[string]any, severities []osvSeverity) string {
	for _, source := range []map[string]any{ecosystemSpecific, databaseSpecific} {
		if source == nil {
			continue
		}
		for _, key := range []string{"severity", "impact", "priority"} {
			if value, ok := source[key].(string); ok {
				if severity := severityWord(value); severity != "" {
					return severity
				}
			}
		}
	}
	for _, item := range severities {
		if severity := severityWord(item.Score); severity != "" {
			return severity
		}
		if severity := severityWord(item.Type); severity != "" {
			return severity
		}
	}
	return "unknown"
}

func severityWord(value string) string {
	match := severityWordPattern.FindString(value)
	return strings.ToLower(match)
}

func displayAdvisoryID(id string, aliases []string) string {
	for _, alias := range aliases {
		alias = strings.TrimSpace(alias)
		if strings.HasPrefix(strings.ToUpper(alias), "CVE-") {
			return alias
		}
	}
	return strings.TrimSpace(id)
}

func uniqueNonEmpty(values []string, limit int) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	return out
}

func osvAllURL() string {
	if value := strings.TrimSpace(os.Getenv("SHELLORCHESTRA_VULN_OSV_ALL_URL")); value != "" {
		return value
	}
	return defaultOSVAllURL
}

func osvModifiedIDURL() string {
	if value := strings.TrimSpace(os.Getenv("SHELLORCHESTRA_VULN_OSV_MODIFIED_ID_URL")); value != "" {
		return value
	}
	return defaultOSVModifiedIDURL
}

func osvRecordBaseURL() string {
	if value := strings.TrimSpace(os.Getenv("SHELLORCHESTRA_VULN_OSV_RECORD_BASE_URL")); value != "" {
		return value
	}
	return defaultOSVRecordBaseURL
}

func bytesLabel(value int64) string {
	units := []string{"B", "KiB", "MiB", "GiB", "TiB"}
	amount := float64(value)
	unit := 0
	for amount >= 1024 && unit < len(units)-1 {
		amount /= 1024
		unit++
	}
	if unit == 0 {
		return fmt.Sprintf("%d %s", value, units[unit])
	}
	return fmt.Sprintf("%.1f %s", amount, units[unit])
}
