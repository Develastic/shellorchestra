#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
PATH=$PATH:/usr/local/sbin:/usr/sbin:/sbin
action=${SHELLORCHESTRA_FIREWALL_ACTION:-}
rule=${SHELLORCHESTRA_FIREWALL_RULE:-}
rule_number=${SHELLORCHESTRA_FIREWALL_RULE_NUMBER:-}
ssh_port=${SHELLORCHESTRA_SSH_PORT:-22}
find_ufw() {
  if command -v ufw >/dev/null 2>&1; then
    command -v ufw
    return
  fi
  for candidate in /usr/sbin/ufw /sbin/ufw /usr/local/sbin/ufw; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  return 1
}
run_root() {
  if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then "$@"; elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo -n "$@"; elif command -v doas >/dev/null 2>&1 && doas -n true >/dev/null 2>&1; then doas -n "$@"; else echo "Root privileges are required for firewall actions." >&2; exit 1; fi
}
ssh_rule_present() {
  expected_port=$1
  awk -v port="$expected_port" '
    BEGIN { found = 0 }
    {
      line = tolower($0)
      if (line !~ /allow/ || line !~ /(^|[[:space:]])in([[:space:]]|$)/) {
        next
      }
      pattern = "(^|[^0-9])" port "(/tcp)?([^0-9]|$)"
      if (line ~ pattern || (port == "22" && line ~ /(^|[[:space:]])openssh([[:space:]]|$)/)) {
        found = 1
      }
    }
    END { exit found ? 0 : 1 }
  '
}
ufw_cmd=$(find_ufw || true)
if [ -z "$ufw_cmd" ]; then echo "UFW is required for this Firewall app profile." >&2; exit 1; fi
case "$ssh_port" in ''|*[!0123456789]*) ssh_port=22 ;; esac
case "$action" in
  enable)
    current_rules=$(run_root "$ufw_cmd" status numbered 2>/dev/null || true)
    if printf '%s\n' "$current_rules" | ssh_rule_present "$ssh_port"; then
      echo "Incoming SSH allow rule for port $ssh_port is already present." >&2
    else
      echo "Incoming SSH allow rule for port $ssh_port was not found. Adding allow $ssh_port/tcp before enabling UFW." >&2
      run_root "$ufw_cmd" allow "$ssh_port/tcp" >&2
    fi
    yes | run_root "$ufw_cmd" enable >&2
    ;;
  disable)
    run_root "$ufw_cmd" disable >&2
    ;;
  add_rule)
    if ! printf '%s' "$rule" | grep -Eq '^[A-Za-z0-9._:/ -]{1,160}$'; then
      echo "A safe UFW rule is required." >&2
      exit 1
    fi
    # shellcheck disable=SC2086
    run_root "$ufw_cmd" $rule >&2
    ;;
  delete_rule)
    case "$rule_number" in ''|*[!0123456789]*) echo "A numeric UFW rule number is required." >&2; exit 1 ;; esac
    yes | run_root "$ufw_cmd" delete "$rule_number" >&2
    ;;
  *) echo "Unsupported firewall action: $action" >&2; exit 1 ;;
esac
status=$(run_root "$ufw_cmd" status 2>/dev/null | head -1 || true)
printf '{"ok":true,"manager":"ufw","action":"%s","status":"%s"}\n' "$action" "$status"
