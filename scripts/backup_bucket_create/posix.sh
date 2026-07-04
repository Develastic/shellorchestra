#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
export LC_ALL=C

root_path=${SHELLORCHESTRA_BACKUP_ROOT_PATH:-}
bucket_name=${SHELLORCHESTRA_BACKUP_BUCKET_NAME:-ShellOrchestraBackups}
bucket_label=${SHELLORCHESTRA_BACKUP_BUCKET_LABEL:-ShellOrchestra backup bucket}
manifest_name='.shellorchestra-bucket.json'

run_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; return; fi
  if command -v sudo >/dev/null 2>&1; then sudo "$@"; return; fi
  if command -v doas >/dev/null 2>&1; then doas "$@"; return; fi
  echo "Root privileges are required to create a backup bucket." >&2
  exit 1
}

json_string() {
  if [ "$#" -eq 0 ] || [ -z "$1" ]; then printf '""'; return; fi
  printf '%s' "$1" | awk 'BEGIN { ORS = "" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "\\r"); gsub(/\n/, "\\n"); printf "\"%s\"", $0 }'
}

json_error() {
  printf '{"ok":false,"error":'
  json_string "$1"
  printf '}\n'
}

case "$root_path" in
  /*) ;;
  *) json_error "Backup bucket root path must be absolute."; exit 64 ;;
esac
case "$bucket_name" in
  ''|*/*|*\\*|.*|*'..'*|*[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.@+-]*)
    json_error "Backup bucket folder name contains unsupported characters."; exit 64 ;;
esac

bucket_path=${root_path%/}/$bucket_name
manifest_tmp=$(mktemp)
created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date)
{
  printf '{\n'
  printf '  "schema": "shellorchestra.backup.bucket.v1",\n'
  printf '  "label": '
  json_string "$bucket_label"
  printf ',\n'
  printf '  "created_at": '
  json_string "$created_at"
  printf '\n}\n'
} > "$manifest_tmp"
run_root install -d -m 0750 "$bucket_path"
run_root install -m 0640 "$manifest_tmp" "$bucket_path/$manifest_name"
rm -f "$manifest_tmp"

filesystem=$(df -P "$root_path" 2>/dev/null | awk 'NR==2 {print $1}' || printf '')
free_bytes=$(df -Pk "$root_path" 2>/dev/null | awk 'NR==2 {printf "%.0f", $4 * 1024}' || printf '0')
total_bytes=$(df -Pk "$root_path" 2>/dev/null | awk 'NR==2 {printf "%.0f", $2 * 1024}' || printf '0')
printf '{"ok":true,"root_path":'
json_string "$root_path"
printf ',"bucket_name":'
json_string "$bucket_name"
printf ',"bucket_path":'
json_string "$bucket_path"
printf ',"root_exists":true,"bucket_exists":true,"manifest_exists":true,"manifest_status":"ok","filesystem":'
json_string "$filesystem"
printf ',"free_bytes":%s,"total_bytes":%s}\n' "${free_bytes:-0}" "${total_bytes:-0}"
