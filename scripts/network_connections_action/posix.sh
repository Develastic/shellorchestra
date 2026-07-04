#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu

action=${SHELLORCHESTRA_NETWORK_ACTION:-}
iface=${SHELLORCHESTRA_NETWORK_INTERFACE:-}
hostname_value=${SHELLORCHESTRA_NETWORK_HOSTNAME:-}
mtu=${SHELLORCHESTRA_NETWORK_MTU:-}
dns=${SHELLORCHESTRA_NETWORK_DNS:-}
dry_run=${SHELLORCHESTRA_DRY_RUN:-0}
os_name=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' || printf unknown)

json_string() { awk 'BEGIN { value=ARGV[1]; ARGV[1]=""; gsub(/\\/,"\\\\",value); gsub(/"/,"\\\"",value); gsub(/\t/,"\\t",value); gsub(/\r/,"\\r",value); gsub(/\n/,"\\n",value); printf "\"%s\"", value }' "$1"; }
run_root() {
  if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then "$@"; return; fi
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo "$@"; return; fi
  if command -v doas >/dev/null 2>&1 && doas -n true >/dev/null 2>&1; then doas "$@"; return; fi
  echo "Administrator rights are required to change network settings." >&2
  exit 1
}
safe_iface() { case "$1" in ''|*[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:-]*) return 1 ;; *) [ ${#1} -le 64 ] ;; esac; }
safe_hostname() { case "$1" in ''|.*|*..*|*-|*_*|*[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-]*) return 1 ;; *) [ ${#1} -le 253 ] ;; esac; }
safe_dns_list() {
  [ -n "$1" ] || return 1
  old_ifs=$IFS; IFS=','
  for item in $1; do
    case "$item" in ''|*[!0123456789abcdefABCDEF:.]*) IFS=$old_ifs; return 1 ;; esac
  done
  IFS=$old_ifs
  return 0
}
macos_network_service_for_iface() {
  iface_name=$1
  command -v networksetup >/dev/null 2>&1 || return 1
  networksetup -listallhardwareports 2>/dev/null | awk -v dev="$iface_name" '
    /^Hardware Port: / { port = substr($0, 16) }
    /^Device: / && $2 == dev { print port; found = 1; exit }
    END { exit found ? 0 : 1 }
  '
}
macos_local_host_name() {
  printf '%s' "$1" | sed 's/[.].*$//' | tr -cd '[:alnum:]-'
}
success() {
  printf '{"ok":true,"action":'; json_string "$action"
  printf ',"dry_run":'
  if [ "$dry_run" = "1" ]; then printf 'true'; else printf 'false'; fi
  printf ',"message":'; json_string "$1"
  printf '}\n'
}
case "$action" in set_hostname|set_mtu|set_dns) ;; *) echo "Unsupported network action: $action" >&2; exit 1 ;; esac
case "$action" in
  set_hostname)
    if ! safe_hostname "$hostname_value"; then echo "Enter a valid host name before saving." >&2; exit 1; fi
    if [ "$os_name" = "darwin" ]; then
      if [ "$dry_run" = "1" ]; then
        success "Preview only. ShellOrchestra would set the macOS HostName and ComputerName with scutil."
        exit 0
      fi
      local_host_name=$(macos_local_host_name "$hostname_value")
      run_root scutil --set HostName "$hostname_value"
      run_root scutil --set ComputerName "$hostname_value"
      if [ -n "$local_host_name" ]; then
        run_root scutil --set LocalHostName "$local_host_name"
      fi
      success "macOS host name was updated with scutil."
      exit 0
    fi
    if [ "$dry_run" = "1" ]; then
      if command -v hostnamectl >/dev/null 2>&1; then
        success "Preview only. ShellOrchestra would set the managed server host name with hostnamectl."
      else
        success "Preview only. ShellOrchestra would update /etc/hostname and the running host name."
      fi
      exit 0
    fi
    if command -v hostnamectl >/dev/null 2>&1; then
      run_root hostnamectl set-hostname "$hostname_value"
    else
      tmp_file=$(mktemp)
      printf '%s\n' "$hostname_value" > "$tmp_file"
      run_root install -m 0644 "$tmp_file" /etc/hostname
      rm -f "$tmp_file"
      run_root hostname "$hostname_value"
    fi
    success "Host name was updated."
    ;;
  set_mtu)
    if ! safe_iface "$iface"; then echo "Choose a valid network interface." >&2; exit 1; fi
    case "$mtu" in ''|*[!0123456789]*) echo "MTU must be a number." >&2; exit 1 ;; esac
    if [ "$mtu" -lt 576 ] 2>/dev/null || [ "$mtu" -gt 9000 ] 2>/dev/null; then echo "MTU must be between 576 and 9000." >&2; exit 1; fi
    if [ "$os_name" = "darwin" ]; then
      if ! command -v ifconfig >/dev/null 2>&1; then echo "ifconfig is required to change MTU on macOS." >&2; exit 1; fi
      if [ "$dry_run" = "1" ]; then
        success "Preview only. ShellOrchestra would set the runtime MTU on this macOS interface with ifconfig."
        exit 0
      fi
      run_root ifconfig "$iface" mtu "$mtu"
      success "macOS interface MTU was updated for the running system."
      exit 0
    fi
    if [ "$dry_run" = "1" ]; then
      if command -v ip >/dev/null 2>&1; then
        success "Preview only. ShellOrchestra would set the runtime MTU on this interface with iproute2."
      else
        echo "iproute2 is required to change MTU on this Linux target." >&2
        exit 1
      fi
      exit 0
    fi
    if command -v ip >/dev/null 2>&1; then run_root ip link set dev "$iface" mtu "$mtu"
    else echo "iproute2 is required to change MTU on this Linux target." >&2; exit 1; fi
    success "Interface MTU was updated for the running system."
    ;;
  set_dns)
    if ! safe_iface "$iface"; then echo "Choose a valid network interface." >&2; exit 1; fi
    if ! safe_dns_list "$dns"; then echo "Enter comma-separated DNS server IP addresses." >&2; exit 1; fi
    if [ "$os_name" = "darwin" ]; then
      service=$(macos_network_service_for_iface "$iface" || true)
      if [ -z "$service" ]; then echo "ShellOrchestra could not map this macOS interface to a network service." >&2; exit 1; fi
      if [ "$dry_run" = "1" ]; then
        success "Preview only. ShellOrchestra would set DNS servers on the macOS network service mapped to this interface."
        exit 0
      fi
      # shellcheck disable=SC2086
      run_root networksetup -setdnsservers "$service" $(printf '%s' "$dns" | tr ',' ' ')
      success "macOS DNS servers were updated for the selected network service."
      exit 0
    fi
    if command -v resolvectl >/dev/null 2>&1; then
      if [ "$dry_run" = "1" ]; then
        success "Preview only. ShellOrchestra would set runtime DNS servers for this interface with resolvectl."
        exit 0
      fi
      # Runtime DNS setting; persistent profile editing will be a separate workflow.
      # shellcheck disable=SC2086
      run_root resolvectl dns "$iface" $(printf '%s' "$dns" | tr ',' ' ')
      success "Runtime DNS servers were updated for this interface."
    else
      echo "resolvectl is required for the current DNS configuration workflow on Linux." >&2
      exit 1
    fi
    ;;
esac
