#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu

guest_type=${SHELLORCHESTRA_PVE_GUEST_TYPE:-}
vmid=${SHELLORCHESTRA_PVE_VMID:-}

find_tool() {
  name=$1
  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
    return 0
  fi
  for candidate in "/usr/sbin/$name" "/sbin/$name" "/usr/local/sbin/$name"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
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
  echo "Root privileges are required for Proxmox VE guest console access." >&2
  exit 1
}

case "$vmid" in
  ''|*[!0123456789]*) echo "A numeric Proxmox VMID is required." >&2; exit 1 ;;
esac
case "$guest_type" in
  qemu|vm) tool=qm; mode=terminal ;;
  lxc|ct|openvz) tool=pct; mode=enter ;;
  *) echo "Unsupported Proxmox guest type: $guest_type" >&2; exit 1 ;;
esac
if ! tool_path=$(find_tool "$tool"); then
  echo "Proxmox tool $tool was not found on this server." >&2
  exit 1
fi
case "$tool:$mode" in
  qm:terminal)
    config=$(run_root "$tool_path" config "$vmid" 2>/dev/null || true)
    if ! printf '%s\n' "$config" | grep -Eq '^serial[0-9]+:'; then
      cat >&2 <<EOF
ShellOrchestra cannot open an interactive Proxmox serial console for VMID $vmid yet.

This VM does not expose a serial console in its Proxmox configuration. Proxmox VM
console access through SSH requires a serial device such as:

  serial0: socket
  vga: serial0

ShellOrchestra did not change the VM configuration automatically. Configure a
serial console in Proxmox if you want this Virtual Machines console button to
attach to the guest. You can still use the normal ShellOrchestra SSH profile for
this VM when SSH is available.
EOF
      exit 0
    fi
    echo "Opening Proxmox VM serial console for VMID $vmid. Press Enter if the guest is waiting at a blank serial screen." >&2
    run_root "$tool_path" terminal "$vmid"
    ;;
  pct:enter)
    echo "Opening Proxmox container console for CTID $vmid." >&2
    run_root "$tool_path" enter "$vmid"
    ;;
esac
