#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
action=${SHELLORCHESTRA_PVE_ACTION:-}
guest_type=${SHELLORCHESTRA_PVE_GUEST_TYPE:-}
vmid=${SHELLORCHESTRA_PVE_VMID:-}

json_string() {
  awk 'BEGIN { value=ARGV[1]; ARGV[1]=""; gsub(/\\/,"\\\\",value); gsub(/"/,"\\\"",value); gsub(/\t/,"\\t",value); gsub(/\r/,"\\r",value); gsub(/\n/,"\\n",value); printf "\"%s\"", value }' "$1"
}
run_root() {
  if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then "$@"; elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo -n "$@"; elif command -v doas >/dev/null 2>&1 && doas -n true >/dev/null 2>&1; then doas -n "$@"; else echo "Root privileges are required for Proxmox VE guest actions." >&2; exit 1; fi
}
case "$vmid" in ''|*[!0123456789]*) echo "A numeric Proxmox VMID is required." >&2; exit 1 ;; esac
case "$action" in start|shutdown|reboot|stop) ;; *) echo "Unsupported Proxmox action: $action" >&2; exit 1 ;; esac
case "$guest_type" in qemu|vm) kind=qemu; tool=qm ;; lxc|ct|openvz) kind=lxc; tool=pct ;; *) echo "Unsupported Proxmox guest type: $guest_type" >&2; exit 1 ;; esac
if ! command -v "$tool" >/dev/null 2>&1; then echo "Proxmox tool $tool was not found on this server." >&2; exit 1; fi
case "$kind:$action" in
  qemu:start) run_root qm start "$vmid" >&2 ;;
  qemu:shutdown) run_root qm shutdown "$vmid" --timeout 60 >&2 ;;
  qemu:reboot) run_root qm reboot "$vmid" --timeout 60 >&2 ;;
  qemu:stop) run_root qm stop "$vmid" >&2 ;;
  lxc:start) run_root pct start "$vmid" >&2 ;;
  lxc:shutdown) run_root pct shutdown "$vmid" --timeout 60 >&2 ;;
  lxc:reboot) run_root pct reboot "$vmid" >&2 ;;
  lxc:stop) run_root pct stop "$vmid" >&2 ;;
esac
printf '{"ok":true,"action":'
json_string "$action"
printf ',"guest_type":'
json_string "$kind"
printf ',"vmid":'
json_string "$vmid"
printf '}\n'
