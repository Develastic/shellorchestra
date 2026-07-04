#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu

operation="install"
package_name=${SHELLORCHESTRA_PACKAGE_NAME:-}
manager=${SHELLORCHESTRA_PACKAGE_MANAGER:-}
case "$package_name" in
  ''|*[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+:-]*)
    echo "Package name is required and may only contain letters, digits, dot, underscore, plus, colon, and hyphen." >&2
    exit 1
    ;;
esac
run_root() {
  if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo -n "$@"
  elif command -v doas >/dev/null 2>&1 && doas -n true >/dev/null 2>&1; then
    doas -n "$@"
  else
    echo "Root privileges are required for package $operation. Run as root or configure passwordless sudo/doas for the ShellOrchestra account." >&2
    exit 1
  fi
}
if [ -z "$manager" ] || [ "$manager" = "auto" ]; then
  if command -v apt-get >/dev/null 2>&1; then manager=apt
  elif command -v apk >/dev/null 2>&1; then manager=apk
  elif command -v dnf >/dev/null 2>&1; then manager=dnf
  elif command -v yum >/dev/null 2>&1; then manager=yum
  elif command -v pacman >/dev/null 2>&1; then manager=pacman
  elif command -v zypper >/dev/null 2>&1; then manager=zypper
  elif command -v brew >/dev/null 2>&1; then manager=brew
  elif [ -x /opt/homebrew/bin/brew ]; then manager=brew
  elif [ -x /usr/local/bin/brew ]; then manager=brew
  else echo "No supported package manager was detected." >&2; exit 1
  fi
fi
if [ "${SHELLORCHESTRA_DRY_RUN:-0}" = "1" ] || [ "${SHELLORCHESTRA_CONFIRMED:-0}" != "1" ]; then
  printf '{"ok":true,"dry_run":true,"manager":"%s","operation":"%s","package":"%s"}\n' "$manager" "$operation" "$package_name"
  exit 0
fi
case "$manager:$operation" in
  apt:install)
    run_root apt-get update >&2
    run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y "$package_name" >&2
    ;;
  apt:remove) run_root env DEBIAN_FRONTEND=noninteractive apt-get remove -y "$package_name" >&2 ;;
  apk:install) run_root apk add "$package_name" >&2 ;;
  apk:remove) run_root apk del "$package_name" >&2 ;;
  dnf:install) run_root dnf -y install "$package_name" >&2 ;;
  dnf:remove) run_root dnf -y remove "$package_name" >&2 ;;
  yum:install) run_root yum -y install "$package_name" >&2 ;;
  yum:remove) run_root yum -y remove "$package_name" >&2 ;;
  pacman:install) run_root pacman -S --noconfirm "$package_name" >&2 ;;
  pacman:remove) run_root pacman -R --noconfirm "$package_name" >&2 ;;
  zypper:install) run_root zypper --non-interactive install "$package_name" >&2 ;;
  zypper:remove) run_root zypper --non-interactive remove "$package_name" >&2 ;;
  brew:install)
    if command -v brew >/dev/null 2>&1; then brew install "$package_name" >&2
    elif [ -x /opt/homebrew/bin/brew ]; then /opt/homebrew/bin/brew install "$package_name" >&2
    elif [ -x /usr/local/bin/brew ]; then /usr/local/bin/brew install "$package_name" >&2
    else echo "Homebrew was not found." >&2; exit 1; fi ;;
  brew:remove)
    if command -v brew >/dev/null 2>&1; then brew uninstall "$package_name" >&2
    elif [ -x /opt/homebrew/bin/brew ]; then /opt/homebrew/bin/brew uninstall "$package_name" >&2
    elif [ -x /usr/local/bin/brew ]; then /usr/local/bin/brew uninstall "$package_name" >&2
    else echo "Homebrew was not found." >&2; exit 1; fi ;;
  *) echo "Unsupported package operation: $manager $operation" >&2; exit 1 ;;
esac
printf '{"ok":true,"manager":"%s","operation":"%s","package":"%s"}\n' "$manager" "$operation" "$package_name"
