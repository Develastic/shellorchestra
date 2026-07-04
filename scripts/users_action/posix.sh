#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu

action=${SHELLORCHESTRA_USER_ACTION:-}
target_user=${SHELLORCHESTRA_USER_NAME:-}
password=${SHELLORCHESTRA_USER_PASSWORD:-}
full_name=${SHELLORCHESTRA_USER_FULL_NAME:-}
create_home=${SHELLORCHESTRA_USER_CREATE_HOME:-true}
admin=${SHELLORCHESTRA_USER_ADMIN:-false}
remove_home=${SHELLORCHESTRA_USER_REMOVE_HOME:-false}
ssh_key=${SHELLORCHESTRA_USER_SSH_KEY:-}
target_group=${SHELLORCHESTRA_USER_GROUP:-}
dry_run=${SHELLORCHESTRA_DRY_RUN:-0}

json_string() {
  awk 'BEGIN { value=ARGV[1]; ARGV[1]=""; gsub(/\\/,"\\\\",value); gsub(/"/,"\\\"",value); gsub(/\t/,"\\t",value); gsub(/\r/,"\\r",value); gsub(/\n/,"\\n",value); printf "\"%s\"", value }' "$1"
}

safe_local_user_name() {
  case "$1" in
    ''|*[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-]*|[-.]*|*[.-]) return 1 ;;
    *) return 0 ;;
  esac
}

safe_user_name() {
  safe_local_user_name "$1" || return 1
  case "$1" in
    root|Administrator|Guest) return 1 ;;
    *) return 0 ;;
  esac
}

safe_user_name_for_action() {
  safe_local_user_name "$1" || return 1
  case "$action:$1" in
    add_ssh_key:Guest|remove_ssh_key:Guest) return 1 ;;
    add_ssh_key:*|remove_ssh_key:*) return 0 ;;
    *:root|*:Administrator|*:Guest) return 1 ;;
    *) return 0 ;;
  esac
}

safe_group_name() {
  case "$1" in
    ''|*[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-]*|[-.]*|*[.-]) return 1 ;;
    *) return 0 ;;
  esac
}

root_prefix=
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
  echo "Root privileges are required to manage users." >&2
  exit 1
}

run_root_stdin() {
  run_root "$@"
}

success() {
  printf '{"ok":true,"action":'
  json_string "$action"
  printf ',"user":'
  json_string "$target_user"
  printf ',"message":'
  json_string "$1"
  printf '}
'
}

admin_group() {
  if getent group sudo >/dev/null 2>&1; then printf 'sudo'; return 0; fi
  if getent group wheel >/dev/null 2>&1; then printf 'wheel'; return 0; fi
  if getent group admin >/dev/null 2>&1; then printf 'admin'; return 0; fi
  echo "No sudo, wheel, or admin group was found on this server." >&2
  return 1
}

set_admin_rights() {
  group=$(admin_group)
  if [ "$admin" = "true" ]; then
    if command -v usermod >/dev/null 2>&1; then
      run_root usermod -aG "$group" "$target_user"
    elif command -v adduser >/dev/null 2>&1; then
      run_root adduser "$target_user" "$group"
    else
      echo "usermod or adduser is required to grant administrator rights." >&2
      exit 1
    fi
    success "Administrator rights were granted."
  else
    if command -v gpasswd >/dev/null 2>&1; then
      run_root gpasswd -d "$target_user" "$group" >/dev/null 2>&1 || true
    elif command -v deluser >/dev/null 2>&1; then
      run_root deluser "$target_user" "$group" >/dev/null 2>&1 || true
    else
      echo "gpasswd or deluser is required to remove administrator rights." >&2
      exit 1
    fi
    success "Administrator rights were removed."
  fi
}

case "$action" in
  create|edit|set_password|lock|unlock|set_admin|add_group|remove_group|delete|add_ssh_key|remove_ssh_key) ;;
  *) echo "Unsupported user action: $action" >&2; exit 1 ;;
esac
if ! safe_user_name_for_action "$target_user"; then
  case "$action" in
    add_ssh_key|remove_ssh_key) echo "Choose a valid local account name before editing authorized_keys." >&2 ;;
    *) echo "Choose a valid non-root user name before running this action." >&2 ;;
  esac
  exit 1
fi
if [ "$dry_run" = "1" ]; then
  success "Dry run completed."
  exit 0
fi

set_password() {
  if [ -z "$password" ]; then
    echo "Password is required for this action." >&2
    exit 1
  fi
  if ! command -v chpasswd >/dev/null 2>&1; then
    echo "chpasswd is required to set passwords on this server." >&2
    exit 1
  fi
  printf '%s:%s\n' "$target_user" "$password" | run_root_stdin chpasswd
}

safe_ssh_public_key() {
  case "$1" in
    ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-nistp256\ *|ecdsa-sha2-nistp384\ *|ecdsa-sha2-nistp521\ *) ;;
    *) return 1 ;;
  esac
  if printf '%s' "$1" | grep -q '[[:cntrl:]]'; then return 1; fi
  [ "${#1}" -le 8192 ] || return 1
  return 0
}

authorized_keys_path_for_user() {
  awk -F: -v user="$target_user" '$1 == user { print $6 "/.ssh/authorized_keys"; exit }' /etc/passwd
}

require_existing_group() {
  if ! safe_group_name "$target_group"; then
    echo "Choose a valid local group name." >&2
    exit 1
  fi
  if ! getent group "$target_group" >/dev/null 2>&1; then
    echo "Group was not found: $target_group" >&2
    exit 1
  fi
}

add_user_to_group() {
  require_existing_group
  if command -v usermod >/dev/null 2>&1; then
    run_root usermod -aG "$target_group" "$target_user"
  elif command -v adduser >/dev/null 2>&1; then
    run_root adduser "$target_user" "$target_group"
  else
    echo "usermod or adduser is required to add users to groups." >&2
    exit 1
  fi
  success "User was added to the group."
}

remove_user_from_group() {
  require_existing_group
  if command -v gpasswd >/dev/null 2>&1; then
    run_root gpasswd -d "$target_user" "$target_group" >/dev/null 2>&1 || true
  elif command -v deluser >/dev/null 2>&1; then
    run_root deluser "$target_user" "$target_group" >/dev/null 2>&1 || true
  else
    echo "gpasswd or deluser is required to remove users from groups." >&2
    exit 1
  fi
  success "User was removed from the group."
}

case "$action" in
  create)
    if id "$target_user" >/dev/null 2>&1; then
      echo "User already exists: $target_user" >&2
      exit 1
    fi
    if command -v useradd >/dev/null 2>&1; then
      if [ "$create_home" = "true" ]; then
        run_root useradd -m -c "$full_name" -s /bin/sh "$target_user"
      else
        run_root useradd -M -c "$full_name" -s /bin/sh "$target_user"
      fi
    elif command -v adduser >/dev/null 2>&1; then
      if [ "$create_home" = "true" ]; then
        run_root adduser -D -s /bin/sh -g "$full_name" "$target_user"
      else
        run_root adduser -D -H -s /bin/sh -g "$full_name" "$target_user"
      fi
    else
      echo "useradd or adduser is required to create users on this server." >&2
      exit 1
    fi
    if [ -n "$password" ]; then
      set_password
    fi
    if [ "$admin" = "true" ]; then
      set_admin_rights >/dev/null
    fi
    success "User was created."
    ;;
  edit)
    if ! id "$target_user" >/dev/null 2>&1; then
      echo "User was not found: $target_user" >&2
      exit 1
    fi
    if command -v usermod >/dev/null 2>&1; then
      run_root usermod -c "$full_name" "$target_user"
    elif command -v chfn >/dev/null 2>&1; then
      run_root chfn -f "$full_name" "$target_user"
    else
      echo "usermod or chfn is required to edit the full name on this server." >&2
      exit 1
    fi
    success "User details were updated."
    ;;
  set_password)
    if ! id "$target_user" >/dev/null 2>&1; then
      echo "User was not found: $target_user" >&2
      exit 1
    fi
    set_password
    success "Password was updated."
    ;;
  lock)
    if command -v passwd >/dev/null 2>&1; then
      run_root passwd -l "$target_user" >/dev/null
    elif command -v usermod >/dev/null 2>&1; then
      run_root usermod -L "$target_user"
    else
      echo "passwd or usermod is required to disable password login on this server." >&2
      exit 1
    fi
    success "Password login was disabled."
    ;;
  unlock)
    if command -v passwd >/dev/null 2>&1; then
      run_root passwd -u "$target_user" >/dev/null
    elif command -v usermod >/dev/null 2>&1; then
      run_root usermod -U "$target_user"
    else
      echo "passwd or usermod is required to enable password login on this server." >&2
      exit 1
    fi
    success "Password login was enabled."
    ;;
  set_admin)
    if ! id "$target_user" >/dev/null 2>&1; then
      echo "User was not found: $target_user" >&2
      exit 1
    fi
    set_admin_rights
    ;;
  add_group)
    if ! id "$target_user" >/dev/null 2>&1; then
      echo "User was not found: $target_user" >&2
      exit 1
    fi
    add_user_to_group
    ;;
  remove_group)
    if ! id "$target_user" >/dev/null 2>&1; then
      echo "User was not found: $target_user" >&2
      exit 1
    fi
    remove_user_from_group
    ;;
  delete)
    if ! id "$target_user" >/dev/null 2>&1; then
      echo "User was not found: $target_user" >&2
      exit 1
    fi
    if command -v userdel >/dev/null 2>&1; then
      if [ "$remove_home" = "true" ]; then
        run_root userdel -r "$target_user"
      else
        run_root userdel "$target_user"
      fi
    elif command -v deluser >/dev/null 2>&1; then
      if [ "$remove_home" = "true" ]; then
        run_root deluser --remove-home "$target_user"
      else
        run_root deluser "$target_user"
      fi
    else
      echo "userdel or deluser is required to delete users on this server." >&2
      exit 1
    fi
    success "User was deleted."
    ;;
  add_ssh_key)
    if ! id "$target_user" >/dev/null 2>&1; then
      echo "User was not found: $target_user" >&2
      exit 1
    fi
    if ! safe_ssh_public_key "$ssh_key"; then
      echo "Enter a supported one-line OpenSSH public key." >&2
      exit 1
    fi
    key_path=$(authorized_keys_path_for_user)
    key_dir=$(dirname "$key_path")
    run_root install -d -m 0700 -o "$target_user" -g "$(id -gn "$target_user")" "$key_dir"
    if run_root test -f "$key_path"; then
      if run_root grep -Fxq "$ssh_key" "$key_path"; then
        success "SSH public key is already installed."
        exit 0
      fi
    fi
    printf '%s\n' "$ssh_key" | run_root tee -a "$key_path" >/dev/null
    run_root chown "$target_user:$(id -gn "$target_user")" "$key_path"
    run_root chmod 0600 "$key_path"
    success "SSH public key was added."
    ;;
  remove_ssh_key)
    if ! id "$target_user" >/dev/null 2>&1; then
      echo "User was not found: $target_user" >&2
      exit 1
    fi
    if ! safe_ssh_public_key "$ssh_key"; then
      echo "Enter the exact OpenSSH public key line to remove." >&2
      exit 1
    fi
    key_path=$(authorized_keys_path_for_user)
    if ! run_root test -f "$key_path"; then
      success "No authorized_keys file exists for this user."
      exit 0
    fi
    tmp_file=$(mktemp)
    trap 'rm -f "$tmp_file"' EXIT HUP INT TERM
    run_root awk -v key="$ssh_key" '$0 != key { print }' "$key_path" > "$tmp_file"
    run_root install -m 0600 -o "$target_user" -g "$(id -gn "$target_user")" "$tmp_file" "$key_path"
    success "SSH public key was removed."
    ;;
esac
