#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
export LC_ALL=C

source_parent=${SHELLORCHESTRA_FILE_MANAGER_SOURCE_PARENT:-}
source_names_b64=${SHELLORCHESTRA_FILE_MANAGER_SOURCE_NAMES_B64:-}
compression_preferences=${SHELLORCHESTRA_STREAM_OUTPUT_COMPRESSION:-none}
compression_level=${SHELLORCHESTRA_STREAM_OUTPUT_COMPRESSION_LEVEL:-3}
case "$compression_level" in [1-9]|1[0-9]) ;; *) compression_level=3 ;; esac
gzip_level=$compression_level
if [ "$gzip_level" -gt 9 ]; then gzip_level=9; fi

die() { echo "$1" >&2; exit "${2:-2}"; }
run_file_read_command() {
  if [ "$(id -u 2>/dev/null || printf 1)" -eq 0 ]; then "$@"; return; fi
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo -n "$@"; return; fi
  if command -v doas >/dev/null 2>&1 && doas -n true >/dev/null 2>&1; then doas -n "$@"; return; fi
  "$@"
}
decode_b64_to_file() {
  value=$1
  out=$2
  if command -v base64 >/dev/null 2>&1; then
    if printf '%s' "$value" | base64 -d > "$out" 2>/dev/null; then return; fi
    if printf '%s' "$value" | base64 -D > "$out" 2>/dev/null; then return; fi
  fi
  die "base64 is required to decode the ShellOrchestra Send To name manifest."
}
wants_stream_compression() { case ",$compression_preferences," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
validate_name() {
  name=$1
  case "$name" in ''|'.'|'..'|'-'*|*/*|*\\*) return 1 ;; esac
  return 0
}
stream_archive() {
  if wants_stream_compression zstd && command -v zstd >/dev/null 2>&1; then
    run_file_read_command tar -cf - -C "$source_parent" -T "$names_file" | zstd -q -c "-$compression_level"
    return
  fi
  if wants_stream_compression gzip && command -v gzip >/dev/null 2>&1; then
    run_file_read_command tar -cf - -C "$source_parent" -T "$names_file" | gzip "-$gzip_level" -c
    return
  fi
  run_file_read_command tar -cf - -C "$source_parent" -T "$names_file"
}

[ -n "$source_parent" ] || die "Source parent directory is required."
[ -n "$source_names_b64" ] || die "Source names manifest is required."
run_file_read_command test -d "$source_parent" || die "Source parent directory was not found."
command -v tar >/dev/null 2>&1 || die "tar is required for ShellOrchestra Send To folder and multi-item transfer."

names_file=$(mktemp) || die "Could not create a temporary Send To name manifest."
trap 'rm -f "$names_file"' INT TERM HUP EXIT
decode_b64_to_file "$source_names_b64" "$names_file"
[ -s "$names_file" ] || die "Source name manifest is empty."
while IFS= read -r name || [ -n "$name" ]; do
  validate_name "$name" || die "Source name is not safe for archive transfer: $name"
  run_file_read_command test -e "$source_parent/$name" || die "Source item was not found: $name"
done < "$names_file"
stream_archive
