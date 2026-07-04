#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
export LC_ALL=C

archive_path=${SHELLORCHESTRA_ARCHIVE_PATH:-${SHELLORCHESTRA_FILE_MANAGER_PATH:-}}
platform=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' || printf unknown)
inner_path=${SHELLORCHESTRA_ARCHIVE_INNER_PATH:-}
max_entries=${SHELLORCHESTRA_ARCHIVE_MAX_ENTRIES:-1000}

case "$max_entries" in ''|*[!0-9]*) max_entries=1000 ;; esac
if [ "$max_entries" -lt 1 ]; then max_entries=1; fi
if [ "$max_entries" -gt 5000 ]; then max_entries=5000; fi

json_string() {
  if [ "$#" -eq 0 ] || [ -z "$1" ]; then printf '""'; return; fi
  printf '%s' "$1" | awk 'BEGIN { ORS = "" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "\\r"); gsub(/\n/, "\\n"); printf "\"%s\"", $0 }'
}
json_error() {
  printf '{"ok":false,"action":"archive_list","error":'
  json_string "$1"
  printf ',"archive_path":'
  json_string "$archive_path"
  printf '}\n'
}
run_file_read_command() {
  if [ "$(id -u 2>/dev/null || printf 1)" -eq 0 ]; then "$@"; return; fi
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo -n "$@"; return; fi
  if command -v doas >/dev/null 2>&1 && doas -n true >/dev/null 2>&1; then doas -n "$@"; return; fi
  "$@"
}
lower_name() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
archive_kind() {
  name=$(lower_name "$archive_path")
  case "$name" in
    *.zip|*.jar|*.war|*.ear|*.docx|*.xlsx|*.pptx|*.odt|*.ods|*.odp) printf 'zip' ;;
    *.rar) printf 'rar' ;;
    *.tar.zst|*.tzst) printf 'tar.zst' ;;
    *.tar.gz|*.tgz) printf 'tar.gz' ;;
    *.tar.bz2|*.tbz2|*.tbz) printf 'tar.bz2' ;;
    *.tar.xz|*.txz) printf 'tar.xz' ;;
    *.tar) printf 'tar' ;;
    *) printf 'unknown' ;;
  esac
}
list_archive() {
  kind=$1
  case "$kind" in
    zip)
      if command -v zipinfo >/dev/null 2>&1; then run_file_read_command zipinfo -1 -- "$archive_path"; return; fi
      if command -v unzip >/dev/null 2>&1; then run_file_read_command unzip -Z1 -- "$archive_path"; return; fi
      return 127
      ;;
    rar)
      if command -v unrar >/dev/null 2>&1; then run_file_read_command unrar lb -- "$archive_path"; return; fi
      if command -v bsdtar >/dev/null 2>&1; then run_file_read_command bsdtar -tf "$archive_path"; return; fi
      return 127
      ;;
    tar.zst)
      if command -v tar >/dev/null 2>&1 && tar --help 2>/dev/null | grep -q -- '--zstd'; then run_file_read_command tar --zstd -tf "$archive_path"; return; fi
      if command -v bsdtar >/dev/null 2>&1; then run_file_read_command bsdtar -tf "$archive_path"; return; fi
      if command -v zstd >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then run_file_read_command zstd -dc -- "$archive_path" | tar -tf -; return; fi
      return 127
      ;;
    tar.gz|tar.bz2|tar.xz|tar)
      if command -v tar >/dev/null 2>&1 && run_file_read_command tar -tf "$archive_path" 2>/dev/null; then return; fi
      if command -v bsdtar >/dev/null 2>&1; then run_file_read_command bsdtar -tf "$archive_path"; return; fi
      return 127
      ;;
    *) return 64 ;;
  esac
}
normalize_inner() {
  value=$1
  while [ "${value#/}" != "$value" ]; do value=${value#/}; done
  while [ "${value%/}" != "$value" ]; do value=${value%/}; done
  printf '%s' "$value"
}

[ -n "$archive_path" ] || { json_error "Archive path is required."; exit 0; }
run_file_read_command test -f "$archive_path" || { json_error "Archive path must point to a regular file."; exit 0; }
kind=$(archive_kind)
[ "$kind" != "unknown" ] || { json_error "This archive type is not supported yet."; exit 0; }
inner_path=$(normalize_inner "$inner_path")
entries_file=$(mktemp) || { json_error "Could not create a temporary archive listing file."; exit 0; }
trap 'rm -f "$entries_file"' INT TERM HUP EXIT
if ! list_archive "$kind" > "$entries_file" 2>/tmp/shellorchestra-archive-list-err.$$; then
  detail=$(cat /tmp/shellorchestra-archive-list-err.$$ 2>/dev/null | head -c 400 || true)
  rm -f /tmp/shellorchestra-archive-list-err.$$
  if [ -n "$detail" ]; then json_error "Could not list this archive: $detail"; else json_error "Could not list this archive. Install zipinfo, unzip, unrar, bsdtar, tar, or zstd support for this archive type."; fi
  exit 0
fi
rm -f /tmp/shellorchestra-archive-list-err.$$

awk -v archive="$archive_path" -v inner="$inner_path" -v kind="$kind" -v max="$max_entries" -v platform="$platform" '
function js(s, out, i, c) {
  out="\""
  for (i=1; i<=length(s); i++) {
    c=substr(s,i,1)
    if (c=="\\") out=out "\\\\"
    else if (c=="\"") out=out "\\\""
    else if (c=="\t") out=out "\\t"
    else if (c=="\r") out=out "\\r"
    else out=out c
  }
  return out "\""
}
function unsafe(p) {
  return p == "" || p ~ /^\// || p ~ /(^|\/)\.\.($|\/)/
}
function emit_entry(name, type, full, isdir) {
  if (count >= max) { truncated=1; return }
  if (seen[name SUBSEP type]++) return
  if (count > 0) printf ","
  printf "{\"name\":%s,\"path\":%s,\"type\":%s,\"is_dir\":%s,\"size\":0,\"mode\":\"archive\",\"user\":\"\",\"group\":\"\",\"modified_epoch\":0,\"archive_entry_path\":%s}", js(name), js(archive "!/" full), js(type), isdir ? "true" : "false", js(full)
  count++
}
BEGIN {
  prefix = inner
  if (prefix != "") prefix = prefix "/"
  printf "{\"ok\":true,\"action\":\"archive_list\",\"platform\":%s,\"archive_path\":%s,\"archive_inner_path\":%s,\"archive_type\":%s,\"path\":%s,\"entries\":[", js(platform), js(archive), js(inner), js(kind), js(archive "!/" inner)
}
{
  p=$0
  sub(/^\.\//, "", p)
  if (unsafe(p)) { skipped++; next }
  if (prefix != "" && index(p, prefix) != 1) next
  rel = prefix == "" ? p : substr(p, length(prefix)+1)
  if (rel == "") next
  split(rel, parts, "/")
  name = parts[1]
  full = prefix name
  isdir = index(rel, "/") > 0 || p ~ /\/$/
  emit_entry(name, isdir ? "directory" : "file", full, isdir)
}
END {
  printf "],\"entry_count\":%d,\"skipped_entries\":%d,\"truncated\":%s,\"readonly\":true}\n", count+0, skipped+0, truncated ? "true" : "false"
}
' "$entries_file"
