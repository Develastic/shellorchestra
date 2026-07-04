#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
action=${SHELLORCHESTRA_FIREWALL_ACTION:-}
run_root() { if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then "$@"; elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo -n "$@"; else echo "Administrator privileges are required for macOS firewall actions." >&2; exit 1; fi; }
fw=/usr/libexec/ApplicationFirewall/socketfilterfw
[ -x "$fw" ] || { echo "macOS Application Firewall tool was not found." >&2; exit 1; }
case "$action" in
  enable) run_root "$fw" --setglobalstate on >&2 ;;
  disable) run_root "$fw" --setglobalstate off >&2 ;;
  *) echo "This macOS firewall profile supports enable and disable actions only." >&2; exit 1 ;;
esac
printf '{"ok":true,"manager":"macos_application_firewall","action":"%s"}\n' "$action"
