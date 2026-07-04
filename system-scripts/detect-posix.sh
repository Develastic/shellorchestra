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
hostname_value=$(uname -n 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]_.-' || true)
[ -n "$hostname_value" ] || hostname_value=unknown
platform_os=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]_.-' || printf unknown)
platform_arch=$(uname -m 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]_.-' || printf unknown)
[ -n "$platform_os" ] || platform_os=unknown
[ -n "$platform_arch" ] || platform_arch=unknown
os=$platform_os
case "$os" in
  darwin*) os=darwin ;;
  freebsd*) os=freebsd ;;
  linux*) os=linux ;;
esac
distro=""
if [ -r /etc/os-release ]; then
  distro=$(awk -F= '$1=="ID"{gsub(/"/,"",$2); print $2; exit}' /etc/os-release | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]_.-' || true)
fi
admin=none
if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then
  admin=root
elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  admin=passwordless_sudo
elif command -v doas >/dev/null 2>&1 && doas -n true >/dev/null 2>&1; then
  admin=passwordless_doas
fi
kernel_version=$(uname -r 2>/dev/null | tr -cd '[:alnum:]_.:+~-' || true)
[ -n "$kernel_version" ] || kernel_version=unknown
package_manager=none
for candidate in apt-get dnf yum pacman zypper apk brew; do
  if command -v "$candidate" >/dev/null 2>&1; then
    case "$candidate" in
      apt-get) package_manager=apt ;;
      *) package_manager=$candidate ;;
    esac
    break
  fi
done
if [ "$package_manager" = "none" ]; then
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$candidate" ]; then
      package_manager=brew
      break
    fi
  done
fi
PATH=$PATH:/usr/local/sbin:/usr/sbin:/sbin
ssh_max_sessions=0
sshd_bin=$(command -v sshd 2>/dev/null || true)
if [ -n "$sshd_bin" ]; then
  sshd_config_dump=$("$sshd_bin" -T 2>/dev/null || true)
  if [ -z "$sshd_config_dump" ] && [ "$admin" = "root" ]; then
    sshd_config_dump=$("$sshd_bin" -T 2>/dev/null || true)
  elif [ -z "$sshd_config_dump" ] && [ "$admin" = "passwordless_sudo" ]; then
    sshd_config_dump=$(sudo -n "$sshd_bin" -T 2>/dev/null || true)
  elif [ -z "$sshd_config_dump" ] && [ "$admin" = "passwordless_doas" ]; then
    sshd_config_dump=$(doas -n "$sshd_bin" -T 2>/dev/null || true)
  fi
  ssh_max_sessions=$(printf '%s\n' "$sshd_config_dump" | awk 'tolower($1)=="maxsessions" && $2 ~ /^[0-9]+$/ {print $2; exit}' || true)
  if [ -z "$ssh_max_sessions" ] && [ -r /etc/ssh/sshd_config ]; then
    ssh_max_sessions=$(awk '
      /^[[:space:]]*($|#)/ { next }
      tolower($1) == "match" { exit }
      tolower($1) == "maxsessions" && $2 ~ /^[0-9]+$/ { print $2; exit }
    ' /etc/ssh/sshd_config 2>/dev/null || true)
  fi
  [ -n "$ssh_max_sessions" ] || ssh_max_sessions=10
fi
is_pve_host=false
if [ -d /etc/pve ] || command -v pveversion >/dev/null 2>&1; then
  is_pve_host=true
fi
is_docker_host=false
if command -v docker >/dev/null 2>&1 || command -v podman >/dev/null 2>&1 || [ -S /var/run/docker.sock ] || [ -S /run/docker.sock ] || [ -S /run/podman/podman.sock ]; then
  is_docker_host=true
fi
is_podman_host=false
if command -v podman >/dev/null 2>&1 || [ -S /run/podman/podman.sock ]; then
  is_podman_host=true
fi
virtualization=unknown
if command -v systemd-detect-virt >/dev/null 2>&1; then
  virtualization=$(systemd-detect-virt 2>/dev/null || true)
  virtualization=$(printf '%s' "$virtualization" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]_.:+~-' || true)
  [ "$virtualization" = "none" ] && virtualization=physical
elif [ -r /proc/cpuinfo ] && grep -qi hypervisor /proc/cpuinfo 2>/dev/null; then
  virtualization=virtual-machine
else
  hv_present=$(sysctl -n kern.hv_vmm_present 2>/dev/null || true)
  if [ "$hv_present" = "1" ]; then
    virtualization=virtual-machine
  elif [ "$hv_present" = "0" ]; then
    virtualization=physical
  else
    virtualization=physical
  fi
fi
[ -n "$virtualization" ] || virtualization=unknown
app_mc=false
app_htop=false
app_btop=false
app_neofetch=false
app_docker=false
app_podman=false
app_lazydocker=false
app_speedtest=false
app_ufw=false
command -v mc >/dev/null 2>&1 && app_mc=true
command -v htop >/dev/null 2>&1 && app_htop=true
command -v btop >/dev/null 2>&1 && app_btop=true
if command -v neofetch >/dev/null 2>&1 || command -v fastfetch >/dev/null 2>&1; then
  app_neofetch=true
fi
command -v docker >/dev/null 2>&1 && app_docker=true
command -v podman >/dev/null 2>&1 && app_podman=true
command -v lazydocker >/dev/null 2>&1 && app_lazydocker=true
if command -v speedtest >/dev/null 2>&1 || command -v speedtest-cli >/dev/null 2>&1; then
  app_speedtest=true
fi
if command -v ufw >/dev/null 2>&1 || [ -x /usr/sbin/ufw ] || [ -x /sbin/ufw ] || [ -x /usr/local/sbin/ufw ]; then
  app_ufw=true
fi
printf '{"hostname":"%s","shell":"%s","os":"%s","platform_os":"%s","platform_arch":"%s","platform":"%s %s","distro":"%s","admin_rights":"%s","kernel_version":"%s","package_manager":"%s","ssh_max_sessions":%s,"virtualization":"%s","is_pve_host":%s,"is_docker_host":%s,"is_podman_host":%s,"apps":{"mc":%s,"htop":%s,"btop":%s,"neofetch":%s,"docker":%s,"podman":%s,"lazydocker":%s,"speedtest":%s,"ufw":%s}}\n' \
  "$hostname_value" "$shell" "$os" "$platform_os" "$platform_arch" "$platform_os" "$platform_arch" "$distro" "$admin" \
  "$kernel_version" "$package_manager" "$ssh_max_sessions" "$virtualization" "$is_pve_host" "$is_docker_host" "$is_podman_host" \
  "$app_mc" "$app_htop" "$app_btop" "$app_neofetch" "$app_docker" "$app_podman" "$app_lazydocker" "$app_speedtest" "$app_ufw"
