#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu

json_string() {
  awk 'BEGIN {
    value = ARGV[1]
    ARGV[1] = ""
    gsub(/\\/, "\\\\", value)
    gsub(/"/, "\\\"", value)
    gsub(/\t/, "\\t", value)
    gsub(/\r/, "\\r", value)
    gsub(/\n/, "\\n", value)
    printf "\"%s\"", value
  }' "$1"
}

json_number_or_null() {
  case "${1:-}" in
    ''|*[!0123456789]*) printf 'null' ;;
    *) printf '%s' "$1" ;;
  esac
}

limit=${SHELLORCHESTRA_PACKAGE_LIMIT:-80}
case "$limit" in ''|*[!0123456789]*) limit=80 ;; esac
[ "$limit" -lt 1 ] 2>/dev/null && limit=1
[ "$limit" -gt 100000 ] 2>/dev/null && limit=100000

action=${SHELLORCHESTRA_PACKAGE_ACTION:-installed}
query=${SHELLORCHESTRA_PACKAGE_QUERY:-}
manager=${SHELLORCHESTRA_PACKAGE_MANAGER:-}
output_encoding=${SHELLORCHESTRA_PACKAGE_OUTPUT_ENCODING:-}
stream_format=${SHELLORCHESTRA_PACKAGE_STREAM_FORMAT:-json}
known_state_token=${SHELLORCHESTRA_PACKAGE_KNOWN_STATE_TOKEN:-}
case "$output_encoding" in ''|'auto'|'zstd'|'gzip') ;; *) echo "Unsupported ShellOrchestra package output encoding: $output_encoding" >&2; exit 64 ;; esac
case "$stream_format" in ''|'json') stream_format=json ;; 'row_events') ;; *) echo "Unsupported ShellOrchestra package stream format: $stream_format" >&2; exit 64 ;; esac

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
        echo "zstd or gzip is required for compressed ShellOrchestra package data on this server." >&2
        exit 127
      fi
      ;;
    'zstd')
      if ! command -v zstd >/dev/null 2>&1; then
        echo "zstd is required for zstd-compressed ShellOrchestra package data on this server." >&2
        exit 127
      fi
      zstd -1 -q -c
      ;;
    'gzip')
      if ! command -v gzip >/dev/null 2>&1; then
        echo "gzip is required for gzip-compressed ShellOrchestra package data on this server." >&2
        exit 127
      fi
      gzip -1 -c
      ;;
  esac
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
  else manager=unknown
  fi
fi

brew_bin() {
  if command -v brew >/dev/null 2>&1; then command -v brew
  elif [ -x /opt/homebrew/bin/brew ]; then printf /opt/homebrew/bin/brew
  elif [ -x /usr/local/bin/brew ]; then printf /usr/local/bin/brew
  else return 1
  fi
}

brew_cmd() {
  brew=$(brew_bin) || return 1
  HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ENV_HINTS=1 "$brew" "$@"
}

mtime_epoch() {
  path=$1
  stat -c '%Y' "$path" 2>/dev/null || stat -f '%m' "$path" 2>/dev/null || return 1
}

newest_mtime_from_paths() {
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    mtime_epoch "$path" 2>/dev/null || true
  done | sort -n | tail -1
}

epoch_to_iso() {
  epoch=$1
  date -u -d "@$epoch" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -r "$epoch" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || printf ''
}

now_epoch() {
  date -u '+%s' 2>/dev/null || date '+%s'
}

package_metadata_epoch() {
  case "$manager" in
    apt)
      [ -d /var/lib/apt/lists ] || return 1
      find /var/lib/apt/lists -type f ! -name lock ! -path '*/partial/*' -print 2>/dev/null | newest_mtime_from_paths
      ;;
    apk)
      { find /var/cache/apk /etc/apk/cache -type f -name 'APKINDEX.*' -print 2>/dev/null || true; } | newest_mtime_from_paths
      ;;
    pacman)
      [ -d /var/lib/pacman/sync ] || return 1
      find /var/lib/pacman/sync -type f -name '*.db*' -print 2>/dev/null | newest_mtime_from_paths
      ;;
    dnf|yum)
      { find /var/cache/dnf /var/cache/yum -type f -print 2>/dev/null || true; } | newest_mtime_from_paths
      ;;
    zypper)
      { find /var/cache/zypp -type f -print 2>/dev/null || true; } | newest_mtime_from_paths
      ;;
    brew)
      repo=$(brew_cmd --repo 2>/dev/null || brew_cmd --repository 2>/dev/null || true)
      if [ -n "$repo" ]; then
        { [ -e "$repo/.git/FETCH_HEAD" ] && printf '%s\n' "$repo/.git/FETCH_HEAD"; find "$repo/Library/Taps" -maxdepth 4 -type f -name FETCH_HEAD -print 2>/dev/null || true; } | newest_mtime_from_paths
      fi
      ;;
    *) return 1 ;;
  esac
}

package_metadata_hint() {
  case "$manager" in
    apt) printf 'APT upgrade/search results use /var/lib/apt/lists. Run apt-get update when this metadata is stale.' ;;
    apk) printf 'Alpine search/upgrade results use APKINDEX cache files. Run apk update when this metadata is stale.' ;;
    pacman) printf 'Pacman search/upgrade results use /var/lib/pacman/sync. Run pacman -Sy to refresh repository databases.' ;;
    dnf) printf 'DNF search/upgrade results use local repository cache. Run dnf makecache --refresh when this metadata is stale.' ;;
    yum) printf 'YUM search/upgrade results use local repository cache. Run yum makecache when this metadata is stale.' ;;
    zypper) printf 'Zypper search/upgrade results use local repository cache. Run zypper refresh when this metadata is stale.' ;;
    brew) printf 'Homebrew search/info results use local tap metadata. Run brew update when this metadata is stale.' ;;
    *) printf 'This package manager does not expose refreshable repository metadata to ShellOrchestra.' ;;
  esac
}

package_metadata_json_fields() {
  hint=$(package_metadata_hint || true)
  epoch=$(package_metadata_epoch 2>/dev/null || true)
  if [ -z "$epoch" ]; then
    status=unknown
    case "$manager" in unknown|'') status=unsupported ;; esac
    printf ',"metadata_updated_at":"","metadata_age_seconds":null,"metadata_status":'
    json_string "$status"
    printf ',"metadata_refresh_hint":'
    json_string "$hint"
    return
  fi
  now=$(now_epoch)
  age=$((now - epoch))
  [ "$age" -lt 0 ] 2>/dev/null && age=0
  updated_at=$(epoch_to_iso "$epoch")
  status=fresh
  [ "$age" -gt 86400 ] 2>/dev/null && status=stale
  printf ',"metadata_updated_at":'
  json_string "$updated_at"
  printf ',"metadata_age_seconds":%s,"metadata_status":' "$(json_number_or_null "$age")"
  json_string "$status"
  printf ',"metadata_refresh_hint":'
  json_string "$hint"
}

stat_token_input() {
  for path in "$@"; do
    [ -e "$path" ] || continue
    if stat -c '%n:%F:%s:%Y' "$path" 2>/dev/null; then
      :
    elif stat -f '%N:%HT:%z:%m' "$path" 2>/dev/null; then
      :
    else
      ls -ldn "$path" 2>/dev/null || true
    fi
  done
}

package_state_token() {
  case "$manager" in
    apt)
      stat_token_input /var/lib/dpkg/status
      ;;
    apk)
      db_file=$(apk_db_file) || true
      [ -n "${db_file:-}" ] && stat_token_input "$db_file"
      ;;
    pacman)
      if [ -d /var/lib/pacman/local ]; then
        find /var/lib/pacman/local -maxdepth 1 -mindepth 1 -type d -exec sh -c 'for path do stat -c "%n:%s:%Y" "$path" 2>/dev/null || ls -ldn "$path" 2>/dev/null || true; done' sh {} + 2>/dev/null
      fi
      ;;
    dnf|yum|zypper)
      stat_token_input /var/lib/rpm /usr/lib/sysimage/rpm
      ;;
    brew)
      cellar=$(brew_cmd --cellar 2>/dev/null || true)
      [ -n "$cellar" ] && stat_token_input "$cellar"
      ;;
  esac | cksum | awk '{ printf "v1-%s-%s", $1, $2 }'
}

rows_to_packages() {
  awk -F '\t' -v limit="$limit" -v stream_format="$stream_format" '
    function json_string(value, escaped) {
      escaped = value
      gsub(/\\/, "\\\\", escaped)
      gsub(/"/, "\\\"", escaped)
      gsub(/\t/, "\\t", escaped)
      gsub(/\r/, "\\r", escaped)
      gsub(/\n/, "\\n", escaped)
      return "\"" escaped "\""
    }
    function json_string_array(value, parts, i, count) {
      if (value == "") return "[]"
      count = split(value, parts, /[, ]+/)
      out = "["
      emitted = 0
      for (i = 1; i <= count; i++) {
        if (parts[i] == "") continue
        if (emitted > 0) out = out ","
        out = out json_string(parts[i])
        emitted++
      }
      return out "]"
    }
    NF >= 1 && count < limit {
      name=$1; version=$2; description=$3; installed_value=$4; upgradable_value=$5
      security_value=$6; severity=$7; advisory=$8; cves=$9; fixed_version=$10
      if (name == "") next
      installed_bool = "false"
      upgradable_bool = "false"
      security_bool = "false"
      if (installed_value == "true") installed_bool = "true"
      if (upgradable_value == "true") upgradable_bool = "true"
      if (security_value == "true") security_bool = "true"
      object = sprintf("{\"name\":%s,\"version\":%s,\"description\":%s,\"installed\":%s,\"upgradable\":%s", json_string(name), json_string(version), json_string(description), installed_bool, upgradable_bool)
      if (security_value != "" || severity != "" || advisory != "" || cves != "" || fixed_version != "") {
        object = object sprintf(",\"security\":%s,\"severity\":%s,\"advisory\":%s,\"cves\":%s,\"fixed_version\":%s", security_bool, json_string(severity), json_string(advisory), json_string_array(cves), json_string(fixed_version))
      }
      object = object "}"
      if (stream_format == "row_events") {
        printf "{\"event\":\"row\",\"data\":%s}\n", object
      } else {
        if (count > 0) printf ","
        printf "%s", object
      }
      count++
    }
  '
}

apk_db_file() {
  if [ -r /lib/apk/db/installed ]; then
    printf /lib/apk/db/installed
    return 0
  fi
  if [ -r /var/lib/apk/db/installed ]; then
    printf /var/lib/apk/db/installed
    return 0
  fi
  return 1
}

apk_installed_rows() {
  db_file=$(apk_db_file) || return 0
  awk -v query="$query" '
    function emit() {
      if (name == "") return
      if (query != "" && index(name, query) == 0 && index(description, query) == 0) return
      print name "\t" version "\t" description "\ttrue\tfalse"
    }
    /^$/ {
      emit()
      name = ""; version = ""; description = ""
      next
    }
    /^P:/ { name = substr($0, 3); next }
    /^V:/ { version = substr($0, 3); next }
    /^T:/ { description = substr($0, 3); next }
    END { emit() }
  ' "$db_file" | sort | rows_to_packages
}

apk_index_stream() {
  for index_file in /var/cache/apk/APKINDEX.*.tar.gz /etc/apk/cache/APKINDEX.*.tar.gz; do
    [ -r "$index_file" ] || continue
    tar -xOf "$index_file" APKINDEX 2>/dev/null || true
  done
}

apk_available_rows() {
  [ -n "$query" ] || return 0
  apk_index_stream | awk -v query="$query" '
    function lower(value) { return tolower(value) }
    function emit() {
      if (name == "") return
      haystack = lower(name " " description)
      if (index(haystack, lower(query)) == 0) return
      print name "\t" version "\t" description "\tfalse\tfalse"
    }
    /^$/ {
      emit()
      name = ""; version = ""; description = ""
      next
    }
    /^P:/ { name = substr($0, 3); next }
    /^V:/ { version = substr($0, 3); next }
    /^T:/ { description = substr($0, 3); next }
    END { emit() }
  ' | sort | rows_to_packages
}

pacman_installed_rows() {
  if [ ! -d /var/lib/pacman/local ]; then
    pacman -Q 2>/dev/null | awk '{print $1 "\t" $2 "\t\ttrue\tfalse"}' | rows_to_packages
    return
  fi
  find /var/lib/pacman/local -maxdepth 2 -mindepth 2 -type f -name desc -print 2>/dev/null | sort | while IFS= read -r desc_file; do
    awk '
      BEGIN { field = ""; name = ""; version = ""; description = "" }
      /^%[^%]+%$/ { field = $0; next }
      field == "%NAME%" && name == "" { name = $0; next }
      field == "%VERSION%" && version == "" { version = $0; next }
      field == "%DESC%" && description == "" { description = $0; next }
      END {
        if (name != "") print name "\t" version "\t" description "\ttrue\tfalse"
      }
    ' "$desc_file"
  done | rows_to_packages
}

apt_security_rows() {
  if ! command -v apt >/dev/null 2>&1 || ! command -v apt-cache >/dev/null 2>&1; then return 0; fi
  apt list --upgradable 2>/dev/null | awk -F'[/ ]' 'NR>1 && $1 != "" {print $1 "\t" $3}' | while IFS="$(printf '\t')" read -r package version; do
    [ -n "$package" ] || continue
    if [ -n "$query" ] && ! printf '%s\n' "$package" | grep -Fqi -- "$query"; then
      continue
    fi
    policy=$(apt-cache policy "$package" 2>/dev/null || true)
    if printf '%s\n' "$policy" | grep -Eiq 'security|[.]debian[.]org/debian-security|ubuntu.*-security'; then
      printf '%s\t%s\tSecurity update from the configured apt security pocket\ttrue\ttrue\ttrue\tsecurity\tapt-security\t\t%s\n' "$package" "$version" "$version"
    fi
  done | rows_to_packages
}

apk_security_rows() {
  # The local apk installed database C: field is a package checksum, not CVE/secfix metadata.
  # Community edition must not invent Alpine security rows from that field.
  return 0
}

dnf_security_rows() {
  tool=$1
  "$tool" -q updateinfo list security 2>/dev/null | awk -v query="$query" '
    function lower(value) { return tolower(value) }
    NF >= 3 {
      advisory=$1; severity=$2; package=$NF
      name=package
      sub(/\.[^.]+$/, "", name)
      sub(/-[0-9][^-]*(-[^-]+)?$/, "", name)
      haystack = lower(name " " package " " advisory " " severity)
      if (query != "" && index(haystack, lower(query)) == 0) next
      print name "\t" package "\tSecurity advisory " advisory "\ttrue\ttrue\ttrue\t" severity "\t" advisory "\t\t"
    }
  ' | rows_to_packages
}

zypper_security_rows() {
  zypper --non-interactive list-patches --category security 2>/dev/null | awk -F '|' -v query="$query" '
    function trim(value) { gsub(/^ +| +$/, "", value); return value }
    function lower(value) { return tolower(value) }
    $0 ~ /\|/ && $0 !~ /^[-+ ]*$/ {
      category=trim($4); if (tolower(category) != "security") next
      severity=trim($5); name=trim($2); version=trim($3)
      haystack = lower(name " " version " " severity)
      if (query != "" && index(haystack, lower(query)) == 0) next
      print name "\t" version "\tSecurity patch\ttrue\ttrue\ttrue\t" severity "\tzypper-patch\t\t" version
    }
  ' | rows_to_packages
}

emit_package_rows() {
  case "$manager:$action" in
    apt:installed)
      dpkg-query -W -f='${Package}\t${Version}\t${binary:Summary}\ttrue\tfalse\n' 2>/dev/null | sort | rows_to_packages ;;
    apt:search)
      [ -n "$query" ] || return 0
      apt-cache search --names-only "$query" 2>/dev/null | awk -F ' - ' '{print $1 "\t\t" substr($0, index($0,$2)) "\tfalse\tfalse"}' | rows_to_packages ;;
    apt:upgradable)
      apt list --upgradable 2>/dev/null | awk -F'[/ ]' 'NR>1 {print $1 "\t" $3 "\t\ttrue\ttrue"}' | rows_to_packages ;;
    apt:security)
      apt_security_rows ;;
    apk:installed)
      apk_installed_rows ;;
    apk:search)
      [ -n "$query" ] || return 0
      apk_available_rows ;;
    apk:security)
      apk_security_rows ;;
    pacman:installed)
      pacman_installed_rows ;;
    pacman:search)
      [ -n "$query" ] || return 0
      pacman -Ss "$query" 2>/dev/null | awk '/^[^ ]/ {split($1,a,"/"); name=a[2]; ver=$2; getline desc; sub(/^    /,"",desc); print name "\t" ver "\t" desc "\tfalse\tfalse"}' | rows_to_packages ;;
    pacman:security)
      return 0 ;;
    dnf:installed|yum:installed)
      rpm -qa --qf '%{NAME}\t%{VERSION}-%{RELEASE}\t%{SUMMARY}\ttrue\tfalse\n' 2>/dev/null | sort | rows_to_packages ;;
    dnf:search)
      [ -n "$query" ] || return 0
      dnf -q search "$query" 2>/dev/null | awk -F ' : ' '/^[[:alnum:]_.+-]+\./ {split($1,a,"."); print a[1] "\t\t" $2 "\tfalse\tfalse"}' | rows_to_packages ;;
    dnf:security)
      dnf_security_rows dnf ;;
    yum:search)
      [ -n "$query" ] || return 0
      yum -q search "$query" 2>/dev/null | awk -F ' : ' '/^[[:alnum:]_.+-]+\./ {split($1,a,"."); print a[1] "\t\t" $2 "\tfalse\tfalse"}' | rows_to_packages ;;
    yum:security)
      dnf_security_rows yum ;;
    zypper:installed)
      rpm -qa --qf '%{NAME}\t%{VERSION}-%{RELEASE}\t%{SUMMARY}\ttrue\tfalse\n' 2>/dev/null | sort | rows_to_packages ;;
    zypper:search)
      [ -n "$query" ] || return 0
      zypper --non-interactive search "$query" 2>/dev/null | awk -F '|' '/^ *[iv ]/ {gsub(/^ +| +$/, "", $2); gsub(/^ +| +$/, "", $4); print $2 "\t" $4 "\t\tfalse\tfalse"}' | rows_to_packages ;;
    zypper:security)
      zypper_security_rows ;;
    brew:installed)
      brew_cmd list --versions 2>/dev/null | awk '{name=$1; $1=""; sub(/^ /,""); print name "\t" $0 "\t\ttrue\tfalse"}' | rows_to_packages ;;
    brew:search)
      [ -n "$query" ] || return 0
      brew_cmd search "$query" 2>/dev/null | awk '{print $1 "\t\t\tfalse\tfalse"}' | rows_to_packages ;;
    brew:security)
      return 0 ;;
    *) return 0 ;;
  esac
}

info_text() {
  [ -n "$query" ] || return 0
  case "$manager" in
    apt) apt-cache show "$query" 2>/dev/null | sed -n '1,120p' ;;
    apk)
      db_file=$(apk_db_file) || return 0
      { cat "$db_file"; printf "\n"; apk_index_stream; } | awk -v query="$query" '
        function emit() {
          if (name != query) return
          if (found) return
          found = 1
          print "Package: " name
          print "Version: " version
          print "Description: " description
          print "URL: " url
          print "License: " license
        }
        /^$/ {
          emit()
          name = ""; version = ""; description = ""; url = ""; license = ""
          next
        }
        /^P:/ { name = substr($0, 3); next }
        /^V:/ { version = substr($0, 3); next }
        /^T:/ { description = substr($0, 3); next }
        /^U:/ { url = substr($0, 3); next }
        /^L:/ { license = substr($0, 3); next }
        END { emit() }
      ' | sed -n '1,160p'
      ;;
    pacman) pacman -Si "$query" 2>/dev/null | sed -n '1,160p' ;;
    dnf) dnf -q info "$query" 2>/dev/null | sed -n '1,160p' ;;
    yum) yum -q info "$query" 2>/dev/null | sed -n '1,160p' ;;
    zypper) zypper --non-interactive info "$query" 2>/dev/null | sed -n '1,160p' ;;
    brew) brew_cmd info "$query" 2>/dev/null | sed -n '1,160p' ;;
  esac
}

security_info_text() {
  case "$manager" in
    apt) printf 'APT security rows are detected from configured security pockets in local apt metadata. CVE identifiers are not available from plain apt metadata on every distribution.\n' ;;
    apk) printf 'Alpine apk does not expose CVE/security advisory metadata through the local installed package database. ShellOrchestra Community shows ordinary package updates, but full Alpine CVE matching requires the Pro vulnerability database.\n' ;;
    dnf|yum) printf 'Security rows are read from package-manager updateinfo security advisories when available.\n' ;;
    zypper) printf 'Security rows are read from zypper security patches when available.\n' ;;
    pacman) printf 'Pacman does not expose local CVE/security advisory metadata through a stable default command. ShellOrchestra does not query external trackers from the managed server.\n' ;;
    brew) printf 'Homebrew does not expose package CVE/security advisory metadata through a stable local package-manager command. ShellOrchestra does not query external trackers from the managed server.\n' ;;
    *) printf 'This package manager does not expose supported local security/CVE metadata.\n' ;;
  esac
}

emit_package_json() {
  generated_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || printf '')
  state_token=''
  if [ "$action" = "installed" ] && [ -z "$query" ]; then
    state_token=$(package_state_token || true)
    if [ -n "$state_token" ] && [ "$known_state_token" = "$state_token" ]; then
      printf '{"generated_at":"%s","manager":' "$generated_at"
      json_string "$manager"
      printf ',"action":"installed","query":"","state_token":'
      json_string "$state_token"
      package_metadata_json_fields
      printf ',"not_modified":true,"packages":[]}\n'
      return
    fi
  fi
  printf '{"generated_at":"%s","manager":' "$generated_at"
  json_string "$manager"
  printf ',"action":'
  json_string "$action"
  printf ',"query":'
  json_string "$query"
  package_metadata_json_fields
  if [ -n "$state_token" ]; then
    printf ',"state_token":'
    json_string "$state_token"
  fi
  printf ',"packages":['
  if [ "$action" = "info" ]; then
    :
  else
    emit_package_rows || true
  fi
  printf ']'
  if [ "$action" = "info" ]; then
    info=$(info_text || true)
    printf ',"info":'
    json_string "$info"
  elif [ "$action" = "security" ]; then
    info=$(security_info_text || true)
    printf ',"info":'
    json_string "$info"
  fi
  printf '}\n'
}

emit_package_event() {
  kind=$1
  generated_at=$2
  state_token=$3
  not_modified=$4
  info=${5:-}

  printf '{"event":'
  json_string "$kind"
  printf ',"data":{"generated_at":'
  json_string "$generated_at"
  printf ',"manager":'
  json_string "$manager"
  printf ',"action":'
  json_string "$action"
  printf ',"query":'
  json_string "$query"
  package_metadata_json_fields
  if [ -n "$state_token" ]; then
    printf ',"state_token":'
    json_string "$state_token"
  fi
  printf ',"not_modified":%s' "$not_modified"
  if [ -n "$info" ]; then
    printf ',"info":'
    json_string "$info"
  fi
  printf '}}\n'
}

emit_package_events() {
  generated_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || printf '')
  state_token=''
  not_modified=false
  if [ "$action" = "installed" ] && [ -z "$query" ]; then
    state_token=$(package_state_token || true)
    if [ -n "$state_token" ] && [ "$known_state_token" = "$state_token" ]; then
      not_modified=true
    fi
  fi

  emit_package_event meta "$generated_at" "$state_token" "$not_modified"
  if [ "$not_modified" = "true" ]; then
    emit_package_event done "$generated_at" "$state_token" "$not_modified"
    return
  fi

  case "$action" in
    info)
      info=$(info_text || true)
      emit_package_event done "$generated_at" "$state_token" "$not_modified" "$info"
      return
      ;;
    security)
      emit_package_rows || true
      info=$(security_info_text || true)
      emit_package_event done "$generated_at" "$state_token" "$not_modified" "$info"
      return
      ;;
    *)
      emit_package_rows || true
      emit_package_event done "$generated_at" "$state_token" "$not_modified"
      return
      ;;
  esac
}

emit_package_stream() {
  if [ "$stream_format" = "row_events" ]; then
    emit_package_events
  else
    emit_package_json
  fi
}

if [ -n "$output_encoding" ]; then
  emit_package_stream | compress_json_stream
else
  emit_package_stream
fi
