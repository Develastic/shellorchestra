#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
shell_name=${SHELL##*/}
case "$shell_name" in
  bash|zsh) shell=$shell_name ;;
  *) shell=posix ;;
esac
platform_os=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]_.-' || printf unknown)
platform_arch=$(uname -m 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]_.-' || printf unknown)
[ -n "$platform_os" ] || platform_os=unknown
[ -n "$platform_arch" ] || platform_arch=unknown
admin=none
if [ "$(id -u 2>/dev/null || printf 1)" = "0" ]; then
  admin=root
elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  admin=passwordless_sudo
elif command -v doas >/dev/null 2>&1 && doas -n true >/dev/null 2>&1; then
  admin=passwordless_doas
fi
os=$platform_os
case "$os" in
  darwin*) os=darwin ;;
  freebsd*) os=freebsd ;;
  linux*) os=linux ;;
esac
printf '{"shell":"%s","os":"%s","platform_os":"%s","platform_arch":"%s","platform":"%s %s","admin_rights":"%s"}\n' "$shell" "$os" "$platform_os" "$platform_arch" "$platform_os" "$platform_arch" "$admin"
