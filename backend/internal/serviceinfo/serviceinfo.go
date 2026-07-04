// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package serviceinfo

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"shellorchestra/backend/internal/buildinfo"
	"shellorchestra/backend/internal/config"
)

var startedAt = time.Now().UTC()

type Status struct {
	Name                   string         `json:"name"`
	Role                   string         `json:"role"`
	Version                string         `json:"version"`
	State                  string         `json:"state"`
	Status                 string         `json:"status"`
	StartedAt              time.Time      `json:"started_at"`
	UptimeSeconds          int64          `json:"uptime_seconds"`
	GoMemoryBytes          uint64         `json:"go_memory_bytes"`
	CgroupCPUUsagePercent  float64        `json:"cgroup_cpu_usage_percent,omitempty"`
	CgroupCPUUsageReady    bool           `json:"cgroup_cpu_usage_ready"`
	CgroupMemoryUsageBytes int64          `json:"cgroup_memory_usage_bytes,omitempty"`
	CgroupMemoryLimitBytes int64          `json:"cgroup_memory_limit_bytes,omitempty"`
	DataDirBytes           int64          `json:"data_dir_bytes,omitempty"`
	DataDirScanTruncated   bool           `json:"data_dir_scan_truncated,omitempty"`
	Details                map[string]any `json:"details,omitempty"`
}

type DetailsFunc func(ctx context.Context) map[string]any

const (
	MaxDataDirWalkEntries = 10000
	MaxCgroupValueBytes   = 4096
)

var cpuState = struct {
	sync.Mutex
	last cpuSample
}{}

type cpuSample struct {
	usage time.Duration
	at    time.Time
	seen  bool
}

func Handler(cfg config.AppConfig, role string, details DetailsFunc) http.HandlerFunc {
	return HandlerWithSecret(cfg, role, cfg.Internal.SharedSecret, details)
}

func HandlerWithSecret(cfg config.AppConfig, role string, internalSecret string, details DetailsFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			methodNotAllowed(w)
			return
		}
		if !validInternalRequest(internalSecret, r) {
			writeError(w, http.StatusForbidden, "Internal authentication failed.")
			return
		}
		var detailValues map[string]any
		if details != nil {
			detailValues = details(r.Context())
		}
		writeJSON(w, http.StatusOK, Collect(cfg, role, detailValues))
	}
}

func Collect(cfg config.AppConfig, role string, details map[string]any) Status {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	cpuPercent, cpuReady := cgroupCPUUsagePercent()
	usage, limit := cgroupMemory()
	dataDirSize, dataDirTruncated := directorySize(filepath.Dir(cfg.Database.Path))
	now := time.Now().UTC()
	return Status{
		Name:                   cfg.App.Name,
		Role:                   role,
		Version:                buildinfo.ProductVersion(),
		State:                  "running",
		Status:                 "Service telemetry endpoint responded.",
		StartedAt:              startedAt,
		UptimeSeconds:          int64(now.Sub(startedAt).Seconds()),
		GoMemoryBytes:          mem.Alloc,
		CgroupCPUUsagePercent:  cpuPercent,
		CgroupCPUUsageReady:    cpuReady,
		CgroupMemoryUsageBytes: usage,
		CgroupMemoryLimitBytes: limit,
		DataDirBytes:           dataDirSize,
		DataDirScanTruncated:   dataDirTruncated,
		Details:                details,
	}
}

func cgroupCPUUsagePercent() (float64, bool) {
	usage, ok := cgroupCPUUsage()
	if !ok {
		return 0, false
	}
	now := time.Now()
	cpuState.Lock()
	previous := cpuState.last
	cpuState.last = cpuSample{usage: usage, at: now, seen: true}
	cpuState.Unlock()
	if !previous.seen {
		return 0, false
	}
	usageDelta := usage - previous.usage
	wallDelta := now.Sub(previous.at)
	if usageDelta <= 0 || wallDelta <= 0 {
		return 0, false
	}
	return float64(usageDelta) / float64(wallDelta) * 100, true
}

func cgroupCPUUsage() (time.Duration, bool) {
	if value, ok := cgroupV2CPUUsage("/sys/fs/cgroup/cpu.stat"); ok {
		return value, true
	}
	value := readIntFile("/sys/fs/cgroup/cpuacct/cpuacct.usage")
	if value <= 0 {
		return 0, false
	}
	return time.Duration(value), true
}

func cgroupV2CPUUsage(path string) (time.Duration, bool) {
	data, err := readSmallTextFile(path, MaxCgroupValueBytes)
	if err != nil {
		return 0, false
	}
	for _, line := range strings.Split(data, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), " ")
		if !ok || key != "usage_usec" {
			continue
		}
		parsed, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
		if err != nil || parsed < 0 {
			return 0, false
		}
		return time.Duration(parsed) * time.Microsecond, true
	}
	return 0, false
}

func validInternalRequest(internalSecret string, r *http.Request) bool {
	expected := strings.TrimSpace(internalSecret)
	provided := strings.TrimSpace(r.Header.Get("X-ShellOrchestra-Internal-Secret"))
	if expected == "" || provided == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

func cgroupMemory() (int64, int64) {
	usage := readIntFile("/sys/fs/cgroup/memory.current")
	limit := readCgroupLimit("/sys/fs/cgroup/memory.max")
	if usage <= 0 {
		usage = readIntFile("/sys/fs/cgroup/memory/memory.usage_in_bytes")
	}
	if limit <= 0 {
		limit = readCgroupLimit("/sys/fs/cgroup/memory/memory.limit_in_bytes")
	}
	return usage, limit
}

func readIntFile(path string) int64 {
	data, err := readSmallTextFile(path, MaxCgroupValueBytes)
	if err != nil {
		return 0
	}
	value, err := strconv.ParseInt(strings.TrimSpace(data), 10, 64)
	if err != nil || value < 0 {
		return 0
	}
	return value
}

func readCgroupLimit(path string) int64 {
	data, err := readSmallTextFile(path, MaxCgroupValueBytes)
	if err != nil {
		return 0
	}
	value := strings.TrimSpace(data)
	if value == "" || value == "max" {
		return 0
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed < 0 {
		return 0
	}
	return parsed
}

func readSmallTextFile(path string, maxBytes int64) (string, error) {
	if maxBytes <= 0 {
		return "", fmt.Errorf("maxBytes must be positive")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return "", err
	}
	if int64(len(data)) > maxBytes {
		return "", fmt.Errorf("file exceeds %d bytes", maxBytes)
	}
	return string(data), nil
}

func directorySize(root string) (int64, bool) {
	if strings.TrimSpace(root) == "" {
		return 0, false
	}
	var total int64
	var entries int
	var truncated bool
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		entries++
		if entries > MaxDataDirWalkEntries {
			truncated = true
			return fs.SkipAll
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return nil
		}
		size := info.Size()
		if size > 0 {
			if total > math.MaxInt64-size {
				total = math.MaxInt64
				truncated = true
				return fs.SkipAll
			}
			total += size
		}
		return nil
	})
	return total, truncated
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func methodNotAllowed(w http.ResponseWriter) {
	writeError(w, http.StatusMethodNotAllowed, "Method not allowed.")
}
