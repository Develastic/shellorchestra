#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
target_user=${SHELLORCHESTRA_CRON_USER:-}
cron_content=${SHELLORCHESTRA_CRON_CONTENT:-}

json_string() {
  awk 'BEGIN { value=ARGV[1]; ARGV[1]=""; gsub(/\\/,"\\\\",value); gsub(/"/,"\\\"",value); gsub(/\t/,"\\t",value); gsub(/\r/,"\\r",value); gsub(/\n/,"\\n",value); printf "\"%s\"", value }' "$1"
}

safe_user_name() {
  case "$1" in
    ''|*[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-]*|[-.]*|*[.-]) return 1 ;;
    *) return 0 ;;
  esac
}

current_user() {
  id -un 2>/dev/null || whoami 2>/dev/null || printf ''
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
  echo "Root privileges are required to manage another user's crontab." >&2
  return 1
}

if ! command -v crontab >/dev/null 2>&1; then
  printf '{"mode":"save","available":false,"message":"crontab is not installed on this server."}\n'
  exit 0
fi

if ! safe_user_name "$target_user"; then
  echo "Choose a valid user before saving crontab." >&2
  exit 1
fi

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT HUP INT TERM
printf '%s\n' "$cron_content" >"$tmp"
if [ "$target_user" = "$(current_user)" ]; then
  crontab "$tmp" >/dev/null
else
  run_root crontab -u "$target_user" "$tmp" >/dev/null
fi
printf '{"mode":"save","available":true,"user":'
json_string "$target_user"
printf ',"saved":true}\n'
