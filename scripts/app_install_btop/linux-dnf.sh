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
    echo "Root privileges are required to install btop. Run as root or configure passwordless sudo/doas for the ShellOrchestra account." >&2
    exit 1
  fi
}
if ! run_root dnf -y install btop >&2; then
  run_root dnf -y install epel-release >&2 || true
  if command -v crb >/dev/null 2>&1; then
    run_root crb enable >&2 || true
  fi
  run_root dnf -y install btop >&2
fi
printf '{"ok":true,"app":"%s","manager":"%s"}\n' "btop" "dnf"
