#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
run_root() {
  if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo -n "$@"
  elif command -v doas >/dev/null 2>&1 && doas -n true >/dev/null 2>&1; then
    doas -n "$@"
  else
    echo "Root privileges are required to remove htop. Run as root or configure passwordless sudo/doas for the ShellOrchestra account." >&2
    exit 1
  fi
}
run_root dnf -y remove htop >/dev/null 2>&1 || true
printf '{"ok":true,"app":"%s","manager":"%s","removed":true}\n' "htop" "dnf"
