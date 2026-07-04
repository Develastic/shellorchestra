#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
json_string() {
  printf '%s' "$1" | awk 'BEGIN { ORS = "" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "\\r"); printf "\"%s\"", $0 }'
}
json_number_or_null() {
  value=$(printf '%s' "$1" | tr -d '[:space:]')
  case "$value" in ''|null|*[!0123456789.-]*) printf 'null' ;; *) printf '%s' "$value" ;; esac
}
normalize_arch() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    x86_64|amd64) printf 'amd64' ;;
    arm64|aarch64) printf 'arm64' ;;
    *) printf '%s' "$1" ;;
  esac
}
filesystems_json() {
  df -P -k 2>/dev/null | awk '
    BEGIN { printf "["; count = 0 }
    NR == 1 { next }
    $1 ~ /^devfs$/ || $1 ~ /^map/ { next }
    {
      total = $2 * 1024; used = $3 * 1024; avail = $4 * 1024; mount = $6; pct = $5; gsub(/%/, "", pct)
      if (count > 0) printf ","
      printf "{\"filesystem\":\"%s\",\"mount\":\"%s\",\"total_bytes\":%.0f,\"used_bytes\":%.0f,\"available_bytes\":%.0f,\"use_percent\":%.1f}", $1, mount, total, used, avail, pct + 0
      count++
    }
    END { printf "]" }
  ' || printf '[]'
}
hostname_value=$(hostname 2>/dev/null || printf unknown)
username_value=$(id -un 2>/dev/null || whoami 2>/dev/null || printf unknown)
shell_value=${SHELL:-/bin/sh}
raw_arch=$(uname -m 2>/dev/null || printf unknown)
platform_arch=$(normalize_arch "$raw_arch")
kernel_value=$(uname -r 2>/dev/null || printf unknown)
distro_name=$(sw_vers -productName 2>/dev/null || printf macOS)
distro_version=$(sw_vers -productVersion 2>/dev/null || printf '')
boot_epoch=$(sysctl -n kern.boottime 2>/dev/null | awk -F'[ ,}]+' '{for (i=1;i<=NF;i++) if ($i=="sec") {print $(i+2); exit}}' || printf 0)
now_epoch=$(date +%s 2>/dev/null || printf 0)
uptime_sec=0
if [ "${boot_epoch:-0}" -gt 0 ] 2>/dev/null && [ "${now_epoch:-0}" -gt 0 ] 2>/dev/null; then uptime_sec=$((now_epoch - boot_epoch)); fi
cpu_logical_count=$(sysctl -n hw.logicalcpu 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || printf 0)
load_values=$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' | awk '{print $1, $2, $3}' || printf 'null null null')
set -- $load_values
load1=${1:-null}
load5=${2:-null}
load15=${3:-null}
cpu_usage_percent=$(ps -A -o %cpu= 2>/dev/null | awk -v cores="$cpu_logical_count" '{sum += $1} END {if (cores > 0) sum = sum / cores; if (sum < 0) sum = 0; if (sum > 100) sum = 100; printf "%.1f", sum}')
mem_total=$(sysctl -n hw.memsize 2>/dev/null || printf 0)
page_size=$(pagesize 2>/dev/null || sysctl -n hw.pagesize 2>/dev/null || printf 0)
mem_available=$(vm_stat 2>/dev/null | awk -v page_size="$page_size" '
  /Pages free/ {free=$3; gsub(/\./, "", free)}
  /Pages inactive/ {inactive=$3; gsub(/\./, "", inactive)}
  /Pages speculative/ {spec=$3; gsub(/\./, "", spec)}
  END {printf "%.0f", (free + inactive + spec) * page_size}
' || printf 0)
printf '{'
printf '"hostname":%s,' "$(json_string "$hostname_value")"
printf '"username":%s,' "$(json_string "$username_value")"
printf '"shell":%s,' "$(json_string "$shell_value")"
printf '"platform":%s,' "$(json_string "darwin $platform_arch")"
printf '"platform_os":"darwin","platform_arch":%s,' "$(json_string "$platform_arch")"
printf '"distro_name":%s,"distro_version":%s,' "$(json_string "$distro_name")" "$(json_string "$distro_version")"
printf '"kernel":%s,' "$(json_string "$kernel_value")"
printf '"uptime_sec":%s,' "$(json_number_or_null "$uptime_sec")"
printf '"cpu_usage_percent":%s,' "$(json_number_or_null "$cpu_usage_percent")"
printf '"cpu_logical_count":%s,"cpu_metric_source":"ps_cpu",' "$(json_number_or_null "$cpu_logical_count")"
printf '"load1":%s,"load5":%s,"load15":%s,' "$(json_number_or_null "$load1")" "$(json_number_or_null "$load5")" "$(json_number_or_null "$load15")"
printf '"mem_total_bytes":%s,"mem_available_bytes":%s,' "$(json_number_or_null "$mem_total")" "$(json_number_or_null "$mem_available")"
printf '"filesystems":%s' "$(filesystems_json)"
printf '}\n'
