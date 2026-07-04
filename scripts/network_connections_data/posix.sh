#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu

output_encoding=${SHELLORCHESTRA_NETWORK_CONNECTIONS_OUTPUT_ENCODING:-${network_connections_output_encoding:-}}
stream_format=${SHELLORCHESTRA_NETWORK_CONNECTIONS_STREAM_FORMAT:-${network_connections_stream_format:-json}}
case "$stream_format" in ''|'json') stream_format=json ;; 'row_events') ;; *) echo "Unsupported ShellOrchestra network connections stream format: $stream_format" >&2; exit 64 ;; esac
case "$output_encoding" in ''|'none') output_encoding=none ;; 'auto'|'zstd'|'gzip') ;; *) echo "Unsupported ShellOrchestra network connections output encoding: $output_encoding" >&2; exit 64 ;; esac

json_string() {
  awk 'BEGIN { value=ARGV[1]; ARGV[1]=""; gsub(/\\/,"\\\\",value); gsub(/"/,"\\\"",value); gsub(/\t/,"\\t",value); gsub(/\r/,"\\r",value); gsub(/\n/,"\\n",value); printf "\"%s\"", value }' "$1"
}

json_array_lines() {
  printf '['
  first=true
  while IFS= read -r value; do
    [ -n "$value" ] || continue
    if [ "$first" = true ]; then first=false; else printf ','; fi
    json_string "$value"
  done
  printf ']'
}

compress_json_stream() {
  case "$output_encoding" in
    zstd)
      if command -v zstd >/dev/null 2>&1; then zstd -3 -c; elif command -v gzip >/dev/null 2>&1; then gzip -1 -c; else cat; fi
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

iface_type() {
  name=$1
  if [ -d "/sys/class/net/$name/wireless" ]; then printf wireless; return; fi
  case "$name" in lo) printf loopback ;; docker*|br-*|veth*|virbr*|podman*) printf virtual ;; *) printf ethernet ;; esac
}
addresses_for() {
  name=$1
  if command -v ip >/dev/null 2>&1; then
    ip -o addr show dev "$name" 2>/dev/null | awk '{print $3 ":" $4}'
  elif command -v ifconfig >/dev/null 2>&1; then
    ifconfig "$name" 2>/dev/null | awk '/inet / {print "inet:" $2} /inet6 / {print "inet6:" $2}'
  fi
}
default_gateway_for() {
  name=$1
  if command -v ip >/dev/null 2>&1; then
    ip route show default dev "$name" 2>/dev/null | awk '/default/ {for (i=1;i<=NF;i++) if ($i=="via") {print $(i+1); exit}}'
  elif command -v route >/dev/null 2>&1; then
    route -n get default 2>/dev/null | awk -v dev="$name" '
      $1 == "gateway:" {gateway=$2}
      $1 == "interface:" {iface=$2}
      END {if (iface == dev) print gateway}
    '
  fi
}
dns_servers() {
  if command -v resolvectl >/dev/null 2>&1; then
    resolvectl dns 2>/dev/null | awk '
      {
        after_colon = 0
        for (i = 1; i <= NF; i++) {
          if (after_colon == 1 && $i != "") print $i
          if (index($i, ":") > 0) after_colon = 1
        }
      }
    ' | sort -u
  elif [ -r /etc/resolv.conf ]; then
    awk '$1 == "nameserver" {print $2}' /etc/resolv.conf | sort -u
  fi
}
dns_search_domains() {
  if command -v resolvectl >/dev/null 2>&1; then
    resolvectl domain 2>/dev/null | awk '
      {
        after_colon = 0
        for (i = 1; i <= NF; i++) {
          if (after_colon == 1 && $i != "" && $i != "~.") print $i
          if (index($i, ":") > 0) after_colon = 1
        }
      }
    ' | sort -u
  elif [ -r /etc/resolv.conf ]; then
    awk '$1 == "search" {for (i=2;i<=NF;i++) print $i} $1 == "domain" {print $2}' /etc/resolv.conf | sort -u
  fi
}
route_rows() {
  if command -v ip >/dev/null 2>&1; then
    ip -o route show 2>/dev/null | awk '
      NF > 0 {
        destination=$1; gateway=""; iface=""; source=""; metric=""
        for (i=1;i<=NF;i++) {
          if ($i == "via" && (i+1) <= NF) gateway=$(i+1)
          if ($i == "dev" && (i+1) <= NF) iface=$(i+1)
          if ($i == "src" && (i+1) <= NF) source=$(i+1)
          if ($i == "metric" && (i+1) <= NF) metric=$(i+1)
        }
        if (destination != "") printf "%s|%s|%s|%s|%s\n", destination, gateway, iface, source, metric
      }
    '
  elif command -v netstat >/dev/null 2>&1; then
    netstat -rn -f inet 2>/dev/null | awk '
      $1 == "Destination" || $1 == "Routing" || $1 == "Internet:" || NF < 4 { next }
      {
        destination=$1; gateway=$2; iface=$NF
        if (iface ~ /^[0-9]+$/ && (NF-1) >= 1) iface=$(NF-1)
        if (destination != "") printf "%s|%s|%s||\n", destination, gateway, iface
      }
    '
  elif command -v route >/dev/null 2>&1; then
    route -n 2>/dev/null | awk '
      $1 == "Destination" || $1 == "Kernel" || NF < 8 { next }
      {
        destination=$1; gateway=$2; metric=$5; iface=$8
        if (destination == "0.0.0.0") destination="default"
        printf "%s|%s|%s||%s\n", destination, gateway, iface, metric
      }
    '
  fi
}
ssh_path_details() {
  connection=${SSH_CONNECTION:-}
  if [ -z "$connection" ]; then
    printf '||||'
    return
  fi
  set -- $connection
  client_address=${1:-}
  server_address=${3:-}
  server_port=${4:-}
  if [ -n "$client_address" ] && command -v ip >/dev/null 2>&1; then
    route_line=$(ip route get "$client_address" 2>/dev/null | head -n 1 || true)
    route_details=$(printf '%s\n' "$route_line" | awk '
      {
        for (i = 1; i <= NF; i++) {
          if ($i == "dev" && (i + 1) <= NF) dev = $(i + 1)
          if ($i == "src" && (i + 1) <= NF) src = $(i + 1)
        }
      }
      END { printf "%s|%s", dev, src }
    ')
  elif [ -n "$client_address" ] && command -v route >/dev/null 2>&1; then
    route_details=$(route -n get "$client_address" 2>/dev/null | awk '
      $1 == "interface:" { dev = $2 }
      $1 == "local" { src = $2 }
      END { printf "%s|%s", dev, src }
    ')
  else
    route_details='|'
  fi
  interface_name=${route_details%%|*}
  source_address=${route_details#*|}
  printf '%s|%s|%s|%s|%s' "$client_address" "$server_address" "$server_port" "$interface_name" "$source_address"
}

emit_route_object() {
  destination=$1; gateway=$2; iface=$3; source=$4; metric=$5
  printf '{"destination":'; json_string "$destination"
  printf ',"gateway":'; json_string "$gateway"
  printf ',"interface_name":'; json_string "$iface"
  printf ',"source_address":'; json_string "$source"
  printf ',"metric":'; json_string "$metric"
  printf ',"is_default":'
  case "$destination" in default|0.0.0.0/0|::/0) printf true ;; *) printf false ;; esac
  printf '}'
}

emit_adapter_object() {
  name=$1
  path="/sys/class/net/$name"
  if [ -d "$path" ]; then
    operstate=$(cat "$path/operstate" 2>/dev/null || printf unknown)
    mtu=$(cat "$path/mtu" 2>/dev/null || printf '')
    mac=$(cat "$path/address" 2>/dev/null || printf '')
  elif command -v ifconfig >/dev/null 2>&1; then
    ifconfig_output=$(ifconfig "$name" 2>/dev/null || printf '')
    if printf '%s\n' "$ifconfig_output" | grep -Eq 'status: active|(^|[[:space:]])UP([,[:space:]]|$)'; then operstate=up; else operstate=down; fi
    mtu=$(printf '%s\n' "$ifconfig_output" | awk 'NR == 1 {for (i=1;i<=NF;i++) if ($i=="mtu") {print $(i+1); exit}}')
    mac=$(printf '%s\n' "$ifconfig_output" | awk '$1 == "ether" {print $2; exit}')
  else
    operstate=unknown; mtu=''; mac=''
  fi
  gateway=$(default_gateway_for "$name" | head -n 1)
  printf '{"name":'; json_string "$name"
  printf ',"type":'; json_string "$(iface_type "$name")"
  printf ',"state":'; json_string "$operstate"
  printf ',"mtu":'; json_string "$mtu"
  printf ',"mac":'; json_string "$mac"
  printf ',"gateway":'; json_string "$gateway"
  printf ',"addresses":'
  addresses_for "$name" | json_array_lines
  printf '}'
}

platform=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' || printf linux)
hostname_value=$(hostname 2>/dev/null || printf '')
if command -v nmcli >/dev/null 2>&1; then manager_value=networkmanager; elif command -v networkctl >/dev/null 2>&1; then manager_value=systemd-networkd; else manager_value=kernel; fi
ssh_details=$(ssh_path_details)
ssh_client=${ssh_details%%|*}
ssh_rest=${ssh_details#*|}
ssh_server=${ssh_rest%%|*}
ssh_rest=${ssh_rest#*|}
ssh_port=${ssh_rest%%|*}
ssh_rest=${ssh_rest#*|}
ssh_iface=${ssh_rest%%|*}
ssh_source=${ssh_rest#*|}
interface_names=''
if [ -d /sys/class/net ]; then
  for path in /sys/class/net/*; do
    [ -e "$path" ] || continue
    interface_names="${interface_names}
$(basename "$path")"
  done
elif command -v ifconfig >/dev/null 2>&1; then
  interface_names=$(ifconfig -l 2>/dev/null || printf '')
fi

emit_meta_object() {
  printf '{"platform":'; json_string "$platform"
  printf ',"manager":'; json_string "$manager_value"
  printf ',"hostname":'; json_string "$hostname_value"
  printf ',"dns":'; dns_servers | json_array_lines
  printf ',"dns_search_domains":'; dns_search_domains | json_array_lines
  printf ',"ssh_path":{"client_address":'; json_string "$ssh_client"
  printf ',"server_address":'; json_string "$ssh_server"
  printf ',"server_port":'; json_string "$ssh_port"
  printf ',"interface_name":'; json_string "$ssh_iface"
  printf ',"source_address":'; json_string "$ssh_source"
  printf ',"route_known":'
  if [ -n "$ssh_iface" ]; then printf true; else printf false; fi
  printf '}}'
}

emit_row_events() {
  printf '{"event":"meta","data":'
  emit_meta_object
  printf '}\n'
  route_rows | while IFS='|' read -r destination gateway iface source metric; do
    [ -n "$destination" ] || continue
    printf '{"event":"row","data":{"kind":"route","item":'
    emit_route_object "$destination" "$gateway" "$iface" "$source" "$metric"
    printf '}}\n'
  done
  for name in $interface_names; do
    [ -n "$name" ] || continue
    printf '{"event":"row","data":{"kind":"adapter","item":'
    emit_adapter_object "$name"
    printf '}}\n'
  done
  printf '{"event":"done","data":'
  emit_meta_object
  printf '}\n'
}

emit_json_payload() {
  printf '{"platform":'; json_string "$platform"
  printf ',"manager":'; json_string "$manager_value"
  printf ',"hostname":'; json_string "$hostname_value"
  printf ',"dns":'; dns_servers | json_array_lines
  printf ',"dns_search_domains":'; dns_search_domains | json_array_lines
  printf ',"routes":['
  first_route=true
  route_rows | while IFS='|' read -r destination gateway iface source metric; do
    [ -n "$destination" ] || continue
    if [ "$first_route" = true ]; then first_route=false; else printf ','; fi
    emit_route_object "$destination" "$gateway" "$iface" "$source" "$metric"
  done
  printf ']'
  printf ',"ssh_path":{"client_address":'; json_string "$ssh_client"
  printf ',"server_address":'; json_string "$ssh_server"
  printf ',"server_port":'; json_string "$ssh_port"
  printf ',"interface_name":'; json_string "$ssh_iface"
  printf ',"source_address":'; json_string "$ssh_source"
  printf ',"route_known":'
  if [ -n "$ssh_iface" ]; then printf true; else printf false; fi
  printf '}'
  printf ',"adapters":['
  first_adapter=true
  for name in $interface_names; do
    [ -n "$name" ] || continue
    if [ "$first_adapter" = true ]; then first_adapter=false; else printf ','; fi
    emit_adapter_object "$name"
  done
  printf ']}\n'
}

if [ "$stream_format" = "row_events" ]; then
  emit_row_events | compress_json_stream
else
  emit_json_payload | compress_json_stream
fi
