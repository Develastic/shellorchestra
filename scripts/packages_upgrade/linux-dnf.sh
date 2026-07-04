#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
run_root() {
  if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo -n "$@"
  elif command -v doas >/dev/null 2>&1 && doas -n true >/dev/null 2>&1; then
    doas -n "$@"
  else
    echo "Root privileges are required for package upgrades. Run as root or configure passwordless sudo/doas for the ShellOrchestra account." >&2
    exit 1
  fi
}
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
  printf '{"ok":true,"manager":"dnf","dry_run":true}\n'
  exit 0
fi
shellorchestra_log=$(mktemp)
trap 'rm -f "$shellorchestra_log"' EXIT
run_root dnf -y upgrade >>"$shellorchestra_log" 2>&1
updated_count=$(awk '/Upgraded:/{flag=1; next} flag && NF==0{flag=0} flag{count++} END{if(count>0) print count}' "$shellorchestra_log")
updated_packages_json=$(awk '/Upgraded:/{flag=1; next} flag && NF==0{flag=0} flag{print $1}' "$shellorchestra_log" | sort -u | json_string_list)
finish_json dnf "$updated_count" "$updated_packages_json"
