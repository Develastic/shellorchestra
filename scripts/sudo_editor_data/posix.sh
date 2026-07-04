#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
mode=${SHELLORCHESTRA_SUDO_MODE:-list}
target_path=${SHELLORCHESTRA_SUDO_PATH:-}
sudo_content=${SHELLORCHESTRA_SUDO_CONTENT:-}
output_encoding=${SHELLORCHESTRA_SUDO_OUTPUT_ENCODING:-${sudo_output_encoding:-}}
stream_format=${SHELLORCHESTRA_SUDO_STREAM_FORMAT:-${sudo_stream_format:-json}}
case "$stream_format" in ''|'json') stream_format=json ;; 'row_events') ;; *) echo "Unsupported ShellOrchestra Edit Sudo stream format: $stream_format" >&2; exit 64 ;; esac
case "$output_encoding" in ''|'none') output_encoding=none ;; 'auto'|'zstd'|'gzip') ;; *) echo "Unsupported ShellOrchestra Edit Sudo output encoding: $output_encoding" >&2; exit 64 ;; esac

json_string() {
  awk 'BEGIN { value=ARGV[1]; ARGV[1]=""; gsub(/\\/,"\\\\",value); gsub(/"/,"\\\"",value); gsub(/\t/,"\\t",value); gsub(/\r/,"\\r",value); gsub(/\n/,"\\n",value); printf "\"%s\"", value }' "$1"
}

compress_json_stream() {
  case "$output_encoding" in
    zstd)
      if command -v zstd >/dev/null 2>&1; then zstd -3 -c; elif command -v gzip >/dev/null 2>&1; then gzip -1 -c; else cat; fi
      ;;
    gzip)
      gzip -1 -c
      ;;
    auto)
      if command -v zstd >/dev/null 2>&1; then zstd -3 -c
      elif command -v gzip >/dev/null 2>&1; then gzip -1 -c
      else cat
      fi
      ;;
    *)
      cat
      ;;
  esac
}

emit_event_prefix() {
  printf '{"event":'
  json_string "$1"
  printf ',"data":'
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
  echo "Root privileges are required to read sudoers files." >&2
  exit 1
}

safe_sudoers_path() {
  case "$1" in
    /etc/sudoers) return 0 ;;
    /etc/sudoers.d/*)
      name=${1#/etc/sudoers.d/}
      case "$name" in ''|.*|*/*|*[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-]*) return 1 ;; *) return 0 ;; esac
      ;;
    *) return 1 ;;
  esac
}

file_size() {
  wc -c <"$1" 2>/dev/null | tr -d '[:space:]' || printf '0'
}

file_mode() {
  if command -v stat >/dev/null 2>&1; then
    stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null || printf ''
  else
    printf ''
  fi
}

file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" 2>/dev/null | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'
    return
  fi
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" 2>/dev/null | awk '{print $NF}'
    return
  fi
  printf ''
}

find_visudo() {
  if command -v visudo >/dev/null 2>&1; then
    command -v visudo
    return 0
  fi
  for candidate in /usr/sbin/visudo /sbin/visudo /usr/local/sbin/visudo; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

visudo_bin=$(find_visudo || true)
if [ -z "$visudo_bin" ]; then
  {
    if [ "$stream_format" = "row_events" ]; then
      emit_event_prefix meta
      printf '{"mode":'
      json_string "$mode"
      printf ',"available":false,"message":"Sudoers syntax validation is not available on this server."}}\n'
      emit_event_prefix done
      printf '{"mode":'
      json_string "$mode"
      printf ',"available":false,"message":"Sudoers syntax validation is not available on this server."}}\n'
    else
      printf '{"mode":'
      json_string "$mode"
      printf ',"available":false,"message":"Sudoers syntax validation is not available on this server."}\n'
    fi
  } | compress_json_stream
  exit 0
fi

case "$mode" in
  list)
    {
      if [ "$stream_format" = "row_events" ]; then
        emit_event_prefix meta
        printf '{"mode":"list","available":true}}\n'
        emit_file() {
          path=$1
          [ -f "$path" ] || return 0
          printf '{"event":"row","data":{"kind":"sudoers_file","item":{"path":'
          json_string "$path"
          printf ',"size":'
          json_string "$(file_size "$path")"
          printf ',"mode":'
          json_string "$(file_mode "$path")"
          printf '}}}\n'
        }
        emit_file /etc/sudoers
        if [ -d /etc/sudoers.d ]; then
          for candidate in /etc/sudoers.d/*; do
            [ -e "$candidate" ] || continue
            case "$(basename "$candidate")" in .*|*~|*.bak|README) continue ;; esac
            emit_file "$candidate"
          done
        fi
        emit_event_prefix done
        printf '{"mode":"list","available":true}}\n'
      else
        printf '{"mode":"list","available":true,"files":['
        count=0
        emit_file() {
          path=$1
          [ -f "$path" ] || return 0
          if [ "$count" -gt 0 ]; then printf ','; fi
          count=$((count + 1))
          printf '{"path":'; json_string "$path"
          printf ',"size":'; json_string "$(file_size "$path")"
          printf ',"mode":'; json_string "$(file_mode "$path")"
          printf '}'
        }
        emit_file /etc/sudoers
        if [ -d /etc/sudoers.d ]; then
          for candidate in /etc/sudoers.d/*; do
            [ -e "$candidate" ] || continue
            case "$(basename "$candidate")" in .*|*~|*.bak|README) continue ;; esac
            emit_file "$candidate"
          done
        fi
        printf ']}\n'
      fi
    } | compress_json_stream
    ;;
  read)
    {
      if ! safe_sudoers_path "$target_path"; then
        echo "Choose a supported sudoers file before reading." >&2
        exit 1
      fi
      tmp=$(mktemp)
      trap 'rm -f "$tmp"' EXIT HUP INT TERM
      run_root cat "$target_path" >"$tmp"
      content=$(cat "$tmp")
      if [ "$stream_format" = "row_events" ]; then
        emit_event_prefix meta
        printf '{"mode":"read","available":true,"path":'
        json_string "$target_path"
        printf ',"size":'
        json_string "$(file_size "$tmp")"
        printf ',"sha256":'
        json_string "$(file_sha256 "$tmp")"
        printf '}}\n'
        printf '{"event":"row","data":{"kind":"sudoers_content","item":{"path":'
        json_string "$target_path"
        printf ',"content":'
        json_string "$content"
        printf ',"size":'
        json_string "$(file_size "$tmp")"
        printf ',"sha256":'
        json_string "$(file_sha256 "$tmp")"
        printf '}}}\n'
        emit_event_prefix done
        printf '{"mode":"read","available":true,"path":'
        json_string "$target_path"
        printf '}}\n'
      else
        printf '{"mode":"read","available":true,"path":'
        json_string "$target_path"
        printf ',"content":'
        json_string "$content"
        printf ',"size":'; json_string "$(file_size "$tmp")"
        printf ',"sha256":'; json_string "$(file_sha256 "$tmp")"
        printf '}\n'
      fi
    } | compress_json_stream
    ;;
  validate)
    {
      if ! safe_sudoers_path "$target_path"; then
        echo "Choose a supported sudoers file before validating." >&2
        exit 1
      fi
      tmp=$(mktemp)
      err=$(mktemp)
      trap 'rm -f "$tmp" "$err"' EXIT HUP INT TERM
      printf '%s\n' "$sudo_content" >"$tmp"
      if "$visudo_bin" -cf "$tmp" >"$err" 2>&1; then
        valid=true
      else
        valid=false
      fi
      output=$(cat "$err")
      printf '{"mode":"validate","available":true,"path":'
      json_string "$target_path"
      printf ',"valid":%s,"validation_output":' "$valid"
      json_string "$output"
      printf ',"size":'; json_string "$(file_size "$tmp")"
      printf '}\n'
    } | compress_json_stream
    ;;
  save)
    {
      if ! safe_sudoers_path "$target_path"; then
        echo "Choose a supported sudoers file before saving." >&2
        exit 1
      fi
      tmp=$(mktemp)
      err=$(mktemp)
      trap 'rm -f "$tmp" "$err"' EXIT HUP INT TERM
      printf '%s\n' "$sudo_content" >"$tmp"
      if ! "$visudo_bin" -cf "$tmp" >"$err" 2>&1; then
        cat "$err" >&2
        exit 1
      fi
      parent=$(dirname "$target_path")
      run_root install -d -o root -g root -m 0755 "$parent"
      if [ -f "$target_path" ]; then
        backup="$target_path.shellorchestra.$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || date +%s).bak"
        run_root cp -p "$target_path" "$backup" 2>/dev/null || true
      fi
      run_root install -o root -g root -m 0440 "$tmp" "$target_path"
      run_root "$visudo_bin" -cf "$target_path" >&2
      printf '{"mode":"save","available":true,"path":'
      json_string "$target_path"
      printf ',"saved":true,"sha256":'
      json_string "$(file_sha256 "$tmp")"
      printf '}\n'
    } | compress_json_stream
    ;;
  *)
    echo "Unsupported sudo editor mode: $mode" >&2
    exit 1
    ;;
esac
