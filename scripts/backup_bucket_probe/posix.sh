#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
export LC_ALL=C

root_path=${SHELLORCHESTRA_BACKUP_ROOT_PATH:-}
bucket_name=${SHELLORCHESTRA_BACKUP_BUCKET_NAME:-ShellOrchestraBackups}
manifest_name='.shellorchestra-bucket.json'

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
filesystem=$(df -P "$root_path" 2>/dev/null | awk 'NR==2 {print $1}' || printf '')
free_bytes=$(df -Pk "$root_path" 2>/dev/null | awk 'NR==2 {printf "%.0f", $4 * 1024}' || printf '0')
total_bytes=$(df -Pk "$root_path" 2>/dev/null | awk 'NR==2 {printf "%.0f", $2 * 1024}' || printf '0')
root_exists=false
bucket_exists=false
manifest_exists=false
[ -d "$root_path" ] && root_exists=true
[ -d "$bucket_path" ] && bucket_exists=true
[ -f "$bucket_path/$manifest_name" ] && manifest_exists=true
manifest_status=missing
if [ "$manifest_exists" = true ]; then manifest_status=ok; fi

printf '{"ok":true,"root_path":'
json_string "$root_path"
printf ',"bucket_name":'
json_string "$bucket_name"
printf ',"bucket_path":'
json_string "$bucket_path"
printf ',"root_exists":%s,"bucket_exists":%s,"manifest_exists":%s,"manifest_status":' "$root_exists" "$bucket_exists" "$manifest_exists"
json_string "$manifest_status"
printf ',"filesystem":'
json_string "$filesystem"
printf ',"free_bytes":%s,"total_bytes":%s}\n' "${free_bytes:-0}" "${total_bytes:-0}"
