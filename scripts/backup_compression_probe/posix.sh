#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
export LC_ALL=C

zstd_available=false
gzip_available=false
tar_available=false
zstd_version=''
gzip_version=''
tar_version=''
if command -v zstd >/dev/null 2>&1; then
  zstd_available=true
  zstd_version=$(zstd --version 2>/dev/null | head -n 1 || printf '')
fi
if command -v gzip >/dev/null 2>&1; then
  gzip_available=true
  gzip_version=$(gzip --version 2>/dev/null | head -n 1 || printf '')
fi
if command -v tar >/dev/null 2>&1; then
  tar_available=true
  tar_version=$(tar --version 2>/dev/null | head -n 1 || printf 'tar')
fi
json_string() {
  if [ "$#" -eq 0 ] || [ -z "$1" ]; then printf '""'; return; fi
  printf '%s' "$1" | awk 'BEGIN { ORS = "" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "\\r"); gsub(/\n/, "\\n"); printf "\"%s\"", $0 }'
}
recommended=none
if [ "$gzip_available" = true ]; then recommended=gzip; fi
if [ "$zstd_available" = true ]; then recommended=zstd; fi
printf '{"ok":true,"tar_available":%s,"zstd_available":%s,"gzip_available":%s,"recommended":"' "$tar_available" "$zstd_available" "$gzip_available"
printf '%s' "$recommended"
printf '","tar_version":'
json_string "$tar_version"
printf ',"zstd_version":'
json_string "$zstd_version"
printf ',"gzip_version":'
json_string "$gzip_version"
printf '}\n'
