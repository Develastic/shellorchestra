#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
run_root() {
  if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then "$@"; elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo -n "$@"; elif command -v doas >/dev/null 2>&1 && doas -n true >/dev/null 2>&1; then doas -n "$@"; else echo "Root privileges are required to install netcat for LAN Watch. Run as root or configure passwordless sudo/doas for the ShellOrchestra account." >&2; exit 1; fi
}
run_root zypper --non-interactive install netcat-openbsd >&2
if ! command -v nc >/dev/null 2>&1 && ! command -v ncat >/dev/null 2>&1 && ! command -v netcat >/dev/null 2>&1; then echo "netcat installation finished, but no nc/ncat/netcat command is available." >&2; exit 1; fi
printf '{"ok":true,"app":"%s","manager":"%s"}\n' "lan-probe" "zypper"
