#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu

platform=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' || printf unknown)
generated_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || printf '')
source_name=unavailable
output_encoding=${SHELLORCHESTRA_CONNECTION_WATCH_OUTPUT_ENCODING:-${connection_watch_output_encoding:-}}
stream_format=${SHELLORCHESTRA_CONNECTION_WATCH_STREAM_FORMAT:-${connection_watch_stream_format:-json}}
case "$stream_format" in ''|'json') stream_format=json ;; 'row_events') ;; *) echo "Unsupported ShellOrchestra connection watch stream format: $stream_format" >&2; exit 64 ;; esac
case "$output_encoding" in ''|'none') output_encoding=none ;; 'auto'|'zstd'|'gzip') ;; *) echo "Unsupported ShellOrchestra connection watch output encoding: $output_encoding" >&2; exit 64 ;; esac

json_string() {
  awk 'BEGIN { value=ARGV[1]; ARGV[1]=""; gsub(/\\/,"\\\\",value); gsub(/"/,"\\\"",value); gsub(/\t/,"\\t",value); gsub(/\r/,"\\r",value); gsub(/\n/,"\\n",value); printf "\"%s\"", value }' "$1"
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

emit_ss_json_items() {
  ss -H -tunap 2>/dev/null | awk '
    BEGIN { first = 1 }
    function json_string(value, escaped) { escaped=value; gsub(/\\/, "\\\\", escaped); gsub(/"/, "\\\"", escaped); gsub(/\t/, "\\t", escaped); gsub(/\r/, "\\r", escaped); gsub(/\n/, "\\n", escaped); return "\"" escaped "\"" }
    function endpoint_port(endpoint, cleaned, n, parts) { cleaned=endpoint; gsub(/^\[/, "", cleaned); gsub(/\]/, "", cleaned); n=split(cleaned, parts, ":"); if (n < 2) return ""; return parts[n] }
    function endpoint_host(endpoint, cleaned, port, suffix) { cleaned=endpoint; gsub(/^\[/, "", cleaned); gsub(/\]/, "", cleaned); port=endpoint_port(endpoint); suffix=":" port; if (port != "" && substr(cleaned, length(cleaned)-length(suffix)+1) == suffix) return substr(cleaned, 1, length(cleaned)-length(suffix)); return cleaned }
    function direction_for(proto, state, local_port, remote_port, lp, rp) { lp=local_port+0; rp=remote_port+0; if (state == "LISTEN" || remote_port == "*" || remote_port == "") return "listening"; if (proto == "udp" && state == "UNCONN") return "listening"; if (lp > 0 && rp > 0 && lp < 49152 && rp >= 49152) return "incoming"; return "outgoing" }
    NF >= 6 {
      proto=$1; state=$2; local=$5; remote=$6; process="";
      for (i=7; i<=NF; i++) process = process (process == "" ? "" : " ") $i
      local_port=endpoint_port(local); remote_port=endpoint_port(remote); direction=direction_for(proto, state, local_port, remote_port)
      if (!first) printf ","; first=0
      printf "{\"protocol\":%s,\"direction\":%s,\"state\":%s,\"local_address\":%s,\"local_port\":%s,\"remote_address\":%s,\"remote_port\":%s,\"process\":%s}", json_string(proto), json_string(direction), json_string(state), json_string(endpoint_host(local)), json_string(local_port), json_string(endpoint_host(remote)), json_string(remote_port), json_string(process)
    }
  '
}

emit_ss_row_events() {
  ss -H -tunap 2>/dev/null | awk '
    function json_string(value, escaped) { escaped=value; gsub(/\\/, "\\\\", escaped); gsub(/"/, "\\\"", escaped); gsub(/\t/, "\\t", escaped); gsub(/\r/, "\\r", escaped); gsub(/\n/, "\\n", escaped); return "\"" escaped "\"" }
    function endpoint_port(endpoint, cleaned, n, parts) { cleaned=endpoint; gsub(/^\[/, "", cleaned); gsub(/\]/, "", cleaned); n=split(cleaned, parts, ":"); if (n < 2) return ""; return parts[n] }
    function endpoint_host(endpoint, cleaned, port, suffix) { cleaned=endpoint; gsub(/^\[/, "", cleaned); gsub(/\]/, "", cleaned); port=endpoint_port(endpoint); suffix=":" port; if (port != "" && substr(cleaned, length(cleaned)-length(suffix)+1) == suffix) return substr(cleaned, 1, length(cleaned)-length(suffix)); return cleaned }
    function direction_for(proto, state, local_port, remote_port, lp, rp) { lp=local_port+0; rp=remote_port+0; if (state == "LISTEN" || remote_port == "*" || remote_port == "") return "listening"; if (proto == "udp" && state == "UNCONN") return "listening"; if (lp > 0 && rp > 0 && lp < 49152 && rp >= 49152) return "incoming"; return "outgoing" }
    NF >= 6 {
      proto=$1; state=$2; local=$5; remote=$6; process="";
      for (i=7; i<=NF; i++) process = process (process == "" ? "" : " ") $i
      local_port=endpoint_port(local); remote_port=endpoint_port(remote); direction=direction_for(proto, state, local_port, remote_port)
      printf "{\"event\":\"row\",\"data\":{\"protocol\":%s,\"direction\":%s,\"state\":%s,\"local_address\":%s,\"local_port\":%s,\"remote_address\":%s,\"remote_port\":%s,\"process\":%s}}\n", json_string(proto), json_string(direction), json_string(state), json_string(endpoint_host(local)), json_string(local_port), json_string(endpoint_host(remote)), json_string(remote_port), json_string(process)
    }
  '
}

emit_netstat_json_items() {
  { netstat -anv -p tcp 2>/dev/null || netstat -an -p tcp 2>/dev/null || true; netstat -anv -p udp 2>/dev/null || netstat -an -p udp 2>/dev/null || true; } | awk '
    BEGIN { first = 1 }
    function json_string(value, escaped) { escaped=value; gsub(/\\/, "\\\\", escaped); gsub(/"/, "\\\"", escaped); gsub(/\t/, "\\t", escaped); gsub(/\r/, "\\r", escaped); gsub(/\n/, "\\n", escaped); return "\"" escaped "\"" }
    function normalize_endpoint(endpoint, n, i) { if (endpoint == "" || endpoint == "*" || endpoint == "*.*") return endpoint; n=length(endpoint); for (i=n; i>=1; i--) { if (substr(endpoint, i, 1) == ".") return substr(endpoint, 1, i-1) ":" substr(endpoint, i+1) } return endpoint }
    function endpoint_port(endpoint, cleaned, n, parts) { cleaned=normalize_endpoint(endpoint); n=split(cleaned, parts, ":"); if (n < 2) return ""; return parts[n] }
    function endpoint_host(endpoint, cleaned, port, suffix) { cleaned=normalize_endpoint(endpoint); port=endpoint_port(cleaned); suffix=":" port; if (port != "" && substr(cleaned, length(cleaned)-length(suffix)+1) == suffix) return substr(cleaned, 1, length(cleaned)-length(suffix)); return cleaned }
    function direction_for(proto, state, local_port, remote_port, lp, rp) { lp=local_port+0; rp=remote_port+0; if (state == "LISTEN" || remote_port == "*" || remote_port == "" || remote_port == "*") return "listening"; if (proto ~ /^udp/ && (state == "" || state == "UNCONN")) return "listening"; if (lp > 0 && rp > 0 && lp < 49152 && rp >= 49152) return "incoming"; return "outgoing" }
    $1 ~ /^(tcp|tcp4|tcp6|udp|udp4|udp6)$/ && NF >= 5 {
      proto=$1; local=$4; remote=$5; state=""; process="";
      if (proto ~ /^tcp/ && NF >= 6) state=$6; else if (proto ~ /^udp/) state="UNCONN";
      local_port=endpoint_port(local); remote_port=endpoint_port(remote); direction=direction_for(proto, state, local_port, remote_port)
      if (!first) printf ","; first=0
      printf "{\"protocol\":%s,\"direction\":%s,\"state\":%s,\"local_address\":%s,\"local_port\":%s,\"remote_address\":%s,\"remote_port\":%s,\"process\":%s}", json_string(proto), json_string(direction), json_string(state), json_string(endpoint_host(local)), json_string(local_port), json_string(endpoint_host(remote)), json_string(remote_port), json_string(process)
    }
  '
}

emit_netstat_row_events() {
  { netstat -anv -p tcp 2>/dev/null || netstat -an -p tcp 2>/dev/null || true; netstat -anv -p udp 2>/dev/null || netstat -an -p udp 2>/dev/null || true; } | awk '
    function json_string(value, escaped) { escaped=value; gsub(/\\/, "\\\\", escaped); gsub(/"/, "\\\"", escaped); gsub(/\t/, "\\t", escaped); gsub(/\r/, "\\r", escaped); gsub(/\n/, "\\n", escaped); return "\"" escaped "\"" }
    function normalize_endpoint(endpoint, n, i) { if (endpoint == "" || endpoint == "*" || endpoint == "*.*") return endpoint; n=length(endpoint); for (i=n; i>=1; i--) { if (substr(endpoint, i, 1) == ".") return substr(endpoint, 1, i-1) ":" substr(endpoint, i+1) } return endpoint }
    function endpoint_port(endpoint, cleaned, n, parts) { cleaned=normalize_endpoint(endpoint); n=split(cleaned, parts, ":"); if (n < 2) return ""; return parts[n] }
    function endpoint_host(endpoint, cleaned, port, suffix) { cleaned=normalize_endpoint(endpoint); port=endpoint_port(cleaned); suffix=":" port; if (port != "" && substr(cleaned, length(cleaned)-length(suffix)+1) == suffix) return substr(cleaned, 1, length(cleaned)-length(suffix)); return cleaned }
    function direction_for(proto, state, local_port, remote_port, lp, rp) { lp=local_port+0; rp=remote_port+0; if (state == "LISTEN" || remote_port == "*" || remote_port == "" || remote_port == "*") return "listening"; if (proto ~ /^udp/ && (state == "" || state == "UNCONN")) return "listening"; if (lp > 0 && rp > 0 && lp < 49152 && rp >= 49152) return "incoming"; return "outgoing" }
    $1 ~ /^(tcp|tcp4|tcp6|udp|udp4|udp6)$/ && NF >= 5 {
      proto=$1; local=$4; remote=$5; state=""; process="";
      if (proto ~ /^tcp/ && NF >= 6) state=$6; else if (proto ~ /^udp/) state="UNCONN";
      local_port=endpoint_port(local); remote_port=endpoint_port(remote); direction=direction_for(proto, state, local_port, remote_port)
      printf "{\"event\":\"row\",\"data\":{\"protocol\":%s,\"direction\":%s,\"state\":%s,\"local_address\":%s,\"local_port\":%s,\"remote_address\":%s,\"remote_port\":%s,\"process\":%s}}\n", json_string(proto), json_string(direction), json_string(state), json_string(endpoint_host(local)), json_string(local_port), json_string(endpoint_host(remote)), json_string(remote_port), json_string(process)
    }
  '
}

if command -v ss >/dev/null 2>&1; then
  source_name=ss
elif command -v netstat >/dev/null 2>&1; then
  source_name=netstat
else
  source_name=unavailable
fi

emit_payload() {
  if [ "$stream_format" = row_events ]; then
    printf '{"event":"meta","data":{"generated_at":"%s","platform":' "$generated_at"
    json_string "$platform"
    printf ',"source":'
    json_string "$source_name"
    printf '}}\n'
    case "$source_name" in
      ss) emit_ss_row_events ;;
      netstat) emit_netstat_row_events ;;
      *) : ;;
    esac
    printf '{"event":"done","data":{"generated_at":"%s","platform":' "$generated_at"
    json_string "$platform"
    printf ',"source":'
    json_string "$source_name"
    printf '}}\n'
    return
  fi

  rows=''
  case "$source_name" in
    ss) rows=$(emit_ss_json_items) ;;
    netstat) rows=$(emit_netstat_json_items) ;;
    *) rows='' ;;
  esac
  printf '{"generated_at":"%s","platform":' "$generated_at"
  json_string "$platform"
  printf ',"source":'
  json_string "$source_name"
  printf ',"connections":[%s]}\n' "$rows"
}

emit_payload | compress_json_stream
