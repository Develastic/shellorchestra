#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
action=${SHELLORCHESTRA_CONTAINER_ACTION:-install}
engine=${SHELLORCHESTRA_CONTAINER_ENGINE:-auto}
dry_run=${SHELLORCHESTRA_DRY_RUN:-0}
template_id=${SHELLORCHESTRA_CONTAINER_INSTALL_TEMPLATE:-}
image=${SHELLORCHESTRA_CONTAINER_INSTALL_IMAGE:-}
name=${SHELLORCHESTRA_CONTAINER_INSTALL_NAME:-}
bind_address=${SHELLORCHESTRA_CONTAINER_INSTALL_BIND_ADDRESS:-127.0.0.1}
host_port=${SHELLORCHESTRA_CONTAINER_INSTALL_HOST_PORT:-}
container_port=${SHELLORCHESTRA_CONTAINER_INSTALL_CONTAINER_PORT:-}
restart_policy=${SHELLORCHESTRA_CONTAINER_INSTALL_RESTART_POLICY:-unless-stopped}
exposure_confirmed=${SHELLORCHESTRA_CONTAINER_INSTALL_EXPOSURE_CONFIRMED:-false}
json_string() { awk 'BEGIN { value=ARGV[1]; ARGV[1]=""; gsub(/\\/,"\\\\",value); gsub(/"/,"\\\"",value); gsub(/\t/,"\\t",value); gsub(/\r/,"\\r",value); gsub(/\n/,"\\n",value); printf "\"%s\"", value }' "$1"; }
fail() { echo "$1" >&2; exit "${2:-1}"; }
is_port() { case "$1" in ''|*[!0123456789]*) return 1 ;; esac; [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }
case "$action" in install) ;; *) fail "Unsupported container install action: $action" 64 ;; esac
case "$dry_run" in 1|true|TRUE) dry_run=1 ;; ''|0|false|FALSE) dry_run=0 ;; *) fail "Unsupported dry_run value." 64 ;; esac
case "$template_id" in nginx|custom) ;; *) fail "Choose a supported install template." 64 ;; esac
case "$name" in ''|*[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-]*|[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789]*) fail "Use a safe container name: letters, digits, dot, underscore, or dash." 64 ;; esac
case "$image" in ''|*[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:/@-]*|[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789]*) fail "Use a safe image reference." 64 ;; esac
case "$bind_address" in 127.0.0.1|localhost|0.0.0.0|::1) ;; *) fail "Use 127.0.0.1, localhost, ::1, or 0.0.0.0 as the bind address." 64 ;; esac
is_port "$host_port" || fail "Choose a host port between 1 and 65535." 64
is_port "$container_port" || fail "Choose a container port between 1 and 65535." 64
case "$restart_policy" in unless-stopped|no) ;; *) fail "Choose a supported restart policy." 64 ;; esac
if [ "$bind_address" != 127.0.0.1 ] && [ "$bind_address" != localhost ] && [ "$bind_address" != ::1 ]; then
  case "$exposure_confirmed" in true|TRUE|1) ;; *) fail "Network exposure must be confirmed before binding outside localhost." 64 ;; esac
fi
if [ "$engine" = auto ] || [ -z "$engine" ]; then
  if command -v docker >/dev/null 2>&1; then engine=docker
  elif command -v podman >/dev/null 2>&1; then engine=podman
  else fail "Docker or Podman is required before installing containerized apps." 127
  fi
fi
case "$engine" in docker|podman) ;; *) fail "Unsupported container engine: $engine" 64 ;; esac
run_engine() {
  if "$engine" info >/dev/null 2>&1; then
    "$engine" "$@"
    return
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n "$engine" info >/dev/null 2>&1; then
    sudo -n "$engine" "$@"
    return
  fi
  if command -v doas >/dev/null 2>&1 && doas -n "$engine" info >/dev/null 2>&1; then
    doas -n "$engine" "$@"
    return
  fi
  fail "$engine is installed, but ShellOrchestra cannot access it with this SSH user."
}
container_exists=false
if run_engine inspect "$name" >/dev/null 2>&1; then container_exists=true; fi
port_warning=""
if command -v ss >/dev/null 2>&1 && ss -H -ltn 2>/dev/null | awk '{print $4}' | grep -E "[:.]${host_port}$" >/dev/null 2>&1; then
  port_warning="Host port $host_port already appears to be listening on this server."
fi
if [ "$container_exists" = true ]; then
  fail "A container named $name already exists on this server. Choose another name or remove the existing container first."
fi
endpoint="http://${bind_address}:${host_port}"
plan_log="Install preview passed.
Engine: $engine
Template: $template_id
Image: $image
Container name: $name
Port mapping: $bind_address:$host_port -> $container_port/tcp
Restart policy: $restart_policy
Endpoint after start: $endpoint"
if [ -n "$port_warning" ]; then
  plan_log="$plan_log
Warning: $port_warning"
fi
if [ -n "$port_warning" ] && [ "$dry_run" != 1 ]; then
  fail "$port_warning Choose another host port before installing."
fi
if [ "$dry_run" = 1 ]; then
  printf '{"ok":true,"dry_run":true,"engine":'; json_string "$engine"; printf ',"action":"install","template_id":'; json_string "$template_id"; printf ',"image":'; json_string "$image"; printf ',"container_name":'; json_string "$name"; printf ',"endpoint":'; json_string "$endpoint"; printf ',"message":'; json_string "Preview passed. ShellOrchestra can install $name with $engine."; printf ',"output_log":'; json_string "$plan_log"; printf ',"output_log_truncated":false}\n'
  exit 0
fi
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/shellorchestra-containers-install.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM
output_file="$tmp_dir/output.log"
{
  echo "Pulling image $image ..."
  run_engine pull "$image"
  echo "Creating container $name ..."
  run_engine run -d \
    --name "$name" \
    --label com.shellorchestra.managed=true \
    --label com.shellorchestra.template_id="$template_id" \
    --label com.shellorchestra.installed_by=shellorchestra \
    --restart "$restart_policy" \
    -p "$bind_address:$host_port:$container_port" \
    "$image"
  echo "Container $name created successfully."
  echo "Endpoint: $endpoint"
} >"$output_file" 2>&1 || { cat "$output_file" >&2; exit 1; }
output_log=$(cat "$output_file")
printf '{"ok":true,"dry_run":false,"engine":'; json_string "$engine"; printf ',"action":"install","template_id":'; json_string "$template_id"; printf ',"image":'; json_string "$image"; printf ',"container_name":'; json_string "$name"; printf ',"endpoint":'; json_string "$endpoint"; printf ',"message":'; json_string "Installed $name with $engine."; printf ',"output_log":'; json_string "$output_log"; printf ',"output_log_truncated":false}\n'
