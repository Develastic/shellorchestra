#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
export LC_ALL=C

json_string() {
  awk 'BEGIN { value=ARGV[1]; ARGV[1]=""; gsub(/\\/,"\\\\",value); gsub(/"/,"\\\"",value); gsub(/\t/,"\\t",value); gsub(/\r/,"\\r",value); gsub(/\n/,"\\n",value); printf "\"%s\"", value }' "$1"
}

limit=${SHELLORCHESTRA_LOGS_LIMIT:-200}
output_encoding=${SHELLORCHESTRA_LOGS_OUTPUT_ENCODING:-}
stream_format=${SHELLORCHESTRA_LOGS_STREAM_FORMAT:-json}
case "$output_encoding" in ''|'auto'|'zstd'|'gzip') ;; *) echo "Unsupported ShellOrchestra logs output encoding: $output_encoding" >&2; exit 64 ;; esac
case "$stream_format" in ''|'json') stream_format=json ;; 'row_events') ;; *) echo "Unsupported ShellOrchestra logs stream format: $stream_format" >&2; exit 64 ;; esac
case "$limit" in ''|*[!0123456789]*) limit=200 ;; esac
[ "$limit" -lt 1 ] 2>/dev/null && limit=1
[ "$limit" -gt 5000 ] 2>/dev/null && limit=5000
live_limit=${SHELLORCHESTRA_LOGS_LIVE_LIMIT:-5000}
case "$live_limit" in ''|*[!0123456789]*) live_limit=5000 ;; esac
[ "$live_limit" -lt 1 ] 2>/dev/null && live_limit=1
[ "$live_limit" -gt 20000 ] 2>/dev/null && live_limit=20000
live_max_bytes=${SHELLORCHESTRA_LOGS_LIVE_MAX_BYTES:-1048576}
case "$live_max_bytes" in ''|*[!0123456789]*) live_max_bytes=1048576 ;; esac
[ "$live_max_bytes" -lt 4096 ] 2>/dev/null && live_max_bytes=4096
[ "$live_max_bytes" -gt 16777216 ] 2>/dev/null && live_max_bytes=16777216
follow=${SHELLORCHESTRA_LOGS_FOLLOW:-0}
case "$follow" in 1|true|yes) follow=1 ;; *) follow=0 ;; esac
cursor=${SHELLORCHESTRA_LOGS_CURSOR:-}
case "$cursor" in *[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:=\;,@+-]*) cursor= ;; esac
query=${SHELLORCHESTRA_LOGS_QUERY:-}
unit=${SHELLORCHESTRA_LOGS_UNIT:-}
priority=${SHELLORCHESTRA_LOGS_PRIORITY:-}
since=${SHELLORCHESTRA_LOGS_SINCE:-}
until=${SHELLORCHESTRA_LOGS_UNTIL:-}
log_path=${SHELLORCHESTRA_LOGS_PATH:-}
log_source=${SHELLORCHESTRA_LOGS_SOURCE:-}
container_id=${SHELLORCHESTRA_LOGS_CONTAINER_ID:-}
container_engine=${SHELLORCHESTRA_LOGS_CONTAINER_ENGINE:-auto}
case "$log_source" in ''|'file'|'system'|'container') ;; *) echo "Unsupported ShellOrchestra log source: $log_source" >&2; exit 64 ;; esac

safe_unit_name() {
  case "$1" in
    ''|*[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@_.:-]*) return 1 ;;
    *) return 0 ;;
  esac
}

safe_priority() {
  case "$1" in ''|emerg|alert|crit|err|warning|notice|info|debug|0|1|2|3|4|5|6|7) return 0 ;; *) return 1 ;; esac
}

safe_time_filter() {
  cleaned=$(printf '%s' "$1" | tr -d '[:alnum:]:+_.,/ -')
  [ -z "$cleaned" ]
}

if ! safe_time_filter "$since"; then echo "Unsupported log since filter." >&2; exit 1; fi
if ! safe_time_filter "$until"; then echo "Unsupported log until filter." >&2; exit 1; fi

generated_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || printf '')
os_name=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' || printf unknown)
source=none
format=unknown
raw_file=$(mktemp)
scan_file=$(mktemp)
complete_file=$(mktemp)
chunk_file=$(mktemp)
trap 'rm -f "$raw_file" "$scan_file" "$complete_file" "$chunk_file"' EXIT HUP INT TERM
: > "$raw_file"
: > "$scan_file"
: > "$complete_file"
next_cursor=""
follow_mode=false
follow_reset=false
follow_partial=false
follow_scanned_bytes=0

compress_logs_json_stream() {
  case "$output_encoding" in
    '')
      cat
      ;;
    'auto')
      if command -v zstd >/dev/null 2>&1; then
        zstd -3 -q -c
      elif command -v gzip >/dev/null 2>&1; then
        gzip -1 -c
      else
        echo "zstd or gzip is required for compressed ShellOrchestra log data on this server." >&2
        exit 127
      fi
      ;;
    'zstd')
      if ! command -v zstd >/dev/null 2>&1; then
        echo "zstd is required for zstd-compressed ShellOrchestra log data on this server." >&2
        exit 127
      fi
      zstd -3 -q -c
      ;;
    'gzip')
      if ! command -v gzip >/dev/null 2>&1; then
        echo "gzip is required for gzip-compressed ShellOrchestra log data on this server." >&2
        exit 127
      fi
      gzip -1 -c
      ;;
  esac
}

safe_log_path() {
  case "$1" in
    /*) return 0 ;;
    [ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz]:/*|[ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz]:\\*) return 0 ;;
    *) return 1 ;;
  esac
}

safe_container_id() {
  case "$1" in
    ''|*[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:-]*) return 1 ;;
    *) return 0 ;;
  esac
}

resolve_container_engine() {
  if [ "$container_engine" = auto ] || [ -z "$container_engine" ]; then
    if command -v docker >/dev/null 2>&1; then container_engine=docker
    elif command -v podman >/dev/null 2>&1; then container_engine=podman
    else echo "Docker or Podman is required for container logs." >&2; exit 127
    fi
  fi
  case "$container_engine" in docker|podman) ;; *) echo "Unsupported container engine: $container_engine" >&2; exit 64 ;; esac
}

run_container_engine() {
  if "$container_engine" info >/dev/null 2>&1; then
    "$container_engine" "$@"
    return
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n "$container_engine" info >/dev/null 2>&1; then
    sudo -n "$container_engine" "$@"
    return
  fi
  if command -v doas >/dev/null 2>&1 && doas -n "$container_engine" info >/dev/null 2>&1; then
    doas -n "$container_engine" "$@"
    return
  fi
  echo "$container_engine is installed, but ShellOrchestra cannot access it with this SSH user." >&2
  exit 1
}

stat_log_file() {
  if stat -c '%i|%s|%Y' "$log_path" 2>/dev/null; then
    return
  fi
  if stat -f '%i|%z|%m' "$log_path" 2>/dev/null; then
    return
  fi
  printf '0|0|0\n'
}

read_tail_log_file() {
  if [ -r "$log_path" ]; then
    if [ -n "$query" ]; then
      grep -a -i -F -- "$query" "$log_path" 2>/dev/null | tail -n "$limit" > "$raw_file" || true
    else
      tail -n "$limit" "$log_path" > "$raw_file" 2>/dev/null || true
    fi
    return
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n test -r "$log_path" 2>/dev/null; then
    if [ -n "$query" ]; then
      sudo -n grep -a -i -F -- "$query" "$log_path" 2>/dev/null | tail -n "$limit" > "$raw_file" || true
    else
      sudo -n tail -n "$limit" "$log_path" > "$raw_file" 2>/dev/null || true
    fi
    return
  fi
  echo "ShellOrchestra cannot read this log file with the managed SSH account." >&2
  exit 1
}

read_log_bytes_from_offset() {
  offset=$1
  bytes=$2
  start=$((offset + 1))
  if [ -r "$log_path" ]; then
    tail -c +"$start" "$log_path" 2>/dev/null | head -c "$bytes" > "$scan_file" || true
    return
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n test -r "$log_path" 2>/dev/null; then
    sudo -n tail -c +"$start" "$log_path" 2>/dev/null | head -c "$bytes" > "$scan_file" || true
    return
  fi
  echo "ShellOrchestra cannot read this log file with the managed SSH account." >&2
  exit 1
}

cap_follow_chunk_to_live_limit() {
  # Keep cursor progress tied to the physical bytes represented by this response.
  # A row limit is a per-response chunk size, not permission to skip unseen rows.
  follow_scanned_bytes=$(wc -c < "$scan_file" | tr -d ' ')
  line_count=$(wc -l < "$scan_file" | tr -d ' ')
  case "$line_count" in ''|*[!0123456789]*) line_count=0 ;; esac
  if [ "$line_count" -gt "$live_limit" ] 2>/dev/null; then
    follow_partial=true
    awk -v limit="$live_limit" 'NR <= limit { print }' "$scan_file" > "$chunk_file" || : > "$chunk_file"
    cat "$chunk_file" > "$scan_file"
    follow_scanned_bytes=$(wc -c < "$scan_file" | tr -d ' ')
  fi
}

read_log_file() {
  state=$(stat_log_file)
  inode=${state%%|*}
  rest=${state#*|}
  size=${rest%%|*}
  mtime=${rest#*|}
  case "$size" in ''|*[!0123456789]*) size=0 ;; esac
  if [ "$follow" = 1 ] && [ -n "$cursor" ]; then
    old_cursor=$cursor
    if [ "${old_cursor#file:}" != "$old_cursor" ]; then
      old_cursor=${old_cursor#file:}
      cursor_inode=${old_cursor%%:*}
      old_cursor=${old_cursor#*:}
      cursor_size=${old_cursor%%:*}
      case "$cursor_size" in ''|*[!0123456789]*) cursor_size= ;; esac
      if [ -n "$cursor_size" ] && [ "$cursor_inode" = "$inode" ] && [ "$size" -ge "$cursor_size" ] 2>/dev/null; then
        follow_mode=true
        delta=$((size - cursor_size))
        if [ "$delta" -gt 0 ]; then
          bytes_to_read=$delta
          if [ "$bytes_to_read" -gt "$live_max_bytes" ]; then
            bytes_to_read=$live_max_bytes
            follow_partial=true
          fi
          read_log_bytes_from_offset "$cursor_size" "$bytes_to_read"
          follow_scanned_bytes=$(wc -c < "$scan_file" | tr -d ' ')
          if [ "$follow_partial" = true ] && [ "${follow_scanned_bytes:-0}" -gt 0 ]; then
            last_byte_hex=$(tail -c 1 "$scan_file" 2>/dev/null | od -An -tx1 | tr -d ' \n' || true)
            if [ "$last_byte_hex" != "0a" ]; then
              sed '$d' "$scan_file" > "$complete_file" 2>/dev/null || : > "$complete_file"
              complete_bytes=$(wc -c < "$complete_file" | tr -d ' ')
              if [ "${complete_bytes:-0}" -gt 0 ]; then
                cat "$complete_file" > "$scan_file"
                follow_scanned_bytes=$complete_bytes
              fi
            fi
          fi
          cap_follow_chunk_to_live_limit
          if [ -n "$query" ]; then
            grep -a -i -F -- "$query" "$scan_file" 2>/dev/null > "$raw_file" || true
          else
            cat "$scan_file" > "$raw_file" 2>/dev/null || true
          fi
          next_size=$((cursor_size + follow_scanned_bytes))
        else
          : > "$raw_file"
          next_size=$cursor_size
        fi
        next_cursor="file:$inode:$next_size:$mtime"
        return
      fi
    fi
    follow_reset=true
  fi
  read_tail_log_file
  next_cursor="file:$inode:$size:$mtime"
}

read_container_logs() {
  if ! safe_container_id "$container_id"; then
    echo "A safe container id or name is required." >&2
    exit 1
  fi
  resolve_container_engine
  run_container_engine inspect "$container_id" >/dev/null
  source=container
  format=container-stdout
  unit=$container_id
  log_path=""
  since_cursor=""
  if [ "$follow" = 1 ] && [ -n "$cursor" ]; then
    if [ "${cursor#container:}" != "$cursor" ]; then
      since_cursor=${cursor#container:}
      case "$since_cursor" in
        ''|*[!0123456789TtZz:.,+-]*) since_cursor="" ;;
        *) follow_mode=true ;;
      esac
    else
      follow_reset=true
    fi
  fi
  if [ "$follow_mode" = true ] && [ -n "$since_cursor" ]; then
    run_container_engine logs --timestamps --since "$since_cursor" "$container_id" > "$scan_file" 2>"$complete_file" || {
      cat "$complete_file" >&2
      exit 1
    }
    awk -v since="$since_cursor" '{
      timestamp=$1
      if (timestamp > since) print
    }' "$scan_file" > "$chunk_file" || : > "$chunk_file"
    cat "$chunk_file" > "$scan_file"
  else
    if [ "$follow" = 1 ] && [ -n "$cursor" ]; then follow_reset=true; fi
    run_container_engine logs --timestamps --tail "$limit" "$container_id" > "$scan_file" 2>"$complete_file" || {
      cat "$complete_file" >&2
      exit 1
    }
  fi
  line_count=$(wc -l < "$scan_file" | tr -d ' ')
  case "$line_count" in ''|*[!0123456789]*) line_count=0 ;; esac
  max_lines=$limit
  if [ "$follow_mode" = true ]; then max_lines=$live_limit; fi
  if [ "$line_count" -gt "$max_lines" ] 2>/dev/null; then
    follow_partial=true
    awk -v limit="$max_lines" 'NR <= limit { print }' "$scan_file" > "$chunk_file" || : > "$chunk_file"
    cat "$chunk_file" > "$scan_file"
  fi
  if [ -n "$query" ]; then
    grep -a -i -F -- "$query" "$scan_file" 2>/dev/null > "$raw_file" || true
  else
    cat "$scan_file" > "$raw_file" 2>/dev/null || true
  fi
  follow_scanned_bytes=$(wc -c < "$raw_file" | tr -d ' ')
  last_timestamp=$(awk '/^[0-9][0-9][0-9][0-9]-/ { value=$1 } END { print value }' "$scan_file" 2>/dev/null || true)
  case "$last_timestamp" in
    ''|*[!0123456789TtZz:.,+-]*) next_cursor="$cursor" ;;
    *) next_cursor="container:$last_timestamp" ;;
  esac
}

if [ "$log_source" = "container" ]; then
  read_container_logs
elif [ -n "$log_path" ]; then
  if ! safe_log_path "$log_path"; then
    echo "A full remote log file path is required." >&2
    exit 1
  fi
  source=file
  case "$log_path" in
    *.jsonl|*.ndjson) format=jsonl ;;
    *access*.log|*access_log*) format=access ;;
    *syslog*|*auth.log*|*/messages) format=syslog ;;
    *.log|*.log.*) format=log ;;
    *) format=text ;;
  esac
  read_log_file
elif command -v journalctl >/dev/null 2>&1; then
  source=journalctl
  format=journal
  if [ "$follow" = 1 ] && [ -n "$cursor" ] && [ "${cursor#journal:}" != "$cursor" ]; then
    journal_cursor=${cursor#journal:}
    follow_mode=true
    set -- journalctl --no-pager --after-cursor "$journal_cursor" --show-cursor -o short-iso
  else
    if [ "$follow" = 1 ] && [ -n "$cursor" ]; then follow_reset=true; fi
    set -- journalctl --no-pager -n "$limit" --show-cursor -o short-iso
  fi
  if [ -n "$unit" ]; then
    if ! safe_unit_name "$unit"; then echo "A safe systemd unit name is required for log filtering." >&2; exit 1; fi
    set -- "$@" -u "$unit"
  fi
  if [ -n "$priority" ]; then
    if ! safe_priority "$priority"; then echo "Unsupported journal priority filter: $priority" >&2; exit 1; fi
    set -- "$@" -p "$priority"
  fi
  [ -n "$since" ] && set -- "$@" --since "$since"
  [ -n "$until" ] && set -- "$@" --until "$until"
  "$@" > "$raw_file" 2>/dev/null || true
  journal_cursor_line=$(grep '^-- cursor: ' "$raw_file" 2>/dev/null | tail -n 1 || true)
  if [ -n "$journal_cursor_line" ]; then
    next_cursor="journal:${journal_cursor_line#-- cursor: }"
    grep -v '^-- cursor: ' "$raw_file" > "$scan_file" || true
    cat "$scan_file" > "$raw_file"
  fi
  follow_scanned_bytes=$(wc -c < "$raw_file" | tr -d ' ')
elif command -v log >/dev/null 2>&1 && [ "$os_name" = "darwin" ]; then
  source=macos-log
  format=macos
  log show --style compact --last 1h --info --debug 2>/dev/null | tail -n "$limit" > "$raw_file" || true
elif [ -r /var/log/syslog ]; then
  source=syslog
  format=syslog
  tail -n "$limit" /var/log/syslog > "$raw_file" || true
elif [ -r /var/log/messages ]; then
  source=messages
  format=syslog
  tail -n "$limit" /var/log/messages > "$raw_file" || true
fi

output_limit=$limit
if [ "$follow_mode" = true ]; then output_limit=$live_limit; fi

emit_logs_event() {
  kind=$1
  printf '{"event":'
  json_string "$kind"
  printf ',"data":{"generated_at":"%s","platform":' "$generated_at"
  json_string "$os_name"
  printf ',"source":'
  json_string "$source"
  printf ',"path":'
  json_string "$log_path"
  printf ',"format":'
  json_string "$format"
  printf ',"query":'
  json_string "$query"
  printf ',"unit":'
  json_string "$unit"
  printf ',"priority":'
  json_string "$priority"
  printf ',"since":'
  json_string "$since"
  printf ',"until":'
  json_string "$until"
  printf ',"cursor":'
  json_string "$next_cursor"
  printf ',"follow":%s,"follow_reset":%s,"follow_partial":%s,"scanned_bytes":%s' "$follow_mode" "$follow_reset" "$follow_partial" "$follow_scanned_bytes"
  printf '}}\n'
}

emit_log_entries() {
  entry_format=$1
  awk -v query="$query" -v limit="$output_limit" -v wanted_priority="$priority" -v since="$since" -v until="$until" -v stream_format="$entry_format" -v entry_source="$source" -v unit_filter="$unit" '
    function js(value, escaped){ escaped=value; gsub(/\\/,"\\\\",escaped); gsub(/"/,"\\\"",escaped); gsub(/\t/,"\\t",escaped); gsub(/\r/,"\\r",escaped); gsub(/\n/,"\\n",escaped); return "\"" escaped "\"" }
    function lower(value) { return tolower(value) }
    function norm_time(value, out) { out=value; gsub(/T/, " ", out); gsub(/\.[0-9]+Z$/, "Z", out); gsub(/Z$/, "", out); return out }
    function time_match(value, s, u, nv, ns, nu) {
      if (value == "" || value !~ /^[0-9][0-9][0-9][0-9]-/) return 1
      nv=norm_time(value); ns=norm_time(s); nu=norm_time(u)
      if (ns != "" && nv < ns) return 0
      if (nu != "" && nv > nu) return 0
      return 1
    }
    function priority_match(value, wanted, lv, w) {
      if (wanted == "") return 1
      lv=lower(value); w=lower(wanted)
      if (w == "warning") w="warn"
      if (w == "err") w="error"
      return index(lv, w) > 0
    }
    count < limit {
      line=$0
      if (query != "" && index(lower(line), lower(query)) == 0) next
      timestamp=""; host=""; service=""; priority=""
      if (entry_source == "container" && line ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ][0-9]/) {
        timestamp=$1; service=unit_filter
      } else if (line ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ][0-9]/) {
        timestamp=$1; host=$2; service=$3; sub(/:$/, "", service)
        if ($2 ~ /^(EMERG|ALERT|CRIT|FATAL|ERROR|ERR|WARN|WARNING|NOTICE|INFO|DEBUG|TRACE)$/) {
          priority=$2; service=$3; sub(/:$/, "", service)
        }
      } else if (match(line, /\[[0-9][0-9]\/[A-Za-z][A-Za-z][A-Za-z]\/[0-9][0-9][0-9][0-9]:[0-9][0-9]:[0-9][0-9]:[0-9][0-9] [+-][0-9][0-9][0-9][0-9]\]/)) {
        timestamp=substr(line, RSTART + 1, RLENGTH - 2); host=$1; service="access"
      } else if (line ~ /^[A-Z][a-z][a-z][ ][ 0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]/) {
        timestamp=$1 " " $2 " " $3; host=$4; service=$5; sub(/\[[0-9]+\]:$/, "", service); sub(/:$/, "", service)
      } else if (line ~ /^\{/) {
        if (match(line, /"(ts|time|timestamp)"[[:space:]]*:[[:space:]]*"[^"]+"/)) { timestamp=substr(line, RSTART, RLENGTH); sub(/^"[^"]+"[[:space:]]*:[[:space:]]*"/, "", timestamp); sub(/"$/, "", timestamp) }
        if (match(line, /"(level|severity|priority)"[[:space:]]*:[[:space:]]*"[^"]+"/)) { priority=substr(line, RSTART, RLENGTH); sub(/^"[^"]+"[[:space:]]*:[[:space:]]*"/, "", priority); sub(/"$/, "", priority) }
        if (match(line, /"(service|logger|component|unit)"[[:space:]]*:[[:space:]]*"[^"]+"/)) { service=substr(line, RSTART, RLENGTH); sub(/^"[^"]+"[[:space:]]*:[[:space:]]*"/, "", service); sub(/"$/, "", service) }
      }
      if (priority == "" && match(line, /(EMERG|ALERT|CRIT|FATAL|ERROR|ERR|WARN|WARNING|NOTICE|INFO|DEBUG|TRACE)/)) {
        priority=substr(line, RSTART, RLENGTH)
      }
      if (!time_match(timestamp, since, until)) next
      if (!priority_match(priority " " line, wanted_priority)) next
      object=sprintf("{\"timestamp\":%s,\"host\":%s,\"unit\":%s,\"priority\":%s,\"message\":%s}", js(timestamp), js(host), js(service), js(priority), js(line))
      if (stream_format == "row_events") {
        printf "{\"event\":\"row\",\"data\":%s}\n", object
      } else {
        if (count > 0) printf ","
        printf "%s", object
      }
      count++
    }
  ' "$raw_file"
}

emit_logs_json() {
  printf '{"generated_at":"%s","platform":' "$generated_at"
  json_string "$os_name"
  printf ',"source":'
  json_string "$source"
  printf ',"path":'
  json_string "$log_path"
  printf ',"format":'
  json_string "$format"
  printf ',"query":'
  json_string "$query"
  printf ',"unit":'
  json_string "$unit"
  printf ',"priority":'
  json_string "$priority"
  printf ',"since":'
  json_string "$since"
  printf ',"until":'
  json_string "$until"
  printf ',"cursor":'
  json_string "$next_cursor"
  printf ',"follow":%s,"follow_reset":%s,"follow_partial":%s,"scanned_bytes":%s' "$follow_mode" "$follow_reset" "$follow_partial" "$follow_scanned_bytes"
  printf ',"entries":['
  emit_log_entries json
  printf '],"raw_text":'
  json_string "$(cat "$raw_file")"
  printf '}\n'
}

emit_logs_events() {
  emit_logs_event meta
  emit_log_entries row_events
  emit_logs_event done
}

if [ "$stream_format" = "row_events" ]; then
  emit_logs_events | compress_logs_json_stream
else
  emit_logs_json | compress_logs_json_stream
fi
