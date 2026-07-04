#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu

json_string() {
  awk 'BEGIN { value=ARGV[1]; ARGV[1]=""; gsub(/\\/,"\\\\",value); gsub(/"/,"\\\"",value); gsub(/\t/,"\\t",value); gsub(/\r/,"\\r",value); gsub(/\n/,"\\n",value); printf "\"%s\"", value }' "$1"
}

run_root() {
  if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then
    "$@"
    return
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo -n "$@"
    return
  fi
  if command -v doas >/dev/null 2>&1 && doas -n true >/dev/null 2>&1; then
    doas -n "$@"
    return
  fi
  "$@"
}

output_encoding=${SHELLORCHESTRA_PVE_MANAGER_OUTPUT_ENCODING:-${pve_manager_output_encoding:-}}
stream_format=${SHELLORCHESTRA_PVE_MANAGER_STREAM_FORMAT:-${pve_manager_stream_format:-json}}
case "$stream_format" in ''|'json') stream_format=json ;; 'row_events') ;; *) echo "Unsupported ShellOrchestra PVE Manager stream format: $stream_format" >&2; exit 64 ;; esac
case "$output_encoding" in ''|'none') output_encoding=none ;; 'auto'|'zstd'|'gzip') ;; *) echo "Unsupported ShellOrchestra PVE Manager output encoding: $output_encoding" >&2; exit 64 ;; esac

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

emit_resource_rows() {
  awk '
    BEGIN { depth = 0; in_string = 0; escape = 0; object = "" }
    {
      line = $0
      for (i = 1; i <= length(line); i++) {
        ch = substr(line, i, 1)
        if (escape) {
          if (depth > 0) object = object ch
          escape = 0
          continue
        }
        if (ch == "\\" && in_string) {
          if (depth > 0) object = object ch
          escape = 1
          continue
        }
        if (ch == "\"") {
          if (depth > 0) object = object ch
          in_string = !in_string
          continue
        }
        if (!in_string && ch == "{") {
          if (depth == 0) object = ch
          else object = object ch
          depth++
          continue
        }
        if (!in_string && ch == "}") {
          if (depth > 0) object = object ch
          depth--
          if (depth == 0 && object != "") {
            printf "{\"event\":\"row\",\"data\":%s}\n", object
            object = ""
          }
          continue
        }
        if (depth > 0) object = object ch
      }
    }
  '
}

emit_payload() {
  is_pve=false
  [ -d /etc/pve ] && is_pve=true
  generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf '')

  if command -v pvesh >/dev/null 2>&1; then
    # Proxmox groups QEMU VMs under --type vm, but LXC guests are only present in
    # the full cluster resource list. The frontend model filters unsupported
    # resource kinds, so keep the source complete instead of silently dropping CTs.
    resources=$(run_root pvesh get /cluster/resources --output-format json 2>/dev/null || printf '[]')
    case "$resources" in '['*) ;; *) resources='[]' ;; esac
    node=$(hostname -s 2>/dev/null || hostname 2>/dev/null || printf '')
    node_status='{}'
    if [ -n "$node" ]; then
      node_status=$(run_root pvesh get "/nodes/$node/status" --output-format json 2>/dev/null || printf '{}')
      case "$node_status" in '{'*) ;; *) node_status='{}' ;; esac
    fi

    if [ "$stream_format" = "row_events" ]; then
      printf '{"event":"meta","data":{"available":true,"is_pve":%s,"source":"pvesh","node":' "$is_pve"
      json_string "$node"
      printf ',"generated_at":'
      json_string "$generated_at"
      printf '}}
'
      printf '%s\n' "$resources" | emit_resource_rows
      printf '{"event":"done","data":{"available":true,"is_pve":%s,"source":"pvesh","node":' "$is_pve"
      json_string "$node"
      printf ',"generated_at":'
      json_string "$generated_at"
      printf ',"node_status":%s}}
' "$node_status"
      return
    fi

    printf '{"available":true,"is_pve":%s,"source":"pvesh","node":' "$is_pve"
    json_string "$node"
    printf ',"generated_at":'
    json_string "$generated_at"
    printf ',"resources":%s,"node_status":%s}\n' "$resources" "$node_status"
    return
  fi

  if [ "$stream_format" = "row_events" ]; then
    printf '{"event":"meta","data":{"available":false,"is_pve":%s,"source":"pvesh","generated_at":' "$is_pve"
    json_string "$generated_at"
    printf ',"message":"Proxmox VE tools were not detected on this server."}}
'
    printf '{"event":"done","data":{"available":false,"is_pve":%s,"source":"pvesh","generated_at":' "$is_pve"
    json_string "$generated_at"
    printf ',"message":"Proxmox VE tools were not detected on this server."}}
'
    return
  fi

  printf '{"available":false,"is_pve":%s,"message":"Proxmox VE tools were not detected on this server."}\n' "$is_pve"
}

emit_payload | compress_json_stream
