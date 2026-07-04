#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu

output_encoding=${SHELLORCHESTRA_USERS_OUTPUT_ENCODING:-${users_output_encoding:-}}
stream_format=${SHELLORCHESTRA_USERS_STREAM_FORMAT:-${users_stream_format:-json}}
case "$stream_format" in ''|'json') stream_format=json ;; 'row_events') ;; *) echo "Unsupported ShellOrchestra users stream format: $stream_format" >&2; exit 64 ;; esac
case "$output_encoding" in ''|'none') output_encoding=none ;; 'auto'|'zstd'|'gzip') ;; *) echo "Unsupported ShellOrchestra users output encoding: $output_encoding" >&2; exit 64 ;; esac

json_string() {
  awk 'BEGIN { value=ARGV[1]; ARGV[1]=""; gsub(/\\/,"\\\\",value); gsub(/"/,"\\\"",value); gsub(/\t/,"\\t",value); gsub(/\r/,"\\r",value); gsub(/\n/,"\\n",value); printf "\"%s\"", value }' "$1"
}

bool_json() {
  if [ "$1" = "true" ]; then printf 'true'; else printf 'false'; fi
}

json_array_words() {
  printf '['
  first=true
  for value in "$@"; do
    [ -n "$value" ] || continue
    if [ "$first" = true ]; then first=false; else printf ','; fi
    json_string "$value"
  done
  printf ']'
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

safe_user_name() {
  case "$1" in
    ''|*[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-]*|[-.]*|*[.-]) return 1 ;;
    *) return 0 ;;
  esac
}

emit_event_prefix() {
  printf '{"event":'
  json_string "$1"
  printf ',"data":'
}

can_run_root=false
root_prefix=
if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then
  can_run_root=true
elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  can_run_root=true
  root_prefix=sudo
elif command -v doas >/dev/null 2>&1 && doas -n true >/dev/null 2>&1; then
  can_run_root=true
  root_prefix=doas
fi

run_root_capture() {
  if [ "$root_prefix" = "" ]; then
    "$@"
  else
    "$root_prefix" "$@"
  fi
}

manager=passwd
if command -v useradd >/dev/null 2>&1; then
  manager=useradd
elif command -v adduser >/dev/null 2>&1; then
  manager=adduser
fi
platform=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' || printf 'posix')
is_darwin=false
if [ "$platform" = "darwin" ]; then
  is_darwin=true
fi
mode=${SHELLORCHESTRA_USERS_MODE:-list}
target_user=${SHELLORCHESTRA_USER_NAME:-}
passwd_file=$(mktemp)
shadow_file=$(mktemp)
trap 'rm -f "$passwd_file" "$shadow_file"' EXIT HUP INT TERM
if command -v getent >/dev/null 2>&1; then
  getent passwd > "$passwd_file" 2>/dev/null || cat /etc/passwd > "$passwd_file"
else
  cat /etc/passwd > "$passwd_file"
fi

emit_ssh_key_rows() {
  if [ -n "$authorized_keys_path" ] && run_root_capture test -r "$authorized_keys_path" 2>/dev/null; then
    run_root_capture cat "$authorized_keys_path" 2>/dev/null | awk '
      function js(value, escaped){ escaped=value; gsub(/\\/,"\\\\",escaped); gsub(/"/,"\\\"",escaped); gsub(/\t/,"\\t",escaped); gsub(/\r/,"\\r",escaped); gsub(/\n/,"\\n",escaped); return "\"" escaped "\"" }
      /^[[:space:]]*($|#)/ { next }
      {
        type=$1; label=""; for (i=3;i<=NF;i++) label=label (label?" ":"") $i
        printf "{\"event\":\"row\",\"data\":{\"kind\":\"ssh_key\",\"item\":{\"index\":%d,\"type\":%s,\"label\":%s,\"line\":%s}}}\n", count + 1, js(type), js(label), js($0)
        count++
      }'
  fi
}

emit_ssh_key_array() {
  first_key=true
  if [ -n "$authorized_keys_path" ] && run_root_capture test -r "$authorized_keys_path" 2>/dev/null; then
    run_root_capture cat "$authorized_keys_path" 2>/dev/null | awk '
      function js(value, escaped){ escaped=value; gsub(/\\/,"\\\\",escaped); gsub(/"/,"\\\"",escaped); gsub(/\t/,"\\t",escaped); gsub(/\r/,"\\r",escaped); gsub(/\n/,"\\n",escaped); return "\"" escaped "\"" }
      /^[[:space:]]*($|#)/ { next }
      {
        type=$1; label=""; for (i=3;i<=NF;i++) label=label (label?" ":"") $i
        if (count > 0) printf ","
        printf "{\"index\":%d,\"type\":%s,\"label\":%s,\"line\":%s}", count + 1, js(type), js(label), js($0)
        count++
      }'
  fi
}

emit_sessions_rows() {
  if command -v who >/dev/null 2>&1; then
    who 2>/dev/null | awk '
      function js(value, escaped){ escaped=value; gsub(/\\/,"\\\\",escaped); gsub(/"/,"\\\"",escaped); gsub(/\t/,"\\t",escaped); gsub(/\r/,"\\r",escaped); gsub(/\n/,"\\n",escaped); return "\"" escaped "\"" }
      NF >= 2 {
        remote=""; if (NF >= 5) { remote=$5; gsub(/[()]/, "", remote) }
        printf "{\"event\":\"row\",\"data\":{\"kind\":\"session\",\"item\":{\"user\":%s,\"tty\":%s,\"started\":%s,\"remote\":%s}}}\n", js($1), js($2), js($3 " " $4), js(remote)
      }'
  fi
}

emit_sessions_array() {
  if command -v who >/dev/null 2>&1; then
    who 2>/dev/null | awk '
      function js(value, escaped){ escaped=value; gsub(/\\/,"\\\\",escaped); gsub(/"/,"\\\"",escaped); gsub(/\t/,"\\t",escaped); gsub(/\r/,"\\r",escaped); gsub(/\n/,"\\n",escaped); return "\"" escaped "\"" }
      NF >= 2 {
        remote=""; if (NF >= 5) { remote=$5; gsub(/[()]/, "", remote) }
        if (count > 0) printf ","
        printf "{\"user\":%s,\"tty\":%s,\"started\":%s,\"remote\":%s}", js($1), js($2), js($3 " " $4), js(remote)
        count++
      }'
  fi
}

emit_user_record() {
  row_event=$1
  if [ "$row_event" = "true" ]; then
    printf '{"event":"row","data":{"kind":"user","item":'
  fi
  printf '{"name":'; json_string "$name"
  printf ',"uid":'; json_string "$uid"
  printf ',"gid":'; json_string "$gid"
  printf ',"full_name":'; json_string "$gecos"
  printf ',"home":'; json_string "$home"
  printf ',"shell":'; json_string "$shell"
  printf ',"system":'; bool_json "$system_user"
  printf ',"enabled":true'
  printf ',"admin":'; bool_json "$admin"
  if [ -n "$password_login_enabled" ]; then printf ',"password_login_enabled":%s' "$password_login_enabled"; fi
  printf ',"password_required":true'
  printf ',"password_state":'; json_string "$password_state"
  printf ',"groups":'
  # shellcheck disable=SC2086
  json_array_words $groups
  printf ',"ssh_key_count":'; json_string "$ssh_key_count"
  printf ',"authorized_keys_path":'; json_string "$authorized_keys_path"
  printf ',"last_login":'; json_string "$last_login"
  printf ',"account_expires":'; json_string "$account_expires"
  printf ',"password_last_changed":'; json_string "$password_last_changed"
  printf '}'
  if [ "$row_event" = "true" ]; then
    printf '}}\n'
  fi
}

emit_user_rows_or_array() {
  row_event=$1
  count=0
  darwin_admin_members=
  if [ "$is_darwin" = "true" ] && command -v dscl >/dev/null 2>&1; then
    darwin_admin_members=$(dscl . -read /Groups/admin GroupMembership 2>/dev/null | sed 's/^GroupMembership:[[:space:]]*//' || true)
  fi
  while IFS=: read -r name pass uid gid gecos home shell rest; do
    [ -n "$name" ] || continue
    system_user=false
    if [ "${uid:-0}" -lt 1000 ] 2>/dev/null && [ "$name" != "root" ]; then system_user=true; fi
    admin=false
    if [ "$uid" = "0" ]; then
      admin=true
    else
      if [ "$is_darwin" = "true" ]; then
        for admin_member in $darwin_admin_members; do
          [ "$admin_member" = "$name" ] && admin=true
        done
      else
        groups=$(id -nG "$name" 2>/dev/null || true)
        for group in $groups; do
          case "$group" in sudo|wheel|admin) admin=true ;; esac
        done
      fi
    fi
    password_state=unknown
    password_login_enabled=
    shadow_line=$(awk -F: -v user="$name" '$1 == user { print $2; exit }' "$shadow_file" 2>/dev/null || true)
    if [ -n "$shadow_line" ]; then
      case "$shadow_line" in
        '!'*|'*'*) password_state=locked; password_login_enabled=false ;;
        '') password_state=no-password; password_login_enabled=false ;;
        *) password_state=password-set; password_login_enabled=true ;;
      esac
    elif command -v passwd >/dev/null 2>&1; then
      status_line=$(passwd -S "$name" 2>/dev/null || true)
      case "$status_line" in
        *' L '*|*' LK '*|*' locked '*) password_state=locked; password_login_enabled=false ;;
        *' NP '*|*' no password '*) password_state=no-password; password_login_enabled=false ;;
        *' P '*|*' PS '*) password_state=password-set; password_login_enabled=true ;;
      esac
    fi
    authorized_keys_path=
    ssh_key_count=0
    if [ -n "$home" ]; then
      authorized_keys_path="$home/.ssh/authorized_keys"
      if { [ "$is_darwin" != "true" ] || [ "$system_user" != "true" ] || [ "$name" = "root" ]; } && run_root_capture test -r "$authorized_keys_path" 2>/dev/null; then
        ssh_key_count=$(run_root_capture awk 'BEGIN{count=0} /^[[:space:]]*($|#)/ {next} {count++} END{print count}' "$authorized_keys_path" 2>/dev/null || printf 0)
      fi
    fi
    last_login=
    if [ "$is_darwin" != "true" ] && command -v lastlog >/dev/null 2>&1; then
      last_login=$(lastlog -u "$name" 2>/dev/null | awk 'NR==2 && $0 !~ /Never logged in/ {for(i=4;i<=NF;i++) printf "%s%s", (i==4?"":" "), $i}')
    fi
    account_expires=
    password_last_changed=
    if [ "$can_run_root" = "true" ] && command -v chage >/dev/null 2>&1; then
      chage_output=$(run_root_capture chage -l "$name" 2>/dev/null || true)
      account_expires=$(printf '%s\n' "$chage_output" | awk -F: '$1=="Account expires" {sub(/^ /,"",$2); print $2; exit}')
      password_last_changed=$(printf '%s\n' "$chage_output" | awk -F: '$1=="Last password change" {sub(/^ /,"",$2); print $2; exit}')
    fi
    if [ "$is_darwin" = "true" ] && [ "$system_user" = "true" ] && [ "$name" != "root" ]; then
      groups=
    else
      groups=$(id -nG "$name" 2>/dev/null || true)
    fi
    if [ "$row_event" = "true" ]; then
      emit_user_record true
    else
      if [ $count -gt 0 ]; then printf ','; fi
      emit_user_record false
      count=$((count + 1))
    fi
  done < "$passwd_file"
}

if [ "$mode" = "ssh_keys" ]; then
  if ! safe_user_name "$target_user"; then
    echo "Choose a valid user name before reading SSH authorized keys." >&2
    exit 1
  fi
  home_dir=$(awk -F: -v user="$target_user" '$1 == user { print $6; exit }' "$passwd_file")
  authorized_keys_path=
  if [ -n "$home_dir" ]; then
    authorized_keys_path="$home_dir/.ssh/authorized_keys"
  fi
  if [ "$stream_format" = "row_events" ]; then
    {
      emit_event_prefix meta
      printf '{"platform":'; json_string "$platform"
      printf ',"manager":'; json_string "$manager"
      printf ',"user":'; json_string "$target_user"
      printf ',"authorized_keys_path":'; json_string "$authorized_keys_path"
      printf '}}\n'
      emit_ssh_key_rows
      emit_event_prefix done
      printf '{"platform":'; json_string "$platform"
      printf ',"manager":'; json_string "$manager"
      printf ',"user":'; json_string "$target_user"
      printf ',"authorized_keys_path":'; json_string "$authorized_keys_path"
      printf '}}\n'
    } | compress_json_stream
    exit 0
  fi
  {
    printf '{"platform":'
    json_string "$platform"
    printf ',"manager":'
    json_string "$manager"
    printf ',"user":'
    json_string "$target_user"
    printf ',"authorized_keys_path":'
    json_string "$authorized_keys_path"
    printf ',"keys":['
    emit_ssh_key_array
    printf ']}\n'
  } | compress_json_stream
  exit 0
fi

if [ "$can_run_root" = "true" ]; then
  if command -v getent >/dev/null 2>&1; then
    run_root_capture getent shadow > "$shadow_file" 2>/dev/null || run_root_capture cat /etc/shadow > "$shadow_file" 2>/dev/null || true
  else
    run_root_capture cat /etc/shadow > "$shadow_file" 2>/dev/null || true
  fi
fi

if [ "$stream_format" = "row_events" ]; then
  {
    emit_event_prefix meta
    printf '{"platform":'; json_string "$platform"
    printf ',"manager":'; json_string "$manager"
    printf ',"can_manage":%s}}\n' "$can_run_root"
    emit_sessions_rows
    emit_user_rows_or_array true
    emit_event_prefix done
    printf '{"platform":'; json_string "$platform"
    printf ',"manager":'; json_string "$manager"
    printf ',"can_manage":%s}}\n' "$can_run_root"
  } | compress_json_stream
  exit 0
fi

{
  printf '{"platform":'
  json_string "$platform"
  printf ',"manager":'
  json_string "$manager"
  printf ',"can_manage":%s,"sessions":[' "$can_run_root"
  emit_sessions_array
  printf '],"users":['
  emit_user_rows_or_array false
  printf ']}\n'
} | compress_json_stream
