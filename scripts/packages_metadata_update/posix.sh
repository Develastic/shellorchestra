#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu

manager=${SHELLORCHESTRA_PACKAGE_MANAGER:-}
operation=metadata_update

json_string() {
  awk 'BEGIN {
    value = ARGV[1]
    ARGV[1] = ""
    gsub(/\\/, "\\\\", value)
    gsub(/"/, "\\\"", value)
    gsub(/\t/, "\\t", value)
    gsub(/\r/, "\\r", value)
    gsub(/\n/, "\\n", value)
    printf "\"%s\"", value
  }' "$1"
}

json_escape_file_tail() {
  tail -n 80 "$1" 2>/dev/null | awk 'BEGIN{printf "\""} {gsub(/[^[:print:]\t]/,"?"); gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); gsub(/\t/,"\\t"); printf "%s%s", sep, $0; sep="\\n"} END{printf "\""}'
}

run_root() {
  if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo -n "$@"
  elif command -v doas >/dev/null 2>&1 && doas -n true >/dev/null 2>&1; then
    doas -n "$@"
  else
    echo "Root privileges are required to refresh package repository metadata. Run as root or configure passwordless sudo/doas for the ShellOrchestra account." >&2
    exit 1
  fi
}

if [ -z "$manager" ] || [ "$manager" = "auto" ]; then
  if command -v apt-get >/dev/null 2>&1; then manager=apt
  elif command -v apk >/dev/null 2>&1; then manager=apk
  elif command -v dnf >/dev/null 2>&1; then manager=dnf
  elif command -v yum >/dev/null 2>&1; then manager=yum
  elif command -v pacman >/dev/null 2>&1; then manager=pacman
  elif command -v zypper >/dev/null 2>&1; then manager=zypper
  elif command -v brew >/dev/null 2>&1; then manager=brew
  elif [ -x /opt/homebrew/bin/brew ]; then manager=brew
  elif [ -x /usr/local/bin/brew ]; then manager=brew
  else echo "No supported package manager was detected." >&2; exit 1
  fi
fi

if [ "${SHELLORCHESTRA_DRY_RUN:-0}" = "1" ] || [ "${SHELLORCHESTRA_CONFIRMED:-0}" != "1" ]; then
  printf '{"ok":true,"dry_run":true,"manager":'
  json_string "$manager"
  printf ',"operation":"%s"}\n' "$operation"
  exit 0
fi

shellorchestra_log=$(mktemp)
trap 'rm -f "$shellorchestra_log"' EXIT

case "$manager" in
  apt)
    run_root apt-get update >>"$shellorchestra_log" 2>&1
    ;;
  apk)
    run_root apk update >>"$shellorchestra_log" 2>&1
    ;;
  dnf)
    run_root dnf -y makecache --refresh >>"$shellorchestra_log" 2>&1
    ;;
  yum)
    run_root yum -y makecache >>"$shellorchestra_log" 2>&1
    ;;
  pacman)
    run_root pacman -Sy --noconfirm >>"$shellorchestra_log" 2>&1
    ;;
  zypper)
    run_root zypper --non-interactive refresh >>"$shellorchestra_log" 2>&1
    ;;
  brew)
    if command -v brew >/dev/null 2>&1; then brew update >>"$shellorchestra_log" 2>&1
    elif [ -x /opt/homebrew/bin/brew ]; then /opt/homebrew/bin/brew update >>"$shellorchestra_log" 2>&1
    elif [ -x /usr/local/bin/brew ]; then /usr/local/bin/brew update >>"$shellorchestra_log" 2>&1
    else echo "Homebrew was not found." >&2; exit 1; fi
    ;;
  *)
    echo "Unsupported package metadata update manager: $manager" >&2
    exit 1
    ;;
esac

printf '{"ok":true,"manager":'
json_string "$manager"
printf ',"operation":"%s","output_preview":' "$operation"
json_escape_file_tail "$shellorchestra_log"
printf '}\n'
