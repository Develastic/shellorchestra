#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
json_string() { awk 'BEGIN { value=ARGV[1]; ARGV[1]=""; gsub(/\\/,"\\\\",value); gsub(/"/,"\\\"",value); gsub(/\t/,"\\t",value); gsub(/\r/,"\\r",value); gsub(/\n/,"\\n",value); printf "\"%s\"", value }' "$1"; }
generated_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || printf '')
status_text=''
rules_text=''
if [ -x /usr/libexec/ApplicationFirewall/socketfilterfw ]; then
  status_text=$(/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>&1 || true)
  status_text="$status_text
$(/usr/libexec/ApplicationFirewall/socketfilterfw --getblockall 2>&1 || true)
$(/usr/libexec/ApplicationFirewall/socketfilterfw --getstealthmode 2>&1 || true)"
  rules_text=$(/usr/libexec/ApplicationFirewall/socketfilterfw --listapps 2>&1 || true)
fi
printf '{"generated_at":"%s","manager":"macos_application_firewall","status_text":' "$generated_at"
json_string "$status_text"
printf ',"rules_text":'
json_string "$rules_text"
printf '}\n'
