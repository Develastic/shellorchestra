#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
target_path=${SHELLORCHESTRA_SUDO_PATH:-}
sudo_content=${SHELLORCHESTRA_SUDO_CONTENT:-}

json_string() {
  awk 'BEGIN { value=ARGV[1]; ARGV[1]=""; gsub(/\\/,"\\\\",value); gsub(/"/,"\\\"",value); gsub(/\t/,"\\t",value); gsub(/\r/,"\\r",value); gsub(/\n/,"\\n",value); printf "\"%s\"", value }' "$1"
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
  echo "Root privileges are required to save sudoers files." >&2
  exit 1
}

safe_sudoers_path() {
  case "$1" in
    /etc/sudoers) return 0 ;;
    /etc/sudoers.d/*)
      name=${1#/etc/sudoers.d/}
      case "$name" in ''|.*|*/*|*[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-]*) return 1 ;; *) return 0 ;; esac
      ;;
    *) return 1 ;;
  esac
}

find_visudo() {
  if command -v visudo >/dev/null 2>&1; then
    command -v visudo
    return 0
  fi
  for candidate in /usr/sbin/visudo /sbin/visudo /usr/local/sbin/visudo; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

if ! safe_sudoers_path "$target_path"; then
  echo "Choose a supported sudoers file before saving." >&2
  exit 1
fi
visudo_bin=$(find_visudo || true)
if [ -z "$visudo_bin" ]; then
  printf '{"mode":"save","available":false,"message":"Sudoers syntax validation is not available on this server."}\n'
  exit 0
fi

tmp=$(mktemp)
trap 'rm -f "$tmp" "$tmp.err"' EXIT HUP INT TERM
printf '%s\n' "$sudo_content" >"$tmp"
if ! "$visudo_bin" -cf "$tmp" >"$tmp.err" 2>&1; then
  cat "$tmp.err" >&2
  exit 1
fi
parent=$(dirname "$target_path")
run_root install -d -o root -g root -m 0755 "$parent"
if [ -f "$target_path" ]; then
  backup="$target_path.shellorchestra.$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || date +%s).bak"
  run_root cp -p "$target_path" "$backup" 2>/dev/null || true
fi
run_root install -o root -g root -m 0440 "$tmp" "$target_path"
run_root "$visudo_bin" -cf "$target_path" >&2
printf '{"mode":"save","available":true,"path":'
json_string "$target_path"
printf ',"saved":true}\n'
