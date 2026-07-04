#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
limit=${SHELLORCHESTRA_SERVICES_LIMIT:-160}
case "$limit" in ''|*[!0123456789]*) limit=160 ;; esac
[ "$limit" -lt 1 ] 2>/dev/null && limit=1
[ "$limit" -gt 500 ] 2>/dev/null && limit=500
filter=${SHELLORCHESTRA_SERVICES_FILTER:-}
mode=${SHELLORCHESTRA_SERVICES_MODE:-list}
service_name=${SHELLORCHESTRA_SERVICE_NAME:-}
output_encoding=${SHELLORCHESTRA_SERVICES_OUTPUT_ENCODING:-${services_output_encoding:-}}
stream_format=${SHELLORCHESTRA_SERVICES_STREAM_FORMAT:-${services_stream_format:-json}}
case "$stream_format" in ''|'json') stream_format=json ;; 'row_events') ;; *) echo "Unsupported ShellOrchestra services stream format: $stream_format" >&2; exit 64 ;; esac
case "$output_encoding" in ''|'none') output_encoding=none ;; 'auto'|'zstd'|'gzip') ;; *) echo "Unsupported ShellOrchestra services output encoding: $output_encoding" >&2; exit 64 ;; esac

json_string() {
  awk 'BEGIN { value=ARGV[1]; ARGV[1]=""; gsub(/\\/,"\\\\",value); gsub(/"/,"\\\"",value); gsub(/\t/,"\\t",value); gsub(/\r/,"\\r",value); gsub(/\n/,"\\n",value); printf "\"%s\"", value }' "$1"
}

safe_service_name() {
  case "$1" in
    ''|*[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@_.:-]*) return 1 ;;
    *) return 0 ;;
  esac
}

compress_json_stream() {
  case "$output_encoding" in
    zstd)
      if command -v zstd >/dev/null 2>&1; then zstd -1 -c; else gzip -1 -c; fi
      ;;
    gzip)
      gzip -1 -c
      ;;
    auto)
      if command -v zstd >/dev/null 2>&1; then zstd -1 -c
      elif command -v gzip >/dev/null 2>&1; then gzip -1 -c
      else cat
      fi
      ;;
    *)
      cat
      ;;
  esac
}

generated_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || printf '')
if command -v systemctl >/dev/null 2>&1; then manager=systemd; else manager=unknown; fi

emit_payload() {
  if [ "$mode" = unit_file ]; then
    printf '{"generated_at":"%s","manager":' "$generated_at"
    json_string "$manager"
    printf ',"service":'
    json_string "$service_name"
    printf ',"unit_file_path":'
    unit_file_path=
    if [ "$manager" = systemd ]; then
      if ! safe_service_name "$service_name"; then
        echo "A safe systemd service name is required." >&2
        exit 1
      fi
      case "$service_name" in *.service) ;; *) service_name="$service_name.service" ;; esac
      unit_file_path=$(systemctl show "$service_name" --property=FragmentPath --value 2>/dev/null || true)
      case "$unit_file_path" in ""|/dev/null) unit_file_path= ;; esac
    fi
    json_string "$unit_file_path"
    printf '}\n'
    return
  fi

  if [ "$mode" = details ]; then
    printf '{"generated_at":"%s","manager":' "$generated_at"
    json_string "$manager"
    printf ',"service":'
    json_string "$service_name"
    if [ "$manager" = systemd ]; then
      if ! safe_service_name "$service_name"; then
        echo "A safe systemd service name is required." >&2
        exit 1
      fi
      case "$service_name" in *.service) ;; *) service_name="$service_name.service" ;; esac
      show_prop() { systemctl show "$service_name" --property="$1" --value 2>/dev/null | sed -n '1p' || true; }
      status_text=$(systemctl status "$service_name" --no-pager -l 2>/dev/null | sed -n '1,28p' || true)
      for field in LoadState ActiveState SubState UnitFileState FragmentPath ActiveEnterTimestamp InactiveEnterTimestamp ExecMainPID ExecMainCode ExecMainStatus Result; do
        case "$field" in
          LoadState) key=load_state ;;
          ActiveState) key=active_state ;;
          SubState) key=sub_state ;;
          UnitFileState) key=unit_file_state ;;
          FragmentPath) key=fragment_path ;;
          ActiveEnterTimestamp) key=active_enter_timestamp ;;
          InactiveEnterTimestamp) key=inactive_enter_timestamp ;;
          ExecMainPID) key=exec_main_pid ;;
          ExecMainCode) key=exec_main_code ;;
          ExecMainStatus) key=exec_main_status ;;
          Result) key=result ;;
        esac
        printf ',"%s":' "$key"
        json_string "$(show_prop "$field")"
      done
      printf ',"status_text":'
      json_string "$status_text"
    fi
    printf '}\n'
    return
  fi

  if [ "$mode" = logs ]; then
    printf '{"generated_at":"%s","manager":' "$generated_at"
    json_string "$manager"
    printf ',"service":'
    json_string "$service_name"
    printf ',"logs":['
    if [ "$manager" = systemd ]; then
      if ! safe_service_name "$service_name"; then
        echo "A safe systemd service name is required." >&2
        exit 1
      fi
      case "$service_name" in *.service) ;; *) service_name="$service_name.service" ;; esac
      journalctl -u "$service_name" --no-pager --output=short-iso --lines="$limit" 2>/dev/null | awk '
        function js(value, escaped){ escaped=value; gsub(/\\/,"\\\\",escaped); gsub(/"/,"\\\"",escaped); gsub(/\t/,"\\t",escaped); gsub(/\r/,"\\r",escaped); gsub(/\n/,"\\n",escaped); return "\"" escaped "\"" }
        {
          timestamp=$1 " " $2
          message=$0
          sub(/^[^ ]+ [^ ]+ +/, "", message)
          if (count > 0) printf ","
          printf "{\"timestamp\":%s,\"message\":%s}", js(timestamp), js(message)
          count++
        }'
    fi
    printf ']}\n'
    return
  fi

  if [ "$stream_format" = "row_events" ]; then
    printf '{"event":"meta","data":{"generated_at":"%s","manager":' "$generated_at"
    json_string "$manager"
    printf ',"filter":'
    json_string "$filter"
    printf '}}\n'
    if [ "$manager" = systemd ]; then
      systemctl list-units --type=service --all --no-legend --no-pager 2>/dev/null | awk -v limit="$limit" -v filter="$filter" '
        function js(value, escaped){ escaped=value; gsub(/\\/,"\\\\",escaped); gsub(/"/,"\\\"",escaped); gsub(/\t/,"\\t",escaped); gsub(/\r/,"\\r",escaped); gsub(/\n/,"\\n",escaped); return "\"" escaped "\"" }
        count < limit {
          offset=0
          if ($1 !~ /\.service$/ && $2 ~ /\.service$/) offset=1
          unit=$(1+offset); load=$(2+offset); active=$(3+offset); substate=$(4+offset); desc=""; for (i=5+offset;i<=NF;i++) desc=desc (desc?" ":"") $i
          if (filter != "" && index(tolower(unit " " desc), tolower(filter)) == 0) next
          printf "{\"event\":\"row\",\"data\":{\"name\":%s,\"load\":%s,\"active\":%s,\"sub\":%s,\"description\":%s}}\n", js(unit), js(load), js(active), js(substate), js(desc)
          count++
        }'
    fi
    printf '{"event":"done","data":{"generated_at":"%s","manager":' "$generated_at"
    json_string "$manager"
    printf '}}\n'
    return
  fi

  printf '{"generated_at":"%s","manager":' "$generated_at"
  json_string "$manager"
  printf ',"services":['
  if [ "$manager" = systemd ]; then
    systemctl list-units --type=service --all --no-legend --no-pager 2>/dev/null | awk -v limit="$limit" -v filter="$filter" '
      function js(value, escaped){ escaped=value; gsub(/\\/,"\\\\",escaped); gsub(/"/,"\\\"",escaped); gsub(/\t/,"\\t",escaped); gsub(/\r/,"\\r",escaped); gsub(/\n/,"\\n",escaped); return "\"" escaped "\"" }
      count < limit {
        offset=0
        if ($1 !~ /\.service$/ && $2 ~ /\.service$/) offset=1
        unit=$(1+offset); load=$(2+offset); active=$(3+offset); substate=$(4+offset); desc=""; for (i=5+offset;i<=NF;i++) desc=desc (desc?" ":"") $i
        if (filter != "" && index(tolower(unit " " desc), tolower(filter)) == 0) next
        if (count > 0) printf ","
        printf "{\"name\":%s,\"load\":%s,\"active\":%s,\"sub\":%s,\"description\":%s}", js(unit), js(load), js(active), js(substate), js(desc)
        count++
      }'
  fi
  printf ']}\n'
}

emit_payload | compress_json_stream
