#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu

HELPER_NAME="ShellOrchestra SSH key setup helper"
CA_FILE="/etc/ssh/shellorchestra_user_ca.pub"
CA_CONF_DIR="/etc/ssh/sshd_config.d"
CA_CONF_FILE="$CA_CONF_DIR/99-shellorchestra-user-ca.conf"
MAIN_SSHD_CONFIG="/etc/ssh/sshd_config"
tmp_files=""

preflight_os="not checked"
preflight_privileges="not checked"
preflight_sshd_bin=""
preflight_sshd_version="not checked"
preflight_sshd_config="$MAIN_SSHD_CONFIG"
preflight_ca_config_target="not selected"
preflight_reload_method="not required"
preflight_remote_login="not checked"
service_user_report="not requested"
configuration_test_report="not run"
install_report="not run"
reload_report="not required"
report_warnings=""
report_started="0"
NL='
'

info() {
  printf '%s: %s\n' "$HELPER_NAME" "$*" >&2
}

add_warning() {
  if [ -n "$report_warnings" ]; then
    report_warnings="$report_warnings$NL  - $*"
  else
    report_warnings="  - $*"
  fi
}

print_final_report() {
  result="$1"
  printf '\n%s final report\n' "$HELPER_NAME" >&2
  printf '  Result: %s\n' "$result" >&2
  printf '  Mode: %s\n' "$mode" >&2
  printf '  Platform: %s\n' "$preflight_os" >&2
  printf '  Privileges: %s\n' "$preflight_privileges" >&2
  printf '  OpenSSH server: %s\n' "${preflight_sshd_bin:-not found}" >&2
  printf '  OpenSSH version: %s\n' "$preflight_sshd_version" >&2
  printf '  SSH config checked: %s\n' "$preflight_sshd_config" >&2
  printf '  CA config target: %s\n' "$preflight_ca_config_target" >&2
  printf '  Remote Login: %s\n' "$preflight_remote_login" >&2
  printf '  Service user: %s\n' "$service_user_report" >&2
  printf '  Configuration test: %s\n' "$configuration_test_report" >&2
  printf '  Installed/updated: %s\n' "$install_report" >&2
  printf '  Reload/restart: %s\n' "$reload_report" >&2
  if [ -n "$report_warnings" ]; then
    printf '  Warnings:\n%s\n' "$report_warnings" >&2
  fi
}

confirm_auto_setup() {
  issue="$1"
  action="$2"
  if [ "$assume_yes" = "1" ]; then
    add_warning "$issue Auto-approved by --yes: $action"
    return
  fi
  if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
    fail "$issue Automatic setup requires confirmation from a terminal. Fix it manually or rerun this helper with --yes if you intentionally want ShellOrchestra to try: $action"
  fi
  {
    printf '\n%s found a host setup issue:\n' "$HELPER_NAME"
    printf '  %s\n' "$issue"
    printf 'Proposed automatic fix:\n'
    printf '  %s\n' "$action"
    printf 'Do you want ShellOrchestra to try this fix now? Type YES to continue: '
  } >/dev/tty
  IFS= read -r answer </dev/tty || answer=""
  [ "$answer" = "YES" ] || fail "$issue Automatic setup was declined. Fix it manually or rerun this helper and approve the automatic setup."
}

fail() {
  printf '%s error: %s\n' "$HELPER_NAME" "$*" >&2
  if [ "$report_started" = "1" ]; then
    print_final_report "failed"
  fi
  exit 1
}

cleanup() {
  for tmp_file in $tmp_files; do
    [ -n "$tmp_file" ] && rm -f "$tmp_file"
  done
}

trap cleanup EXIT
trap 'cleanup; exit 1' HUP INT TERM

make_temp() {
  if tmp_file=$(mktemp "${TMPDIR:-/tmp}/shellorchestra.XXXXXX"); then
    tmp_files="$tmp_files $tmp_file"
    printf '%s\n' "$tmp_file"
    return
  fi
  fail "mktemp failed"
}

usage() {
  cat >&2 <<'USAGE'
ShellOrchestra SSH key setup helper

Usage:
  sh install-posix.sh <CA_KEY_B64URL>
  sh install-posix.sh --ca <CA_KEY_B64URL>
  sh install-posix.sh --create-user --account sh-orchestra <CA_KEY_B64URL>
  sh install-posix.sh --yes --create-user --account sh-orchestra <CA_KEY_B64URL>
  sh install-posix.sh --classic [--account USER] <AUTHORIZED_KEYS_LINE_B64URL>
  sh install-posix.sh --classic --create-user --account sh-orchestra <AUTHORIZED_KEYS_LINE_B64URL>

The helper detects the supported POSIX platform before changing SSH
configuration. The default mode writes a ShellOrchestra SSH CA public key and
configures OpenSSH TrustedUserCAKeys. Classic mode writes one permanent
authorized_keys line for one account and should be used only when the server
deliberately does not use SSH CA certificates. The optional --create-user mode
creates the selected service account and configures passwordless sudo or doas
for it before writing SSH trust/key configuration.

On macOS, if Remote Login is disabled, the helper explains the finding and asks
before enabling it with systemsetup. Use --yes only when you intentionally want
those OpenSSH setup prompts approved automatically.
USAGE
}

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
    return
  fi
  if command -v doas >/dev/null 2>&1; then
    doas "$@"
    return
  fi
  fail "root privileges are required. Run this helper as root, or install/configure sudo or doas first"
}

mode="ca"
target_account="${SHELLORCHESTRA_TARGET_USER:-root}"
encoded_payload=""
create_user="0"
assume_yes="0"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ca)
      mode="ca"
      shift
      ;;
    --classic)
      mode="classic"
      shift
      ;;
    --account)
      shift
      [ "$#" -gt 0 ] || fail "--account requires a user name"
      target_account="$1"
      shift
      ;;
    --create-user)
      create_user="1"
      shift
      ;;
    --yes)
      assume_yes="1"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --*)
      fail "unsupported option: $1"
      ;;
    *)
      [ -z "$encoded_payload" ] || fail "only one encoded key payload is allowed"
      encoded_payload="$1"
      shift
      ;;
  esac
done

[ -n "$encoded_payload" ] || fail "encoded key payload is required"
[ -n "$target_account" ] || fail "target account cannot be empty"

base64_decode() {
  if command -v base64 >/dev/null 2>&1; then
    case "$(uname -s)" in
      Darwin|FreeBSD|OpenBSD|NetBSD)
        base64 -D
        ;;
      *)
        base64 -d
        ;;
    esac
    return
  fi
  fail "base64 command is required to decode the key payload"
}

decode_base64url() {
  value="$1"
  case "$value" in
    *[!A-Za-z0-9_-]*)
      fail "encoded key payload contains characters outside base64url"
      ;;
  esac
  length_mod=$((${#value} % 4))
  case "$length_mod" in
    0) padding="" ;;
    2) padding="==" ;;
    3) padding="=" ;;
    *) fail "encoded key payload has invalid base64url length" ;;
  esac
  printf '%s%s' "$value" "$padding" | tr '_-' '/+' | base64_decode
}

payload=$(decode_base64url "$encoded_payload" | tr -d '\r')
payload=$(printf '%s' "$payload" | sed 's/[[:space:]]*$//')
[ -n "$payload" ] || fail "decoded key payload is empty"

validate_service_user_name() {
  name="$1"
  [ "$name" != "root" ] || fail "service user name cannot be root"
  case "$name" in
    *[!abcdefghijklmnopqrstuvwxyz0123456789_-]*|[!abcdefghijklmnopqrstuvwxyz_]*|"")
      fail "service user name must start with a lowercase letter or underscore and contain only lowercase letters, digits, underscore, or hyphen"
      ;;
  esac
  [ "${#name}" -le 31 ] || fail "service user name must be 31 characters or shorter"
}

validate_ca_key() {
  key="$1"
  case "$1" in
    *"
"*)
      fail "decoded CA key must be a single line"
      ;;
  esac
  key_type=${key%%[	 ]*}
  [ "$key_type" != "$key" ] || fail "decoded CA key is not an OpenSSH public key"
  [ "$key_type" = "ssh-ed25519" ] || fail "ShellOrchestra currently expects an ssh-ed25519 public key"
}

validate_authorized_key_line() {
  line="$1"
  case "$line" in
    *"
"*)
      fail "decoded classic payload must be a single authorized_keys line"
      ;;
  esac
  case "$line" in
    ssh-ed25519\ *|from=\"*\"\ ssh-ed25519\ *)
      return
      ;;
  esac
  fail "decoded classic payload must be an ssh-ed25519 authorized_keys line"
}

find_optional_command() {
  name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
    return
  fi
  for candidate in "/usr/sbin/$name" "/sbin/$name" "/usr/bin/$name" "/bin/$name"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  return 1
}

find_command() {
  name="$1"
  if find_optional_command "$name"; then
    return
  fi
  fail "$name command is required"
}

read_sshd_version() {
  sshd_bin="$1"
  version=$("$sshd_bin" -V 2>&1 || true)
  version=$(printf '%s\n' "$version" | sed -n '1p')
  if [ -n "$version" ]; then
    printf '%s\n' "$version"
  else
    printf 'version not reported by sshd -V\n'
  fi
}

ensure_macos_remote_login_enabled() {
  find_command systemsetup >/dev/null
  status=$(systemsetup -getremotelogin 2>/dev/null || true)
  case "$status" in
    *": On"|*" On")
      preflight_remote_login="enabled"
      return
      ;;
  esac
  preflight_remote_login="${status:-disabled or unknown}"
  confirm_auto_setup "macOS Remote Login is not enabled (${status:-status unavailable})." "Enable Remote Login with systemsetup -setremotelogin on so OpenSSH can accept inbound SSH connections."
  run_root systemsetup -setremotelogin on >/dev/null
  status=$(systemsetup -getremotelogin 2>/dev/null || true)
  case "$status" in
    *": On"|*" On")
      preflight_remote_login="enabled by helper"
      ;;
    *)
      fail "macOS Remote Login still does not report enabled after systemsetup -setremotelogin on"
      ;;
  esac
}

detect_linux_reload_method() {
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl list-unit-files sshd.service 2>/dev/null | grep -q '^sshd\.service[[:space:]]'; then
      printf 'systemctl reload sshd\n'
      return
    fi
    if systemctl list-unit-files ssh.service 2>/dev/null | grep -q '^ssh\.service[[:space:]]'; then
      printf 'systemctl reload ssh\n'
      return
    fi
  fi
  if command -v service >/dev/null 2>&1; then
    if service sshd status >/dev/null 2>&1; then
      printf 'service sshd reload\n'
      return
    fi
    if service ssh status >/dev/null 2>&1; then
      printf 'service ssh reload\n'
      return
    fi
  fi
  printf 'not detected\n'
}

preflight_environment() {
  report_started="1"
  preflight_os=$(uname -s)
  case "$preflight_os" in
    Linux|Darwin)
      ;;
    *)
      fail "unsupported operating system: $preflight_os"
      ;;
  esac

  if [ "$(id -u)" -eq 0 ]; then
    preflight_privileges="running as root"
  else
    if command -v sudo >/dev/null 2>&1; then
      preflight_privileges="sudo available; commands requiring changes will run through sudo"
    elif command -v doas >/dev/null 2>&1; then
      preflight_privileges="doas available; commands requiring changes will run through doas"
    else
      fail "root privileges are required. Run this helper as root, or install/configure sudo or doas first"
    fi
  fi

  preflight_sshd_bin=$(find_command sshd)
  [ -f "$MAIN_SSHD_CONFIG" ] || fail "OpenSSH server config was not found at $MAIN_SSHD_CONFIG"
  preflight_sshd_version=$(read_sshd_version "$preflight_sshd_bin")

  case "$preflight_os" in
    Linux)
      preflight_remote_login="not applicable on Linux"
      if [ "$mode" = "ca" ]; then
        if [ -d "$CA_CONF_DIR" ] || grep -Eq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf' "$MAIN_SSHD_CONFIG" 2>/dev/null; then
          preflight_ca_config_target="$CA_CONF_FILE"
        else
          preflight_ca_config_target="$MAIN_SSHD_CONFIG"
          add_warning "sshd_config.d include was not detected; CA trust will be appended to $MAIN_SSHD_CONFIG."
        fi
      else
        preflight_ca_config_target="not used in classic mode"
      fi
      preflight_reload_method=$(detect_linux_reload_method)
      [ "$preflight_reload_method" != "not detected" ] || fail "OpenSSH reload method was not detected. Start/reload ssh or sshd manually, then rerun this helper."
      ;;
    Darwin)
      preflight_ca_config_target="$MAIN_SSHD_CONFIG"
      preflight_reload_method="launchctl kickstart -k system/com.openssh.sshd"
      find_command launchctl >/dev/null
      ensure_macos_remote_login_enabled
      ;;
  esac

  if [ "$create_user" = "1" ]; then
    validate_service_user_name "$target_account"
    case "$preflight_os" in
      Linux)
        if ! find_optional_command useradd >/dev/null 2>&1 && ! find_optional_command adduser >/dev/null 2>&1; then
          fail "useradd or adduser is required before creating $target_account"
        fi
        if command -v sudo >/dev/null 2>&1 || [ -x /usr/bin/sudo ] || [ -x /bin/sudo ]; then
          find_command visudo >/dev/null
        elif ! command -v doas >/dev/null 2>&1; then
          fail "sudo or doas is required before configuring passwordless admin rights for $target_account"
        fi
        ;;
      Darwin)
        find_command sysadminctl >/dev/null
        find_command dseditgroup >/dev/null
        find_command createhomedir >/dev/null
        ;;
    esac
    service_user_report="$target_account (will be created if missing, then configured for passwordless sudo or doas)"
  elif [ "$mode" = "classic" ]; then
    if ! id "$target_account" >/dev/null 2>&1; then
      fail "target account was not found: $target_account"
    fi
    service_user_report="existing account $target_account"
  fi

  case "$preflight_os" in
    Darwin)
      run_root "$preflight_sshd_bin" -t -f "$MAIN_SSHD_CONFIG"
      ;;
    *)
      run_root "$preflight_sshd_bin" -t
      ;;
  esac
  configuration_test_report="passed before changes"
  info "Preflight passed: $preflight_os, $preflight_sshd_version, reload method: $preflight_reload_method"
}

install_sudoers_file() {
  sudoers_file="$1"
  sudoers_group="${2:-root}"
  tmp_file=$(make_temp)
  printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$target_account" > "$tmp_file"
  run_root install -d -o root -g "$sudoers_group" -m 0750 "$(dirname "$sudoers_file")"
  run_root install -o root -g "$sudoers_group" -m 0440 "$tmp_file" "$sudoers_file"
  visudo_bin=$(find_command visudo)
  run_root "$visudo_bin" -cf "$sudoers_file"
}

install_doas_file() {
  doas_file="/etc/doas.d/shellorchestra-$target_account.conf"
  tmp_file=$(make_temp)
  printf 'permit nopass %s as root\n' "$target_account" > "$tmp_file"
  run_root install -d -o root -g root -m 0750 "$(dirname "$doas_file")"
  run_root install -o root -g root -m 0440 "$tmp_file" "$doas_file"
}

ensure_ssh_service_account_not_locked() {
  shadow_password=$(run_root awk -F: -v user="$target_account" '$1 == user { print $2 }' /etc/shadow 2>/dev/null || true)
  case "$shadow_password" in
    \!*)
      usermod_bin=$(find_optional_command usermod) || fail "usermod is required to make $target_account usable for SSH certificate login"
      run_root "$usermod_bin" -p '*' "$target_account"
      info "Service user $target_account had a locked shadow password; changed it to an invalid non-locked password hash so OpenSSH can evaluate public-key/certificate authentication."
      ;;
  esac
}

ensure_service_user_linux() {
  validate_service_user_name "$target_account"
  created="no"
  if ! id "$target_account" >/dev/null 2>&1; then
    if useradd_bin=$(find_optional_command useradd); then
      run_root "$useradd_bin" --create-home --shell /bin/sh "$target_account"
    elif adduser_bin=$(find_optional_command adduser); then
      run_root "$adduser_bin" -D -s /bin/sh "$target_account"
    else
      fail "useradd or adduser is required before creating $target_account"
    fi
    created="yes"
  fi
  ensure_ssh_service_account_not_locked
  if command -v sudo >/dev/null 2>&1 || [ -x /usr/bin/sudo ] || [ -x /bin/sudo ]; then
    install_sudoers_file "/etc/sudoers.d/shellorchestra-$target_account"
    admin_method="passwordless sudo"
  elif command -v doas >/dev/null 2>&1; then
    install_doas_file
    admin_method="passwordless doas"
  else
    fail "sudo or doas is required before configuring passwordless admin rights for $target_account"
  fi
  if [ "$created" = "yes" ]; then
    service_user_report="$target_account created with /bin/sh and $admin_method"
  else
    service_user_report="$target_account already existed; $admin_method configured"
  fi
  info "Service user $target_account exists and has $admin_method."
}

random_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32
    return
  fi
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen
    return
  fi
  fail "openssl or uuidgen is required to create a random service-user password"
}

next_macos_uid() {
  last_uid=$(dscl . -list /Users UniqueID 2>/dev/null | awk '$2 >= 501 && $2 < 60000 {print $2}' | sort -n | tail -1)
  if [ -z "$last_uid" ]; then
    printf '501\n'
    return
  fi
  printf '%s\n' "$((last_uid + 1))"
}

ensure_service_user_macos() {
  validate_service_user_name "$target_account"
  created="no"
  if ! id "$target_account" >/dev/null 2>&1; then
    sysadminctl_bin=$(find_command sysadminctl)
    password=$(random_password)
    uid=$(next_macos_uid)
    run_root "$sysadminctl_bin" -addUser "$target_account" -fullName "ShellOrchestra" -UID "$uid" -shell /bin/zsh -password "$password"
    createhomedir_bin=$(find_command createhomedir)
    run_root "$createhomedir_bin" -c -u "$target_account"
    created="yes"
  fi
  dseditgroup_bin=$(find_command dseditgroup)
  run_root "$dseditgroup_bin" -o edit -a "$target_account" -t user admin
  install_sudoers_file "/private/etc/sudoers.d/shellorchestra-$target_account" wheel
  if [ "$created" = "yes" ]; then
    service_user_report="$target_account created with /bin/zsh, admin group membership, and passwordless sudo"
  else
    service_user_report="$target_account already existed; admin group membership and passwordless sudo verified"
  fi
  info "Service user $target_account exists and has passwordless sudo."
}

ensure_service_user() {
  [ "$create_user" = "1" ] || return
  case "$(uname -s)" in
    Linux)
      ensure_service_user_linux
      ;;
    Darwin)
      ensure_service_user_macos
      ;;
    *)
      fail "service user creation is not supported on this operating system: $(uname -s)"
      ;;
  esac
}

linux_sshd_reload() {
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl list-unit-files sshd.service 2>/dev/null | grep -q '^sshd\.service[[:space:]]'; then
      run_root systemctl reload sshd
      reload_report="systemctl reload sshd completed"
      return
    fi
    if systemctl list-unit-files ssh.service 2>/dev/null | grep -q '^ssh\.service[[:space:]]'; then
      run_root systemctl reload ssh
      reload_report="systemctl reload ssh completed"
      return
    fi
  fi
  if command -v service >/dev/null 2>&1; then
    if service sshd status >/dev/null 2>&1; then
      run_root service sshd reload
      reload_report="service sshd reload completed"
      return
    fi
    if service ssh status >/dev/null 2>&1; then
      run_root service ssh reload
      reload_report="service ssh reload completed"
      return
    fi
  fi
  fail "OpenSSH configuration is valid, but SSH reload method was not detected. Reload ssh or sshd manually."
}

install_ca_linux() {
  tmp_file=$(make_temp)
  printf '%s\n' "$payload" > "$tmp_file"
  run_root install -d -o root -g root -m 0755 "$(dirname "$CA_FILE")"
  run_root install -o root -g root -m 0644 "$tmp_file" "$CA_FILE"

  if [ -d "$CA_CONF_DIR" ] || grep -Eq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf' "$MAIN_SSHD_CONFIG" 2>/dev/null; then
    run_root install -d -o root -g root -m 0755 "$CA_CONF_DIR"
    printf 'TrustedUserCAKeys %s\n' "$CA_FILE" | run_root tee "$CA_CONF_FILE" >/dev/null
    preflight_ca_config_target="$CA_CONF_FILE"
  elif grep -Eq '^[[:space:]]*TrustedUserCAKeys[[:space:]]+' "$MAIN_SSHD_CONFIG" 2>/dev/null; then
    fail "TrustedUserCAKeys is already configured in $MAIN_SSHD_CONFIG. Update it manually or remove the old directive before using this helper."
  else
    printf '\n# ShellOrchestra SSH CA\nTrustedUserCAKeys %s\n' "$CA_FILE" | run_root tee -a "$MAIN_SSHD_CONFIG" >/dev/null
    preflight_ca_config_target="$MAIN_SSHD_CONFIG"
  fi

  run_root "${preflight_sshd_bin:-$(find_command sshd)}" -t
  configuration_test_report="passed after CA configuration change"
  install_report="CA public key written to $CA_FILE; TrustedUserCAKeys configured in $preflight_ca_config_target"
  linux_sshd_reload
}

install_ca_macos() {
  tmp_file=$(make_temp)
  printf '%s\n' "$payload" > "$tmp_file"
  run_root install -o root -g wheel -m 0644 "$tmp_file" "$CA_FILE"

  if ! grep -Eq '^[[:space:]]*TrustedUserCAKeys[[:space:]]+/etc/ssh/shellorchestra_user_ca\.pub[[:space:]]*$' "$MAIN_SSHD_CONFIG" 2>/dev/null; then
    if grep -Eq '^[[:space:]]*TrustedUserCAKeys[[:space:]]+' "$MAIN_SSHD_CONFIG" 2>/dev/null; then
      fail "TrustedUserCAKeys is already configured in $MAIN_SSHD_CONFIG. Update it manually or remove the old directive before using this helper."
    fi
    printf '\n# ShellOrchestra SSH CA\nTrustedUserCAKeys %s\n' "$CA_FILE" | run_root tee -a "$MAIN_SSHD_CONFIG" >/dev/null
  fi

  run_root "${preflight_sshd_bin:-/usr/sbin/sshd}" -t -f "$MAIN_SSHD_CONFIG"
  configuration_test_report="passed after CA configuration change"
  install_report="CA public key written to $CA_FILE; TrustedUserCAKeys configured in $MAIN_SSHD_CONFIG"
  run_root launchctl kickstart -k system/com.openssh.sshd
  reload_report="launchctl kickstart -k system/com.openssh.sshd completed"
}

account_home_linux() {
  if [ "$target_account" = "root" ]; then
    printf '/root\n'
    return
  fi
  if command -v getent >/dev/null 2>&1; then
    home=$(getent passwd "$target_account" | awk -F: '{print $6}')
    [ -n "$home" ] || fail "target account was not found: $target_account"
    printf '%s\n' "$home"
    return
  fi
  fail "getent is required to locate non-root target accounts on this platform"
}

account_home_macos() {
  if [ "$target_account" = "root" ]; then
    printf '/var/root\n'
    return
  fi
  home=$(dscl . -read "/Users/$target_account" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
  [ -n "$home" ] || fail "target account was not found: $target_account"
  printf '%s\n' "$home"
}

install_classic_authorized_key() {
  home_dir="$1"
  key_line="$payload"
  group_name=$(id -gn "$target_account")
  ssh_dir="$home_dir/.ssh"
  authorized_keys="$ssh_dir/authorized_keys"

  run_root install -d -o "$target_account" -g "$group_name" -m 0700 "$ssh_dir"
  run_root touch "$authorized_keys"
  run_root chown "$target_account:$group_name" "$authorized_keys"
  run_root chmod 0600 "$authorized_keys"
  if ! run_root grep -qxF "$key_line" "$authorized_keys" 2>/dev/null; then
    printf '%s\n' "$key_line" | run_root tee -a "$authorized_keys" >/dev/null
    install_report="classic authorized_keys line appended to $authorized_keys"
  else
    install_report="classic authorized_keys line already present in $authorized_keys"
  fi
  reload_report="not required for authorized_keys changes"
}

case "$mode" in
  ca)
    validate_ca_key "$payload"
    preflight_environment
    case "$preflight_os" in
      Linux)
        ensure_service_user
        info "Installing ShellOrchestra SSH CA public key for Linux OpenSSH"
        install_ca_linux
        ;;
      Darwin)
        ensure_service_user
        info "Installing ShellOrchestra SSH CA public key for macOS OpenSSH"
        install_ca_macos
        ;;
      *)
        fail "unsupported operating system for CA installation: $preflight_os"
        ;;
    esac
    info "Done. This server now trusts ShellOrchestra short-lived SSH certificates."
    print_final_report "success"
    ;;
  classic)
    validate_authorized_key_line "$payload"
    preflight_environment
    case "$preflight_os" in
      Linux)
        ensure_service_user
        info "Installing ShellOrchestra classic fallback key for account: $target_account"
        install_classic_authorized_key "$(account_home_linux)"
        ;;
      Darwin)
        ensure_service_user
        info "Installing ShellOrchestra classic fallback key for account: $target_account"
        install_classic_authorized_key "$(account_home_macos)"
        ;;
      *)
        fail "unsupported operating system for classic fallback installation: $preflight_os"
        ;;
    esac
    info "Done. Classic permanent-key fallback was installed for $target_account."
    print_final_report "success"
    ;;
  *)
    fail "unsupported install mode: $mode"
    ;;
esac
