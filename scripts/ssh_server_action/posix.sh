#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
PATH=$PATH:/usr/local/sbin:/usr/sbin:/sbin

action=${SHELLORCHESTRA_SSH_SERVER_ACTION:-}
target_path=${SHELLORCHESTRA_SSH_SERVER_PATH:-}
target_content=${SHELLORCHESTRA_SSH_SERVER_CONTENT:-}
expected_hash=${SHELLORCHESTRA_SSH_SERVER_EXPECTED_HASH:-}
main_config=${SHELLORCHESTRA_SSH_SERVER_MAIN_CONFIG:-}
backup_path=${SHELLORCHESTRA_SSH_SERVER_BACKUP_PATH:-}

json_string() {
  awk 'BEGIN { value=ARGV[1]; ARGV[1]=""; gsub(/\\/,"\\\\",value); gsub(/"/,"\\\"",value); gsub(/\t/,"\\t",value); gsub(/\r/,"\\r",value); gsub(/\n/,"\\n",value); printf "\"%s\"", value }' "$1"
}

run_root() {
  if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then
    "$@"
    return
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo -n "$@"
    return
  fi
  if command -v doas >/dev/null 2>&1 && doas -n true >/dev/null 2>&1; then
    doas -n "$@"
    return
  fi
  echo "Root privileges are required to manage OpenSSH server configuration." >&2
  exit 1
}

run_optional_root() {
  if "$@"; then
    return 0
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo -n "$@"
    return
  fi
  if command -v doas >/dev/null 2>&1 && doas -n true >/dev/null 2>&1; then
    doas -n "$@"
    return
  fi
  return 1
}

safe_conf_name() {
  case "$1" in
    ''|.*|*/*|*'..'*|*[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-]*) return 1 ;;
  esac
  case "$1" in
    *.conf) return 0 ;;
    *) return 1 ;;
  esac
}

safe_config_path() {
  case "$1" in
    /etc/ssh/sshd_config|/usr/local/etc/ssh/sshd_config|/private/etc/ssh/sshd_config) return 0 ;;
    /etc/ssh/sshd_config.d/*.conf)
      name=${1#/etc/ssh/sshd_config.d/}
      safe_conf_name "$name"
      return
      ;;
    /usr/local/etc/ssh/sshd_config.d/*.conf)
      name=${1#/usr/local/etc/ssh/sshd_config.d/}
      safe_conf_name "$name"
      return
      ;;
    /private/etc/ssh/sshd_config.d/*.conf)
      name=${1#/private/etc/ssh/sshd_config.d/}
      safe_conf_name "$name"
      return
      ;;
    *) return 1 ;;
  esac
}

safe_backup_path() {
  case "$1" in
    /etc/ssh/.shellorchestra-backups/*|/usr/local/etc/ssh/.shellorchestra-backups/*|/private/etc/ssh/.shellorchestra-backups/*)
      case "$1" in *'/../'*|*'/..') return 1 ;; *) return 0 ;; esac
      ;;
    *) return 1 ;;
  esac
}

find_sshd() {
  for candidate in sshd /usr/sbin/sshd /usr/local/sbin/sshd /opt/homebrew/sbin/sshd /usr/libexec/sshd-keygen-wrapper; do
    if command -v "$candidate" >/dev/null 2>&1; then command -v "$candidate"; return 0; fi
    if [ -x "$candidate" ]; then printf '%s\n' "$candidate"; return 0; fi
  done
  return 1
}

default_main_config() {
  for candidate in /etc/ssh/sshd_config /usr/local/etc/ssh/sshd_config /private/etc/ssh/sshd_config; do
    if [ -f "$candidate" ]; then printf '%s\n' "$candidate"; return 0; fi
  done
  printf '%s\n' /etc/ssh/sshd_config
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    run_root sha256sum "$1" | awk '{print "sha256:" $1; exit}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    run_root shasum -a 256 "$1" | awk '{print "sha256:" $1; exit}'
    return
  fi
  if command -v openssl >/dev/null 2>&1; then
    run_root openssl dgst -sha256 -r "$1" | awk '{print "sha256:" $1; exit}'
    return
  fi
  echo "No SHA-256 tool is available on this server." >&2
  exit 1
}

write_content_to_tmp() {
  tmp=$1
  printf '%s' "$target_content" > "$tmp"
  printf '\n' >> "$tmp"
}

validate_config_file() {
  config_to_test=$1
  err_file=$2
  sshd_bin=$(find_sshd || true)
  if [ -z "$sshd_bin" ]; then
    echo "OpenSSH sshd binary was not found on this server." > "$err_file"
    return 1
  fi
  set +e
  run_optional_root "$sshd_bin" -t -f "$config_to_test" > /dev/null 2> "$err_file"
  status=$?
  set -e
  return "$status"
}

reload_ssh() {
  if command -v systemctl >/dev/null 2>&1; then
    for service in ssh sshd; do
      if systemctl list-unit-files "$service.service" >/dev/null 2>&1 || systemctl status "$service.service" >/dev/null 2>&1; then
        run_root systemctl reload "$service.service"
        return 0
      fi
    done
  fi
  if command -v rc-service >/dev/null 2>&1; then
    for service in sshd ssh; do
      if rc-service "$service" status >/dev/null 2>&1; then
        run_root rc-service "$service" reload
        return 0
      fi
    done
  fi
  if command -v service >/dev/null 2>&1; then
    for service in ssh sshd; do
      if service "$service" status >/dev/null 2>&1; then
        run_root service "$service" reload
        return 0
      fi
    done
  fi
  if [ "$(uname -s 2>/dev/null || true)" = "Darwin" ] && command -v launchctl >/dev/null 2>&1; then
    run_root launchctl kickstart -k system/com.openssh.sshd
    return 0
  fi
  return 2
}

result_json() {
  mode=$1
  ok=$2
  message=$3
  backup=${4:-}
  reloaded=${5:-false}
  printf '{"ok":%s,"action":' "$ok"
  json_string "$mode"
  printf ',"path":'
  json_string "$target_path"
  printf ',"backup_path":'
  json_string "$backup"
  printf ',"reloaded":%s,"message":' "$reloaded"
  json_string "$message"
  printf '}\n'
}

case "$action" in
  validate|apply|rollback) ;;
  *) echo "Unsupported SSH Server action: $action" >&2; exit 1 ;;
esac

if ! safe_config_path "$target_path"; then
  echo "Choose a supported OpenSSH server config file before saving." >&2
  exit 1
fi

if [ -z "$main_config" ]; then
  main_config=$(default_main_config)
fi
if ! safe_config_path "$main_config"; then
  echo "Choose a supported OpenSSH main config path before validation." >&2
  exit 1
fi

tmp=$(mktemp)
err=$(mktemp)
trap 'rm -f "$tmp" "$err"' EXIT HUP INT TERM

if [ "$action" = "validate" ]; then
  write_content_to_tmp "$tmp"
  if validate_config_file "$tmp" "$err"; then
    result_json validate true "Draft passed OpenSSH sshd syntax validation." "" false
    exit 0
  fi
  cat "$err" >&2
  exit 1
fi

if [ "$action" = "rollback" ]; then
  if ! safe_backup_path "$backup_path"; then
    echo "Choose a ShellOrchestra OpenSSH backup before rollback." >&2
    exit 1
  fi
  run_root test -f "$backup_path" || { echo "The selected OpenSSH backup file does not exist." >&2; exit 1; }
  run_root cp -p "$backup_path" "$target_path"
  if ! validate_config_file "$main_config" "$err"; then
    cat "$err" >&2
    exit 1
  fi
  reloaded=false
  if reload_ssh >/dev/null 2>"$err"; then
    reloaded=true
    result_json rollback true "Backup restored and OpenSSH service reloaded." "$backup_path" true
  else
    result_json rollback true "Backup restored and validated, but ShellOrchestra could not reload OpenSSH automatically. Reload sshd manually." "$backup_path" false
  fi
  exit 0
fi

[ -f "$target_path" ] || { echo "The target OpenSSH config file does not exist." >&2; exit 1; }
current_hash=$(sha256_file "$target_path")
if [ "$current_hash" != "$expected_hash" ]; then
  echo "OpenSSH config changed after it was loaded. Refresh SSH Server before applying this draft." >&2
  exit 1
fi

write_content_to_tmp "$tmp"
backup_dir=$(dirname "$target_path")/.shellorchestra-backups
backup_name=$(basename "$target_path").$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || date +%s).bak
backup_file=$backup_dir/$backup_name
run_root install -d -o root -g root -m 0700 "$backup_dir"
run_root cp -p "$target_path" "$backup_file"
run_root cp "$tmp" "$target_path"
if ! validate_config_file "$main_config" "$err"; then
  run_root cp -p "$backup_file" "$target_path"
  cat "$err" >&2
  echo "OpenSSH validation failed. ShellOrchestra restored the previous config from backup." >&2
  exit 1
fi
if reload_ssh >/dev/null 2>"$err"; then
  result_json apply true "OpenSSH config was validated, saved, backed up, and the service was reloaded." "$backup_file" true
else
  result_json apply true "OpenSSH config was validated and saved, but ShellOrchestra could not reload OpenSSH automatically. Reload sshd manually." "$backup_file" false
fi
