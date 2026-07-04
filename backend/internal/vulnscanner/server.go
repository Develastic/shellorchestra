// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package vulnscanner

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"shellorchestra/backend/internal/config"
	"shellorchestra/backend/internal/httplimits"
	"shellorchestra/backend/internal/serviceinfo"

	_ "modernc.org/sqlite"
)

const requiredDatabaseBytes int64 = 10 * 1024 * 1024 * 1024

type server struct {
	cfg         config.AppConfig
	databaseDir string
	advisoryDB  string
	mu          sync.Mutex
	db          databaseState
	advisories  []advisory
	count       int
}

type databaseState struct {
	State       string    `json:"state"`
	Progress    int       `json:"progress_percent"`
	Message     string    `json:"message"`
	LastUpdated time.Time `json:"last_updated_at,omitempty"`
	Updating    bool      `json:"updating"`
}

type advisory struct {
	ID               string   `json:"id"`
	Severity         string   `json:"severity"`
	Summary          string   `json:"summary"`
	PackageName      string   `json:"package_name"`
	PackageManager   string   `json:"package_manager"`
	Ecosystem        string   `json:"ecosystem"`
	AffectedVersions []string `json:"affected_versions"`
	FixedVersion     string   `json:"fixed_version"`
	References       []string `json:"references"`
}

type scanRequest struct {
	GeneratedAt string       `json:"generated_at"`
	Servers     []scanServer `json:"servers"`
}

type scanServer struct {
	ID             string        `json:"id"`
	Name           string        `json:"name"`
	OS             string        `json:"os"`
	Distro         string        `json:"distro"`
	PackageManager string        `json:"package_manager"`
	Packages       []scanPackage `json:"packages"`
	Error          string        `json:"error"`
}

type scanPackage struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	Manager     string `json:"manager"`
	Description string `json:"description"`
}

type finding struct {
	ID              string          `json:"id"`
	Severity        string          `json:"severity"`
	PackageName     string          `json:"package_name"`
	Summary         string          `json:"summary"`
	FixedVersion    string          `json:"fixed_version,omitempty"`
	References      []string        `json:"references,omitempty"`
	FixAvailable    bool            `json:"fix_available"`
	AffectedServers []findingServer `json:"affected_servers"`
}

type findingServer struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	InstalledVersion string `json:"installed_version"`
	PackageManager   string `json:"package_manager"`
}

// ListenAndServe runs the Pro vulnerability scanner service contract.
func ListenAndServe(ctx context.Context, cfg config.AppConfig) error {
	s := &server{
		cfg:         cfg,
		databaseDir: vulnerabilityDatabaseDir(),
		db: databaseState{
			State:    "missing",
			Progress: 0,
			Message:  "The local vulnerability database has not been updated yet.",
		},
	}
	s.advisoryDB = advisorySQLitePath(s.databaseDir)
	if count, err := s.loadAdvisoryCount(); err == nil {
		s.count = count
		if count > 0 {
			s.db.State = "ready"
			s.db.Progress = 100
			s.db.Message = fmt.Sprintf("Loaded %d normalized advisories from the local vulnerability database.", count)
		}
	}
	httpServer := &http.Server{
		Addr:              cfg.App.ListenAddr,
		Handler:           s.handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    httplimits.MaxHeaderBytes,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/internal/service/status", serviceinfo.Handler(s.cfg, "vulnerability-scanner", func(ctx context.Context) map[string]any {
		status := s.status()
		return map[string]any{
			"database_state":          status["database_state"],
			"database_update_percent": status["database_update_percent"],
			"required_storage_bytes":  requiredDatabaseBytes,
		}
	}))
	mux.HandleFunc("/internal/vulnerability/status", s.statusHandler)
	mux.HandleFunc("/internal/vulnerability/update", s.updateHandler)
	mux.HandleFunc("/internal/vulnerability/update/upload", s.uploadUpdateHandler)
	mux.HandleFunc("/internal/vulnerability/scan", s.scanHandler)
	return mux
}

func (s *server) statusHandler(w http.ResponseWriter, r *http.Request) {
	if !s.validInternalRequest(w, r) {
		return
	}
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	writeJSON(w, http.StatusOK, s.status())
}

func (s *server) updateHandler(w http.ResponseWriter, r *http.Request) {
	if !s.validInternalRequest(w, r) {
		return
	}
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var body struct {
		Mode string `json:"mode"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body)
	mode := directUpdateMode(strings.TrimSpace(body.Mode))
	if mode == "" {
		mode = directUpdateAuto
	}
	if mode != directUpdateAuto && mode != directUpdateFullRebuild {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Unsupported vulnerability database update mode."})
		return
	}
	started := s.startUpdate(mode)
	writeJSON(w, http.StatusAccepted, map[string]any{
		"started": started,
		"status":  s.status(),
	})
}

func (s *server) uploadUpdateHandler(w http.ResponseWriter, r *http.Request) {
	if !s.validInternalRequest(w, r) {
		return
	}
	if r.Method != http.MethodPut && r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if r.ContentLength > maxVulnerabilityFeedBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "Vulnerability metadata feed is larger than the 8 GB safety limit."})
		return
	}
	if !s.beginUpdate("Receiving vulnerability database from the trusted browser.") {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "A vulnerability database update is already running.", "status": s.status()})
		return
	}
	zipPath, err := s.receiveUploadedFeed(r.Body, r.ContentLength)
	if err != nil {
		s.finishUpdate(0, err)
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error(), "status": s.status()})
		return
	}
	go s.completeUpdateFromZip(zipPath, 45)
	writeJSON(w, http.StatusAccepted, map[string]any{
		"started": true,
		"status":  s.status(),
	})
}

func (s *server) scanHandler(w http.ResponseWriter, r *http.Request) {
	if !s.validInternalRequest(w, r) {
		return
	}
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var body struct {
		GeneratedAt string       `json:"generated_at"`
		Servers     []scanServer `json:"servers"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<20)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Scan request is invalid."})
		return
	}
	status := s.status()
	if status["database_state"] != "ready" {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "Update the vulnerability database before running a scan.", "status": status})
		return
	}
	findings := s.matchFindings(scanRequest{GeneratedAt: body.GeneratedAt, Servers: body.Servers})
	message := "No vulnerability findings were returned by the current scanner database."
	if len(findings) > 0 {
		message = fmt.Sprintf("ShellOrchestra found %d vulnerability finding group(s). Review the affected servers before running fixes.", len(findings))
	}
	skipped := 0
	for _, server := range body.Servers {
		if server.Error != "" {
			skipped++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"generated_at": time.Now().UTC().Format(time.RFC3339),
		"scanned":      len(body.Servers),
		"skipped":      skipped,
		"findings":     findings,
		"message":      message,
	})
}

func (s *server) status() map[string]any {
	s.mu.Lock()
	dbState := s.db
	count := s.count
	root := s.databaseRoot()
	s.mu.Unlock()
	out := map[string]any{
		"available":                  true,
		"database_state":             dbState.State,
		"database_update_percent":    dbState.Progress,
		"database_message":           dbState.Message,
		"required_storage_bytes":     requiredDatabaseBytes,
		"required_storage_label":     "10 GB",
		"scanner_container_required": true,
		"advisory_count":             count,
		"database_source_label":      "OSV public vulnerability dump",
	}
	if !dbState.LastUpdated.IsZero() {
		out["last_update_at"] = dbState.LastUpdated.UTC().Format(time.RFC3339)
	}
	dbPath := advisorySQLitePath(root)
	if fileExists(dbPath) {
		metadata, err := loadOSVSyncMetadata(dbPath)
		if err == nil {
			if !metadata.Checkpoint.IsZero() {
				out["osv_checkpoint_at"] = metadata.Checkpoint.UTC().Format(time.RFC3339)
			}
			if !metadata.LastFullRebuild.IsZero() {
				out["last_full_rebuild_at"] = metadata.LastFullRebuild.UTC().Format(time.RFC3339)
			}
			if !metadata.LastIncremental.IsZero() {
				out["last_incremental_update_at"] = metadata.LastIncremental.UTC().Format(time.RFC3339)
			}
			if metadata.LastUpdateKind != "" {
				out["last_update_kind"] = metadata.LastUpdateKind
			}
			if metadata.LastSourceURL != "" {
				out["last_source_url"] = metadata.LastSourceURL
			}
			if metadata.LastModifiedFeedURL != "" {
				out["last_modified_feed_url"] = metadata.LastModifiedFeedURL
			}
			out["last_changed_record_count"] = metadata.LastChangedRecordCount
			out["incremental_available"] = !metadata.Checkpoint.IsZero()
		}
	}
	return out
}

func (s *server) loadAdvisories() ([]advisory, error) {
	root := s.databaseDir
	if root == "" {
		root = vulnerabilityDatabaseDir()
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("Could not prepare vulnerability database directory: %w", err)
	}
	var files []string
	if mainFile := filepath.Join(root, "advisories.json"); fileExists(mainFile) {
		files = append(files, mainFile)
	}
	matches, _ := filepath.Glob(filepath.Join(root, "advisories.d", "*.json"))
	sort.Strings(matches)
	files = append(files, matches...)
	var out []advisory
	for _, file := range files {
		list, err := loadAdvisoryFile(file)
		if err != nil {
			return nil, err
		}
		for _, item := range list {
			item.ID = strings.TrimSpace(item.ID)
			item.PackageName = strings.TrimSpace(item.PackageName)
			item.PackageManager = strings.TrimSpace(strings.ToLower(item.PackageManager))
			item.Ecosystem = strings.TrimSpace(strings.ToLower(item.Ecosystem))
			item.FixedVersion = strings.TrimSpace(item.FixedVersion)
			if item.ID == "" || item.PackageName == "" {
				continue
			}
			out = append(out, item)
		}
	}
	return out, nil
}

func (s *server) loadAdvisoryCount() (int, error) {
	root := s.databaseDir
	if root == "" {
		root = vulnerabilityDatabaseDir()
	}
	dbPath := advisorySQLitePath(root)
	if fileExists(dbPath) {
		db, err := sql.Open("sqlite", dbPath)
		if err != nil {
			return 0, fmt.Errorf("Could not open vulnerability advisory index: %w", err)
		}
		defer db.Close()
		var count int
		if err := db.QueryRow(`SELECT COUNT(*) FROM advisories`).Scan(&count); err != nil {
			return 0, fmt.Errorf("Could not read vulnerability advisory index: %w", err)
		}
		return count, nil
	}
	return 0, nil
}

func loadAdvisoryFile(path string) ([]advisory, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("Could not read vulnerability advisory file %s: %w", filepath.Base(path), err)
	}
	defer file.Close()

	decoder := json.NewDecoder(file)
	token, err := decoder.Token()
	if err != nil {
		return nil, fmt.Errorf("Could not parse vulnerability advisory file %s: %w", filepath.Base(path), err)
	}
	delim, ok := token.(json.Delim)
	if !ok || delim != '[' {
		return nil, fmt.Errorf("Could not parse vulnerability advisory file %s: expected JSON array", filepath.Base(path))
	}

	var out []advisory
	for decoder.More() {
		var item advisory
		if err := decoder.Decode(&item); err != nil {
			return nil, fmt.Errorf("Could not parse vulnerability advisory file %s: %w", filepath.Base(path), err)
		}
		out = append(out, item)
	}
	token, err = decoder.Token()
	if err != nil {
		return nil, fmt.Errorf("Could not parse vulnerability advisory file %s: %w", filepath.Base(path), err)
	}
	delim, ok = token.(json.Delim)
	if !ok || delim != ']' {
		return nil, fmt.Errorf("Could not parse vulnerability advisory file %s: expected JSON array end", filepath.Base(path))
	}
	return out, nil
}

func (s *server) matchFindings(request scanRequest) []finding {
	s.mu.Lock()
	advisories := append([]advisory(nil), s.advisories...)
	s.mu.Unlock()
	if len(advisories) == 0 && strings.TrimSpace(s.advisoryDB) != "" && fileExists(s.advisoryDB) {
		return s.matchFindingsFromDB(request)
	}
	findingByKey := map[string]*finding{}
	for _, server := range request.Servers {
		if server.Error != "" {
			continue
		}
		for _, pkg := range server.Packages {
			for _, adv := range advisories {
				if !advisoryMatchesPackage(adv, server, pkg) {
					continue
				}
				key := adv.ID + "\x00" + strings.ToLower(adv.PackageName)
				item := findingByKey[key]
				if item == nil {
					item = &finding{
						ID:              adv.ID,
						Severity:        firstNonEmpty(adv.Severity, "unknown"),
						PackageName:     adv.PackageName,
						Summary:         firstNonEmpty(adv.Summary, "Security advisory affects this package."),
						FixedVersion:    adv.FixedVersion,
						References:      adv.References,
						FixAvailable:    adv.FixedVersion != "",
						AffectedServers: []findingServer{},
					}
					findingByKey[key] = item
				}
				appendAffectedServerOnce(item, findingServer{
					ID:               server.ID,
					Name:             firstNonEmpty(server.Name, server.ID),
					InstalledVersion: pkg.Version,
					PackageManager:   firstNonEmpty(pkg.Manager, server.PackageManager),
				})
			}
		}
	}
	return sortedFindings(findingByKey)
}

func (s *server) matchFindingsFromDB(request scanRequest) []finding {
	db, err := sql.Open("sqlite", s.advisoryDB)
	if err != nil {
		return nil
	}
	defer db.Close()
	findingByKey := map[string]*finding{}
	for _, server := range request.Servers {
		if server.Error != "" {
			continue
		}
		for _, pkg := range server.Packages {
			manager := strings.ToLower(firstNonEmpty(pkg.Manager, server.PackageManager))
			advisories, err := queryAdvisoriesForPackage(db, pkg.Name, manager)
			if err != nil {
				continue
			}
			for _, adv := range advisories {
				if !advisoryMatchesPackage(adv, server, pkg) {
					continue
				}
				key := adv.ID + "\x00" + strings.ToLower(adv.PackageName)
				item := findingByKey[key]
				if item == nil {
					item = &finding{
						ID:              adv.ID,
						Severity:        firstNonEmpty(adv.Severity, "unknown"),
						PackageName:     adv.PackageName,
						Summary:         firstNonEmpty(adv.Summary, "Security advisory affects this package."),
						FixedVersion:    adv.FixedVersion,
						References:      adv.References,
						FixAvailable:    adv.FixedVersion != "",
						AffectedServers: []findingServer{},
					}
					findingByKey[key] = item
				}
				appendAffectedServerOnce(item, findingServer{
					ID:               server.ID,
					Name:             firstNonEmpty(server.Name, server.ID),
					InstalledVersion: pkg.Version,
					PackageManager:   firstNonEmpty(pkg.Manager, server.PackageManager),
				})
			}
		}
	}
	return sortedFindings(findingByKey)
}

func queryAdvisoriesForPackage(db *sql.DB, packageName string, packageManager string) ([]advisory, error) {
	rows, err := db.Query(`
SELECT id, severity, summary, package_name, package_manager, ecosystem, affected_versions_json, fixed_version, references_json
FROM advisories
WHERE package_name = ? AND package_manager = ?
`, strings.TrimSpace(packageName), strings.ToLower(strings.TrimSpace(packageManager)))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []advisory
	for rows.Next() {
		item, err := scanAdvisoryRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

type advisoryScanner interface {
	Scan(dest ...any) error
}

func scanAdvisoryRow(row advisoryScanner) (advisory, error) {
	var item advisory
	var affectedJSON string
	var referencesJSON string
	if err := row.Scan(&item.ID, &item.Severity, &item.Summary, &item.PackageName, &item.PackageManager, &item.Ecosystem, &affectedJSON, &item.FixedVersion, &referencesJSON); err != nil {
		return advisory{}, err
	}
	_ = json.Unmarshal([]byte(affectedJSON), &item.AffectedVersions)
	_ = json.Unmarshal([]byte(referencesJSON), &item.References)
	return item, nil
}

func sortedFindings(findingByKey map[string]*finding) []finding {
	var findings []finding
	for _, item := range findingByKey {
		findings = append(findings, *item)
	}
	sort.Slice(findings, func(i, j int) bool {
		left := severityRank(findings[i].Severity)
		right := severityRank(findings[j].Severity)
		if left != right {
			return left > right
		}
		return findings[i].ID < findings[j].ID
	})
	return findings
}

func appendAffectedServerOnce(item *finding, server findingServer) {
	for _, existing := range item.AffectedServers {
		if existing.ID == server.ID && existing.InstalledVersion == server.InstalledVersion && existing.PackageManager == server.PackageManager {
			return
		}
	}
	item.AffectedServers = append(item.AffectedServers, server)
}

func advisoryMatchesPackage(adv advisory, server scanServer, pkg scanPackage) bool {
	if !strings.EqualFold(adv.PackageName, pkg.Name) {
		return false
	}
	manager := strings.ToLower(firstNonEmpty(pkg.Manager, server.PackageManager))
	if adv.PackageManager != "" && adv.PackageManager != manager {
		return false
	}
	if adv.Ecosystem != "" {
		haystack := strings.ToLower(server.Distro + " " + server.OS + " " + manager)
		if !strings.Contains(haystack, adv.Ecosystem) {
			return false
		}
	}
	for _, affected := range adv.AffectedVersions {
		if strings.TrimSpace(affected) == pkg.Version {
			return true
		}
	}
	if adv.FixedVersion != "" && looseVersionLess(pkg.Version, adv.FixedVersion) {
		return true
	}
	return false
}

func looseVersionLess(left string, right string) bool {
	leftNumbers := versionNumbers(left)
	rightNumbers := versionNumbers(right)
	if len(leftNumbers) == 0 || len(rightNumbers) == 0 {
		return false
	}
	maxLen := len(leftNumbers)
	if len(rightNumbers) > maxLen {
		maxLen = len(rightNumbers)
	}
	for index := 0; index < maxLen; index++ {
		leftValue, rightValue := 0, 0
		if index < len(leftNumbers) {
			leftValue = leftNumbers[index]
		}
		if index < len(rightNumbers) {
			rightValue = rightNumbers[index]
		}
		if leftValue < rightValue {
			return true
		}
		if leftValue > rightValue {
			return false
		}
	}
	return false
}

func versionNumbers(value string) []int {
	matches := regexp.MustCompile(`[0-9]+`).FindAllString(value, 8)
	out := make([]int, 0, len(matches))
	for _, match := range matches {
		number, err := strconv.Atoi(match)
		if err == nil {
			out = append(out, number)
		}
	}
	return out
}

func severityRank(value string) int {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "critical":
		return 5
	case "high":
		return 4
	case "medium", "moderate":
		return 3
	case "low":
		return 2
	default:
		return 1
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func vulnerabilityDatabaseDir() string {
	if value := strings.TrimSpace(os.Getenv("SHELLORCHESTRA_VULN_DB_DIR")); value != "" {
		return value
	}
	return "/app/vulnerability-db"
}

func (s *server) validInternalRequest(w http.ResponseWriter, r *http.Request) bool {
	expected := strings.TrimSpace(s.cfg.Internal.SharedSecret)
	provided := strings.TrimSpace(r.Header.Get("X-ShellOrchestra-Internal-Secret"))
	if expected == "" || provided == "" || provided != expected {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Verified internal service identity is required."})
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func methodNotAllowed(w http.ResponseWriter) {
	writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "Method not allowed."})
}
