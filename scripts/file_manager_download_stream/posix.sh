#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
export LC_ALL=C
path=${SHELLORCHESTRA_FILE_MANAGER_PATH:-}
compression_preferences=${SHELLORCHESTRA_STREAM_OUTPUT_COMPRESSION:-none}
compression_level=${SHELLORCHESTRA_STREAM_OUTPUT_COMPRESSION_LEVEL:-1}
case "$compression_level" in
  [1-9]|1[0-9]) ;;
  *) compression_level=1 ;;
esac
gzip_level=$compression_level
if [ "$gzip_level" -gt 9 ]; then gzip_level=9; fi
run_file_read_command() {
  if [ "$(id -u 2>/dev/null || printf 1)" -eq 0 ]; then "$@"; return; fi
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo -n "$@"; return; fi
  if command -v doas >/dev/null 2>&1 && doas -n true >/dev/null 2>&1; then doas -n "$@"; return; fi
  "$@"
}
run_file_stream_shell() {
  script=$1
  if [ "$(id -u 2>/dev/null || printf 1)" -eq 0 ]; then /bin/sh -c "$script" sh "$path" "$compression_level" "$gzip_level"; return; fi
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo -n /bin/sh -c "$script" sh "$path" "$compression_level" "$gzip_level"; return; fi
  if command -v doas >/dev/null 2>&1 && doas -n true >/dev/null 2>&1; then doas -n /bin/sh -c "$script" sh "$path" "$compression_level" "$gzip_level"; return; fi
  /bin/sh -c "$script" sh "$path" "$compression_level" "$gzip_level"
}
wants_stream_compression() {
  case ",$compression_preferences," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}
stream_file() {
  if wants_stream_compression zstd && command -v zstd >/dev/null 2>&1; then
    run_file_stream_shell 'cat -- "$1" | zstd -q -c "-$2"'
    return
  fi
  if wants_stream_compression gzip && command -v gzip >/dev/null 2>&1; then
    run_file_stream_shell 'cat -- "$1" | gzip "-$3" -c'
    return
  fi
  run_file_read_command cat -- "$path"
}

[ -n "$path" ] || { echo "Path is required." >&2; exit 2; }
run_file_read_command test -f "$path" || { echo "Only regular files can be downloaded." >&2; exit 2; }
run_file_read_command sh -c 'test -r "$1"' sh "$path" || { echo "File is not readable. Check file permissions or passwordless sudo/doas for the ShellOrchestra service user." >&2; exit 2; }
stream_file
