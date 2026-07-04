#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
export LC_ALL=C

path=${SHELLORCHESTRA_FILE_MANAGER_PATH:-}
overwrite=${SHELLORCHESTRA_FILE_MANAGER_OVERWRITE:-false}

json_string() {
  if [ "$#" -eq 0 ] || [ -z "$1" ]; then printf '""'; return; fi
  printf '%s' "$1" | awk 'BEGIN { ORS = "" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "\\r"); gsub(/\n/, "\\n"); printf "\"%s\"", $0 }'
}
json_error() { printf '{"ok":false,"action":"archive_upload","error":'; json_string "$1"; printf '}\n'; }
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
validate_entry() {
  entry=$1
  case "$entry" in ''|'.'|'..'|'/'*|*'/../'*|'../'*|*'/..'|'-'*) return 1 ;; esac
  return 0
}
file_size() {
  if run_file_read_command stat -c '%s' -- "$1" 2>/dev/null; then return; fi
  if run_file_read_command stat -f '%z' -- "$1" 2>/dev/null; then return; fi
  run_file_read_command wc -c -- "$1" | awk '{print $1 + 0}'
}

[ -n "$path" ] || { json_error "Destination folder is required."; exit 0; }
run_file_read_command test -d "$path" || { json_error "Destination folder was not found."; exit 0; }
command -v tar >/dev/null 2>&1 || { json_error "tar is required for ShellOrchestra Send To folder and multi-item transfer."; exit 0; }

tmp=$(mktemp) || { json_error "Could not create a temporary archive file."; exit 0; }
entries=$(mktemp) || { rm -f "$tmp"; json_error "Could not create a temporary archive entry list."; exit 0; }
trap 'rm -f "$tmp" "$entries"' INT TERM HUP EXIT
if ! cat > "$tmp"; then json_error "Could not receive the Send To archive stream."; exit 0; fi
if ! tar -tf "$tmp" > "$entries" 2>/tmp/shellorchestra-archive-upload-err.$$; then
  detail=$(cat /tmp/shellorchestra-archive-upload-err.$$ 2>/dev/null | head -c 400 || true)
  rm -f /tmp/shellorchestra-archive-upload-err.$$
  json_error "Received archive could not be listed. $detail"
  exit 0
fi
rm -f /tmp/shellorchestra-archive-upload-err.$$
while IFS= read -r entry || [ -n "$entry" ]; do
  validate_entry "$entry" || { json_error "Received archive contains an unsafe entry name."; exit 0; }
  if [ "$overwrite" != "true" ] && run_file_read_command test -e "$path/$entry"; then
    json_error "Destination already contains an item from this transfer. Enable overwrite or choose another folder."
    exit 0
  fi
done < "$entries"
if ! run_file_mutation_command tar -xf "$tmp" -C "$path"; then
  json_error "ShellOrchestra could not extract the received archive. Check file permissions or passwordless sudo/doas for the ShellOrchestra service user."
  exit 0
fi
size=$(file_size "$tmp")
count=$(wc -l < "$entries" | awk '{print $1 + 0}')
printf '{"ok":true,"action":"archive_upload","path":'; json_string "$path"; printf ',"size":%s,"entry_count":%s}\n' "$size" "$count"
