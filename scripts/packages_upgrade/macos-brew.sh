#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
json_escape_file_tail() {
  tail -n 60 "$1" | awk 'BEGIN{printf "\""} {gsub(/[^[:print:]\t]/,"?"); gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); gsub(/\t/,"\\t"); printf "%s%s", sep, $0; sep="\\n"} END{printf "\""}'
}
json_string_list() {
  awk 'BEGIN{printf "["} NF {gsub(/[^[:print:]\t]/,"?"); gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); gsub(/\t/,"\\t"); printf "%s\"%s\"", sep, $0; sep=","} END{printf "]"}'
}
json_number_or_null() {
  case "${1:-}" in
    ''|*[!0123456789]*) printf 'null' ;;
    *) printf '%s' "$1" ;;
  esac
}
finish_json() {
  manager="$1"
  count="$2"
  packages_json="$3"
  preview_json=$(json_escape_file_tail "$shellorchestra_log")
  printf '{"ok":true,"manager":"%s","updated_count":%s,"updated_packages":%s,"output_preview":%s}\n' "$manager" "$(json_number_or_null "$count")" "$packages_json" "$preview_json"
}
if [ "${SHELLORCHESTRA_DRY_RUN:-0}" = "1" ] || [ "${SHELLORCHESTRA_CONFIRMED:-0}" != "1" ]; then
  printf '{"ok":true,"manager":"brew","dry_run":true}\n'
  exit 0
fi
shellorchestra_log=$(mktemp)
trap 'rm -f "$shellorchestra_log"' EXIT
if command -v brew >/dev/null 2>&1; then
  brew update >>"$shellorchestra_log" 2>&1
  brew upgrade >>"$shellorchestra_log" 2>&1
elif [ -x /opt/homebrew/bin/brew ]; then
  /opt/homebrew/bin/brew update >>"$shellorchestra_log" 2>&1
  /opt/homebrew/bin/brew upgrade >>"$shellorchestra_log" 2>&1
elif [ -x /usr/local/bin/brew ]; then
  /usr/local/bin/brew update >>"$shellorchestra_log" 2>&1
  /usr/local/bin/brew upgrade >>"$shellorchestra_log" 2>&1
else
  echo "Homebrew was not found on this server." >&2
  exit 1
fi
updated_packages_json=$(awk '/^==> Upgrading /{print $3}' "$shellorchestra_log" | sort -u | json_string_list)
updated_count=$(awk '/^==> Upgrading /{count++} END{if(count>0) print count; else print 0}' "$shellorchestra_log")
finish_json brew "$updated_count" "$updated_packages_json"
