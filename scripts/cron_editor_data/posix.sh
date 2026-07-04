#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
mode=${SHELLORCHESTRA_CRON_MODE:-users}
target_user=${SHELLORCHESTRA_CRON_USER:-}
cron_content=${SHELLORCHESTRA_CRON_CONTENT:-}
output_encoding=${SHELLORCHESTRA_CRON_OUTPUT_ENCODING:-${cron_output_encoding:-}}
stream_format=${SHELLORCHESTRA_CRON_STREAM_FORMAT:-${cron_stream_format:-json}}
case "$stream_format" in ''|'json') stream_format=json ;; 'row_events') ;; *) echo "Unsupported ShellOrchestra Cron Editor stream format: $stream_format" >&2; exit 64 ;; esac
case "$output_encoding" in ''|'none') output_encoding=none ;; 'auto'|'zstd'|'gzip') ;; *) echo "Unsupported ShellOrchestra Cron Editor output encoding: $output_encoding" >&2; exit 64 ;; esac

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

safe_user_name() {
  case "$1" in
    ''|*[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-]*|[-.]*|*[.-]) return 1 ;;
    *) return 0 ;;
  esac
}

current_user() {
  id -un 2>/dev/null || whoami 2>/dev/null || printf ''
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
  echo "Root privileges are required to manage another user's crontab." >&2
  return 1
}

ensure_crontab_available() {
  if command -v crontab >/dev/null 2>&1; then
    return 0
  fi
  if [ "$stream_format" = "row_events" ]; then
    emit_event_prefix meta
    printf '{"mode":'
    json_string "$mode"
    printf ',"available":false,"message":"crontab is not installed on this server."}}\n'
    emit_event_prefix done
    printf '{"mode":'
    json_string "$mode"
    printf ',"available":false,"message":"crontab is not installed on this server."}}\n'
  else
    printf '{"mode":'
    json_string "$mode"
    printf ',"available":false,"message":"crontab is not installed on this server."}\n'
  fi
  exit 0
}

read_crontab() {
  user=$1
  tmp=$(mktemp)
  err=$(mktemp)
  trap 'rm -f "$tmp" "$err"' EXIT HUP INT TERM
  if [ "$user" = "$(current_user)" ]; then
    if crontab -l >"$tmp" 2>"$err"; then
      exists=true
    else
      if grep -qi 'no crontab' "$err" 2>/dev/null; then
        exists=false
        : >"$tmp"
      else
        cat "$err" >&2
        exit 1
      fi
    fi
  else
    if run_root crontab -u "$user" -l >"$tmp" 2>"$err"; then
      exists=true
    else
      if grep -qi 'no crontab' "$err" 2>/dev/null; then
        exists=false
        : >"$tmp"
      else
        cat "$err" >&2
        exit 1
      fi
    fi
  fi
  content=$(cat "$tmp")
  if [ "$stream_format" = "row_events" ]; then
    emit_event_prefix meta
    printf '{"mode":"read","available":true,"user":'
    json_string "$user"
    printf ',"exists":%s}}\n' "$exists"
    printf '{"event":"row","data":{"kind":"crontab","item":{"user":'
    json_string "$user"
    printf ',"exists":%s,"content":' "$exists"
    json_string "$content"
    printf '}}}\n'
    emit_event_prefix done
    printf '{"mode":"read","available":true,"user":'
    json_string "$user"
    printf ',"exists":%s}}\n' "$exists"
  else
    printf '{"mode":"read","available":true,"user":'
    json_string "$user"
    printf ',"exists":%s,"content":' "$exists"
    json_string "$content"
    printf '}\n'
  fi
}

validate_crontab() {
  user=$1
  tmp=$(mktemp)
  trap 'rm -f "$tmp"' EXIT HUP INT TERM
  printf '%s' "$cron_content" >"$tmp"
  awk -v user="$user" '
    function js(value, escaped) {
      escaped = value
      gsub(/\\/,"\\\\",escaped)
      gsub(/"/,"\\\"",escaped)
      gsub(/\t/,"\\t",escaped)
      gsub(/\r/,"\\r",escaped)
      gsub(/\n/,"\\n",escaped)
      return "\"" escaped "\""
    }
    function add_issue(kind, line_no, message, text) {
      issue_count++
      issue_kind[issue_count] = kind
      issue_line[issue_count] = line_no
      issue_message[issue_count] = message
      issue_text[issue_count] = text
      if (kind == "error") error_count++
      if (kind == "warning") warning_count++
    }
    function cron_value(raw, kind, upper, names, values, count, name_index) {
      if (raw ~ /^[0-9]+$/) return raw + 0
      upper = toupper(raw)
      if (kind == "month") {
        names = "JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC"
        count = split(names, values, " ")
        for (name_index = 1; name_index <= count; name_index++) if (upper == values[name_index]) return name_index
      }
      if (kind == "dow") {
        names = "SUN MON TUE WED THU FRI SAT"
        count = split(names, values, " ")
        for (name_index = 1; name_index <= count; name_index++) if (upper == values[name_index]) return name_index - 1
      }
      return -999999
    }
    function single_value_valid(raw, min, max, kind, value) {
      value = cron_value(raw, kind)
      if (value == -999999) return 0
      if (kind == "dow" && value == 7) return 1
      return value >= min && value <= max
    }
    function field_valid(field, min, max, kind, segments, segment_count, segment_index, segment, step_parts, step_count, base, step, range_parts, range_count, start_value, end_value) {
      if (field == "") return 0
      segment_count = split(field, segments, ",")
      for (segment_index = 1; segment_index <= segment_count; segment_index++) {
        segment = segments[segment_index]
        if (segment == "") return 0
        step_count = split(segment, step_parts, "/")
        if (step_count > 2) return 0
        base = step_parts[1]
        if (step_count == 2) {
          step = step_parts[2]
          if (step !~ /^[0-9]+$/ || step + 0 < 1) return 0
        }
        if (base == "*") continue
        range_count = split(base, range_parts, "-")
        if (range_count == 2) {
          if (!single_value_valid(range_parts[1], min, max, kind) || !single_value_valid(range_parts[2], min, max, kind)) return 0
          start_value = cron_value(range_parts[1], kind)
          end_value = cron_value(range_parts[2], kind)
          if (start_value > end_value) return 0
          continue
        }
        if (range_count > 2) return 0
        if (!single_value_valid(base, min, max, kind)) return 0
      }
      return 1
    }
    function supported_special(token, upper) {
      upper = toupper(token)
      return upper == "@REBOOT" || upper == "@HOURLY" || upper == "@DAILY" || upper == "@WEEKLY" || upper == "@MONTHLY" || upper == "@YEARLY" || upper == "@ANNUALLY"
    }
    function likely_system_user_token(token) {
      return token ~ /^(root|daemon|bin|sync|games|man|lp|mail|news|uucp|proxy|www-data|backup|list|irc|gnats|nobody)$/
    }
    function validate_line(line_no, raw, trimmed, fields, field_count, ok, command_start) {
      trimmed = raw
      sub(/^[ \t]+/, "", trimmed)
      sub(/[ \t]+$/, "", trimmed)
      if (trimmed == "" || trimmed ~ /^#/) return
      if (trimmed ~ /^[A-Za-z_][A-Za-z0-9_]*[ \t]*=/) return
      if (trimmed ~ /^@/) {
        field_count = split(trimmed, fields, /[ \t]+/)
        if (!supported_special(fields[1])) {
          add_issue("error", line_no, "Unsupported cron nickname. Use @reboot, @hourly, @daily, @weekly, @monthly, @yearly, or a five-field schedule.", raw)
          return
        }
        if (field_count < 2) {
          add_issue("error", line_no, "Cron nickname entries must include a command.", raw)
          return
        }
        entry_count++
        return
      }
      field_count = split(trimmed, fields, /[ \t]+/)
      if (field_count < 6) {
        add_issue("error", line_no, "A user crontab entry needs five schedule fields followed by a command.", raw)
        return
      }
      ok = 1
      if (!field_valid(fields[1], 0, 59, "minute")) {
        add_issue("error", line_no, "Minute field is invalid. Use values 0-59, *, ranges, lists, or steps.", raw)
        ok = 0
      }
      if (!field_valid(fields[2], 0, 23, "hour")) {
        add_issue("error", line_no, "Hour field is invalid. Use values 0-23, *, ranges, lists, or steps.", raw)
        ok = 0
      }
      if (!field_valid(fields[3], 1, 31, "dom")) {
        add_issue("error", line_no, "Day-of-month field is invalid. Use values 1-31, *, ranges, lists, or steps.", raw)
        ok = 0
      }
      if (!field_valid(fields[4], 1, 12, "month")) {
        add_issue("error", line_no, "Month field is invalid. Use values 1-12, JAN-DEC, *, ranges, lists, or steps.", raw)
        ok = 0
      }
      if (!field_valid(fields[5], 0, 7, "dow")) {
        add_issue("error", line_no, "Day-of-week field is invalid. Use values 0-7, SUN-SAT, *, ranges, lists, or steps.", raw)
        ok = 0
      }
      if (ok) {
        if (field_count >= 7 && likely_system_user_token(fields[6])) {
          add_issue("warning", line_no, "This looks like a system crontab line with a user column. User crontabs normally start the command immediately after the fifth schedule field.", raw)
        }
        entry_count++
      }
    }
    { validate_line(NR, $0) }
    END {
      printf "{\"mode\":\"validate\",\"available\":true,\"user\":%s,\"valid\":%s,\"entries\":%d,\"errors\":[", js(user), error_count ? "false" : "true", entry_count + 0
      first = 1
      for (issue_index = 1; issue_index <= issue_count; issue_index++) {
        if (issue_kind[issue_index] != "error") continue
        if (!first) printf ","
        first = 0
        printf "{\"line\":%d,\"message\":%s,\"text\":%s}", issue_line[issue_index], js(issue_message[issue_index]), js(issue_text[issue_index])
      }
      printf "],\"warnings\":["
      first = 1
      for (issue_index = 1; issue_index <= issue_count; issue_index++) {
        if (issue_kind[issue_index] != "warning") continue
        if (!first) printf ","
        first = 0
        printf "{\"line\":%d,\"message\":%s,\"text\":%s}", issue_line[issue_index], js(issue_message[issue_index]), js(issue_text[issue_index])
      }
      printf "]}\n"
    }
  ' "$tmp"
}

case "$mode" in
  users)
    {
      ensure_crontab_available
      me=$(current_user)
      if [ "$stream_format" = "row_events" ]; then
        emit_event_prefix meta
        printf '{"mode":"users","available":true,"current_user":'
        json_string "$me"
        printf '}}\n'
        if [ -r /etc/passwd ]; then
          awk -F: -v current="$me" '
            function js(value, escaped){ escaped=value; gsub(/\\/,"\\\\",escaped); gsub(/"/,"\\\"",escaped); gsub(/\t/,"\\t",escaped); gsub(/\r/,"\\r",escaped); gsub(/\n/,"\\n",escaped); return "\"" escaped "\"" }
            function emit(user, uid, home, shell) {
              if (seen[user]++) return
              printf "{\"event\":\"row\",\"data\":{\"kind\":\"user\",\"item\":{\"name\":%s,\"uid\":%s,\"home\":%s,\"shell\":%s}}}\n", js(user), js(uid), js(home), js(shell)
            }
            BEGIN { if (current != "") emit(current, "", "", "") }
            $1 == "root" { emit($1, $3, $6, $7) }
            $7 !~ /(nologin|false)$/ && ($3 >= 1000 || $1 == current) { emit($1, $3, $6, $7) }
          ' /etc/passwd
        else
          printf '{"event":"row","data":{"kind":"user","item":{"name":'
          json_string "$me"
          printf ',"uid":"","home":"","shell":""}}}\n'
        fi
        emit_event_prefix done
        printf '{"mode":"users","available":true,"current_user":'
        json_string "$me"
        printf '}}\n'
      else
        printf '{"mode":"users","available":true,"current_user":'
        json_string "$me"
        printf ',"users":['
        if [ -r /etc/passwd ]; then
          awk -F: -v current="$me" '
            function js(value, escaped){ escaped=value; gsub(/\\/,"\\\\",escaped); gsub(/"/,"\\\"",escaped); gsub(/\t/,"\\t",escaped); gsub(/\r/,"\\r",escaped); gsub(/\n/,"\\n",escaped); return "\"" escaped "\"" }
            function emit(user, uid, home, shell) {
              if (seen[user]++) return
              if (count++ > 0) printf ","
              printf "{\"name\":%s,\"uid\":%s,\"home\":%s,\"shell\":%s}", js(user), js(uid), js(home), js(shell)
            }
            BEGIN { if (current != "") emit(current, "", "", "") }
            $1 == "root" { emit($1, $3, $6, $7) }
            $7 !~ /(nologin|false)$/ && ($3 >= 1000 || $1 == current) { emit($1, $3, $6, $7) }
          ' /etc/passwd
        else
          printf '{"name":'
          json_string "$me"
          printf ',"uid":"","home":"","shell":""}'
        fi
        printf ']}\n'
      fi
    } | compress_json_stream
    ;;
  read)
    {
      ensure_crontab_available
      if ! safe_user_name "$target_user"; then
        echo "Choose a valid user before reading crontab." >&2
        exit 1
      fi
      read_crontab "$target_user"
    } | compress_json_stream
    ;;
  validate)
    {
      if ! safe_user_name "$target_user"; then
        echo "Choose a valid user before validating crontab." >&2
        exit 1
      fi
      validate_crontab "$target_user"
    } | compress_json_stream
    ;;
  *)
    echo "Unsupported read-only cron editor mode: $mode" >&2
    exit 1
    ;;
esac
