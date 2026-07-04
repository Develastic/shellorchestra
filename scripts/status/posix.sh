#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu

json_string() {
  printf '%s' "$1" | awk 'BEGIN { ORS = "" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "\\r"); printf "\"%s\"", $0 }'
}

json_string_or_null() {
  value=$1
  if [ -z "$value" ] || [ "$value" = "null" ]; then
    printf 'null'
    return
  fi
  json_string "$value"
}

json_number_or_null() {
  value=$1
  case "$value" in
    ''|*[!0123456789.-]*) printf 'null' ;;
    *) printf '%s' "$value" ;;
  esac
}

trim_number() {
  value=$1
  case "$value" in
    ''|null|*[!0123456789.-]*) printf 'null'; return ;;
  esac
  awk -v value="$value" 'BEGIN {
    printf "%.1f", value + 0
  }'
}

json_filesystems() {
  if ! command -v df >/dev/null 2>&1; then
    printf '[]'
    return
  fi
  df -P -k 2>/dev/null | awk '
    function json_string(value, escaped) {
      escaped = value
      gsub(/\\/, "\\\\", escaped)
      gsub(/"/, "\\\"", escaped)
      gsub(/\t/, "\\t", escaped)
      gsub(/\r/, "\\r", escaped)
      return "\"" escaped "\""
    }
    function skip_filesystem(fs, mount) {
      if (fs ~ /^(tmpfs|devtmpfs|udev|proc|sysfs|devfs|fdesc|map|overlay)$/) return 1
      if (mount ~ /^\/(proc|sys|dev|run|var\/run)(\/|$)/) return 1
      return 0
    }
    NR == 1 { next }
    NF >= 6 {
      filesystem = $1
      total_kib = $2 + 0
      used_kib = $3 + 0
      available_kib = $4 + 0
      use_percent = $5
      gsub(/%/, "", use_percent)
      mount = $6
      if (skip_filesystem(filesystem, mount)) next
      total_bytes = total_kib * 1024
      used_bytes = used_kib * 1024
      available_bytes = available_kib * 1024
      if (total_bytes <= 0) next
      if (count > 0) printf ","
      printf "{"
      printf "\"filesystem\":%s,", json_string(filesystem)
      printf "\"mount\":%s,", json_string(mount)
      printf "\"total_bytes\":%.0f,", total_bytes
      printf "\"used_bytes\":%.0f,", used_bytes
      printf "\"available_bytes\":%.0f,", available_bytes
      printf "\"use_percent\":%.1f", use_percent + 0
      printf "}"
      count++
    }
    END {
      if (count == 0) {
        printf ""
      }
    }
  ' | awk 'BEGIN { printf "[" } { printf "%s", $0 } END { printf "]" }'
}

os_release_value() {
  key=$1
  [ -r /etc/os-release ] || return 0
  awk -F= -v wanted="$key" '
    $1 == wanted {
      value = $0
      sub(/^[^=]*=/, "", value)
      sub(/^"/, "", value)
      sub(/"$/, "", value)
      gsub(/\\"/, "\"", value)
      print value
      exit
    }
  ' /etc/os-release 2>/dev/null || true
}

normalize_arch() {
  case "$1" in
    x86_64|amd64) printf 'amd64' ;;
    aarch64|arm64) printf 'arm64' ;;
    armv7l|armv7*) printf 'armv7' ;;
    armv6l|armv6*) printf 'armv6' ;;
    i386|i486|i586|i686) printf '386' ;;
    ppc64le) printf 'ppc64le' ;;
    s390x) printf 's390x' ;;
    *) printf '%s' "$1" ;;
  esac
}

hostname_value=$(hostname 2>/dev/null || printf unknown)
username_value=$(id -un 2>/dev/null || whoami 2>/dev/null || printf unknown)
shell_value=${SHELL:-sh}
platform_os=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' || printf unknown)
raw_arch=$(uname -m 2>/dev/null || printf unknown)
platform_arch=$(normalize_arch "$raw_arch")
platform_value="$platform_os $platform_arch"
kernel_value=$(uname -r 2>/dev/null || printf unknown)

distro_name=
distro_version=
case "$platform_os" in
  linux)
    distro_name=$(os_release_value PRETTY_NAME)
    if [ -z "$distro_name" ]; then
      distro_name=$(os_release_value NAME)
    fi
    distro_version=$(os_release_value VERSION_ID)
    if [ -z "$distro_version" ]; then
      distro_version=$(os_release_value VERSION)
    fi
    ;;
  darwin)
    distro_name=$(sw_vers -productName 2>/dev/null || printf macOS)
    distro_version=$(sw_vers -productVersion 2>/dev/null || printf '')
    ;;
  freebsd)
    distro_name=FreeBSD
    distro_version=$(freebsd-version 2>/dev/null || printf '%s' "$kernel_value")
    ;;
  *)
    distro_name=$platform_os
    distro_version=$kernel_value
    ;;
esac
[ -n "$distro_name" ] || distro_name=unknown
[ -n "$distro_version" ] || distro_version=unknown

uptime_value=0
if [ -r /proc/uptime ]; then
  uptime_value=$(awk '{print int($1)}' /proc/uptime 2>/dev/null || printf 0)
elif command -v sysctl >/dev/null 2>&1; then
  boot_sec=$(sysctl -n kern.boottime 2>/dev/null | awk '
    {
      for (i = 1; i <= NF; i++) {
        if ($i == "sec" && $(i + 1) == "=") {
          value = $(i + 2)
          gsub(/,/, "", value)
          print value
          exit
        }
      }
    }
  ' | head -n 1)
  now_sec=$(date +%s 2>/dev/null || printf 0)
  if [ -n "$boot_sec" ] && [ "$now_sec" -gt "$boot_sec" ] 2>/dev/null; then
    uptime_value=$((now_sec - boot_sec))
  fi
fi

cpu_logical_count=0
if command -v getconf >/dev/null 2>&1; then
  cpu_logical_count=$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf 0)
elif command -v sysctl >/dev/null 2>&1; then
  cpu_logical_count=$(sysctl -n hw.logicalcpu 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || printf 0)
fi
case "$cpu_logical_count" in
  ''|*[!0123456789]*) cpu_logical_count=0 ;;
esac

cpu_usage_percent=null
cpu_metric_source=null
cpu_total_jiffies=null
cpu_idle_jiffies=null
if [ -r /proc/stat ]; then
  cpu_counters=$(awk '/^cpu / {
    idle = $5 + $6
    total = 0
    for (i = 2; i <= NF; i++) {
      total += $i
    }
    printf "%.0f %.0f", total, idle
    exit
  }' /proc/stat 2>/dev/null || true)
  if [ -n "$cpu_counters" ]; then
    set -- $cpu_counters
    cpu_total_jiffies=${1:-null}
    cpu_idle_jiffies=${2:-null}
    cpu_metric_source=proc_stat_delta
  fi
elif [ "$platform_os" = "darwin" ] && command -v top >/dev/null 2>&1; then
  cpu_usage_percent=$(top -l 2 -n 0 2>/dev/null | awk '
    /CPU usage:/ {
      gsub(/%|,/, "")
      user = 0
      sys = 0
      for (i = 1; i <= NF; i++) {
        if ($i == "user") user = $(i - 1)
        if ($i == "sys") sys = $(i - 1)
      }
      usage = user + sys
    }
    END {
      if (usage != "") {
        if (usage < 0) usage = 0
        if (usage > 100) usage = 100
        printf "%.1f", usage
      }
    }
  ' || true)
  [ -n "$cpu_usage_percent" ] && cpu_metric_source=top
fi
if [ "$platform_os" = "darwin" ] && { [ "$cpu_usage_percent" = "null" ] || [ -z "$cpu_usage_percent" ]; } && command -v ps >/dev/null 2>&1; then
  cpu_usage_percent=$(ps -A -o %cpu= 2>/dev/null | awk '
    NF {
      total += $1
    }
    END {
      if (total != "") {
        if (total < 0) total = 0
        if (total > 100) total = 100
        printf "%.1f", total
      }
    }
  ' || true)
  [ -n "$cpu_usage_percent" ] && cpu_metric_source=ps_cpu
fi

load1=null
load5=null
load15=null
if [ -r /proc/loadavg ]; then
  set -- $(cat /proc/loadavg)
  load1=$1
  load5=$2
  load15=$3
elif command -v sysctl >/dev/null 2>&1; then
  load_line=$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}')
  if [ -n "$load_line" ]; then
    set -- $load_line
    load1=${1:-null}
    load5=${2:-null}
    load15=${3:-null}
  fi
fi

mem_total=0
mem_available=0
if [ -r /proc/meminfo ]; then
  mem_total=$(awk '/^MemTotal:/ {printf "%.0f", $2 * 1024}' /proc/meminfo 2>/dev/null || printf 0)
  mem_available=$(awk '/^MemAvailable:/ {printf "%.0f", $2 * 1024}' /proc/meminfo 2>/dev/null || printf 0)
elif command -v sysctl >/dev/null 2>&1; then
  mem_total=$(sysctl -n hw.memsize 2>/dev/null || sysctl -n hw.physmem 2>/dev/null || printf 0)
  page_size=$(pagesize 2>/dev/null || sysctl -n hw.pagesize 2>/dev/null || printf 0)
  if command -v vm_stat >/dev/null 2>&1 && [ "$page_size" -gt 0 ] 2>/dev/null; then
    mem_available=$(vm_stat 2>/dev/null | awk -v page_size="$page_size" '
      /Pages free/ { free = $3 }
      /Pages inactive/ { inactive = $3 }
      /Pages speculative/ { speculative = $3 }
      END {
        gsub(/\./, "", free)
        gsub(/\./, "", inactive)
        gsub(/\./, "", speculative)
        printf "%.0f", (free + inactive + speculative) * page_size
      }
    ' || printf 0)
  elif command -v sysctl >/dev/null 2>&1 && [ "$page_size" -gt 0 ] 2>/dev/null; then
    free_pages=$(sysctl -n vm.stats.vm.v_free_count 2>/dev/null || printf 0)
    inactive_pages=$(sysctl -n vm.stats.vm.v_inactive_count 2>/dev/null || printf 0)
    mem_available=$(((free_pages + inactive_pages) * page_size))
  fi
fi

printf '{'
printf '"hostname":%s,' "$(json_string "$hostname_value")"
printf '"username":%s,' "$(json_string "$username_value")"
printf '"shell":%s,' "$(json_string "$shell_value")"
printf '"platform":%s,' "$(json_string "$platform_value")"
printf '"platform_os":%s,' "$(json_string "$platform_os")"
printf '"platform_arch":%s,' "$(json_string "$platform_arch")"
printf '"distro_name":%s,' "$(json_string "$distro_name")"
printf '"distro_version":%s,' "$(json_string "$distro_version")"
printf '"kernel":%s,' "$(json_string "$kernel_value")"
printf '"uptime_sec":%s,' "$(json_number_or_null "$uptime_value")"
printf '"cpu_usage_percent":%s,' "$(json_number_or_null "$(trim_number "$cpu_usage_percent")")"
printf '"cpu_logical_count":%s,' "$(json_number_or_null "$cpu_logical_count")"
printf '"cpu_metric_source":%s,' "$(json_string_or_null "$cpu_metric_source")"
printf '"cpu_total_jiffies":%s,' "$(json_number_or_null "$cpu_total_jiffies")"
printf '"cpu_idle_jiffies":%s,' "$(json_number_or_null "$cpu_idle_jiffies")"
printf '"load1":%s,"load5":%s,"load15":%s,' "$(json_number_or_null "$load1")" "$(json_number_or_null "$load5")" "$(json_number_or_null "$load15")"
printf '"mem_total_bytes":%s,"mem_available_bytes":%s,' "$(json_number_or_null "$mem_total")" "$(json_number_or_null "$mem_available")"
printf '"filesystems":%s' "$(json_filesystems)"
printf '}\n'
