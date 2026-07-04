#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
container_id=${SHELLORCHESTRA_CONTAINER_ID:-}
action=${SHELLORCHESTRA_CONTAINER_ACTION:-}
engine=${SHELLORCHESTRA_CONTAINER_ENGINE:-auto}
dry_run=${SHELLORCHESTRA_DRY_RUN:-0}
json_string() { awk 'BEGIN { value=ARGV[1]; ARGV[1]=""; gsub(/\\/,"\\\\",value); gsub(/"/,"\\\"",value); gsub(/\t/,"\\t",value); gsub(/\r/,"\\r",value); gsub(/\n/,"\\n",value); printf "\"%s\"", value }' "$1"; }
limit_output_log() {
  output_file=$1
  output_limit=12000
  output_bytes=$(wc -c < "$output_file" | tr -d ' ')
  output_truncated=false
  if [ "${output_bytes:-0}" -gt "$output_limit" ]; then
    output_truncated=true
    output_log=$(dd if="$output_file" bs="$output_limit" count=1 2>/dev/null)
    output_log="${output_log}
... output truncated by ShellOrchestra after ${output_limit} bytes ..."
  else
    output_log=$(cat "$output_file")
  fi
}
case "$container_id" in ''|*[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:-]*) echo "A safe container id or name is required." >&2; exit 1 ;; esac
case "$action" in start|stop|restart) ;; *) echo "Unsupported container action: $action" >&2; exit 1 ;; esac
case "$dry_run" in 1|true|TRUE) dry_run=1 ;; ''|0|false|FALSE) dry_run=0 ;; *) echo "Unsupported dry_run value." >&2; exit 64 ;; esac
if [ "$engine" = auto ] || [ -z "$engine" ]; then
  if command -v docker >/dev/null 2>&1; then engine=docker
  elif command -v podman >/dev/null 2>&1; then engine=podman
  else echo "Docker or Podman is required for container actions." >&2; exit 127
  fi
fi
case "$engine" in docker|podman) ;; *) echo "Unsupported container engine: $engine" >&2; exit 64 ;; esac
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
  echo "$engine is installed, but ShellOrchestra cannot access it with this SSH user." >&2
  exit 1
}
run_engine inspect "$container_id" >/dev/null
if [ "$dry_run" = 1 ]; then
  preview_log="Preview passed.
Engine: $engine
Container: $container_id
Action: $action
Container inspect succeeded.
No container state was changed."
  printf '{"ok":true,"dry_run":true,"engine":'; json_string "$engine"; printf ',"container_id":'; json_string "$container_id"; printf ',"action":'; json_string "$action"; printf ',"message":'; json_string "Preview passed. ShellOrchestra can access the selected container with $engine. No container state was changed."; printf ',"output_log":'; json_string "$preview_log"; printf ',"output_log_truncated":false}\n'
  exit 0
fi
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/shellorchestra-containers-action.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM
output_file="$tmp_dir/output.log"
if ! run_engine "$action" "$container_id" >"$output_file" 2>&1; then
  cat "$output_file" >&2
  exit 1
fi
if [ -s "$output_file" ]; then
  limit_output_log "$output_file"
else
  output_truncated=false
  output_log="$engine $action $container_id completed successfully. The container engine returned no stdout/stderr output."
fi
printf '{"ok":true,"dry_run":false,"engine":'; json_string "$engine"; printf ',"container_id":'; json_string "$container_id"; printf ',"action":'; json_string "$action"; printf ',"output_log":'; json_string "$output_log"; printf ',"output_log_truncated":%s}\n' "$output_truncated"
