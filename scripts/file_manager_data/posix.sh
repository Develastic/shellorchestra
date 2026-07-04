#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
export LC_ALL=C

action=${SHELLORCHESTRA_FILE_MANAGER_ACTION:-locations}
target_path=${SHELLORCHESTRA_FILE_MANAGER_PATH:-}
destination_path=${SHELLORCHESTRA_FILE_MANAGER_DESTINATION_PATH:-}
new_name=${SHELLORCHESTRA_FILE_MANAGER_NEW_NAME:-}
mode_value=${SHELLORCHESTRA_FILE_MANAGER_MODE:-}
content_b64=${SHELLORCHESTRA_FILE_MANAGER_CONTENT_B64:-}
overwrite=${SHELLORCHESTRA_FILE_MANAGER_OVERWRITE:-false}
source_names_b64=${SHELLORCHESTRA_FILE_MANAGER_SOURCE_NAMES_B64:-}
archive_format=${SHELLORCHESTRA_FILE_MANAGER_ARCHIVE_FORMAT:-auto}
max_bytes=${SHELLORCHESTRA_FILE_MANAGER_MAX_BYTES:-262144}
offset_bytes=${SHELLORCHESTRA_FILE_MANAGER_OFFSET:-0}
hash_max_bytes=${SHELLORCHESTRA_FILE_MANAGER_HASH_MAX_BYTES:-16777216}
output_encoding=${SHELLORCHESTRA_FILE_MANAGER_OUTPUT_ENCODING:-}
known_listing_hash=${SHELLORCHESTRA_FILE_MANAGER_KNOWN_LISTING_HASH:-}
stream_format=${SHELLORCHESTRA_FILE_MANAGER_STREAM_FORMAT:-json}
editor_mode_request=${SHELLORCHESTRA_FILE_MANAGER_EDITOR_MODE:-edit}
editor_max_bytes=${SHELLORCHESTRA_FILE_MANAGER_EDITOR_MAX_BYTES:-33554432}
editor_max_line_bytes=${SHELLORCHESTRA_FILE_MANAGER_EDITOR_MAX_LINE_BYTES:-65536}
search_name_pattern=${SHELLORCHESTRA_FILE_MANAGER_SEARCH_NAME_PATTERN:-*}
search_name_mode=${SHELLORCHESTRA_FILE_MANAGER_SEARCH_NAME_MODE:-glob}
search_content=${SHELLORCHESTRA_FILE_MANAGER_SEARCH_CONTENT:-}
search_content_mode=${SHELLORCHESTRA_FILE_MANAGER_SEARCH_CONTENT_MODE:-literal}
search_case_sensitive=${SHELLORCHESTRA_FILE_MANAGER_SEARCH_CASE_SENSITIVE:-false}
search_skip_binary=${SHELLORCHESTRA_FILE_MANAGER_SEARCH_SKIP_BINARY:-true}
search_stay_filesystem=${SHELLORCHESTRA_FILE_MANAGER_SEARCH_STAY_FILESYSTEM:-true}
search_include_hidden=${SHELLORCHESTRA_FILE_MANAGER_SEARCH_INCLUDE_HIDDEN:-true}
search_max_results=${SHELLORCHESTRA_FILE_MANAGER_SEARCH_MAX_RESULTS:-1000}
search_max_file_bytes=${SHELLORCHESTRA_FILE_MANAGER_SEARCH_MAX_FILE_BYTES:-1048576}

case "$max_bytes" in ''|*[!0123456789]*) max_bytes=262144 ;; esac
case "$offset_bytes" in ''|*[!0123456789]*) offset_bytes=0 ;; esac
case "$hash_max_bytes" in ''|*[!0123456789]*) hash_max_bytes=16777216 ;; esac
case "$output_encoding" in ''|'auto'|'zstd'|'gzip') ;; *) echo "Unsupported ShellOrchestra file-manager output encoding: $output_encoding" >&2; exit 64 ;; esac
case "$known_listing_hash" in *[!A-Za-z0-9_.:-]*) known_listing_hash= ;; esac
case "$stream_format" in ''|'json') stream_format=json ;; 'row_events') ;; *) echo "Unsupported ShellOrchestra file-manager stream format: $stream_format" >&2; exit 64 ;; esac
case "$editor_mode_request" in ''|'edit') editor_mode_request=edit ;; 'safe_view') ;; *) echo "Unsupported ShellOrchestra editor mode: $editor_mode_request" >&2; exit 64 ;; esac
case "$archive_format" in ''|'auto') archive_format=auto ;; 'tar.zst'|'tar.gz'|'zip') ;; *) echo "Unsupported ShellOrchestra archive format: $archive_format" >&2; exit 64 ;; esac
case "$editor_max_bytes" in ''|*[!0123456789]*) editor_max_bytes=33554432 ;; esac
case "$editor_max_line_bytes" in ''|*[!0123456789]*) editor_max_line_bytes=65536 ;; esac
case "$search_name_mode" in ''|'glob') search_name_mode=glob ;; 'regex'|'literal') ;; *) echo "Unsupported ShellOrchestra search name mode: $search_name_mode" >&2; exit 64 ;; esac
case "$search_content_mode" in ''|'literal') search_content_mode=literal ;; 'regex') ;; *) echo "Unsupported ShellOrchestra search content mode: $search_content_mode" >&2; exit 64 ;; esac
case "$search_case_sensitive" in 'true'|'false') ;; *) search_case_sensitive=false ;; esac
case "$search_skip_binary" in 'true'|'false') ;; *) search_skip_binary=true ;; esac
case "$search_stay_filesystem" in 'true'|'false') ;; *) search_stay_filesystem=true ;; esac
case "$search_include_hidden" in 'true'|'false') ;; *) search_include_hidden=true ;; esac
case "$search_max_results" in ''|*[!0123456789]*) search_max_results=1000 ;; esac
case "$search_max_file_bytes" in ''|*[!0123456789]*) search_max_file_bytes=1048576 ;; esac
if [ "$search_max_results" -lt 1 ]; then search_max_results=1; fi
if [ "$search_max_results" -gt 10000 ]; then search_max_results=10000; fi
if [ "$search_max_file_bytes" -lt 1024 ]; then search_max_file_bytes=1024; fi
if [ "$search_max_file_bytes" -gt 67108864 ]; then search_max_file_bytes=67108864; fi
if [ "${#search_name_pattern}" -gt 4096 ] || [ "${#search_content}" -gt 4096 ]; then echo "ShellOrchestra search pattern is too long." >&2; exit 64; fi

json_string() {
  if [ "$#" -eq 0 ] || [ -z "$1" ]; then
    printf '""'
    return
  fi
  newline='
'
  tab=$(printf '\t')
  cr=$(printf '\r')
  esc=$(printf '\033')
  case "$1" in
    *\\*|*\"*|*"$newline"*|*"$tab"*|*"$cr"*|*"$esc"*)
      ;;
    *)
      printf '"%s"' "$1"
      return
      ;;
  esac
  printf '%s' "$1" | awk 'BEGIN { ORS = "" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "\\r"); gsub(/\n/, "\\n"); printf "\"%s\"", $0 }'
}

json_error() {
  printf '{"ok":false,"action":'
  json_string "$action"
  printf ',"error":'
  json_string "$1"
  printf '}\n'
}

now_ms() {
  value=$(date +%s%3N 2>/dev/null || printf '')
  case "$value" in
    ''|*N*) value=$(date +%s 2>/dev/null | awk '{printf "%d", ($1 + 0) * 1000}') ;;
  esac
  printf '%s' "$value"
}

elapsed_ms() {
  start=$1
  finish=$2
  awk -v start="$start" -v finish="$finish" 'BEGIN { delta = finish - start; if (delta < 0) delta = 0; printf "%d", delta }'
}

compress_json_stream() {
  case "$output_encoding" in
    '')
      cat
      ;;
    'auto')
      if command -v zstd >/dev/null 2>&1; then
        zstd -1 -q -c
      elif command -v gzip >/dev/null 2>&1; then
        gzip -1 -c
      else
        echo "zstd or gzip is required for compressed ShellOrchestra directory listings on this server." >&2
        exit 127
      fi
      ;;
    'zstd')
      if ! command -v zstd >/dev/null 2>&1; then
        echo "zstd is required for zstd-compressed ShellOrchestra directory listings on this server." >&2
        exit 127
      fi
      zstd -1 -q -c
      ;;
    'gzip')
      if ! command -v gzip >/dev/null 2>&1; then
        echo "gzip is required for gzip-compressed ShellOrchestra directory listings on this server." >&2
        exit 127
      fi
      gzip -1 -c
      ;;
  esac
}

file_digest() {
  path=$1
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" 2>/dev/null | awk '{print "sha256:" $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" 2>/dev/null | awk '{print "sha256:" $1}'
    return
  fi
  cksum "$path" 2>/dev/null | awk '{print "cksum:" $1 "-" $2}'
}

home_dir() {
  if [ -n "${HOME:-}" ]; then printf '%s' "$HOME"; return; fi
  (cd ~ 2>/dev/null && pwd) || printf '/'
}

stat_fields() {
  path=$1
  if run_file_read_command stat -c '%s	%a	%U	%G	%Y' -- "$path" 2>/dev/null; then return; fi
  if run_file_read_command stat -f '%z	%Lp	%Su	%Sg	%m' -- "$path" 2>/dev/null; then return; fi
  printf '0	000			0\n'
}

file_size() {
  fields=$(stat_fields "$1")
  printf '%s' "$fields" | awk -F '\t' '{print $1 + 0}'
}

recursive_size() {
  path=$1
  if run_file_read_command test -d "$path"; then
    if run_file_read_command du -sk -- "$path" >/dev/null 2>&1; then run_file_read_command du -sk -- "$path" | awk '{print ($1 + 0) * 1024}'; return; fi
    if run_file_read_command du -sk "$path" >/dev/null 2>&1; then run_file_read_command du -sk "$path" | awk '{print ($1 + 0) * 1024}'; return; fi
  fi
  file_size "$path"
}

entry_type() {
  path=$1
  if run_file_read_command test -L "$path"; then printf 'symlink'; elif run_file_read_command test -d "$path"; then printf 'directory'; elif run_file_read_command test -f "$path"; then printf 'file'; else printf 'other'; fi
}

sha256_file() {
  path=$1
  if command -v sha256sum >/dev/null 2>&1; then run_file_read_command sha256sum -- "$path" | awk '{print $1}'; return; fi
  if command -v shasum >/dev/null 2>&1; then run_file_read_command shasum -a 256 "$path" | awk '{print $1}'; return; fi
  if command -v openssl >/dev/null 2>&1; then read_file_bytes "$path" | openssl dgst -sha256 | awk '{print $NF}'; return; fi
  printf ''
}

run_file_read_command() {
  if [ "$(id -u 2>/dev/null || printf 1)" -eq 0 ]; then "$@"; return; fi
  if command -v sudo >/dev/null 2>&1 && can_sudo_noninteractive; then sudo -n "$@"; return; fi
  if command -v doas >/dev/null 2>&1 && can_doas_noninteractive; then doas -n "$@"; return; fi
  "$@"
}

run_file_mutation_command() {
  if [ "$(id -u 2>/dev/null || printf 1)" -eq 0 ]; then "$@"; return; fi
  if command -v sudo >/dev/null 2>&1 && can_sudo_noninteractive; then sudo -n "$@"; return; fi
  if command -v doas >/dev/null 2>&1 && can_doas_noninteractive; then doas -n "$@"; return; fi
  "$@"
}

can_sudo_noninteractive() {
  if [ "${shellorchestra_sudo_probe_done:-0}" = "1" ]; then
    [ "${shellorchestra_sudo_available:-0}" = "1" ]
    return $?
  fi
  shellorchestra_sudo_probe_done=1
  if privilege_probe sudo -n true; then shellorchestra_sudo_available=1; else shellorchestra_sudo_available=0; fi
  [ "$shellorchestra_sudo_available" = "1" ]
}

can_doas_noninteractive() {
  if [ "${shellorchestra_doas_probe_done:-0}" = "1" ]; then
    [ "${shellorchestra_doas_available:-0}" = "1" ]
    return $?
  fi
  shellorchestra_doas_probe_done=1
  if privilege_probe doas -n true; then shellorchestra_doas_available=1; else shellorchestra_doas_available=0; fi
  [ "$shellorchestra_doas_available" = "1" ]
}

privilege_probe() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 2 "$@" >/dev/null 2>&1
    return $?
  fi
  "$@" >/dev/null 2>&1
}

read_file_bytes() {
  path=$1
  run_file_read_command cat -- "$path"
}

read_file_prefix() {
  path=$1
  bytes=$2
  case "$bytes" in ''|*[!0123456789]*) bytes=8192 ;; esac
  run_file_read_command head -c "$bytes" -- "$path"
}

head_file_lines() {
  path=$1
  lines=$2
  case "$lines" in ''|*[!0123456789]*) lines=1 ;; esac
  # Read through the privileged wrapper so language detection works for
  # root-owned payloads and protected system files.
  read_file_prefix "$path" 131072 2>/dev/null | head -n "$lines"
}

ensure_file_content_readable() {
  path=$1
  if read_file_prefix "$path" 1 >/dev/null 2>&1; then return 0; fi
  json_error "ShellOrchestra could not read this file. Check file permissions or passwordless sudo/doas for the ShellOrchestra service user."
  exit 0
}

base64_encode_file() {
  read_file_bytes "$1" | base64 | tr -d '\n'
}

base64_decode_to_file() {
  value=$1
  output=$2
  if printf '%s' "$value" | base64 -d > "$output" 2>/dev/null; then return 0; fi
  if printf '%s' "$value" | base64 -D > "$output" 2>/dev/null; then return 0; fi
  return 1
}

file_info_text() {
  path=$1
  if command -v file >/dev/null 2>&1; then run_file_read_command file -b -- "$path" 2>/dev/null || printf ''; else printf ''; fi
}

is_text_file() {
  path=$1
  run_file_read_command test -s "$path" || return 0
  if ! read_file_prefix "$path" 1 >/dev/null 2>&1; then return 1; fi
  # Only sample the beginning of the file. Full-file binary checks are too
  # expensive for large logs, disk images, dumps, and other operator artifacts.
  # `grep -Iq` is too aggressive for real logs because ANSI/control bytes can
  # make an otherwise textual log look binary. For preview routing we only need
  # a conservative binary guard: NUL means binary; ordinary text logs, even with
  # a few control/ANSI bytes, are still text and will be sanitized by the editor
  # preflight path before being rendered.
  if command -v perl >/dev/null 2>&1; then
    read_file_prefix "$path" 32768 2>/dev/null | perl -0777 -ne '
      exit 0 if length($_) == 0;
      exit 1 if index($_, "\0") >= 0;
      my $length = length($_);
      my $bad = ($_ =~ tr/\x01-\x08\x0B\x0C\x0E-\x1F\x7F//);
      exit(($bad * 100 > $length * 20) ? 1 : 0);
    ' 2>/dev/null
    return $?
  fi
  if command -v od >/dev/null 2>&1; then
    if read_file_prefix "$path" 32768 2>/dev/null | od -An -tx1 | grep -q ' 00'; then return 1; fi
    return 0
  fi
  return 0
}

append_editor_reason() {
  reason=$1
  if [ -z "$editor_reason" ]; then editor_reason=$reason; else editor_reason="$editor_reason; $reason"; fi
}

has_nul_byte() {
  path=$1
  run_file_read_command test -s "$path" || return 1
  if command -v perl >/dev/null 2>&1; then
    read_file_bytes "$path" 2>/dev/null | perl -0777 -ne 'exit(index($_, "\0") >= 0 ? 0 : 1)'
    return $?
  fi
  if command -v od >/dev/null 2>&1; then
    read_file_bytes "$path" 2>/dev/null | od -An -tx1 -v | grep -q ' 00'
    return $?
  fi
  return 1
}

has_invalid_utf8() {
  path=$1
  if command -v iconv >/dev/null 2>&1; then
    read_file_bytes "$path" 2>/dev/null | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1
    return $?
  fi
  return 0
}

has_editor_control_chars() {
  path=$1
  if command -v perl >/dev/null 2>&1; then
    read_file_bytes "$path" 2>/dev/null | perl -ne '$found = 1 if /[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/; END { exit($found ? 0 : 1) }'
    return $?
  fi
  return 1
}

has_editor_bidi_chars() {
  path=$1
  read_file_bytes "$path" 2>/dev/null | grep -q '[‪‫‬‭‮⁦⁧⁨⁩​‌‍⁠]'
}

has_overlong_editor_line() {
  path=$1
  read_file_bytes "$path" 2>/dev/null | awk -v max="$editor_max_line_bytes" 'length($0) > max { found = 1; exit } END { exit found ? 0 : 1 }'
}

editor_preflight_file() {
  path=$1
  editor_result_mode=editable
  editor_safe=true
  editor_sanitized=false
  editor_reason=""
  size=$(file_size "$path")
  if [ "$size" -gt "$editor_max_bytes" ]; then
    editor_result_mode=blocked
    editor_safe=false
    append_editor_reason "This text file is larger than the browser editor safety limit."
    return
  fi
  if ! is_text_file "$path"; then
    editor_result_mode=blocked
    editor_safe=false
    append_editor_reason "This file looks binary in the initial text check."
    return
  fi
  if has_nul_byte "$path"; then
    editor_result_mode=blocked
    editor_safe=false
    append_editor_reason "This file contains NUL bytes, so it is not a plain text document."
    return
  fi
  if ! has_invalid_utf8 "$path"; then
    editor_result_mode=read_only
    editor_sanitized=true
    append_editor_reason "This file is not valid UTF-8; ShellOrchestra opens a sanitized read-only view."
  fi
  if has_editor_bidi_chars "$path"; then
    editor_result_mode=read_only
    editor_sanitized=true
    append_editor_reason "This file contains bidirectional or invisible Unicode controls; ShellOrchestra strips them in read-only view."
  fi
  if has_editor_control_chars "$path"; then
    editor_result_mode=read_only
    editor_sanitized=true
    append_editor_reason "This file contains unsafe control characters; ShellOrchestra strips them in read-only view."
  fi
  if has_overlong_editor_line "$path"; then
    editor_result_mode=read_only
    editor_sanitized=true
    append_editor_reason "This file contains lines longer than the editor safety limit; ShellOrchestra clips those lines in read-only view."
  fi
}

print_editor_preflight_json_fields() {
  printf ',"editor_mode":'; json_string "$editor_result_mode"
  printf ',"editor_safe":'; if [ "$editor_safe" = "true" ]; then printf 'true'; else printf 'false'; fi
  printf ',"editor_sanitized":'; if [ "$editor_sanitized" = "true" ]; then printf 'true'; else printf 'false'; fi
  printf ',"editor_reason":'; json_string "$editor_reason"
}

sanitize_editor_text_file() {
  path=$1
  if command -v iconv >/dev/null 2>&1; then
    read_file_bytes "$path" 2>/dev/null | iconv -f UTF-8 -t UTF-8 -c 2>/dev/null || read_file_bytes "$path"
  else
    read_file_bytes "$path"
  fi | if command -v perl >/dev/null 2>&1; then
    perl -CSDA -pe 's/[\x{202A}-\x{202E}\x{2066}-\x{2069}\x{200B}\x{200C}\x{200D}\x{2060}]//g; s/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]//g' 2>/dev/null || cat
  else
    sed 's/[‪‫‬‭‮⁦⁧⁨⁩​‌‍⁠]//g' | tr -d '\000-\010\013\014\016-\037\177'
  fi | awk -v max="$editor_max_line_bytes" 'length($0) > max { print substr($0, 1, max) " [ShellOrchestra clipped an overlong line for safe read-only display]"; next } { print }'
}

require_editor_read_allowed() {
  path=$1
  editor_preflight_file "$path"
  if [ "$editor_result_mode" = "blocked" ]; then json_error "$editor_reason"; exit 0; fi
  if [ "$editor_mode_request" = "edit" ] && [ "$editor_result_mode" != "editable" ]; then
    json_error "$editor_reason"
    exit 0
  fi
}

file_magic_hex() {
  path=$1
  if command -v od >/dev/null 2>&1; then
    read_file_prefix "$path" 16 2>/dev/null | od -An -tx1 | tr -d ' \n'
  else
    printf ''
  fi
}

preview_kind_for_file() {
  path=$1
  type=$2
  if [ "$type" = "directory" ]; then printf 'directory'; return; fi
  if [ "$type" != "file" ]; then printf 'other'; return; fi
  if is_document_file_name "$path"; then printf 'document'; return; fi
  magic=$(file_magic_hex "$path")
  case "$magic" in
    89504e470d0a1a0a*) printf 'image' ;;
    ffd8ff*) printf 'image' ;;
    474946383761*|474946383961*) printf 'image' ;;
    52494646????????57454250*) printf 'image' ;;
    25504446*) printf 'pdf' ;;
    *) if is_text_file "$path"; then printf 'text'; else printf 'binary'; fi ;;
  esac
}

is_document_file_name() {
  lower=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case "$lower" in
    *.doc|*.docx|*.xls|*.xlsx|*.ppt|*.pptx|*.odt|*.ods|*.odp|*.rtf) return 0 ;;
    *) return 1 ;;
  esac
}

document_family_for_file() {
  lower=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case "$lower" in
    *.docx) printf 'word-ooxml' ;;
    *.xlsx) printf 'spreadsheet-ooxml' ;;
    *.pptx) printf 'presentation-ooxml' ;;
    *.odt) printf 'word-opendocument' ;;
    *.ods) printf 'spreadsheet-opendocument' ;;
    *.odp) printf 'presentation-opendocument' ;;
    *.rtf) printf 'rich-text' ;;
    *.doc) printf 'legacy-word' ;;
    *.xls) printf 'legacy-spreadsheet' ;;
    *.ppt) printf 'legacy-presentation' ;;
    *) printf 'document' ;;
  esac
}

detect_text_language() {
  path=$1
  base=${path##*/}
  lower_base=$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]')
  lower_path=$(printf '%s' "$path" | tr '[:upper:]' '[:lower:]')
  case "$lower_path" in
    */private/etc/*) lower_path=$(printf '%s' "$lower_path" | sed 's#/private/etc/#/etc/#g') ;;
  esac
  first_line=$(head_file_lines "$path" 1 | awk 'NR == 1 { sub(/^\357\273\277/, ""); print; exit }' || true)
  lower_first=$(printf '%s' "$first_line" | tr '[:upper:]' '[:lower:]')
  case "$lower_first" in
    '#!'*bash*|'#!'*'/sh'*|'#!'*' env sh'*|'#!'*' sh'*|'#!'*zsh*|'#!'*ksh*|'#!'*fish*|'#!'*dash*|'#!'*ash*|'#!'*busybox*) printf 'shell'; return ;;
    '#!'*python*) printf 'python'; return ;;
    '#!'*node*|'#!'*deno*) printf 'javascript'; return ;;
    '#!'*pwsh*|'#!'*powershell*) printf 'powershell'; return ;;
  esac
  case "$lower_path" in
    */.bashrc|*/bashrc|*/.bash_profile|*/bash_profile|*/.bash_login|*/.bash_logout|*/.bash_aliases|*/.profile|*/profile|*/.envrc|*/.direnvrc|*/.zshrc|*/zshrc|*/.zprofile|*/zprofile|*/.zlogin|*/.zlogout|*/.zshenv|*/zshenv|*/.kshrc|*/.mkshrc|*/.xprofile|*/.xinitrc|*/.xsession|*/.xsessionrc|*/.bash_history|*/bash_history|*/.zsh_history|*/.sh_history|*/.ash_history|*/.config/bash/bashrc|*/.config/bash/profile|*/.config/zsh/.zshrc|*/.config/zsh/.zprofile|*/.config/fish/config.fish|*/.config/fish/conf.d/*.fish|*/.config/user-dirs.dirs|*/etc/profile|*/etc/bash.bashrc|*/etc/bashrc|*/etc/zshrc|*/etc/zprofile|*/etc/zlogin|*/etc/zsh/zshrc|*/etc/zsh/zprofile|*/etc/zsh/zshenv|*/etc/zshenv|*/etc/fish/config.fish|*/etc/fish/conf.d/*.fish|*/etc/profile.d/*|*/etc/bash_completion|*/etc/bash_completion.d/*|*/etc/default/*|*/etc/init.d/*|*/etc/conf.d/*|*/etc/sysconfig/*|*/etc/rc.conf|*/etc/rc.conf.d/*|*/etc/rc.subr|*/etc/rc.common|*/etc/rc.local|*/etc/rc.d/*|*/usr/local/etc/rc.d/*|*/etc/acpi/*|*/etc/portage/make.conf|*/etc/makepkg.conf|*/etc/default/grub|*/etc/grub.d/*|*/etc/kernel/postinst.d/*|*/etc/kernel/postrm.d/*|*/etc/update-motd.d/*|*/etc/periodic/*/*|*/etc/local.d/*|*/etc/cron.hourly/*|*/etc/cron.daily/*|*/etc/cron.weekly/*|*/etc/cron.monthly/*|*/etc/x11/xsession|*/etc/x11/xinit/xinitrc|*/etc/ssh/sshrc|*/etc/sv/*/run|*/etc/sv/*/finish|*/etc/service/*/run|*/etc/service/*/finish|*/.ssh/rc|*/sshrc|*/rc.local) printf 'shell'; return ;;
    */etc/sudoers|*/etc/sudoers.d/*|*/usr/local/etc/sudoers|*/usr/local/etc/sudoers.d/*) printf 'sudoers'; return ;;
    */etc/crontab|*/etc/anacrontab|*/etc/cron.d/*|*/usr/local/etc/cron.d/*|*/var/spool/cron/*|*/var/spool/cron/crontabs/*|*/var/cron/tabs/*|*/var/at/tabs/*) printf 'crontab'; return ;;
    */etc/passwd|*/etc/passwd-|*/etc/group|*/etc/group-|*/etc/shadow|*/etc/shadow-|*/etc/gshadow|*/etc/gshadow-|*/etc/subuid|*/etc/subgid|*/etc/master.passwd) printf 'passwd'; return ;;
    */.ssh/config|*/.ssh/config.d/*.conf|*/ssh_config|*/sshd_config|*/etc/ssh/*_config|*/etc/ssh/sshd_config.d/*.conf|*/etc/ssh/ssh_config.d/*.conf|*/usr/local/etc/ssh/*_config|*/usr/local/etc/ssh/sshd_config.d/*.conf|*/usr/local/etc/ssh/ssh_config.d/*.conf|*/programdata/ssh/sshd_config|*/programdata/ssh/ssh_config|*/programdata/ssh/sshd_config.d/*.conf|*/programdata/ssh/ssh_config.d/*.conf) printf 'sshconfig'; return ;;
    */.ssh/authorized_keys|*/authorized_keys|*/authorized_keys2|*/.ssh/known_hosts|*/known_hosts|*/.ssh/allowed_signers|*/allowed_signers|*/etc/ssh/ssh_known_hosts|*/etc/ssh/ssh_known_hosts2|*/etc/ssh/allowed_signers|*/programdata/ssh/administrators_authorized_keys) printf 'sshkeys'; return ;;
    */etc/systemd/system/*|*/etc/systemd/user/*|*/lib/systemd/system/*|*/lib/systemd/user/*|*/usr/lib/systemd/system/*|*/usr/lib/systemd/user/*|*/usr/local/lib/systemd/system/*|*/usr/local/lib/systemd/user/*|*/run/systemd/system/*|*/run/systemd/user/*|*/etc/systemd/*.conf|*/etc/systemd/*.conf.d/*.conf|*/etc/systemd/network/*|*/.config/systemd/user/*|*.network|*.netdev|*.link) printf 'systemd'; return ;;
    */etc/nginx/*|*/nginx.conf) printf 'nginx'; return ;;
    */etc/apache2/*|*/etc/httpd/*|*/apache2.conf|*/httpd.conf) printf 'apache'; return ;;
    */etc/apt/sources.list|*/etc/apt/sources.list.d/*.list|*/etc/apt/sources.list.d/*.sources) printf 'apt_sources'; return ;;
    */etc/hosts|*/windows/system32/drivers/etc/hosts) printf 'hosts'; return ;;
    */etc/fstab|*/etc/fstab.d/*|*/etc/crypttab|*/etc/exports|*/etc/exports.d/*) printf 'fstab'; return ;;
    */etc/logrotate.conf|*/etc/logrotate.d/*) printf 'logrotate'; return ;;
    */etc/pam.d/*) printf 'pam'; return ;;
    */etc/os-release|*/usr/lib/os-release|*/etc/lsb-release|*/etc/locale.conf|*/etc/environment|*/etc/environment.d/*.conf|*/etc/vconsole.conf|*/.ssh/environment|*/.config/environment.d/*.conf) printf 'dotenv'; return ;;
    */etc/hostname|*/etc/machine-id|*/etc/timezone|*/etc/adjtime|*/etc/locale.gen|*/etc/issue|*/etc/issue.d/*|*/etc/issue.net|*/etc/motd|*/etc/motd.d/*|*/etc/hosts.allow|*/etc/hosts.deny|*/etc/hosts.equiv|*/etc/resolv.conf|*/etc/resolvconf/resolv.conf.d/*|*/etc/nsswitch.conf|*/etc/sysctl.conf|*/etc/sysctl.d/*.conf|*/etc/modules|*/etc/modules-load.d/*.conf|*/etc/modprobe.d/*.conf|*/etc/depmod.d/*.conf|*/etc/binfmt.d/*.conf|*/etc/tmpfiles.d/*.conf|*/usr/lib/tmpfiles.d/*.conf|*/lib/tmpfiles.d/*.conf|*/etc/sysusers.d/*.conf|*/usr/lib/sysusers.d/*.conf|*/lib/sysusers.d/*.conf|*/etc/systemd/system-preset/*|*/etc/systemd/user-preset/*|*/usr/lib/systemd/system-preset/*|*/usr/lib/systemd/user-preset/*|*/etc/network/interfaces|*/etc/network/interfaces.d/*|*/etc/security/*.conf|*/etc/security/limits.d/*|*/etc/security/namespace.d/*|*/etc/pam_env.conf|*/etc/selinux/config|*/etc/apk/repositories|*/etc/apk/world|*/etc/apt/preferences|*/etc/apt/preferences.d/*|*/etc/apt/apt.conf|*/etc/apt/apt.conf.d/*|*/etc/apt/auth.conf|*/etc/apt/auth.conf.d/*.conf|*/etc/dpkg/dpkg.cfg|*/etc/dpkg/dpkg.cfg.d/*|*/etc/pacman.d/mirrorlist|*/etc/xbps.d/*.conf|*/etc/doas.conf|*/etc/doas.d/*|*/etc/sudo.conf|*/etc/sudo_logsrvd.conf|*/etc/cron.allow|*/etc/cron.deny|*/etc/at.allow|*/etc/at.deny|*/etc/ssh/authorized_principals|*/etc/ssh/authorized_principals.d/*|*/etc/ssh/moduli|*/etc/ssh/revoked_keys|*/.ssh/authorized_principals|*/.pam_environment|*/etc/udev/rules.d/*.rules|*/etc/audit/audit.rules|*/etc/audit/rules.d/*.rules|*/etc/ca-certificates.conf|*/etc/aliases|*/etc/mail/aliases|*/etc/shells|*/etc/services|*/etc/protocols|*/etc/networks|*/etc/rpc|*/etc/inetd.conf|*/etc/xinetd.d/*|*/etc/smartd.conf|*/etc/multipath.conf|*/etc/mdadm.conf|*/etc/mdadm/mdadm.conf|*/etc/monitrc|*/etc/paths|*/etc/paths.d/*|*/etc/ld.so.conf|*/etc/ld.so.conf.d/*.conf|*/etc/ld.so.preload|*/etc/fuse.conf|*/etc/printcap|*/etc/pf.conf|*/etc/pf.anchors/*|*/etc/pf.os|*/etc/auto.master|*/etc/auto.master.d/*|*/etc/auto.*|*/etc/snapper/configs/*|*/etc/newsyslog.conf|*/etc/newsyslog.d/*|*/etc/asl.conf|*/etc/launchd.conf|*/etc/synthetic.conf|*/etc/periodic.conf|*/etc/login.defs|*/etc/login.conf|*/etc/login.access|*/etc/adduser.conf|*/etc/deluser.conf|*/etc/default/useradd|*/etc/rsyncd.conf|*/etc/rsyslog.conf|*/etc/rsyslog.d/*.conf|*/etc/chrony.conf|*/etc/ntp.conf|*/etc/dhcp/dhclient.conf|*/etc/ufw/*.rules|*/etc/ufw/applications.d/*|*/etc/nftables.conf|*/etc/iptables/rules.v4|*/etc/iptables/rules.v6|*/etc/wpa_supplicant/*.conf|*/etc/openvpn/*.conf|*/etc/keepalived/*.conf|*/etc/haproxy/*.cfg|*/etc/caddy/caddyfile|*/caddyfile|*/etc/redis/redis.conf|*/etc/redis/*.conf|*/etc/postfix/*.cf|*/etc/pve/*.cfg|*/etc/pve/qemu-server/*.conf|*/etc/pve/lxc/*.conf|*/etc/pve/firewall/*.fw|*/etc/nixos/configuration.nix|*/boot/loader/loader.conf|*/boot/loader/entries/*.conf|*/windows/system32/drivers/etc/services|*/windows/system32/drivers/etc/protocol|*/windows/system32/drivers/etc/networks|*/windows/system32/drivers/etc/lmhosts|*/.inputrc|*/.curlrc|*/.wgetrc|*/.netrc|*/.tmux.conf|*/.config/tmux/tmux.conf|*/.screenrc|*/.vimrc|*/.gvimrc|*/.exrc|*/.nanorc|*/.mailrc|*/.psqlrc|*/.pythonrc|*/.config/htop/htoprc|*/.config/procps/toprc|*/.config/mc/mc.keymap|*/.config/kitty/kitty.conf|*/.config/nvim/init.vim|*/.gitignore|*/.dockerignore|*/.containerignore|*/.ignore|*/.gitattributes|*/.npmignore|*/.eslintignore|*/.prettierignore|*/etc/debian_version|*/etc/alpine-release|*/etc/arch-release|*/etc/gentoo-release|*/etc/fedora-release|*/etc/redhat-release|*/etc/rocky-release|*/etc/oracle-release|*/etc/SuSE-release|*/etc/suse-release|*/requirements.txt|*/constraints.txt|*/go.mod|*/go.work|*/go.sum|*/cargo.lock) printf 'systemconfig'; return ;;
    */etc/pacman.conf|*/etc/pacman.d/hooks/*.hook|*/etc/dnf/dnf.conf|*/etc/dnf/plugins/*.conf|*/etc/yum.conf|*/etc/yum/pluginconf.d/*.conf|*/etc/yum.repos.d/*.repo|*/etc/zypp/zypp.conf|*/etc/zypp/repos.d/*.repo|*/etc/samba/smb.conf|*/etc/fail2ban/*.conf|*/etc/fail2ban/*.local|*/etc/fail2ban/*/*.conf|*/etc/fail2ban/*/*.local|*/etc/supervisor/*.conf|*/etc/supervisor/conf.d/*|*/etc/networkmanager/networkmanager.conf|*/etc/networkmanager/conf.d/*.conf|*/etc/networkmanager/system-connections/*|*/etc/wireguard/*.conf|*/etc/mysql/*.cnf|*/etc/mysql/*/*.cnf|*/etc/my.cnf|*/etc/ssl/openssl.cnf|*/etc/pip.conf|*/pip.conf|*/pip.ini|*/.my.cnf|*/.gitconfig|*/.git/config|*/.config/git/config|*/.gitmodules|*/.editorconfig|*/.npmrc|*/.yarnrc|*/.pnpmrc|*/.config/mimeapps.list|*/.local/share/applications/mimeapps.list|*/.config/mc/ini|*/.config/mc/panels.ini|*/.config/gtk-2.0/gtkrc|*/.config/gtk-3.0/settings.ini|*/.config/gtk-4.0/settings.ini|*/etc/xdg/autostart/*.desktop|*/usr/share/applications/*.desktop|*/.local/share/applications/*.desktop|*/.config/autostart/*.desktop) printf 'ini'; return ;;
    */etc/containerd/config.toml|*/etc/containers/containers.conf|*/etc/containers/storage.conf|*/etc/containers/registries.conf|*/etc/containers/registries.conf.d/*.conf|*/.config/containers/containers.conf|*/.config/containers/storage.conf|*/.config/containers/registries.conf|*/.config/containers/registries.conf.d/*.conf|*/.config/starship.toml|*/.config/alacritty/alacritty.toml) printf 'toml'; return ;;
    */etc/docker/daemon.json|*/etc/docker/key.json|*/etc/docker/*.json|*/.docker/config.json|*/etc/containers/policy.json|*/.config/containers/policy.json|*/package.json|*/package-lock.json|*/tsconfig.json|*/jsconfig.json) printf 'json'; return ;;
    */.kube/config|*/etc/netplan/*.yaml|*/etc/netplan/*.yml|*/etc/cloud/cloud.cfg|*/etc/cloud/cloud.cfg.d/*.cfg|*/etc/cloud/cloud.cfg.d/*.yaml|*/etc/cloud/cloud.cfg.d/*.yml) printf 'yaml'; return ;;
    */library/launchdaemons/*.plist|*/library/launchagents/*.plist|*/library/preferences/*.plist|*/library/preferences/systemconfiguration/*.plist|*/system/library/launchdaemons/*.plist|*/system/library/launchagents/*.plist|*/system/library/preferences/*.plist|*/windows/system32/inetsrv/config/*.config|*/windows/microsoft.net/framework*/config/*.config|*/windows/microsoft.net/framework64*/config/*.config|*/etc/firewalld/*.xml|*/etc/firewalld/zones/*.xml|*/etc/firewalld/services/*.xml) printf 'xml'; return ;;
  esac
  case "$lower_base" in
    dockerfile|containerfile) printf 'dockerfile'; return ;;
    docker-compose.yml|docker-compose.yaml|compose.yml|compose.yaml) printf 'yaml'; return ;;
    makefile|gnumakefile) printf 'makefile'; return ;;
    caddyfile|procfile) printf 'systemconfig'; return ;;
    bashrc|*-bashrc|*.bashrc|profile|zshrc|zprofile|zlogin|zlogout|zshenv|kshrc|mkshrc|xprofile|xinitrc|xsession|xsessionrc|sshrc|rc.local) printf 'shell'; return ;;
    sudoers) printf 'sudoers'; return ;;
    crontab|anacrontab) printf 'crontab'; return ;;
    passwd|passwd-|group|group-|shadow|shadow-|gshadow|gshadow-|subuid|subgid) printf 'passwd'; return ;;
    ssh_config|sshd_config) printf 'sshconfig'; return ;;
    authorized_keys|authorized_keys2|known_hosts|allowed_signers|administrators_authorized_keys) printf 'sshkeys'; return ;;
    hosts) printf 'hosts'; return ;;
    fstab|crypttab|exports) printf 'fstab'; return ;;
    logrotate.conf) printf 'logrotate'; return ;;
    nginx.conf|*-nginx.conf|*.nginx.conf|*_nginx.conf) printf 'nginx'; return ;;
    apache2.conf|httpd.conf) printf 'apache'; return ;;
    .env|.env.*|*.env) printf 'dotenv'; return ;;
    .envrc|.direnvrc) printf 'shell'; return ;;
    crontab) if head_file_lines "$path" 80 | grep -Eq '^[[:space:]]*(@(reboot|hourly|daily|weekly|monthly|yearly|annually)([[:space:]]|$)|([*0-9,/:-]+[[:space:]]+){5})'; then printf 'crontab'; return; fi ;;
    *.service|*.socket|*.timer|*.mount|*.target|*.path|*.slice|*.scope|*.automount) printf 'systemd'; return ;;
    *.sh|*.bash|*.zsh|*.ksh|*.fish|*.profile) printf 'shell'; return ;;
    *.ps1|*.psm1|*.psd1) printf 'powershell'; return ;;
    *.ts|*.tsx) printf 'typescript'; return ;;
    *.js|*.jsx|*.mjs|*.cjs) printf 'javascript'; return ;;
    *.json|*.jsonc) printf 'json'; return ;;
    *.yaml|*.yml) printf 'yaml'; return ;;
    *.md|*.markdown) printf 'markdown'; return ;;
    *.go) printf 'go'; return ;;
    *.py) printf 'python'; return ;;
    *.css) printf 'css'; return ;;
    *.html|*.htm|*.jinja|*.j2) printf 'html'; return ;;
    *.toml) printf 'toml'; return ;;
    *.ini|*.cnf|*.cfg|*.desktop|*.properties|*.conf.dpkg-old|*.conf.dpkg-dist) printf 'ini'; return ;;
    *.xml|*.plist|*.ps1xml|web.config|app.config|applicationhost.config|machine.config|nuget.config) printf 'xml'; return ;;
    *.reg) printf 'registry'; return ;;
    *.rules) printf 'systemconfig'; return ;;
  esac
  if head_file_lines "$path" 40 | grep -Eq '^[[:space:]]*<\?xml|^[[:space:]]*<plist[[:space:]>]|^[[:space:]]*<configuration[[:space:]>]|^[[:space:]]*<Project[[:space:]>]|^[[:space:]]*<packageSources[[:space:]>]'; then printf 'xml'; return; fi
  if head_file_lines "$path" 120 | grep -Eq '^[[:space:]]*\[(Unit|Service|Install|Socket|Timer|Mount|Path|Target|Slice|Automount)\][[:space:]]*$'; then printf 'systemd'; return; fi
  if head_file_lines "$path" 120 | grep -Eq '^[[:space:]]*(Defaults|User_Alias|Runas_Alias|Host_Alias|Cmnd_Alias)([[:space:]]|$)|^[[:space:]]*%?[A-Za-z0-9_.-]+[[:space:]]+.*ALL[[:space:]]*='; then printf 'sudoers'; return; fi
  if head_file_lines "$path" 120 | grep -Eq '^[[:space:]]*(@(reboot|hourly|daily|weekly|monthly|yearly|annually)([[:space:]]|$)|([*0-9,/:-]+[[:space:]]+){5})'; then printf 'crontab'; return; fi
  if head_file_lines "$path" 20 | grep -Eq '^[^:#[:space:]][^:]*(:[^:]*){5,}$'; then printf 'passwd'; return; fi
  if head_file_lines "$path" 120 | grep -Eiq '^[[:space:]]*(events|http|server|location|upstream|map)[[:space:]].*[\{;]'; then printf 'nginx'; return; fi
  if head_file_lines "$path" 120 | grep -Eiq '^[[:space:]]*(Host|Match|Include|HostName|IdentityFile|ProxyJump|ProxyCommand|StrictHostKeyChecking|PasswordAuthentication|PubkeyAuthentication)([[:space:]]|$)'; then printf 'sshconfig'; return; fi
  if head_file_lines "$path" 80 | grep -Eq '^[[:space:]]*((cert-authority|command=|from=|no-[A-Za-z-]+|permit[A-Za-z-]+)[^[:space:]]*[[:space:]]+)?(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp[0-9]+|sk-ssh-ed25519@|sk-ecdsa-sha2-nistp[0-9]+@)[[:space:]]+[A-Za-z0-9+/=]{24,}'; then printf 'sshkeys'; return; fi
  if head_file_lines "$path" 120 | grep -Eiq '^[[:space:]]*<(/)?(VirtualHost|Directory|Location|IfModule|FilesMatch)|^[[:space:]]*(ServerName|DocumentRoot|LoadModule|IncludeOptional|ErrorLog|CustomLog)([[:space:]]|$)'; then printf 'apache'; return; fi
  if head_file_lines "$path" 80 | grep -Eq '^[[:space:]]*([0-9]{1,3}\.){3}[0-9]{1,3}[[:space:]]+[A-Za-z0-9_.-]+'; then printf 'hosts'; return; fi
  if head_file_lines "$path" 80 | grep -Eq '^[[:space:]]*[^#[:space:]]+[[:space:]]+[^#[:space:]]+[[:space:]]+(ext[234]|xfs|btrfs|zfs|nfs|cifs|vfat|exfat|swap|auto)[[:space:]]+'; then printf 'fstab'; return; fi
  if head_file_lines "$path" 120 | grep -Eq '^[[:space:]]*(daily|weekly|monthly|rotate|compress|missingok|notifempty|create|postrotate|prerotate|endscript)([[:space:]]|$)|^[[:space:]]*([^#[:space:]]*/[^#{}[:space:]]*|[^#[:space:]]*\*[^#{}[:space:]]*)[[:space:]]*\{'; then printf 'logrotate'; return; fi
  if head_file_lines "$path" 120 | grep -Eq '^[[:space:]]*(auth|account|password|session)[[:space:]]+(\[[^]]+\]|required|requisite|sufficient|optional)'; then printf 'pam'; return; fi
  if head_file_lines "$path" 120 | grep -Eq '^[[:space:]]*(set[[:space:]]+-[A-Za-z]*[euox][A-Za-z]*|if[[:space:]].*[[:space:]]then|for[[:space:]].*[[:space:]]in[[:space:]].*[[:space:]]do|while[[:space:]].*[[:space:]]do|case[[:space:]].*[[:space:]]in|[A-Za-z_][A-Za-z0-9_]*\(\)[[:space:]]*\{|function[[:space:]]+[A-Za-z_][A-Za-z0-9_]*|[^#]*\$\(|[^#]*\$\{)'; then printf 'shell'; return; fi
  if head_file_lines "$path" 120 | grep -Eq '^[[:space:]]*[\{\[]' && head_file_lines "$path" 120 | grep -Eq '"[A-Za-z0-9_.-]+"[[:space:]]*:'; then printf 'json'; return; fi
  if head_file_lines "$path" 120 | grep -Eq '^[[:space:]]*[A-Za-z0-9_.-]+:[[:space:]]+([^[:space:]#]|$)' && head_file_lines "$path" 120 | grep -Eq '^[[:space:]]{2,}[A-Za-z0-9_.-]+:'; then printf 'yaml'; return; fi
  if head_file_lines "$path" 120 | awk 'NR == 1 { sub(/^\357\273\277/, "") } /^[[:space:]]*\[[^]]+\][[:space:]]*$/ { found = 1; exit } END { exit found ? 0 : 1 }'; then printf 'ini'; return; fi
  if head_file_lines "$path" 120 | awk 'BEGIN { count = 0 } /^[[:space:]]*[A-Za-z0-9_.-]+[[:space:]]*=[[:space:]]*[^#[:space:]]/ { line = $0; sub(/^[[:space:]]*/, "", line); key = line; sub(/[[:space:]]*=.*/, "", key); if (key ~ /[.-]/ || line ~ /^[A-Za-z0-9_.-]+[[:space:]]+=/) count++ } END { exit count >= 2 ? 0 : 1 }'; then printf 'ini'; return; fi
  if head_file_lines "$path" 120 | grep -Eq '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*='; then printf 'dotenv'; return; fi
  if head_file_lines "$path" 20 | grep -Eq '^[[:space:]]*Windows Registry Editor Version'; then printf 'registry'; return; fi
  if head_file_lines "$path" 120 | awk 'BEGIN { count = 0 } /^[[:space:]]*[A-Za-z][A-Za-z0-9_.-]+:[[:space:]]+[^#[:space:]]/ { count++ } END { exit count >= 2 ? 0 : 1 }'; then printf 'systemconfig'; return; fi
  if head_file_lines "$path" 120 | grep -Eq '^[[:space:]]*[A-Za-z][A-Za-z0-9_.-]+[[:space:]]+[^#[:space:]]+'; then printf 'systemconfig'; return; fi
  printf 'plaintext'
}

mime_for_preview_kind() {
  path=$1
  kind=$2
  magic=$(file_magic_hex "$path")
  lower=$(printf '%s' "$path" | tr '[:upper:]' '[:lower:]')
  case "$kind:$magic" in
    image:89504e470d0a1a0a*) printf 'image/png' ;;
    image:ffd8ff*) printf 'image/jpeg' ;;
    image:474946383761*|image:474946383961*) printf 'image/gif' ;;
    image:52494646????????57454250*) printf 'image/webp' ;;
    pdf:*) printf 'application/pdf' ;;
    text:*) printf 'text/plain; charset=utf-8' ;;
    document:*) case "$lower" in
      *.docx) printf 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ;;
      *.xlsx) printf 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ;;
      *.pptx) printf 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ;;
      *.odt) printf 'application/vnd.oasis.opendocument.text' ;;
      *.ods) printf 'application/vnd.oasis.opendocument.spreadsheet' ;;
      *.odp) printf 'application/vnd.oasis.opendocument.presentation' ;;
      *.rtf) printf 'application/rtf' ;;
      *.doc) printf 'application/msword' ;;
      *.xls) printf 'application/vnd.ms-excel' ;;
      *.ppt) printf 'application/vnd.ms-powerpoint' ;;
      *) printf 'application/octet-stream' ;;
    esac ;;
    *) printf 'application/octet-stream' ;;
  esac
}

xml_to_plain_text() {
  sed 's/<[^>][^>]*>/ /g' \
    | sed 's/&lt;/</g; s/&gt;/>/g; s/&amp;/\&/g; s/&quot;/"/g; s/&apos;/'"'"'/g; s/&#10;/\
/g; s/&#13;/\
/g; s/&#9;/	/g' \
    | tr '\r\t' '  ' \
    | awk '
      {
        gsub(/[[:space:]][[:space:]]+/, " ");
        line = $0;
        sub(/^[[:space:]]+/, "", line);
        sub(/[[:space:]]+$/, "", line);
        if (line != "") print line;
      }
    '
}

printable_strings_preview() {
  path=$1
  if command -v strings >/dev/null 2>&1; then
    read_file_prefix "$path" "$max_bytes" 2>/dev/null | strings -n 4 2>/dev/null || true
  else
    read_file_prefix "$path" "$max_bytes" 2>/dev/null | tr -cd '\11\12\15\40-\176' | awk 'length($0) >= 4 { print }' || true
  fi
}

python_zip_document_text_preview() {
  path=$1
  family=$2
  python_bin=''
  if command -v python3 >/dev/null 2>&1; then
    python_bin=$(command -v python3)
  elif command -v python >/dev/null 2>&1; then
    python_bin=$(command -v python)
  else
    return 127
  fi
  run_file_read_command "$python_bin" - "$path" "$family" "$max_bytes" <<'PY'
import fnmatch
import sys
import zipfile

archive_path = sys.argv[1]
family = sys.argv[2]
try:
    max_bytes = max(1, int(sys.argv[3]))
except Exception:
    max_bytes = 65536

patterns_by_family = {
    "word-ooxml": [
        "word/document.xml",
        "word/header*.xml",
        "word/footer*.xml",
        "word/footnotes.xml",
        "word/endnotes.xml",
    ],
    "spreadsheet-ooxml": [
        "xl/sharedStrings.xml",
        "xl/workbook.xml",
        "xl/worksheets/sheet*.xml",
    ],
    "presentation-ooxml": [
        "ppt/slides/slide*.xml",
        "ppt/notesSlides/notesSlide*.xml",
    ],
    "word-opendocument": ["content.xml", "meta.xml", "styles.xml"],
    "spreadsheet-opendocument": ["content.xml", "meta.xml", "styles.xml"],
    "presentation-opendocument": ["content.xml", "meta.xml", "styles.xml"],
}

patterns = patterns_by_family.get(family, [])
written = 0
try:
    with zipfile.ZipFile(archive_path) as archive:
        names = archive.namelist()
        selected = []
        for pattern in patterns:
            selected.extend(name for name in names if fnmatch.fnmatch(name, pattern))
        for name in selected:
            if written >= max_bytes:
                break
            try:
                with archive.open(name) as handle:
                    chunk = handle.read(max_bytes - written)
            except Exception:
                continue
            if not chunk:
                continue
            sys.stdout.buffer.write(chunk)
            written += len(chunk)
            if written < max_bytes:
                sys.stdout.buffer.write(b"\n")
                written += 1
except Exception:
    sys.exit(1)
PY
}

zip_document_text_preview() {
  path=$1
  family=$2
  if ! command -v unzip >/dev/null 2>&1; then
    tmp_zip_preview=$(mktemp)
    if python_zip_document_text_preview "$path" "$family" > "$tmp_zip_preview" 2>/dev/null && [ -s "$tmp_zip_preview" ]; then
      head -c "$max_bytes" "$tmp_zip_preview" | xml_to_plain_text | head -c "$max_bytes"
      rm -f "$tmp_zip_preview"
      return
    fi
    rm -f "$tmp_zip_preview"
    printf 'Safe document text preview is limited on this server because unzip is not installed.\n'
    printf 'Download the original only if you trust this file.\n'
    return
  fi
  case "$family" in
    word-ooxml)
      run_file_read_command unzip -p -- "$path" word/document.xml 'word/header*.xml' 'word/footer*.xml' word/footnotes.xml word/endnotes.xml 2>/dev/null || true
      ;;
    spreadsheet-ooxml)
      run_file_read_command unzip -p -- "$path" xl/sharedStrings.xml xl/workbook.xml 'xl/worksheets/sheet*.xml' 2>/dev/null || true
      ;;
    presentation-ooxml)
      run_file_read_command unzip -p -- "$path" 'ppt/slides/slide*.xml' 'ppt/notesSlides/notesSlide*.xml' 2>/dev/null || true
      ;;
    word-opendocument|spreadsheet-opendocument|presentation-opendocument)
      run_file_read_command unzip -p -- "$path" content.xml meta.xml styles.xml 2>/dev/null || true
      ;;
    *)
      return
      ;;
  esac | head -c "$max_bytes" | xml_to_plain_text | head -c "$max_bytes"
}

rtf_text_preview() {
  path=$1
  read_file_prefix "$path" "$max_bytes" 2>/dev/null \
    | sed 's/\\\\par/\
/g; s/\\\\tab/ /g; s/\\\\[A-Za-z][A-Za-z0-9-]*[ ]*//g; s/[{}]//g' \
    | tr '\r' '\n' \
    | awk 'NF { print }' \
    | head -c "$max_bytes" || true
}

document_preview_text() {
  path=$1
  kind=$2
  family=$(document_family_for_file "$path")
  if [ "$kind" = "pdf" ]; then
    printable_strings_preview "$path" | head -c "$max_bytes"
    return
  fi
  case "$family" in
    word-ooxml|spreadsheet-ooxml|presentation-ooxml|word-opendocument|spreadsheet-opendocument|presentation-opendocument)
      zip_document_text_preview "$path" "$family"
      ;;
    rich-text)
      rtf_text_preview "$path"
      ;;
    *)
      printable_strings_preview "$path" | head -c "$max_bytes"
      ;;
  esac
}

require_existing_path() {
  if [ -z "$target_path" ]; then json_error "Path is required."; exit 0; fi
  if ! run_file_read_command test -e "$target_path" && ! run_file_read_command test -L "$target_path"; then json_error "Path was not found."; exit 0; fi
}

require_safe_mutation_path() {
  path=$1
  case "$path" in ''|'/') json_error "Refusing to modify an empty path or the filesystem root."; exit 0 ;; esac
}

dangerous_file_name_reason() {
  name=$1
  newline='
'
  tab=$(printf '\t')
  cr=$(printf '\r')
  esc=$(printf '\033')
  case "$name" in
    ''|'.'|'..') printf 'reserved path component'; return 0 ;;
    *"$newline"*|*"$tab"*|*"$cr"*|*"$esc"*) printf 'control character'; return 0 ;;
    */*|*\\*) printf 'path separator'; return 0 ;;
    *‪*|*‫*|*‬*|*‭*|*‮*|*⁦*|*⁧*|*⁨*|*⁩*) printf 'bidirectional text control'; return 0 ;;
  esac
  if [ "${#name}" -gt 255 ]; then printf 'name is longer than 255 characters'; return 0; fi
  return 1
}

suspicious_file_name_reason() {
  name=$1
  case "$name" in
    -*) printf 'starts with a dash'; return 0 ;;
    *'<'*|*'>'*|*'"'*|*"'"*|*'`'*|*'$('*|*';'*|*'|'*|*'&'*) printf 'contains shell or HTML-like characters'; return 0 ;;
    *​*|*‌*|*‍*|*⁠*) printf 'contains invisible formatting characters'; return 0 ;;
  esac
  return 1
}

append_hidden_reason() {
  reason=$1
  current=$2
  case ",$current," in *,"$reason",*) printf '%s' "$current"; return ;; esac
  if [ -n "$current" ]; then printf '%s,%s' "$current" "$reason"; else printf '%s' "$reason"; fi
}

print_location() {
  first=$1; label=$2; path=$3; kind=$4
  if [ "$first" != "1" ]; then printf ','; fi
  printf '{"label":'; json_string "$label"; printf ',"path":'; json_string "$path"; printf ',"kind":'; json_string "$kind"; printf '}'
}

passwd_entries() {
  if command -v getent >/dev/null 2>&1 && getent passwd >/dev/null 2>&1; then
    getent passwd
    return
  fi
  if [ -r /etc/passwd ]; then cat /etc/passwd; fi
}

is_non_system_user_home() {
  user=$1
  uid=$2
  path=$3
  case "$user" in ''|root|nobody|daemon|bin|sys|sync|shutdown|halt|operator|games|ftp|mail|news|uucp|lp|sshd|dbus|polkitd|avahi|colord|gdm|lightdm|sddm|systemd-*|_* ) return 1 ;; esac
  case "$uid" in ''|*[!0123456789]*) uid=0 ;; esac
  case "$path" in
    /home/*|/Users/*|/var/home/*|/usr/home/*) ;;
    *) [ "$uid" -ge 1000 ] || return 1 ;;
  esac
  case "$path" in ''|'/'|'/nonexistent'|'/dev/null'|'/var/empty'|'/run/'*|'/var/lib/'*) return 1 ;; esac
  [ -d "$path" ] || return 1
  return 0
}

print_posix_user_homes() {
  current_home=$1
  passwd_entries | while IFS=: read -r user _ uid _ _ path _; do
    is_non_system_user_home "$user" "$uid" "$path" || continue
    [ "$path" != "$current_home" ] || continue
    print_location 0 "Home ($user)" "$path" "user_home"
  done
}

print_macos_user_homes() {
  current_home=$1
  dscl . -list /Users NFSHomeDirectory 2>/dev/null | awk '$2 ~ /^\/Users\// {print $1 "\t" $2}' | while IFS='	' read -r user path; do
    [ -n "$user" ] && [ -n "$path" ] || continue
    case "$user" in root|nobody|daemon|_* ) continue ;; esac
    case "$path" in '/Users/Shared'|'/var/empty'|'') continue ;; esac
    [ -d "$path" ] || continue
    [ "$path" != "$current_home" ] || continue
    print_location 0 "Home ($user)" "$path" "user_home"
  done
}

locations() {
  current_home=$(home_dir)
  current_user=$(id -un 2>/dev/null || whoami 2>/dev/null || printf user)
  printf '{"ok":true,"action":"locations","current_path":'
  json_string "$current_home"
  printf ',"locations":['
  first=1
  print_location "$first" "Home ($current_user)" "$current_home" "home"; first=0
  print_location "$first" "Root" "/" "root"
  if [ -d /tmp ]; then print_location 0 "Temporary files" "/tmp" "temporary"; fi
  if [ -d /etc ]; then print_location 0 "System config" "/etc" "system"; fi
  if [ -d /var/log ]; then print_location 0 "System logs" "/var/log" "logs"; fi
  if command -v dscl >/dev/null 2>&1; then print_macos_user_homes "$current_home"; else print_posix_user_homes "$current_home"; fi
  printf ']}\n'
}

list_dir() {
  dir=$target_path
  if [ -z "$dir" ]; then dir=$(home_dir); fi
  if ! run_file_read_command test -d "$dir"; then json_error "Directory was not found."; exit 0; fi
  resolve_started_ms=$(now_ms)
  canonical=$(run_file_read_command sh -c 'cd "$1" 2>/dev/null && pwd -P' sh "$dir" 2>/dev/null || printf '%s' "$dir")
  parent=$(dirname "$canonical" 2>/dev/null || printf '/')
  resolve_finished_ms=$(now_ms)
  resolve_ms=$(elapsed_ms "$resolve_started_ms" "$resolve_finished_ms")
  entry_list=$(mktemp 2>/dev/null || printf '')
  if [ -z "$entry_list" ]; then json_error "ShellOrchestra could not create a temporary directory listing buffer."; exit 0; fi
  sorted_list=$(mktemp 2>/dev/null || printf '')
  if [ -z "$sorted_list" ]; then rm -f "$entry_list"; json_error "ShellOrchestra could not create a temporary sorted directory listing buffer."; exit 0; fi
  enumerate_started_ms=$(now_ms)
  if ! run_file_read_command sh -c '
    dir=$1
    if find "$dir" -mindepth 1 -maxdepth 1 -printf "" >/dev/null 2>&1; then
      find "$dir" -mindepth 1 -maxdepth 1 ! -name "*	*" -printf "%p	%f	%y	%s	%m	%u	%g	%T@\n"
      exit 0
    fi
    for entry in "$dir"/.* "$dir"/*; do
      base=${entry##*/}
      case "$base" in "."|"..") continue ;; esac
      [ -e "$entry" ] || [ -L "$entry" ] || continue
      case "$base" in *"	"*) continue ;; esac
      if stat_fields=$(stat -c "%s	%a	%U	%G	%Y" -- "$entry" 2>/dev/null); then
        :
      elif stat_fields=$(stat -f "%z	%Lp	%Su	%Sg	%m" -- "$entry" 2>/dev/null); then
        :
      else
        stat_fields="0	000			0"
      fi
      if [ -L "$entry" ]; then type=symlink; elif [ -d "$entry" ]; then type=directory; elif [ -f "$entry" ]; then type=file; else type=other; fi
      printf "%s	%s	%s	%s\n" "$entry" "$base" "$type" "$stat_fields"
    done
  ' sh "$canonical" > "$entry_list" 2>/dev/null; then
    rm -f "$entry_list" "$sorted_list"
    json_error "ShellOrchestra could not read this directory. Check directory permissions or passwordless sudo/doas for the ShellOrchestra service user."
    exit 0
  fi
  enumerate_finished_ms=$(now_ms)
  enumerate_ms=$(elapsed_ms "$enumerate_started_ms" "$enumerate_finished_ms")
  sort_started_ms=$(now_ms)
  if command -v sort >/dev/null 2>&1; then
    awk -F '\t' 'BEGIN { OFS = "\t" } { rank = ($3 == "d" || $3 == "directory") ? 0 : 1; print rank, tolower($2), $2, $0 }' "$entry_list" \
      | sort -t '	' -k1,1n -k2,2 -k3,3 \
      | cut -f4- > "$sorted_list"
  else
    cp "$entry_list" "$sorted_list"
  fi
  sort_finished_ms=$(now_ms)
  sort_ms=$(elapsed_ms "$sort_started_ms" "$sort_finished_ms")
  listing_hash=$(file_digest "$sorted_list" 2>/dev/null || printf '')
  if [ -n "$known_listing_hash" ] && [ "$known_listing_hash" = "$listing_hash" ]; then
    entry_count=$(wc -l < "$sorted_list" 2>/dev/null | awk '{print $1 + 0}' || printf '0')
    total_ms=$(awk -v r="$resolve_ms" -v e="$enumerate_ms" -v s="$sort_ms" 'BEGIN { printf "%d", (r + e + s) }')
    if [ "$stream_format" = "row_events" ]; then
      printf '{"event":"meta","data":{"ok":true,"action":"list","path":'; json_string "$canonical"; printf ',"parent_path":'; json_string "$parent"; printf ',"safe_filename_mode":"hide_dangerous","server_sort_key":"name","server_sort_direction":"asc","server_sort_directories_first":true,"listing_hash":'; json_string "$listing_hash"; printf ',"unchanged":true}}\n'
      printf '{"event":"done","data":{"hidden_entries_count":0,"hidden_entries_reasons":[]'
      printf ',"profile":{"action":"list","platform":"posix","requested_path":'; json_string "$dir"; printf ',"resolved_path":'; json_string "$canonical"; printf ',"entries_count":%d' "$entry_count"
      printf ',"resolve_ms":%d,"enumerate_ms":%d,"sort_ms":%d,"project_ms":0,"total_ms":%d' "$resolve_ms" "$enumerate_ms" "$sort_ms" "$total_ms"
      printf ',"output_encoding_requested":'; json_string "$output_encoding"; printf '}}}\n'
      rm -f "$entry_list" "$sorted_list"
      return
    fi
    printf '{"ok":true,"action":"list","path":'; json_string "$canonical"; printf ',"parent_path":'; json_string "$parent"; printf ',"safe_filename_mode":"hide_dangerous","server_sort_key":"name","server_sort_direction":"asc","server_sort_directories_first":true,"listing_hash":'; json_string "$listing_hash"; printf ',"unchanged":true,"entries":[],"hidden_entries_count":0,"hidden_entries_reasons":[]'
    printf ',"profile":{"action":"list","platform":"posix","requested_path":'; json_string "$dir"; printf ',"resolved_path":'; json_string "$canonical"; printf ',"entries_count":%d' "$entry_count"
    printf ',"resolve_ms":%d,"enumerate_ms":%d,"sort_ms":%d,"project_ms":0,"total_ms":%d' "$resolve_ms" "$enumerate_ms" "$sort_ms" "$total_ms"
    printf ',"output_encoding_requested":'; json_string "$output_encoding"; printf '}}\n'
    rm -f "$entry_list" "$sorted_list"
    return
  fi
  if [ "$stream_format" = "row_events" ]; then
    printf '{"event":"meta","data":{"ok":true,"action":"list","path":'; json_string "$canonical"; printf ',"parent_path":'; json_string "$parent"; printf ',"safe_filename_mode":"hide_dangerous","server_sort_key":"name","server_sort_direction":"asc","server_sort_directories_first":true,"listing_hash":'; json_string "$listing_hash"; printf '}}\n'
    awk -F '\t' \
      -v requested_path="$dir" \
      -v resolved_path="$canonical" \
      -v resolve_ms="$resolve_ms" \
      -v enumerate_ms="$enumerate_ms" \
      -v sort_ms="$sort_ms" \
      -v output_encoding_requested="$output_encoding" \
      '
      function json(value) {
        gsub(/\\/, "\\\\", value)
        gsub(/"/, "\\\"", value)
        gsub(/\t/, "\\t", value)
        gsub(/\r/, "\\r", value)
        gsub(/\n/, "\\n", value)
        return "\"" value "\""
      }
      function add_hidden(reason) {
        hidden_count++
        hidden_reasons[reason] = 1
      }
      function mapped_type(value) {
        if (value == "d" || value == "directory") return "directory"
        if (value == "f" || value == "file") return "file"
        if (value == "l" || value == "symlink") return "symlink"
        return "other"
      }
      function dangerous_reason(name) {
        if (name == "" || name == "." || name == "..") return "reserved path component"
        if (name ~ /[\/\\]/) return "path separator"
        if (length(name) > 255) return "name is longer than 255 characters"
        return ""
      }
      function suspicious_reason(name) {
        if (name ~ /^-/) return "starts with a dash"
        if (name ~ /[<>"`;$|&]/ || index(name, "\047") > 0 || index(name, "$(") > 0) return "contains shell or HTML-like characters"
        return ""
      }
      BEGIN { count = 0; hidden_count = 0 }
      {
        entry = $1
        base = $2
        type = mapped_type($3)
        size = ($4 == "" ? 0 : $4 + 0)
        mode = ($5 == "" ? "000" : $5)
        user = $6
        group = $7
        modified = $8
        sub(/\..*$/, "", modified)
        if (modified == "") modified = 0
        reason = dangerous_reason(base)
        if (reason != "") { add_hidden(reason); next }
        warning = suspicious_reason(base)
        printf "{\"event\":\"row\",\"data\":{\"name\":%s,\"path\":%s,\"type\":%s", json(base), json(entry), json(type)
        printf ",\"is_dir\":%s", (type == "directory" ? "true" : "false")
        printf ",\"size\":%d,\"mode\":%s,\"user\":%s,\"group\":%s,\"modified_epoch\":%d", size, json(mode), json(user), json(group), modified + 0
        if (warning != "") {
          printf ",\"name_safety\":\"suspicious\",\"name_safety_reasons\":[%s]", json(warning)
        } else {
          printf ",\"name_safety\":\"safe\",\"name_safety_reasons\":[]"
        }
        printf "}}\n"
        count++
      }
      END {
        printf "{\"event\":\"done\",\"data\":{\"hidden_entries_count\":%d,\"hidden_entries_reasons\":[", hidden_count
        reason_count = 0
        for (reason in hidden_reasons) {
          if (reason_count > 0) printf ","
          printf "%s", json(reason)
          reason_count++
        }
        project_ms = 0
        total_ms = resolve_ms + enumerate_ms + sort_ms + project_ms
        printf "]"
        printf ",\"profile\":{\"action\":\"list\",\"platform\":\"posix\",\"requested_path\":%s,\"resolved_path\":%s,\"entries_count\":%d", json(requested_path), json(resolved_path), count
        printf ",\"resolve_ms\":%d,\"enumerate_ms\":%d,\"sort_ms\":%d,\"project_ms\":%d,\"total_ms\":%d", resolve_ms + 0, enumerate_ms + 0, sort_ms + 0, project_ms + 0, total_ms + 0
        printf ",\"output_encoding_requested\":%s}}}\n", json(output_encoding_requested)
      }
    ' "$sorted_list"
    rm -f "$entry_list" "$sorted_list"
    return
  fi
  printf '{"ok":true,"action":"list","path":'; json_string "$canonical"; printf ',"parent_path":'; json_string "$parent"; printf ',"safe_filename_mode":"hide_dangerous","server_sort_key":"name","server_sort_direction":"asc","server_sort_directories_first":true,"listing_hash":'; json_string "$listing_hash"; printf ',"entries":['
  awk -F '\t' \
    -v requested_path="$dir" \
    -v resolved_path="$canonical" \
    -v resolve_ms="$resolve_ms" \
    -v enumerate_ms="$enumerate_ms" \
    -v sort_ms="$sort_ms" \
    -v output_encoding_requested="$output_encoding" \
    '
    function json(value) {
      gsub(/\\/, "\\\\", value)
      gsub(/"/, "\\\"", value)
      gsub(/\t/, "\\t", value)
      gsub(/\r/, "\\r", value)
      gsub(/\n/, "\\n", value)
      return "\"" value "\""
    }
    function add_hidden(reason) {
      hidden_count++
      hidden_reasons[reason] = 1
    }
    function mapped_type(value) {
      if (value == "d" || value == "directory") return "directory"
      if (value == "f" || value == "file") return "file"
      if (value == "l" || value == "symlink") return "symlink"
      return "other"
    }
    function dangerous_reason(name) {
      if (name == "" || name == "." || name == "..") return "reserved path component"
      if (name ~ /[\/\\]/) return "path separator"
      if (length(name) > 255) return "name is longer than 255 characters"
      return ""
    }
    function suspicious_reason(name) {
      if (name ~ /^-/) return "starts with a dash"
      if (name ~ /[<>"`;$|&]/ || index(name, "\047") > 0 || index(name, "$(") > 0) return "contains shell or HTML-like characters"
      return ""
    }
    BEGIN { count = 0; hidden_count = 0 }
    {
      entry = $1
      base = $2
      type = mapped_type($3)
      size = ($4 == "" ? 0 : $4 + 0)
      mode = ($5 == "" ? "000" : $5)
      user = $6
      group = $7
      modified = $8
      sub(/\..*$/, "", modified)
      if (modified == "") modified = 0
      reason = dangerous_reason(base)
      if (reason != "") { add_hidden(reason); next }
      warning = suspicious_reason(base)
      if (count > 0) printf ","
      printf "{\"name\":%s,\"path\":%s,\"type\":%s", json(base), json(entry), json(type)
      printf ",\"is_dir\":%s", (type == "directory" ? "true" : "false")
      printf ",\"size\":%d,\"mode\":%s,\"user\":%s,\"group\":%s,\"modified_epoch\":%d", size, json(mode), json(user), json(group), modified + 0
      if (warning != "") {
        printf ",\"name_safety\":\"suspicious\",\"name_safety_reasons\":[%s]", json(warning)
      } else {
        printf ",\"name_safety\":\"safe\",\"name_safety_reasons\":[]"
      }
      printf "}"
      count++
    }
    END {
      printf "],\"hidden_entries_count\":%d,\"hidden_entries_reasons\":[", hidden_count
      reason_count = 0
      for (reason in hidden_reasons) {
        if (reason_count > 0) printf ","
        printf "%s", json(reason)
        reason_count++
      }
      project_ms = 0
      total_ms = resolve_ms + enumerate_ms + sort_ms + project_ms
      printf "]"
      printf ",\"profile\":{\"action\":\"list\",\"platform\":\"posix\",\"requested_path\":%s,\"resolved_path\":%s,\"entries_count\":%d", json(requested_path), json(resolved_path), count
      printf ",\"resolve_ms\":%d,\"enumerate_ms\":%d,\"sort_ms\":%d,\"project_ms\":%d,\"total_ms\":%d", resolve_ms + 0, enumerate_ms + 0, sort_ms + 0, project_ms + 0, total_ms + 0
      printf ",\"output_encoding_requested\":%s}", json(output_encoding_requested)
      printf "}\n"
    }
  ' "$sorted_list"
  rm -f "$entry_list" "$sorted_list"
}

list_dir_output() {
  if [ -n "$output_encoding" ]; then
    list_dir | compress_json_stream
    return
  fi
  list_dir
}

search_name_matches() {
  name=$1
  pattern=$2
  [ -n "$pattern" ] || pattern='*'
  case "$search_name_mode" in
    literal)
      if [ "$search_case_sensitive" = "true" ]; then
        case "$name" in *"$pattern"*) return 0 ;; *) return 1 ;; esac
      fi
      lower_name_value=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')
      lower_pattern_value=$(printf '%s' "$pattern" | tr '[:upper:]' '[:lower:]')
      case "$lower_name_value" in *"$lower_pattern_value"*) return 0 ;; *) return 1 ;; esac
      ;;
    regex)
      if [ "$search_case_sensitive" = "true" ]; then
        printf '%s\n' "$name" | grep -E -- "$pattern" >/dev/null 2>&1
      else
        printf '%s\n' "$name" | grep -Ei -- "$pattern" >/dev/null 2>&1
      fi
      ;;
    *)
      if [ "$search_case_sensitive" = "true" ]; then
        case "$name" in $pattern) return 0 ;; *) return 1 ;; esac
      fi
      lower_name_value=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')
      lower_pattern_value=$(printf '%s' "$pattern" | tr '[:upper:]' '[:lower:]')
      case "$lower_name_value" in $lower_pattern_value) return 0 ;; *) return 1 ;; esac
      ;;
  esac
}

search_path_hidden() {
  path=$1
  root=$2
  rel=${path#"$root"}
  case "$rel" in */.*|/.*) return 0 ;; *) return 1 ;; esac
}

search_content_matches() {
  path=$1
  [ -n "$search_content" ] || return 0
  [ "$(entry_type "$path")" = "file" ] || return 1
  if [ "$search_skip_binary" = "true" ] && ! is_text_file "$path"; then
    shellorchestra_search_skipped_binary=$((shellorchestra_search_skipped_binary + 1))
    return 1
  fi
  if [ "$search_content_mode" = "regex" ]; then
    if [ "$search_case_sensitive" = "true" ]; then
      read_file_prefix "$path" "$search_max_file_bytes" 2>/dev/null | grep -E -- "$search_content" >/dev/null 2>&1
    else
      read_file_prefix "$path" "$search_max_file_bytes" 2>/dev/null | grep -Ei -- "$search_content" >/dev/null 2>&1
    fi
    return $?
  fi
  if [ "$search_case_sensitive" = "true" ]; then
    read_file_prefix "$path" "$search_max_file_bytes" 2>/dev/null | grep -F -- "$search_content" >/dev/null 2>&1
  else
    read_file_prefix "$path" "$search_max_file_bytes" 2>/dev/null | grep -Fi -- "$search_content" >/dev/null 2>&1
  fi
}

search_match_snippet() {
  path=$1
  [ -n "$search_content" ] || return 0
  [ "$(entry_type "$path")" = "file" ] || return 0
  if [ "$search_content_mode" = "regex" ]; then
    if [ "$search_case_sensitive" = "true" ]; then
      read_file_prefix "$path" "$search_max_file_bytes" 2>/dev/null | grep -En -- "$search_content" 2>/dev/null | head -n 1 || true
    else
      read_file_prefix "$path" "$search_max_file_bytes" 2>/dev/null | grep -Ein -- "$search_content" 2>/dev/null | head -n 1 || true
    fi
    return 0
  fi
  if [ "$search_case_sensitive" = "true" ]; then
    read_file_prefix "$path" "$search_max_file_bytes" 2>/dev/null | grep -Fn -- "$search_content" 2>/dev/null | head -n 1 || true
  else
    read_file_prefix "$path" "$search_max_file_bytes" 2>/dev/null | grep -Fin -- "$search_content" 2>/dev/null | head -n 1 || true
  fi
}

print_search_row_event() {
  path=$1
  base=${path##*/}
  type=$(entry_type "$path")
  fields=$(stat_fields "$path")
  size=$(printf '%s' "$fields" | awk -F '\t' '{print $1 + 0}')
  mode=$(printf '%s' "$fields" | awk -F '\t' '{print $2}')
  user=$(printf '%s' "$fields" | awk -F '\t' '{print $3}')
  group=$(printf '%s' "$fields" | awk -F '\t' '{print $4}')
  modified=$(printf '%s' "$fields" | awk -F '\t' '{print int($5 + 0)}')
  warning=""
  if suspicious_file_name_reason "$base" >/tmp/shellorchestra-search-warning.$$ 2>/dev/null; then warning=$(cat /tmp/shellorchestra-search-warning.$$ 2>/dev/null || true); fi
  rm -f /tmp/shellorchestra-search-warning.$$
  snippet=$(search_match_snippet "$path")
  match_line=0
  match_text=""
  if [ -n "$snippet" ]; then
    match_line=${snippet%%:*}
    case "$match_line" in ''|*[!0123456789]*) match_line=0; match_text=$snippet ;; *) match_text=${snippet#*:} ;; esac
  fi
  printf '{"event":"row","data":{"name":'; json_string "$base"; printf ',"path":'; json_string "$path"; printf ',"type":'; json_string "$type"
  if [ "$type" = "directory" ]; then printf ',"is_dir":true'; else printf ',"is_dir":false'; fi
  printf ',"size":%s,"mode":' "$size"; json_string "$mode"; printf ',"user":'; json_string "$user"; printf ',"group":'; json_string "$group"; printf ',"modified_epoch":%s' "$modified"
  printf ',"virtual_origin":"search"'
  if [ "$warning" != "" ]; then printf ',"name_safety":"suspicious","name_safety_reasons":['; json_string "$warning"; printf ']'; else printf ',"name_safety":"safe","name_safety_reasons":[]'; fi
  if [ "$match_text" != "" ]; then printf ',"match_line":%s,"match_snippet":' "$match_line"; json_string "$match_text"; fi
  printf '}}\n'
}

search_files() {
  root=$target_path
  if [ -z "$root" ]; then root=$(home_dir); fi
  if ! run_file_read_command test -d "$root"; then json_error "Search root directory was not found."; exit 0; fi
  started_ms=$(now_ms)
  canonical=$(run_file_read_command sh -c 'cd "$1" 2>/dev/null && pwd -P' sh "$root" 2>/dev/null || printf '%s' "$root")
  find_list=$(mktemp 2>/dev/null || printf '')
  [ -n "$find_list" ] || { json_error "ShellOrchestra could not create a temporary search buffer."; exit 0; }
  if [ "$search_stay_filesystem" = "true" ]; then
    run_file_read_command find "$canonical" -xdev \( -type f -o -type d -o -type l \) -print > "$find_list" 2>/dev/null || true
  else
    run_file_read_command find "$canonical" \( -type f -o -type d -o -type l \) -print > "$find_list" 2>/dev/null || true
  fi
  printf '{"event":"meta","data":{"ok":true,"action":"search","path":'; json_string "$canonical"; printf ',"parent_path":'; json_string "$canonical"; printf ',"virtual_location_kind":"search","readonly":true,"safe_filename_mode":"hide_dangerous","query":{"name_pattern":'; json_string "$search_name_pattern"; printf ',"name_mode":'; json_string "$search_name_mode"; printf ',"content_mode":'; json_string "$search_content_mode"; printf ',"case_sensitive":%s,"skip_binary":%s,"stay_filesystem":%s,"include_hidden":%s,"max_results":%s,"max_file_bytes":%s}}}\n' "$search_case_sensitive" "$search_skip_binary" "$search_stay_filesystem" "$search_include_hidden" "$search_max_results" "$search_max_file_bytes"
  shellorchestra_search_scanned=0
  shellorchestra_search_results=0
  shellorchestra_search_skipped_binary=0
  shellorchestra_search_skipped_unsafe=0
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    shellorchestra_search_scanned=$((shellorchestra_search_scanned + 1))
    [ "$candidate" != "$canonical" ] || continue
    base=${candidate##*/}
    if dangerous_file_name_reason "$base" >/dev/null 2>&1; then
      shellorchestra_search_skipped_unsafe=$((shellorchestra_search_skipped_unsafe + 1))
      continue
    fi
    if [ "$search_include_hidden" != "true" ] && search_path_hidden "$candidate" "$canonical"; then
      continue
    fi
    search_name_matches "$base" "$search_name_pattern" || continue
    search_content_matches "$candidate" || continue
    print_search_row_event "$candidate"
    shellorchestra_search_results=$((shellorchestra_search_results + 1))
    if [ "$shellorchestra_search_results" -ge "$search_max_results" ]; then
      break
    fi
    if [ $((shellorchestra_search_scanned % 200)) -eq 0 ]; then
      printf '{"event":"progress","data":{"files_scanned":%s,"results_count":%s,"files_skipped_binary":%s,"unsafe_names_skipped":%s}}\n' "$shellorchestra_search_scanned" "$shellorchestra_search_results" "$shellorchestra_search_skipped_binary" "$shellorchestra_search_skipped_unsafe"
    fi
  done < "$find_list"
  rm -f "$find_list"
  finished_ms=$(now_ms)
  total_ms=$(elapsed_ms "$started_ms" "$finished_ms")
  truncated=false
  if [ "$shellorchestra_search_results" -ge "$search_max_results" ]; then truncated=true; fi
  printf '{"event":"done","data":{"ok":true,"action":"search","path":'; json_string "$canonical"; printf ',"parent_path":'; json_string "$canonical"; printf ',"virtual_location_kind":"search","readonly":true,"entries_count":%s,"results_count":%s,"files_scanned":%s,"files_skipped_binary":%s,"unsafe_names_skipped":%s,"truncated":%s' "$shellorchestra_search_results" "$shellorchestra_search_results" "$shellorchestra_search_scanned" "$shellorchestra_search_skipped_binary" "$shellorchestra_search_skipped_unsafe" "$truncated"
  printf ',"profile":{"action":"search","platform":"posix","requested_path":'; json_string "$root"; printf ',"resolved_path":'; json_string "$canonical"; printf ',"entries_count":%s,"total_ms":%s,"output_encoding_requested":' "$shellorchestra_search_results" "$total_ms"; json_string "$output_encoding"; printf '}}}\n'
}

search_files_output() {
  if [ -n "$output_encoding" ]; then
    search_files | compress_json_stream
    return
  fi
  search_files
}

preview_file() {
  require_existing_path
  type=$(entry_type "$target_path")
  if [ "$type" = "file" ]; then ensure_file_content_readable "$target_path"; fi
  size=$(file_size "$target_path")
  info=""
  if [ "$size" -le "$hash_max_bytes" ]; then info=$(file_info_text "$target_path"); fi
  hash=""
  if run_file_read_command test -f "$target_path" && [ "$size" -le "$hash_max_bytes" ]; then hash=$(sha256_file "$target_path"); fi
  preview_kind=$(preview_kind_for_file "$target_path" "$type")
  mime=$(mime_for_preview_kind "$target_path" "$preview_kind")
  if [ "$preview_kind" = "text" ]; then editor_preflight_file "$target_path"; fi
  printf '{"ok":true,"action":"preview","path":'; json_string "$target_path"; printf ',"type":'; json_string "$type"; printf ',"size":%s,"sha256":' "$size"; json_string "$hash"; printf ',"info":'; json_string "$info"
  printf ',"preview_kind":'; json_string "$preview_kind"; printf ',"mime":'; json_string "$mime"
  if [ "$preview_kind" = "text" ]; then
    detected_language=$(detect_text_language "$target_path")
    tmp=$(mktemp)
    if [ "$editor_sanitized" = "true" ]; then sanitize_editor_text_file "$target_path" | head -n 500 | head -c "$max_bytes" > "$tmp" 2>/dev/null || true; else read_file_bytes "$target_path" | head -n 500 | head -c "$max_bytes" > "$tmp" 2>/dev/null || true; fi
    bytes=$(file_size "$tmp")
    encoded=$(base64_encode_file "$tmp")
    rm -f "$tmp"
    printf ',"text":true,"safe_preview":true,"encoding":"utf-8","truncated":'; if [ "$size" -gt "$bytes" ]; then printf 'true'; else printf 'false'; fi
    printf ',"detected_language":'; json_string "$detected_language"
    printf ',"content_b64":'; json_string "$encoded"
    print_editor_preflight_json_fields
  elif [ "$preview_kind" = "image" ]; then
    printf ',"text":false,"safe_preview":true,"truncated":false,"content_b64":""'
    printf ',"asset_b64":"","asset_error":""'
  elif [ "$preview_kind" = "pdf" ] || [ "$preview_kind" = "document" ]; then
    tmp=$(mktemp)
    document_preview_text "$target_path" "$preview_kind" | head -c "$max_bytes" > "$tmp" 2>/dev/null || true
    bytes=$(file_size "$tmp")
    encoded=$(base64_encode_file "$tmp")
    rm -f "$tmp"
    printf ',"text":true,"safe_preview":true,"encoding":"utf-8","truncated":'; if [ "$size" -gt "$bytes" ]; then printf 'true'; else printf 'false'; fi
    printf ',"content_b64":'; json_string "$encoded"
    printf ',"asset_b64":"","editor_mode":"blocked","editor_safe":false,"editor_sanitized":true,"editor_reason":'; json_string "This file is shown through a simplified safe preview and is not opened in the code editor."
  else
    printf ',"text":false,"safe_preview":false,"truncated":false,"content_b64":""'
  fi
  printf '}\n'
}

path_properties() {
  require_existing_path
  fields=$(stat_fields "$target_path")
  size=$(printf '%s' "$fields" | awk -F '\t' '{print $1 + 0}')
  mode=$(printf '%s' "$fields" | awk -F '\t' '{print $2}')
  user=$(printf '%s' "$fields" | awk -F '\t' '{print $3}')
  group=$(printf '%s' "$fields" | awk -F '\t' '{print $4}')
  modified=$(printf '%s' "$fields" | awk -F '\t' '{print $5 + 0}')
  type=$(entry_type "$target_path")
  hash=""
  if run_file_read_command test -f "$target_path" && [ "$size" -le "$hash_max_bytes" ]; then hash=$(sha256_file "$target_path"); fi
  recursive=$size
  if [ "$action" = "calculate_size" ] || [ "$type" = "directory" ]; then recursive=$(recursive_size "$target_path"); fi
  printf '{"ok":true,"action":'; json_string "$action"; printf ',"path":'; json_string "$target_path"; printf ',"name":'; json_string "${target_path##*/}"
  printf ',"type":'; json_string "$type"; printf ',"size":%s,"recursive_size":%s,"mode":' "$size" "$recursive"; json_string "$mode"
  printf ',"user":'; json_string "$user"; printf ',"group":'; json_string "$group"; printf ',"modified_epoch":%s,"sha256":' "$modified"; json_string "$hash"; printf '}\n'
}
read_file() {
  require_existing_path
  if ! run_file_read_command test -f "$target_path"; then json_error "Only regular files can be opened in the editor."; exit 0; fi
  ensure_file_content_readable "$target_path"
  size=$(file_size "$target_path")
  require_editor_read_allowed "$target_path"
  if [ "$size" -gt "$max_bytes" ]; then json_error "This file is too large for the browser editor. Use a terminal editor or download workflow for larger files."; exit 0; fi
  detected_language=$(detect_text_language "$target_path")
  if [ "$editor_mode_request" = "safe_view" ] || [ "$editor_sanitized" = "true" ]; then
    tmp=$(mktemp)
    sanitize_editor_text_file "$target_path" > "$tmp" 2>/dev/null || true
    size=$(file_size "$tmp")
    if [ "$size" -gt "$max_bytes" ]; then rm -f "$tmp"; json_error "The sanitized read-only view is too large for this editor request."; exit 0; fi
    encoded=$(base64_encode_file "$tmp")
    rm -f "$tmp"
  else
    encoded=$(base64_encode_file "$target_path")
  fi
  hash=$(sha256_file "$target_path")
  printf '{"ok":true,"action":"read","path":'; json_string "$target_path"; printf ',"type":"file","text":true,"encoding":"utf-8","detected_language":'; json_string "$detected_language"; printf ',"size":%s,"sha256":' "$size"; json_string "$hash"; printf ',"content_b64":'; json_string "$encoded"; printf '}\n'
}

read_file_range() {
  require_existing_path
  if ! run_file_read_command test -f "$target_path"; then json_error "Only regular files can be opened in the editor."; exit 0; fi
  ensure_file_content_readable "$target_path"
  require_editor_read_allowed "$target_path"
  detected_language=$(detect_text_language "$target_path")
  tmp=$(mktemp)
  if [ "$editor_mode_request" = "safe_view" ] || [ "$editor_sanitized" = "true" ]; then
    sanitized=$(mktemp)
    sanitize_editor_text_file "$target_path" > "$sanitized" 2>/dev/null || true
    size=$(file_size "$sanitized")
    tail -c +$((offset_bytes + 1)) "$sanitized" 2>/dev/null | head -c "$max_bytes" > "$tmp" 2>/dev/null || true
    rm -f "$sanitized"
  else
    size=$(file_size "$target_path")
  # Read only the requested range so very large files never get shipped to the browser in full.
    read_file_bytes "$target_path" 2>/dev/null | tail -c +$((offset_bytes + 1)) | head -c "$max_bytes" > "$tmp" 2>/dev/null || true
  fi
  bytes=$(file_size "$tmp")
  encoded=$(base64_encode_file "$tmp")
  rm -f "$tmp"
  next_offset=$((offset_bytes + bytes))
  printf '{"ok":true,"action":"read_range","path":'; json_string "$target_path"; printf ',"type":"file","text":true,"encoding":"utf-8","detected_language":'; json_string "$detected_language"; printf ',"size":%s,"sha256":"","offset":%s,"length":%s,"next_offset":%s,"truncated":' "$size" "$offset_bytes" "$bytes" "$next_offset"
  if [ "$next_offset" -lt "$size" ]; then printf 'true'; else printf 'false'; fi
  printf ',"content_b64":'; json_string "$encoded"; printf '}\n'
}

read_file_range_output() {
  if [ -n "$output_encoding" ]; then
    read_file_range | compress_json_stream
    return
  fi
  read_file_range
}

download_file() {
  require_existing_path
  if ! run_file_read_command test -f "$target_path"; then json_error "Only regular files can be downloaded."; exit 0; fi
  ensure_file_content_readable "$target_path"
  size=$(file_size "$target_path")
  if [ "$size" -gt "$max_bytes" ]; then json_error "This file is larger than the browser download limit. Use a terminal transfer workflow for larger files."; exit 0; fi
  encoded=$(base64_encode_file "$target_path")
  hash=$(sha256_file "$target_path")
  mime=$(mime_for_preview_kind "$target_path" "$(preview_kind_for_file "$target_path" file)")
  printf '{"ok":true,"action":"download","path":'; json_string "$target_path"; printf ',"name":'; json_string "${target_path##*/}"
  printf ',"type":"file","encoding":"base64","mime":'; json_string "$mime"; printf ',"size":%s,"sha256":' "$size"; json_string "$hash"
  printf ',"content_b64":'; json_string "$encoded"; printf '}\n'
}

write_file() {
  [ -n "$target_path" ] || { json_error "Path is required."; exit 0; }
  require_safe_mutation_path "$target_path"
  dir=$(dirname "$target_path")
  run_file_read_command test -d "$dir" || { json_error "Parent directory was not found."; exit 0; }
  tmp=$(mktemp) || { json_error "Could not create a temporary file for this editor save."; exit 0; }
  if ! base64_decode_to_file "$content_b64" "$tmp"; then rm -f "$tmp"; json_error "The editor content could not be decoded."; exit 0; fi
  if ! run_file_mutation_command cp -- "$tmp" "$target_path"; then rm -f "$tmp"; json_error "ShellOrchestra could not save this file. Check file permissions or passwordless sudo/doas for the ShellOrchestra service user."; exit 0; fi
  rm -f "$tmp"
  size=$(file_size "$target_path")
  hash=$(sha256_file "$target_path")
  printf '{"ok":true,"action":"write","path":'; json_string "$target_path"; printf ',"size":%s,"sha256":' "$size"; json_string "$hash"; printf '}\n'
}

upload_file() {
  [ -n "$target_path" ] || { json_error "Path is required."; exit 0; }
  require_safe_mutation_path "$target_path"
  case "${target_path##*/}" in ''|'.'|'..') json_error "Remote file name is invalid."; exit 0 ;; esac
  dir=$(dirname "$target_path")
  run_file_read_command test -d "$dir" || { json_error "Parent directory was not found."; exit 0; }
  if run_file_read_command test -d "$target_path"; then json_error "A directory already exists at that path."; exit 0; fi
  if run_file_read_command test -e "$target_path" && [ "$overwrite" != "true" ]; then json_error "A file already exists at that path. Enable overwrite or choose another name."; exit 0; fi
  tmp=$(mktemp) || { json_error "Could not create a temporary file for this upload."; exit 0; }
  if ! base64_decode_to_file "$content_b64" "$tmp"; then rm -f "$tmp"; json_error "The uploaded file content could not be decoded."; exit 0; fi
  if ! run_file_mutation_command cp -- "$tmp" "$target_path"; then rm -f "$tmp"; json_error "ShellOrchestra could not write the uploaded file. Check file permissions or passwordless sudo/doas for the ShellOrchestra service user."; exit 0; fi
  rm -f "$tmp"
  size=$(file_size "$target_path")
  hash=$(sha256_file "$target_path")
  printf '{"ok":true,"action":"upload","path":'; json_string "$target_path"; printf ',"size":%s,"sha256":' "$size"; json_string "$hash"; printf '}\n'
}

create_file() {
  [ -n "$target_path" ] || { json_error "Path is required."; exit 0; }
  require_safe_mutation_path "$target_path"
  if run_file_read_command test -e "$target_path"; then json_error "A file or directory with this path already exists."; exit 0; fi
  if ! run_file_mutation_command touch -- "$target_path"; then json_error "ShellOrchestra could not create this file. Check file permissions or passwordless sudo/doas for the ShellOrchestra service user."; exit 0; fi
  printf '{"ok":true,"action":"create_file","path":'; json_string "$target_path"; printf '}\n'
}

create_directory() {
  [ -n "$target_path" ] || { json_error "Path is required."; exit 0; }
  require_safe_mutation_path "$target_path"
  if ! run_file_mutation_command mkdir -p -- "$target_path"; then json_error "ShellOrchestra could not create this directory. Check file permissions or passwordless sudo/doas for the ShellOrchestra service user."; exit 0; fi
  printf '{"ok":true,"action":"create_directory","path":'; json_string "$target_path"; printf '}\n'
}

delete_path() {
  require_existing_path
  require_safe_mutation_path "$target_path"
  if ! run_file_mutation_command rm -rf -- "$target_path"; then json_error "ShellOrchestra could not delete this path. Check file permissions or passwordless sudo/doas for the ShellOrchestra service user."; exit 0; fi
  printf '{"ok":true,"action":"delete","path":'; json_string "$target_path"; printf '}\n'
}

copy_or_move_path() {
  require_existing_path
  [ -n "$destination_path" ] || { json_error "Destination path is required."; exit 0; }
  require_safe_mutation_path "$destination_path"
  final_dest=$destination_path
  if run_file_read_command test -d "$destination_path"; then final_dest="$destination_path/${target_path##*/}"; fi
  if [ "$action" = "move" ]; then
    if ! run_file_mutation_command mv -- "$target_path" "$final_dest"; then json_error "ShellOrchestra could not move this path. Check file permissions or passwordless sudo/doas for the ShellOrchestra service user."; exit 0; fi
  else
    if run_file_read_command test -d "$target_path"; then
      if ! run_file_mutation_command cp -R -- "$target_path" "$final_dest"; then json_error "ShellOrchestra could not copy this directory. Check file permissions or passwordless sudo/doas for the ShellOrchestra service user."; exit 0; fi
    else
      if ! run_file_mutation_command cp -- "$target_path" "$final_dest"; then json_error "ShellOrchestra could not copy this file. Check file permissions or passwordless sudo/doas for the ShellOrchestra service user."; exit 0; fi
    fi
  fi
  printf '{"ok":true,"action":'; json_string "$action"; printf ',"path":'; json_string "$target_path"; printf ',"destination_path":'; json_string "$final_dest"; printf '}\n'
}

rename_path() {
  require_existing_path
  [ -n "$new_name" ] || { json_error "New name is required."; exit 0; }
  case "$new_name" in */*|*\\*|'.'|'..') json_error "New name must be a simple file or folder name."; exit 0 ;; esac
  parent=$(dirname "$target_path")
  destination_path="$parent/$new_name"
  copy_or_move_path
}

chmod_path() {
  require_existing_path
  case "$mode_value" in
    [0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]) ;;
    *) json_error "Permissions must be an octal mode such as 644 or 0755."; exit 0 ;;
  esac
  if ! run_file_mutation_command chmod -- "$mode_value" "$target_path"; then json_error "ShellOrchestra could not change permissions. Check file permissions or passwordless sudo/doas for the ShellOrchestra service user."; exit 0; fi
  printf '{"ok":true,"action":"chmod","path":'; json_string "$target_path"; printf ',"mode":'; json_string "$mode_value"; printf '}\n'
}

validate_archive_entry_name() {
  entry=$1
  case "$entry" in
    ''|'.'|'..'|'/'*|*'/../'*|'../'*|*'/..'|'-'*|*'//'*) return 1 ;;
  esac
  return 0
}

validate_source_name_component() {
  name=$1
  case "$name" in
    ''|'.'|'..'|*/*|*\\*|'-'*) return 1 ;;
  esac
  return 0
}

decode_source_names_file() {
  [ -n "$source_names_b64" ] || { json_error "Select one or more files or folders before creating an archive."; exit 0; }
  names_file=$(mktemp) || { json_error "Could not create a temporary source list."; exit 0; }
  if ! base64_decode_to_file "$source_names_b64" "$names_file"; then
    rm -f "$names_file"
    json_error "ShellOrchestra could not decode the selected source list."
    exit 0
  fi
  count=0
  while IFS= read -r source_name || [ -n "$source_name" ]; do
    count=$((count + 1))
    if [ "$count" -gt 64 ]; then rm -f "$names_file"; json_error "Compress accepts at most 64 selected items."; exit 0; fi
    if ! validate_source_name_component "$source_name"; then rm -f "$names_file"; json_error "Selected item names must be simple safe path components."; exit 0; fi
    if ! run_file_read_command test -e "$target_path/$source_name"; then rm -f "$names_file"; json_error "One of the selected items no longer exists on the remote server."; exit 0; fi
  done < "$names_file"
  if [ "$count" -eq 0 ]; then rm -f "$names_file"; json_error "Select one or more files or folders before creating an archive."; exit 0; fi
  printf '%s' "$names_file"
}

archive_basename_format() {
  case "$archive_format" in
    zip) printf 'zip' ;;
    tar.gz) printf 'tar.gz' ;;
    tar.zst) printf 'tar.zst' ;;
    auto)
      destination_kind=$(archive_kind_for_path "$destination_path")
      case "$destination_kind" in
        zip|tar.gz|tar.zst) printf '%s' "$destination_kind"; return ;;
        tar.bz2|tar.xz|tar|rar)
          json_error "ShellOrchestra cannot create that archive format yet. Choose zip, tar.gz, or tar.zst."
          exit 0
          ;;
      esac
      if command -v zstd >/dev/null 2>&1; then printf 'tar.zst'; else printf 'tar.gz'; fi
      ;;
  esac
}

archive_kind_for_path() {
  lower=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case "$lower" in
    *.zip) printf 'zip' ;;
    *.tar.zst|*.tzst|*.tar.sz) printf 'tar.zst' ;;
    *.tar.gz|*.tgz) printf 'tar.gz' ;;
    *.tar.bz2|*.tbz2|*.tbz) printf 'tar.bz2' ;;
    *.tar.xz|*.txz) printf 'tar.xz' ;;
    *.tar) printf 'tar' ;;
    *.rar) printf 'rar' ;;
    *) printf '' ;;
  esac
}

compress_selection() {
  [ -n "$target_path" ] || { json_error "Source folder is required."; exit 0; }
  [ -n "$destination_path" ] || { json_error "Archive path is required."; exit 0; }
  require_safe_mutation_path "$destination_path"
  if ! run_file_read_command test -d "$target_path"; then json_error "Compress source folder was not found."; exit 0; fi
  dest_parent=$(dirname "$destination_path")
  if ! run_file_read_command test -d "$dest_parent"; then json_error "Archive destination folder was not found."; exit 0; fi
  if run_file_read_command test -e "$destination_path" && [ "$overwrite" != "true" ]; then json_error "An archive already exists at that path. Enable overwrite or choose another name."; exit 0; fi
  names_file=$(decode_source_names_file)
  tmp_archive=$(mktemp) || { rm -f "$names_file"; json_error "Could not create a temporary archive."; exit 0; }
  effective_format=$(archive_basename_format)
  case "$effective_format" in
    tar.zst)
      command -v tar >/dev/null 2>&1 || { rm -f "$names_file" "$tmp_archive"; json_error "tar is required to create a ShellOrchestra archive."; exit 0; }
      command -v zstd >/dev/null 2>&1 || { rm -f "$names_file" "$tmp_archive"; json_error "zstd is required to create a .tar.zst archive."; exit 0; }
      if ! run_file_read_command tar -cf - -C "$target_path" -T "$names_file" | zstd -5 -q -c > "$tmp_archive"; then rm -f "$names_file" "$tmp_archive"; json_error "ShellOrchestra could not create the zstd archive."; exit 0; fi
      ;;
    tar.gz)
      command -v tar >/dev/null 2>&1 || { rm -f "$names_file" "$tmp_archive"; json_error "tar is required to create a ShellOrchestra archive."; exit 0; }
      command -v gzip >/dev/null 2>&1 || { rm -f "$names_file" "$tmp_archive"; json_error "gzip is required to create a .tar.gz archive."; exit 0; }
      if ! run_file_read_command tar -cf - -C "$target_path" -T "$names_file" | gzip -4 -c > "$tmp_archive"; then rm -f "$names_file" "$tmp_archive"; json_error "ShellOrchestra could not create the gzip archive."; exit 0; fi
      ;;
    zip)
      command -v zip >/dev/null 2>&1 || { rm -f "$names_file" "$tmp_archive"; json_error "zip is required to create a ZIP archive on this server."; exit 0; }
      if ! (cd "$target_path" && zip -q -r "$tmp_archive" -@ < "$names_file"); then rm -f "$names_file" "$tmp_archive"; json_error "ShellOrchestra could not create the ZIP archive."; exit 0; fi
      ;;
  esac
  if ! run_file_mutation_command cp -- "$tmp_archive" "$destination_path"; then rm -f "$names_file" "$tmp_archive"; json_error "ShellOrchestra could not write the archive. Check file permissions or passwordless sudo/doas for the ShellOrchestra service user."; exit 0; fi
  rm -f "$names_file" "$tmp_archive"
  size=$(file_size "$destination_path")
  hash=$(sha256_file "$destination_path")
  printf '{"ok":true,"action":"compress","path":'; json_string "$destination_path"; printf ',"archive_format":'; json_string "$effective_format"; printf ',"size":%s,"sha256":' "$size"; json_string "$hash"; printf '}\n'
}

validate_archive_entries_file() {
  entries_file=$1
  count=0
  while IFS= read -r entry || [ -n "$entry" ]; do
    [ -n "$entry" ] || continue
    count=$((count + 1))
    if [ "$count" -gt 100000 ]; then json_error "Archive has too many entries for safe extraction."; return 1; fi
    if ! validate_archive_entry_name "$entry"; then json_error "Archive contains an unsafe entry path."; return 1; fi
  done < "$entries_file"
  return 0
}

ensure_no_special_entries() {
  extracted_dir=$1
  if find "$extracted_dir" \( -type l -o -type p -o -type b -o -type c \) -print -quit 2>/dev/null | grep . >/dev/null 2>&1; then
    json_error "Archive contains symbolic links or special files. ShellOrchestra will not extract it automatically."
    return 1
  fi
  return 0
}

check_archive_collisions() {
  entries_file=$1
  destination_dir=$2
  [ "$overwrite" = "true" ] && return 0
  while IFS= read -r entry || [ -n "$entry" ]; do
    [ -n "$entry" ] || continue
    case "$entry" in */) continue ;; esac
    if run_file_read_command test -e "$destination_dir/$entry"; then
      json_error "Archive extraction would overwrite an existing file. Enable overwrite or choose an empty destination folder."
      return 1
    fi
  done < "$entries_file"
  return 0
}

cleanup_uncompress_temp() {
  set +e
  [ -z "${entries_file:-}" ] || rm -f "$entries_file" >/dev/null 2>&1
  [ -z "${archive_copy:-}" ] || rm -f "$archive_copy" >/dev/null 2>&1
  if [ -n "${extract_dir:-}" ] && [ -d "$extract_dir" ]; then
    normalize_uncompress_temp_permissions "$extract_dir"
    run_file_mutation_command rm -rf -- "$extract_dir" >/dev/null 2>&1 || true
  fi
  set -e
  return 0
}

normalize_uncompress_temp_permissions() {
  temp_dir=$1
  [ -n "$temp_dir" ] && [ -d "$temp_dir" ] || return 0
  run_file_mutation_command chmod -R u+rwX -- "$temp_dir" >/dev/null 2>&1 || true
}

copy_archive_to_temp() {
  archive_copy=$(mktemp) || { cleanup_uncompress_temp; json_error "Could not create a temporary archive copy."; exit 0; }
  if ! read_file_bytes "$target_path" > "$archive_copy"; then
    cleanup_uncompress_temp
    json_error "ShellOrchestra could not read this archive file."
    exit 0
  fi
}

uncompress_archive() {
  require_existing_path
  [ -n "$destination_path" ] || destination_path=$(dirname "$target_path")
  require_safe_mutation_path "$destination_path"
  if ! run_file_read_command test -f "$target_path"; then json_error "Select an archive file before using Uncompress."; exit 0; fi
  if ! run_file_read_command test -d "$destination_path"; then
    if ! run_file_mutation_command mkdir -p -- "$destination_path"; then json_error "ShellOrchestra could not create the extraction folder."; exit 0; fi
  fi
  kind=$(archive_kind_for_path "$target_path")
  [ -n "$kind" ] || { json_error "This archive type is not supported for extraction."; exit 0; }
  [ "$kind" != "rar" ] || { json_error "RAR extraction is not enabled in this build. Use archive preview or extract manually on the server."; exit 0; }
  entries_file=$(mktemp) || { json_error "Could not create a temporary archive listing."; exit 0; }
  extract_dir=$(mktemp -d) || { rm -f "$entries_file"; json_error "Could not create a temporary extraction folder."; exit 0; }
  archive_copy=
  case "$kind" in
    zip)
      command -v unzip >/dev/null 2>&1 || { cleanup_uncompress_temp; json_error "unzip is required to extract ZIP archives on this server."; exit 0; }
      copy_archive_to_temp
      if ! unzip -Z -1 "$archive_copy" > "$entries_file" 2>/dev/null; then cleanup_uncompress_temp; json_error "ShellOrchestra could not inspect this ZIP archive."; exit 0; fi
      validate_archive_entries_file "$entries_file" || { cleanup_uncompress_temp; exit 0; }
      check_archive_collisions "$entries_file" "$destination_path" || { cleanup_uncompress_temp; exit 0; }
      if ! unzip -q -o "$archive_copy" -d "$extract_dir"; then cleanup_uncompress_temp; json_error "ShellOrchestra could not extract this ZIP archive."; exit 0; fi
      ;;
    tar.zst)
      command -v tar >/dev/null 2>&1 || { cleanup_uncompress_temp; json_error "tar is required to extract this archive."; exit 0; }
      command -v zstd >/dev/null 2>&1 || { cleanup_uncompress_temp; json_error "zstd is required to extract .tar.zst archives on this server."; exit 0; }
      if ! read_file_bytes "$target_path" | zstd -q -d -c | tar -tf - > "$entries_file" 2>/dev/null; then cleanup_uncompress_temp; json_error "ShellOrchestra could not inspect this tar.zst archive."; exit 0; fi
      validate_archive_entries_file "$entries_file" || { cleanup_uncompress_temp; exit 0; }
      check_archive_collisions "$entries_file" "$destination_path" || { cleanup_uncompress_temp; exit 0; }
      if ! read_file_bytes "$target_path" | zstd -q -d -c | tar -xf - -C "$extract_dir"; then cleanup_uncompress_temp; json_error "ShellOrchestra could not extract this tar.zst archive."; exit 0; fi
      ;;
    tar)
      command -v tar >/dev/null 2>&1 || { cleanup_uncompress_temp; json_error "tar is required to extract this archive."; exit 0; }
      if ! read_file_bytes "$target_path" | tar -tf - > "$entries_file" 2>/dev/null; then cleanup_uncompress_temp; json_error "ShellOrchestra could not inspect this tar archive."; exit 0; fi
      validate_archive_entries_file "$entries_file" || { cleanup_uncompress_temp; exit 0; }
      check_archive_collisions "$entries_file" "$destination_path" || { cleanup_uncompress_temp; exit 0; }
      if ! read_file_bytes "$target_path" | tar -xf - -C "$extract_dir"; then cleanup_uncompress_temp; json_error "ShellOrchestra could not extract this tar archive."; exit 0; fi
      ;;
    tar.gz)
      command -v tar >/dev/null 2>&1 || { cleanup_uncompress_temp; json_error "tar is required to extract this archive."; exit 0; }
      if ! read_file_bytes "$target_path" | tar -tzf - > "$entries_file" 2>/dev/null; then cleanup_uncompress_temp; json_error "ShellOrchestra could not inspect this tar.gz archive."; exit 0; fi
      validate_archive_entries_file "$entries_file" || { cleanup_uncompress_temp; exit 0; }
      check_archive_collisions "$entries_file" "$destination_path" || { cleanup_uncompress_temp; exit 0; }
      if ! read_file_bytes "$target_path" | tar -xzf - -C "$extract_dir"; then cleanup_uncompress_temp; json_error "ShellOrchestra could not extract this tar.gz archive."; exit 0; fi
      ;;
    tar.bz2)
      command -v tar >/dev/null 2>&1 || { cleanup_uncompress_temp; json_error "tar is required to extract this archive."; exit 0; }
      if ! read_file_bytes "$target_path" | tar -tjf - > "$entries_file" 2>/dev/null; then cleanup_uncompress_temp; json_error "ShellOrchestra could not inspect this tar.bz2 archive."; exit 0; fi
      validate_archive_entries_file "$entries_file" || { cleanup_uncompress_temp; exit 0; }
      check_archive_collisions "$entries_file" "$destination_path" || { cleanup_uncompress_temp; exit 0; }
      if ! read_file_bytes "$target_path" | tar -xjf - -C "$extract_dir"; then cleanup_uncompress_temp; json_error "ShellOrchestra could not extract this tar.bz2 archive."; exit 0; fi
      ;;
    tar.xz)
      command -v tar >/dev/null 2>&1 || { cleanup_uncompress_temp; json_error "tar is required to extract this archive."; exit 0; }
      if ! read_file_bytes "$target_path" | tar -tJf - > "$entries_file" 2>/dev/null; then cleanup_uncompress_temp; json_error "ShellOrchestra could not inspect this tar.xz archive."; exit 0; fi
      validate_archive_entries_file "$entries_file" || { cleanup_uncompress_temp; exit 0; }
      check_archive_collisions "$entries_file" "$destination_path" || { cleanup_uncompress_temp; exit 0; }
      if ! read_file_bytes "$target_path" | tar -xJf - -C "$extract_dir"; then cleanup_uncompress_temp; json_error "ShellOrchestra could not extract this tar.xz archive."; exit 0; fi
      ;;
  esac
  normalize_uncompress_temp_permissions "$extract_dir"
  ensure_no_special_entries "$extract_dir" || { cleanup_uncompress_temp; exit 0; }
  if ! run_file_mutation_command cp -R "$extract_dir"/. "$destination_path"/; then cleanup_uncompress_temp; json_error "ShellOrchestra could not copy extracted files into the destination folder."; exit 0; fi
  cleanup_uncompress_temp
  printf '{"ok":true,"action":"uncompress","path":'; json_string "$target_path"; printf ',"destination_path":'; json_string "$destination_path"; printf ',"archive_type":'; json_string "$kind"; printf '}\n'
}

case "$action" in
  locations) locations ;;
  list) list_dir_output ;;
  search) search_files_output ;;
  preview) preview_file ;;
  properties|calculate_size) path_properties ;;
  read) read_file ;;
  read_range) read_file_range_output ;;
  download) download_file ;;
  write) write_file ;;
  upload) upload_file ;;
  create_file) create_file ;;
  create_directory) create_directory ;;
  delete) delete_path ;;
  copy|move) copy_or_move_path ;;
  rename) action=move; rename_path ;;
  chmod) chmod_path ;;
  compress) compress_selection ;;
  uncompress) uncompress_archive ;;
  *) json_error "Unsupported file manager action." ;;
esac
