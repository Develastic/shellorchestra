#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
service_name=${SHELLORCHESTRA_SERVICE_NAME:-}
action=${SHELLORCHESTRA_SERVICE_ACTION:-}
case "$service_name" in ''|*[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@_.:-]*) echo "A safe systemd service name is required." >&2; exit 1 ;; esac
case "$action" in start|stop|restart|reload|status) ;; *) echo "Unsupported service action: $action" >&2; exit 1 ;; esac
case "$service_name" in *.service) ;; *) service_name="$service_name.service" ;; esac
run_root() {
  if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then "$@"; elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo -n "$@"; elif command -v doas >/dev/null 2>&1 && doas -n true >/dev/null 2>&1; then doas -n "$@"; else echo "Root privileges are required for service actions." >&2; exit 1; fi
}
if ! command -v systemctl >/dev/null 2>&1; then echo "systemctl is required for the Services app." >&2; exit 1; fi
if [ "$action" = status ]; then systemctl status --no-pager "$service_name" >&2 || true; else run_root systemctl "$action" "$service_name" >&2; fi
active=$(systemctl is-active "$service_name" 2>/dev/null || true)
printf '{"ok":true,"service":"%s","action":"%s","active":"%s"}\n' "$service_name" "$action" "$active"
