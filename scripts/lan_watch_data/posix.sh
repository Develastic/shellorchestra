#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu

limit=${SHELLORCHESTRA_LAN_WATCH_LIMIT:-64}
case "$limit" in ''|*[!0123456789]*) limit=64 ;; esac
[ "$limit" -lt 1 ] 2>/dev/null && limit=1
[ "$limit" -gt 256 ] 2>/dev/null && limit=256
output_encoding=${SHELLORCHESTRA_LAN_WATCH_OUTPUT_ENCODING:-${lan_watch_output_encoding:-}}
stream_format=${SHELLORCHESTRA_LAN_WATCH_STREAM_FORMAT:-${lan_watch_stream_format:-json}}
case "$stream_format" in ''|'json') stream_format=json ;; 'row_events') ;; *) echo "Unsupported ShellOrchestra LAN Watch stream format: $stream_format" >&2; exit 64 ;; esac
case "$output_encoding" in ''|'none') output_encoding=none ;; 'auto'|'zstd'|'gzip') ;; *) echo "Unsupported ShellOrchestra LAN Watch output encoding: $output_encoding" >&2; exit 64 ;; esac
platform=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' || printf unknown)
generated_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || printf '')
source_name=neighbor-cache
no_probe=${SHELLORCHESTRA_LAN_WATCH_NO_PROBE:-}

json_string() {
  awk 'BEGIN { value=ARGV[1]; ARGV[1]=""; gsub(/\\/,"\\\\",value); gsub(/"/,"\\\"",value); gsub(/\t/,"\\t",value); gsub(/\r/,"\\r",value); gsub(/\n/,"\\n",value); printf "\"%s\"", value }' "$1"
}

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

probe_backend_label=none
probe_backend_path=
probe_backend_missing=false
probe_backend_message=

detect_probe_backend() {
  if [ "$no_probe" = "1" ] || [ "$no_probe" = "true" ]; then
    probe_backend_label=disabled
    probe_backend_missing=false
    probe_backend_message="TCP banner probing is disabled for this scan."
    return
  fi
  if command -v nc >/dev/null 2>&1; then
    probe_backend_label=nc
    probe_backend_path=$(command -v nc)
    probe_backend_missing=false
    probe_backend_message="TCP banner probing uses nc on this server."
    return
  fi
  if command -v ncat >/dev/null 2>&1; then
    probe_backend_label=ncat
    probe_backend_path=$(command -v ncat)
    probe_backend_missing=false
    probe_backend_message="TCP banner probing uses ncat on this server."
    return
  fi
  if command -v netcat >/dev/null 2>&1; then
    probe_backend_label=netcat
    probe_backend_path=$(command -v netcat)
    probe_backend_missing=false
    probe_backend_message="TCP banner probing uses netcat on this server."
    return
  fi
  probe_backend_label=none
  probe_backend_missing=true
  probe_backend_message="No TCP probe backend was found. Install netcat so LAN Watch can check TCP/22 and read SSH banners; without it, ShellOrchestra can only show hosts already present in the target OS neighbor cache."
}

prefix24() { printf '%s\n' "$1" | awk -F. 'NF == 4 {print $1 "." $2 "." $3}'; }
mac_for() {
  ip_addr=$1
  if command -v ip >/dev/null 2>&1; then
    ip neigh show "$ip_addr" 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="lladdr") {print $(i+1); exit}}'
  elif command -v arp >/dev/null 2>&1; then
    arp -n "$ip_addr" 2>/dev/null | awk '/ether/ {print $3; exit} /at/ {print $4; exit}'
  fi
}
probe_banner() {
  ip_addr=$1
  if [ "$no_probe" = "1" ] || [ "$no_probe" = "true" ]; then return 0; fi
  if [ -z "$probe_backend_path" ]; then return 0; fi
  if [ "$platform" = "darwin" ]; then
    case "$probe_backend_label" in
      nc|netcat) "$probe_backend_path" -G 1 -w 1 "$ip_addr" 22 < /dev/null 2>/dev/null | head -n 1 | tr -d '\r' || true ;;
      *) "$probe_backend_path" -w 1 "$ip_addr" 22 < /dev/null 2>/dev/null | head -n 1 | tr -d '\r' || true ;;
    esac
  else
    "$probe_backend_path" -w 1 "$ip_addr" 22 < /dev/null 2>/dev/null | head -n 1 | tr -d '\r' || true
  fi
}
probe_ip() {
  ip_addr=$1
  iface=$2
  banner=$(probe_banner "$ip_addr" | head -n 1)
  mac=$(mac_for "$ip_addr" | head -n 1)
  [ -n "$banner$mac" ] || return 0
  printf '{"ip":'; json_string "$ip_addr"
  printf ',"mac":'; json_string "$mac"
  printf ',"interface":'; json_string "$iface"
  printf ',"ssh_open":'
  case "$banner" in SSH-*) printf true ;; *) printf false ;; esac
  printf ',"ssh_banner":'; json_string "$banner"
  printf '}'
}

interfaces_file=$(mktemp)
trap 'rm -f "$interfaces_file"; rm -rf "${tmp_dir:-}"' EXIT HUP INT TERM
detect_probe_backend
if command -v ip >/dev/null 2>&1; then
  ip -o -4 addr show scope global 2>/dev/null | awk '{split($4,a,"/"); split(a[1],b,"."); if (length(a[1])>0 && length($2)>0 && b[1] != "127") print $2 " " a[1] " " a[2]}' > "$interfaces_file"
elif command -v ifconfig >/dev/null 2>&1; then
  ifconfig 2>/dev/null | awk '
    /^[a-zA-Z0-9_.:-]+:/ {iface=$1; sub(":$", "", iface)}
    /inet / && $2 != "127.0.0.1" {print iface " " $2 " 24"}
  ' > "$interfaces_file"
fi

tmp_dir=$(mktemp -d)
subnets_file="$tmp_dir/subnets"
: > "$subnets_file"
index=0
candidate_count=0
while read -r iface addr prefix; do
  [ -n "${addr:-}" ] || continue
  base=$(prefix24 "$addr")
  [ -n "$base" ] || continue
  printf '%s %s %s %s\n' "$iface" "$addr" "${prefix:-24}" "$base" >> "$subnets_file"
  candidate_count=$((candidate_count + 254))
  n=1
  while [ "$n" -le 254 ] && [ "$index" -lt "$limit" ]; do
    ip_addr="$base.$n"
    probe_ip "$ip_addr" "$iface" > "$tmp_dir/host-$index.json" &
    index=$((index + 1))
    n=$((n + 1))
    if [ $((index % 32)) -eq 0 ]; then wait; fi
  done
done < "$interfaces_file"
wait || true
remaining=$((candidate_count - index))
[ "$remaining" -lt 0 ] 2>/dev/null && remaining=0

emit_meta_fields() {
  printf '"generated_at":"%s","platform":"%s","source":"%s","limit":%s,"no_probe":' "$generated_at" "$platform" "$source_name" "$limit"
  if [ "$no_probe" = "1" ] || [ "$no_probe" = "true" ]; then printf true; else printf false; fi
  printf ',"candidate_count":%s,"checked":%s,"remaining":%s' "$candidate_count" "$index" "$remaining"
  printf ',"probe_backend":'
  json_string "$probe_backend_label"
  printf ',"probe_backend_available":'
  if [ "$probe_backend_missing" = true ]; then printf false; else printf true; fi
  printf ',"probe_backend_missing":'
  if [ "$probe_backend_missing" = true ]; then printf true; else printf false; fi
  printf ',"probe_backend_message":'
  json_string "$probe_backend_message"
}

emit_json_payload() {
  printf '{'
  emit_meta_fields
  printf ',"subnets":['
  first=true
  while read -r iface addr prefix base; do
    [ -n "${base:-}" ] || continue
    if [ "$first" = true ]; then first=false; else printf ','; fi
    printf '{"interface":'; json_string "$iface"
    printf ',"address":'; json_string "$addr"
    printf ',"prefix":'; json_string "$prefix"
    printf ',"network":'; json_string "$base.0/24"
    printf '}'
  done < "$subnets_file"
  printf '],"hosts":['
  first=true
  for file in "$tmp_dir"/host-*.json; do
    [ -s "$file" ] || continue
    if [ "$first" = true ]; then first=false; else printf ','; fi
    cat "$file"
  done
  printf ']}\n'
}

emit_row_events() {
  printf '{"event":"meta","data":{'
  emit_meta_fields
  printf '}}\n'
  while read -r iface addr prefix base; do
    [ -n "${base:-}" ] || continue
    printf '{"event":"row","data":{"kind":"subnet","item":{"interface":'
    json_string "$iface"
    printf ',"address":'; json_string "$addr"
    printf ',"prefix":'; json_string "$prefix"
    printf ',"network":'; json_string "$base.0/24"
    printf '}}}\n'
  done < "$subnets_file"
  for file in "$tmp_dir"/host-*.json; do
    [ -s "$file" ] || continue
    printf '{"event":"row","data":{"kind":"host","item":'
    cat "$file"
    printf '}}\n'
  done
  printf '{"event":"done","data":{'
  emit_meta_fields
  printf '}}\n'
}

if [ "$stream_format" = "row_events" ]; then
  emit_row_events | compress_json_stream
else
  emit_json_payload | compress_json_stream
fi
