#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
export LC_ALL=C

source_path=${SHELLORCHESTRA_BACKUP_SOURCE_PATH:-}
exclude_patterns=${SHELLORCHESTRA_BACKUP_EXCLUDE_PATTERNS:-}
max_entries=${SHELLORCHESTRA_BACKUP_SCAN_MAX_ENTRIES:-200000}
case "$max_entries" in ''|*[!0123456789]*) max_entries=200000 ;; esac

json_string() {
  if [ "$#" -eq 0 ] || [ -z "$1" ]; then printf '""'; return; fi
  printf '%s' "$1" | awk 'BEGIN { ORS = "" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "\\r"); gsub(/\n/, "\\n"); printf "\"%s\"", $0 }'
}

json_error() {
  printf '{"ok":false,"error":'
  json_string "$1"
  printf '}\n'
}

file_size_or_zero() {
  # Keep permission-denied paths out of stderr. The scan must report the
  # readable part of a tree without turning unreadable fixture files into a
  # failed script run.
  (wc -c < "$1") 2>/dev/null | awk '{print $1 + 0}'
}

case "$source_path" in
  /*) ;;
  *) json_error "Backup source path must be absolute."; exit 64 ;;
esac
if [ ! -e "$source_path" ]; then
  json_error "Backup source path does not exist."
  exit 66
fi

exclude_file=$(mktemp)
scan_file=$(mktemp)
filtered_file=$(mktemp)
trap 'rm -f "$exclude_file" "$scan_file" "$filtered_file"' EXIT HUP INT TERM
printf '%s\n' "$exclude_patterns" | sed '/^[[:space:]]*$/d; /^[[:space:]]*#/d' > "$exclude_file"

kind=file
if [ -d "$source_path" ]; then kind=directory; fi

if [ "$kind" = file ]; then
  size=$(file_size_or_zero "$source_path")
  printf '%s\t%s\n' "$size" "." > "$scan_file"
else
  (cd "$source_path" && find . -type f -print 2>/dev/null | sed 's#^\./##' | awk -v max="$max_entries" 'BEGIN { count=0 } count < max { print; count++ }') > "$filtered_file"
  awk 'NF { print }' "$filtered_file" > "$scan_file.paths"
  : > "$scan_file"
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    size=$(file_size_or_zero "$source_path/$rel")
    printf '%s\t%s\n' "$size" "$rel" >> "$scan_file"
  done < "$scan_file.paths"
  rm -f "$scan_file.paths"
fi

apply_excludes() {
  awk -F '\t' -v excludes="$exclude_file" '
    BEGIN {
      n=0
      while ((getline line < excludes) > 0) {
        gsub(/^[ \t]+|[ \t]+$/, "", line)
        if (line == "" || line ~ /^#/) continue
        n++
        pattern[n]=line
      }
      close(excludes)
    }
    function endswith(value, suffix) {
      return suffix == "" || substr(value, length(value) - length(suffix) + 1) == suffix
    }
    function excluded(path, p, clean, token) {
      for (i=1; i<=n; i++) {
        p=pattern[i]
        clean=p
        sub(/^!/, "", clean)
        if (clean == "") continue
        gsub(/\\/, "/", clean)
        if (clean ~ /\/\*\*$/) {
          sub(/\/\*\*$/, "", clean)
          if (path == clean || index(path, clean "/") == 1 || index(path, "/" clean "/") > 0) return 1
          continue
        }
        if (clean ~ /\/$/) {
          sub(/\/$/, "", clean)
          if (path == clean || index(path, clean "/") == 1 || index(path, "/" clean "/") > 0) return 1
          continue
        }
        if (substr(clean, 1, 2) == "*.") {
          if (endswith(path, substr(clean, 2))) return 1
          continue
        }
        if (index(clean, "*") > 0) {
          token=clean
          gsub(/\*/, "", token)
          if (token != "" && index(path, token) > 0) return 1
          continue
        }
        if (path == clean || endswith(path, "/" clean)) return 1
      }
      return 0
    }
    !excluded($2) { print }
  ' "$scan_file"
}

original_count=$(awk 'END { print NR + 0 }' "$scan_file")
original_bytes=$(awk -F '\t' '{ total += $1 } END { printf "%.0f", total }' "$scan_file")
apply_excludes > "$filtered_file"
included_count=$(awk 'END { print NR + 0 }' "$filtered_file")
included_bytes=$(awk -F '\t' '{ total += $1 } END { printf "%.0f", total }' "$filtered_file")
excluded_count=$((original_count - included_count))
excluded_bytes=$((original_bytes - included_bytes))

printf '{"ok":true,"source_path":'
json_string "$source_path"
printf ',"kind":'
json_string "$kind"
printf ',"original_file_count":%s,"original_disk_bytes":%s,"included_file_count":%s,"included_disk_bytes":%s,"excluded_file_count":%s,"excluded_disk_bytes":%s,"truncated":%s}\n' \
  "$original_count" "${original_bytes:-0}" "$included_count" "${included_bytes:-0}" "$excluded_count" "${excluded_bytes:-0}" \
  "$(if [ "$original_count" -ge "$max_entries" ]; then printf true; else printf false; fi)"
