#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

json_string() {
  if [ "$#" -eq 0 ] || [ -z "$1" ]; then printf '""'; return; fi
  printf '%s' "$1" | awk 'BEGIN { ORS = ""; printf "\"" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "\\r"); if (NR > 1) printf "\\n"; printf "%s", $0 } END { printf "\"" }'
}

find_ufw() {
  if command -v ufw >/dev/null 2>&1; then
    command -v ufw
    return
  fi
  for candidate in /usr/sbin/ufw /sbin/ufw /usr/local/sbin/ufw; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  return 1
}

run_maybe_root() {
  if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo -n "$@"
  elif command -v doas >/dev/null 2>&1 && doas -n true >/dev/null 2>&1; then
    doas -n "$@"
  else
    "$@"
  fi
}

output_encoding=${SHELLORCHESTRA_FIREWALL_OUTPUT_ENCODING:-${firewall_output_encoding:-}}
stream_format=${SHELLORCHESTRA_FIREWALL_STREAM_FORMAT:-${firewall_stream_format:-json}}
case "$stream_format" in ''|'json') stream_format=json ;; 'row_events') ;; *) echo "Unsupported ShellOrchestra firewall stream format: $stream_format" >&2; exit 64 ;; esac
case "$output_encoding" in ''|'none') output_encoding=none ;; 'auto'|'zstd'|'gzip') ;; *) echo "Unsupported ShellOrchestra firewall output encoding: $output_encoding" >&2; exit 64 ;; esac

compress_json_stream() {
  case "$output_encoding" in
    zstd)
      if command -v zstd >/dev/null 2>&1; then zstd -3 -c; else gzip -1 -c; fi
      ;;
    gzip)
      gzip -1 -c
      ;;
    auto)
      if command -v zstd >/dev/null 2>&1; then zstd -3 -c
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
manager=unknown
status_text=''
rules=''
ufw_cmd=$(find_ufw || true)
if [ -n "$ufw_cmd" ]; then
  manager=ufw
  status_text=$(run_maybe_root "$ufw_cmd" status verbose 2>&1 || true)
  rules=$(run_maybe_root "$ufw_cmd" status numbered 2>&1 || true)
fi

emit_json_payload() {
  printf '{"generated_at":"%s","manager":' "$generated_at"
  json_string "$manager"
  printf ',"status_text":'
  json_string "$status_text"
  printf ',"rules_text":'
  json_string "$rules"
  printf '}\n'
}

emit_row_events() {
  printf '{"event":"meta","data":{"generated_at":"%s","manager":' "$generated_at"
  json_string "$manager"
  printf ',"status_text":'
  json_string "$status_text"
  printf '}}\n'
  printf '%s\n' "$rules" | awk '
    function json_string(value, escaped) { escaped=value; gsub(/\\/, "\\\\", escaped); gsub(/"/, "\\\"", escaped); gsub(/\t/, "\\t", escaped); gsub(/\r/, "\\r", escaped); gsub(/\n/, "\\n", escaped); return "\"" escaped "\"" }
    NF > 0 { printf "{\"event\":\"row\",\"data\":{\"raw\":%s}}\n", json_string($0) }
  '
  printf '{"event":"done","data":{"generated_at":"%s","manager":' "$generated_at"
  json_string "$manager"
  printf ',"status_text":'
  json_string "$status_text"
  printf '}}\n'
}

if [ "$stream_format" = "row_events" ]; then
  emit_row_events | compress_json_stream
else
  emit_json_payload | compress_json_stream
fi
