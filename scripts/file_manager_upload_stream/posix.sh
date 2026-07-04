#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
export LC_ALL=C

action=upload
path=${SHELLORCHESTRA_FILE_MANAGER_PATH:-}
overwrite=${SHELLORCHESTRA_FILE_MANAGER_OVERWRITE:-false}

json_string() {
  if [ "$#" -eq 0 ] || [ -z "$1" ]; then printf '""'; return; fi
  printf '%s' "$1" | awk 'BEGIN { ORS = "" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "\\r"); gsub(/\n/, "\\n"); printf "\"%s\"", $0 }'
}
json_error() { printf '{"ok":false,"action":"upload","error":'; json_string "$1"; printf '}\n'; }
run_file_read_command() {
  if [ "$(id -u 2>/dev/null || printf 1)" -eq 0 ]; then "$@"; return; fi
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo -n "$@"; return; fi
  if command -v doas >/dev/null 2>&1 && doas -n true >/dev/null 2>&1; then doas -n "$@"; return; fi
  "$@"
}
run_file_mutation_command() {
  if [ "$(id -u 2>/dev/null || printf 1)" -eq 0 ]; then "$@"; return; fi
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo -n "$@"; return; fi
  if command -v doas >/dev/null 2>&1 && doas -n true >/dev/null 2>&1; then doas -n "$@"; return; fi
  "$@"
}
file_size() {
  if run_file_read_command stat -c '%s' -- "$1" 2>/dev/null; then return; fi
  if run_file_read_command stat -f '%z' -- "$1" 2>/dev/null; then return; fi
  run_file_read_command wc -c -- "$1" | awk '{print $1 + 0}'
}
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then run_file_read_command sha256sum "$1" | awk '{print $1}'; return; fi
  if command -v shasum >/dev/null 2>&1; then run_file_read_command shasum -a 256 "$1" | awk '{print $1}'; return; fi
  if command -v openssl >/dev/null 2>&1; then run_file_read_command openssl dgst -sha256 "$1" | awk '{print $NF}'; return; fi
  printf ''
}

[ -n "$path" ] || { json_error "Path is required."; exit 0; }
case "$path" in ''|'/') json_error "Refusing to write an empty path or the filesystem root."; exit 0 ;; esac
case "${path##*/}" in ''|'.'|'..') json_error "Remote file name is invalid."; exit 0 ;; esac
dir=$(dirname "$path")
run_file_read_command test -d "$dir" || { json_error "Parent directory was not found."; exit 0; }
if run_file_read_command test -d "$path"; then json_error "A directory already exists at that path."; exit 0; fi
if run_file_read_command test -e "$path" && [ "$overwrite" != "true" ]; then json_error "A file already exists at that path. Enable overwrite or choose another name."; exit 0; fi

tmp=$(mktemp) || { json_error "Could not create a temporary file for this upload."; exit 0; }
trap 'rm -f "$tmp"' INT TERM HUP EXIT
if ! cat > "$tmp"; then json_error "Could not receive the uploaded file stream."; exit 0; fi
if ! run_file_mutation_command cp -- "$tmp" "$path"; then json_error "ShellOrchestra could not write the uploaded file. Check file permissions or passwordless sudo/doas for the ShellOrchestra service user."; exit 0; fi
rm -f "$tmp"
trap - INT TERM HUP EXIT
size=$(file_size "$path")
hash=$(sha256_file "$path")
printf '{"ok":true,"action":"upload","path":'; json_string "$path"; printf ',"size":%s,"sha256":' "$size"; json_string "$hash"; printf '}\n'
