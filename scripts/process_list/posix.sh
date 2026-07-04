#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu

json_string() {
  awk 'BEGIN {
    value = ARGV[1]
    ARGV[1] = ""
    gsub(/\\/, "\\\\", value)
    gsub(/"/, "\\\"", value)
    gsub(/\t/, "\\t", value)
    gsub(/\r/, "\\r", value)
    gsub(/\n/, "\\n", value)
    printf "\"%s\"", value
  }' "$1"
}

limit=${SHELLORCHESTRA_PROCESS_LIMIT:-40}
case "$limit" in
  ''|*[!0123456789]*) limit=40 ;;
esac
[ "$limit" -lt 1 ] 2>/dev/null && limit=1
[ "$limit" -gt 200 ] 2>/dev/null && limit=200

output_encoding=${SHELLORCHESTRA_PROCESS_OUTPUT_ENCODING:-}
stream_format=${SHELLORCHESTRA_PROCESS_STREAM_FORMAT:-json}
case "$output_encoding" in ''|'auto'|'zstd'|'gzip') ;; *) echo "Unsupported ShellOrchestra process output encoding: $output_encoding" >&2; exit 64 ;; esac
case "$stream_format" in ''|'json') stream_format=json ;; 'row_events') ;; *) echo "Unsupported ShellOrchestra process stream format: $stream_format" >&2; exit 64 ;; esac

platform=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' || printf unknown)
generated_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || printf '')

json_number_or_null() {
  case "${1:-}" in
    ''|*[!0123456789]*) printf 'null' ;;
    *) printf '%s' "$1" ;;
  esac
}

proc_io_value() {
  pid=$1
  key=$2
  awk -v key="$key" '$1 == key ":" {print $2; found=1; exit} END {if (!found) print ""}' "/proc/$pid/io" 2>/dev/null || printf ''
}

proc_socket_count() {
  pid=$1
  if ! ls "/proc/$pid/fd" >/dev/null 2>&1; then
    printf ''
    return
  fi
  total=0
  for fd in "/proc/$pid/fd"/*; do
    [ -e "$fd" ] || continue
    link=$(readlink "$fd" 2>/dev/null || true)
    case "$link" in
      socket:\[*\]) total=$((total + 1)) ;;
    esac
  done
  printf '%s' "$total"
}

emit_linux_ps_rows() {
  rows=$(ps -eo pid=,user=,pcpu=,rss=,stat=,comm= --sort=-pcpu 2>/dev/null || ps -eo pid=,user=,pcpu=,rss=,stat=,comm= 2>/dev/null || true)
  [ -n "$rows" ] || return 1
  count=0
  printf '%s\n' "$rows" | while read -r pid user cpu rss state command rest; do
    [ -n "${pid:-}" ] || continue
    case "$pid" in *[!0123456789]*) continue ;; esac
    [ "$count" -lt "$limit" ] || break
    disk_read=$(proc_io_value "$pid" read_bytes)
    disk_write=$(proc_io_value "$pid" write_bytes)
    sockets=$(proc_socket_count "$pid")
    object=$(printf '{"pid":%s,"user":%s,"cpu_percent":%.1f,"memory_bytes":%.0f,"disk_read_bytes":%s,"disk_write_bytes":%s,"network_connections":%s,"state":%s,"command":%s}' \
      "$pid" \
      "$(json_string "${user:-}")" \
      "${cpu:-0}" \
      "$((${rss:-0} * 1024))" \
      "$(json_number_or_null "$disk_read")" \
      "$(json_number_or_null "$disk_write")" \
      "$(json_number_or_null "$sockets")" \
      "$(json_string "${state:-}")" \
      "$(json_string "${command:-}")")
    if [ "$stream_format" = "row_events" ]; then
      printf '{"event":"row","data":%s}\n' "$object"
    else
      [ "$count" -eq 0 ] || printf ','
      printf '%s' "$object"
    fi
    count=$((count + 1))
  done
}

compress_json_stream() {
  case "$output_encoding" in
    '')
      cat
      ;;
    'auto')
      if command -v zstd >/dev/null 2>&1; then
        zstd -1 -q -c
      elif command -v gzip >/dev/null 2>&1; then
        gzip -1 -c
      else
        echo "zstd or gzip is required for compressed ShellOrchestra process data on this server." >&2
        exit 127
      fi
      ;;
    'zstd')
      if ! command -v zstd >/dev/null 2>&1; then
        echo "zstd is required for zstd-compressed ShellOrchestra process data on this server." >&2
        exit 127
      fi
      zstd -1 -q -c
      ;;
    'gzip')
      if ! command -v gzip >/dev/null 2>&1; then
        echo "gzip is required for gzip-compressed ShellOrchestra process data on this server." >&2
        exit 127
      fi
      gzip -1 -c
      ;;
  esac
}

emit_ps_rows() {
  awk -v limit="$limit" -v stream_format="$stream_format" '
    function json_string(value, escaped) {
      escaped = value
      gsub(/\\/, "\\\\", escaped)
      gsub(/"/, "\\\"", escaped)
      gsub(/\t/, "\\t", escaped)
      gsub(/\r/, "\\r", escaped)
      gsub(/\n/, "\\n", escaped)
      return "\"" escaped "\""
    }
    function emit_object(object) {
      if (stream_format == "row_events") {
        printf "{\"event\":\"row\",\"data\":%s}\n", object
      } else {
        if (count > 0) printf ","
        printf "%s", object
      }
      count++
    }
    NF >= 6 && count < limit {
      pid=$1 + 0
      user=$2
      cpu=$3 + 0
      rss=$4 + 0
      state=$5
      command=$6
      for (i=7; i<=NF; i++) command = command " " $i
      object = sprintf("{\"pid\":%d,\"user\":%s,\"cpu_percent\":%.1f,\"memory_bytes\":%.0f,\"disk_read_bytes\":null,\"disk_write_bytes\":null,\"network_connections\":null,\"state\":%s,\"command\":%s}", pid, json_string(user), cpu, rss * 1024, json_string(state), json_string(command))
      emit_object(object)
    }
  '
}

emit_proc_rows() {
  for pid_dir in /proc/[0-9]*; do
    [ -d "$pid_dir" ] || continue
    pid=${pid_dir##*/}
    uid=$(awk '/^Uid:/ {print $2; exit}' "$pid_dir/status" 2>/dev/null || printf '0')
    rss=$(awk '/^VmRSS:/ {print $2; exit}' "$pid_dir/status" 2>/dev/null || printf '0')
    state=$(awk '/^State:/ {print $2; exit}' "$pid_dir/status" 2>/dev/null || printf '?')
    command=$(cat "$pid_dir/comm" 2>/dev/null || printf unknown)
    command="[$command]"
    printf '%s\t%s\t%s\t%s\t%s\n' "$pid" "$uid" "${rss:-0}" "${state:-?}" "$command"
  done | awk -F '\t' -v limit="$limit" -v stream_format="$stream_format" '
    function json_string(value, escaped) {
      escaped = value
      gsub(/\\/, "\\\\", escaped)
      gsub(/"/, "\\\"", escaped)
      gsub(/\t/, "\\t", escaped)
      gsub(/\r/, "\\r", escaped)
      gsub(/\n/, "\\n", escaped)
      return "\"" escaped "\""
    }
    function emit_object(object) {
      if (stream_format == "row_events") {
        printf "{\"event\":\"row\",\"data\":%s}\n", object
      } else {
        if (count > 0) printf ","
        printf "%s", object
      }
      count++
    }
    NF >= 5 && count < limit {
      object = sprintf("{\"pid\":%d,\"user\":%s,\"cpu_percent\":null,\"memory_bytes\":%.0f,\"disk_read_bytes\":null,\"disk_write_bytes\":null,\"network_connections\":null,\"state\":%s,\"command\":%s}", $1 + 0, json_string($2), ($3 + 0) * 1024, json_string($4), json_string($5))
      emit_object(object)
    }
  '
}

generate_processes() {
  if [ "$platform" = "darwin" ] || [ "$platform" = "freebsd" ]; then
    ps -Ao pid=,user=,pcpu=,rss=,state=,comm= 2>/dev/null | sort -k3 -nr | emit_ps_rows
    return
  fi

  if [ "$platform" = "linux" ]; then
    rows=$(emit_linux_ps_rows || true)
    if [ -n "$rows" ]; then
      printf '%s' "$rows"
      return
    fi
  fi

  rows=$( (ps -eo pid=,user=,pcpu=,rss=,stat=,comm= --sort=-pcpu 2>/dev/null || ps -eo pid=,user=,pcpu=,rss=,stat=,comm= 2>/dev/null || true) | emit_ps_rows )
  if [ -n "$rows" ]; then
    printf '%s' "$rows"
    return
  fi

  emit_proc_rows
}

emit_payload() {
  if [ "$stream_format" = "row_events" ]; then
    printf '{"event":"meta","data":{"generated_at":'
    json_string "$generated_at"
    printf ',"platform":'
    json_string "$platform"
    printf ',"source":"ps"}}\n'
    generate_processes
    printf '\n{"event":"done","data":{"generated_at":'
    json_string "$generated_at"
    printf ',"platform":'
    json_string "$platform"
    printf ',"source":"ps"}}\n'
    return
  fi

  printf '{'
  printf '"generated_at":'
  json_string "$generated_at"
  printf ',"platform":'
  json_string "$platform"
  printf ',"source":"ps",'
  printf '"processes":['
  generate_processes
  printf ']}'
  printf '\n'
}

emit_payload | compress_json_stream
