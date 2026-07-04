#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
export LC_ALL=C

source_path=${SHELLORCHESTRA_BACKUP_SOURCE_PATH:-}
bucket_path=${SHELLORCHESTRA_BACKUP_BUCKET_PATH:-}
task_id=${SHELLORCHESTRA_BACKUP_TASK_ID:-manual}
compression=${SHELLORCHESTRA_BACKUP_COMPRESSION:-zstd}
exclude_patterns=${SHELLORCHESTRA_BACKUP_EXCLUDE_PATTERNS:-}
keep_latest=${SHELLORCHESTRA_BACKUP_KEEP_LATEST:-3}
keep_weekly=${SHELLORCHESTRA_BACKUP_KEEP_WEEKLY:-3}
keep_monthly=${SHELLORCHESTRA_BACKUP_KEEP_MONTHLY:-3}
for var_name in keep_latest keep_weekly keep_monthly; do
  eval "var_value=\${$var_name}"
  case "$var_value" in ''|*[!0123456789]*) eval "$var_name=3" ;; esac
done

run_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; return; fi
  if command -v sudo >/dev/null 2>&1; then sudo "$@"; return; fi
  if command -v doas >/dev/null 2>&1; then doas "$@"; return; fi
  echo "Root privileges are required to run this backup." >&2
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

case "$source_path" in /*) ;; *) json_error "Backup source path must be absolute."; exit 64 ;; esac
case "$bucket_path" in /*) ;; *) json_error "Backup bucket path must be absolute."; exit 64 ;; esac
case "$compression" in zstd|gzip) ;; *) json_error "Backup compression must be zstd or gzip."; exit 64 ;; esac
[ -e "$source_path" ] || { json_error "Backup source path does not exist."; exit 66; }
[ -d "$bucket_path" ] || { json_error "Backup bucket path does not exist."; exit 66; }
command -v tar >/dev/null 2>&1 || { json_error "tar is required to create backup archives."; exit 127; }
if [ "$compression" = zstd ]; then command -v zstd >/dev/null 2>&1 || { json_error "zstd is required for this backup task."; exit 127; }; fi
if [ "$compression" = gzip ]; then command -v gzip >/dev/null 2>&1 || { json_error "gzip is required for this backup task."; exit 127; }; fi

exclude_file=$(mktemp)
all_archives_file=$(mktemp)
keep_archives_file=$(mktemp)
weekly_keys_file=$(mktemp)
monthly_keys_file=$(mktemp)
trap 'rm -f "$exclude_file" "$all_archives_file" "$keep_archives_file" "$weekly_keys_file" "$monthly_keys_file"' EXIT HUP INT TERM
printf '%s\n' "$exclude_patterns" | sed '/^[[:space:]]*$/d; /^[[:space:]]*#/d' > "$exclude_file"
timestamp=$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || date +%s)
safe_task=$(printf '%s' "$task_id" | tr -c 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.@+-' '_')
base_name=$(basename "$source_path")
safe_source=$(printf '%s' "$base_name" | tr -c 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.@+-' '_')
archive_name="shellorchestra-${safe_task}-${safe_source}-${timestamp}.tar"
if [ "$compression" = zstd ]; then archive_name="$archive_name.zst"; else archive_name="$archive_name.gz"; fi
archive_path="$bucket_path/$archive_name"
source_parent=$(dirname "$source_path")
source_base=$(basename "$source_path")

if [ "$compression" = zstd ]; then
  (cd "$source_parent" && run_root tar --exclude-from "$exclude_file" -cf - "$source_base") | zstd -3 -q -c | run_root tee "$archive_path" >/dev/null
else
  (cd "$source_parent" && run_root tar --exclude-from "$exclude_file" -cf - "$source_base") | gzip -6 -c | run_root tee "$archive_path" >/dev/null
fi
archive_bytes=$(wc -c < "$archive_path" 2>/dev/null | awk '{print $1 + 0}' || printf '0')

archive_week_key() {
  ts=$1
  ymd=$(printf '%s' "$ts" | cut -c 1-8)
  if date -u -d "$ymd" +%G-W%V >/dev/null 2>&1; then
    date -u -d "$ymd" +%G-W%V
  else
    printf '%s' "$ymd"
  fi
}

archive_month_key() {
  printf '%s' "$1" | cut -c 1-6
}

archive_timestamp() {
  printf '%s\n' "$1" | sed -n 's/^.*-\([0-9]\{8\}T[0-9]\{6\}Z\)[.]tar[.].*$/\1/p'
}

mark_keep() {
  name=$1
  grep -Fx -- "$name" "$keep_archives_file" >/dev/null 2>&1 || printf '%s\n' "$name" >> "$keep_archives_file"
}

ls -1 "$bucket_path"/shellorchestra-"$safe_task"-*.tar.* 2>/dev/null | sed 's#^.*/##' | sort -r > "$all_archives_file" || true
latest_count=0
weekly_count=0
monthly_count=0
while IFS= read -r archive; do
  [ -n "$archive" ] || continue
  if [ "$latest_count" -lt "$keep_latest" ]; then
    mark_keep "$archive"
    latest_count=$((latest_count + 1))
    continue
  fi
  ts=$(archive_timestamp "$archive")
  [ -n "$ts" ] || continue
  if [ "$weekly_count" -lt "$keep_weekly" ]; then
    week_key=$(archive_week_key "$ts")
    if ! grep -Fx -- "$week_key" "$weekly_keys_file" >/dev/null 2>&1; then
      printf '%s\n' "$week_key" >> "$weekly_keys_file"
      mark_keep "$archive"
      weekly_count=$((weekly_count + 1))
      continue
    fi
  fi
  if [ "$monthly_count" -lt "$keep_monthly" ]; then
    month_key=$(archive_month_key "$ts")
    if ! grep -Fx -- "$month_key" "$monthly_keys_file" >/dev/null 2>&1; then
      printf '%s\n' "$month_key" >> "$monthly_keys_file"
      mark_keep "$archive"
      monthly_count=$((monthly_count + 1))
      continue
    fi
  fi
done < "$all_archives_file"

pruned_count=0
while IFS= read -r archive; do
  [ -n "$archive" ] || continue
  if grep -Fx -- "$archive" "$keep_archives_file" >/dev/null 2>&1; then
    continue
  fi
  if run_root rm -f "$bucket_path/$archive"; then
    pruned_count=$((pruned_count + 1))
  fi
done < "$all_archives_file"

printf '{"ok":true,"archive_name":'
json_string "$archive_name"
printf ',"archive_path":'
json_string "$archive_path"
printf ',"archive_bytes":%s,"compression":' "${archive_bytes:-0}"
json_string "$compression"
printf ',"pruned_archives":%s}\n' "$pruned_count"
