#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu

json_string() {
  awk 'BEGIN { value=ARGV[1]; ARGV[1]=""; gsub(/\\/,"\\\\",value); gsub(/"/,"\\\"",value); gsub(/\t/,"\\t",value); gsub(/\r/,"\\r",value); gsub(/\n/,"\\n",value); printf "\"%s\"", value }' "$1"
}

json_file_string() {
  awk 'BEGIN { printf "\"" } { value=$0; gsub(/\\/,"\\\\",value); gsub(/"/,"\\\"",value); gsub(/\t/,"\\t",value); gsub(/\r/,"\\r",value); if (NR > 1) printf "\\n"; printf "%s", value } END { printf "\"" }' "$1"
}

run_maybe_root() {
  if "$@" >"$command_out" 2>"$command_err"; then
    cat "$command_out"
    return 0
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    if sudo -n "$@" >"$command_out" 2>"$command_err"; then
      cat "$command_out"
      return 0
    fi
  fi
  if command -v doas >/dev/null 2>&1 && doas -n true >/dev/null 2>&1; then
    if doas -n "$@" >"$command_out" 2>"$command_err"; then
      cat "$command_out"
      return 0
    fi
  fi
  return 1
}

root_available() {
  if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then return 0; fi
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then return 0; fi
  if command -v doas >/dev/null 2>&1 && doas -n true >/dev/null 2>&1; then return 0; fi
  return 1
}

sha256_file() {
  file_path=$1
  if command -v sha256sum >/dev/null 2>&1; then
    run_maybe_root sha256sum "$file_path" 2>/dev/null | awk '{print $1; exit}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    run_maybe_root shasum -a 256 "$file_path" 2>/dev/null | awk '{print $1; exit}'
    return
  fi
  if command -v openssl >/dev/null 2>&1; then
    run_maybe_root openssl dgst -sha256 -r "$file_path" 2>/dev/null | awk '{print $1; exit}'
    return
  fi
  return 1
}

file_size_bytes() {
  run_maybe_root wc -c "$1" 2>/dev/null | awk '{print $1; exit}'
}

find_sshd() {
  for candidate in sshd /usr/sbin/sshd /usr/local/sbin/sshd /opt/homebrew/sbin/sshd /usr/libexec/sshd-keygen-wrapper; do
    if command -v "$candidate" >/dev/null 2>&1; then command -v "$candidate"; return 0; fi
    if [ -x "$candidate" ]; then printf '%s\n' "$candidate"; return 0; fi
  done
  return 1
}

first_existing_config() {
  for candidate in /etc/ssh/sshd_config /usr/local/etc/ssh/sshd_config /private/etc/ssh/sshd_config; do
    if [ -f "$candidate" ]; then printf '%s\n' "$candidate"; return 0; fi
  done
  printf '%s\n' /etc/ssh/sshd_config
}

append_config_files() {
  [ -f "$config_path" ] && printf '%s\n' "$config_path" >> "$files_tmp"
  for dir in /etc/ssh/sshd_config.d /usr/local/etc/ssh/sshd_config.d /private/etc/ssh/sshd_config.d; do
    if [ -d "$dir" ]; then
      find "$dir" -maxdepth 1 -type f -name '*.conf' 2>/dev/null | sort >> "$files_tmp"
    fi
  done
  awk '!seen[$0]++' "$files_tmp" > "$files_tmp.dedup" && mv "$files_tmp.dedup" "$files_tmp"
  while IFS= read -r file_path; do
    [ -n "$file_path" ] || continue
    [ -r "$file_path" ] || continue
    printf '%s\n' "$file_path" >> "$readable_files_tmp"
  done < "$files_tmp"
}

print_config_files_json() {
  file_index=0
  while IFS= read -r file_path; do
    [ -n "$file_path" ] || continue
    [ "$file_index" -gt 0 ] && printf ','
    json_string "$file_path"
    file_index=$((file_index + 1))
  done < "$files_tmp"
}

print_config_file_details_json() {
  detail_index=0
  while IFS= read -r file_path; do
    [ -n "$file_path" ] || continue
    [ "$detail_index" -gt 0 ] && printf ','
    exists=false
    readable=false
    writable=false
    size=0
    sha=
    content_available=false
    content_tmp=$(mktemp)
    if [ -f "$file_path" ]; then
      exists=true
      if root_available; then writable=true; fi
      if run_maybe_root cat "$file_path" > "$content_tmp" 2>/dev/null; then
        readable=true
        size=$(wc -c < "$content_tmp" | tr -d '[:space:]')
        sha=$(sha256_file "$file_path" 2>/dev/null || true)
        if [ "${size:-0}" -le 262144 ]; then
          content_available=true
        fi
      else
        size=$(file_size_bytes "$file_path" 2>/dev/null || printf 0)
      fi
    fi
    printf '{"path":'; json_string "$file_path"
    printf ',"exists":%s,"readable":%s,"writable":%s,"size_bytes":%s,"sha256":' "$exists" "$readable" "$writable" "${size:-0}"
    if [ -n "$sha" ]; then
      json_string "sha256:$sha"
    else
      json_string ""
    fi
    printf ',"content_available":%s,"content":' "$content_available"
    if [ "$content_available" = true ]; then
      json_file_string "$content_tmp"
    else
      json_string ""
    fi
    printf '}'
    rm -f "$content_tmp"
    detail_index=$((detail_index + 1))
  done < "$files_tmp"
}

print_options_json() {
  set --
  while IFS= read -r file_path; do
    [ -n "$file_path" ] || continue
    [ -f "$file_path" ] || continue
    set -- "$@" "$file_path"
  done < "$readable_files_tmp"
  if [ "$#" -eq 0 ]; then set -- /dev/null; fi
  awk -v efffile="$effective_tmp" '
function esc(v){gsub(/\\/,"\\\\",v);gsub(/"/,"\\\"",v);gsub(/\t/,"\\t",v);gsub(/\r/,"\\r",v);gsub(/\n/,"\\n",v);return "\"" v "\""}
function trim(v){sub(/^[ \t]+/,"",v);sub(/[ \t]+$/, "", v);return v}
function lower(v){return tolower(v)}
function sev(key,value,  k,v){k=lower(key);v=lower(value); if(k=="permitemptypasswords" && v=="yes") return "critical"; if(k=="permitrootlogin" && v=="yes") return "critical"; if(k=="pubkeyauthentication" && v=="no") return "critical"; if(k=="trustedusercakeys" && v=="") return "critical"; if(k=="passwordauthentication" && v=="yes") return "warning"; if(k=="kbdinteractiveauthentication" && v=="yes") return "warning"; if(k=="challengeresponseauthentication" && v=="yes") return "warning"; if(k=="permitrootlogin" && v=="prohibit-password") return "warning"; if(k=="allowtcpforwarding" && v=="yes") return "warning"; if(k=="allowagentforwarding" && v=="yes") return "warning"; if(k=="x11forwarding" && v=="yes") return "warning"; if(k=="gatewayports" && v!="no" && v!="") return "warning"; if(k=="permittunnel" && v!="no" && v!="") return "warning"; if(k=="permituserenvironment" && v=="yes") return "critical"; if(k=="authorizedkeyscommand" && v!="none" && v!="") return "info"; if(k=="forcecommand" && v!="") return "info"; return ""}
function warn(key,value,  k,v){k=lower(key);v=lower(value); if(k=="permitemptypasswords" && v=="yes") return "Empty passwords are permitted. This is unsafe on managed servers."; if(k=="permitrootlogin" && v=="yes") return "Root login is fully enabled. Prefer certificate/key login with explicit admin users unless this host intentionally requires root."; if(k=="pubkeyauthentication" && v=="no") return "Public key authentication is disabled. SSH CA and key based automation cannot work with this setting."; if(k=="passwordauthentication" && v=="yes") return "Password login is enabled. This increases brute-force and credential reuse risk."; if((k=="kbdinteractiveauthentication"||k=="challengeresponseauthentication") && v=="yes") return "Keyboard-interactive login is enabled. Confirm this is intentional for the server policy."; if(k=="permitrootlogin" && v=="prohibit-password") return "Root login by public key or certificate is allowed. This may be intentional for admin-only automation."; if(k=="allowtcpforwarding" && v=="yes") return "TCP forwarding is enabled. This can be needed, but it expands what an SSH session can tunnel."; if(k=="allowagentforwarding" && v=="yes") return "Agent forwarding is enabled. Forwarded agents can be abused by a compromised server."; if(k=="x11forwarding" && v=="yes") return "X11 forwarding is enabled. It is rarely needed on managed servers."; if(k=="gatewayports" && v!="no" && v!="") return "GatewayPorts can expose forwarded ports beyond localhost."; if(k=="permittunnel" && v!="no" && v!="") return "SSH tunneling devices are enabled. Confirm this is intended."; if(k=="permituserenvironment" && v=="yes") return "User-controlled environment files are enabled. This can affect command execution."; if(k=="authorizedkeyscommand" && v!="none" && v!="") return "AuthorizedKeysCommand executes an external helper during authentication. Review the command path and ownership."; if(k=="forcecommand" && v!="") return "ForceCommand changes session behavior. Review Match context and automation impact."; return ""}
function recommended(key,value,  k){k=lower(key); if(k=="passwordauthentication") return "no"; if(k=="permitemptypasswords") return "no"; if(k=="pubkeyauthentication") return "yes"; if(k=="permituserenvironment") return "no"; if(k=="gatewayports") return "no"; return ""}
BEGIN{while((getline line < efffile)>0){split(line,a,/ /); key=tolower(a[1]); sub(/^[^ ]+[ ]*/,"",line); eff[key]=line} print "["; first=1; inmatch=0}
FNR==1{source=FILENAME; inmatch=0}
{raw=$0; line=raw; sub(/[ \t]*#.*/,"",line); line=trim(line); if(line=="") next; split(line,parts,/[^A-Za-z0-9]+/); key=parts[1]; rest=line; sub(/^[^ \t]+[ \t]*/,"",rest); if(tolower(key)=="match"){inmatch=1; next} if(inmatch) next; if(key=="") next; s=sev(key,rest); w=warn(key,rest); rec=recommended(key,rest); if(!first) printf ","; first=0; printf "{\"key\":%s,\"value\":%s,\"effective_value\":%s,\"source\":%s,\"line\":%d,\"severity\":%s,\"warning\":%s,\"recommended\":%s}", esc(key), esc(rest), esc(eff[tolower(key)]), esc(source), FNR, esc(s), esc(w), esc(rec)}
END{print "]"}
' "$@"
}

print_trusted_ca_json() {
  set --
  while IFS= read -r file_path; do
    [ -n "$file_path" ] || continue
    [ -f "$file_path" ] || continue
    set -- "$@" "$file_path"
  done < "$readable_files_tmp"
  if [ "$#" -eq 0 ]; then set -- /dev/null; fi
  ca_index=0
  awk 'function trim(v){sub(/^[ \t]+/,"",v);sub(/[ \t]+$/, "", v);return v} FNR==1{source=FILENAME} {line=$0; sub(/[ \t]*#.*/,"",line); line=trim(line); split(line,parts,/[^A-Za-z0-9]+/); if(tolower(parts[1])=="trustedusercakeys") {value=line; sub(/^[^ \t]+[ \t]*/,"",value); print source "|" FNR "|" value}}' "$@" |
  while IFS='|' read -r ca_source ca_line ca_path; do
    [ -n "$ca_path" ] || continue
    exists=false
    readable=false
    fingerprints=
    if [ -f "$ca_path" ]; then
      exists=true
      if [ -r "$ca_path" ]; then
        readable=true
        if command -v ssh-keygen >/dev/null 2>&1; then fingerprints=$(ssh-keygen -lf "$ca_path" 2>/dev/null | sed -n '1,12p' || true); fi
      fi
    fi
    [ "$ca_index" -gt 0 ] && printf ','
    printf '{"path":'; json_string "$ca_path"; printf ',"source":'; json_string "$ca_source"; printf ',"line":%s,"exists":%s,"readable":%s,"fingerprints":[' "$ca_line" "$exists" "$readable"
    fp_index=0
    printf '%s\n' "$fingerprints" | while IFS= read -r fp; do
      [ -n "$fp" ] || continue
      [ "$fp_index" -gt 0 ] && printf ','
      json_string "$fp"
      fp_index=$((fp_index + 1))
    done
    printf ']}'
    ca_index=$((ca_index + 1))
  done
}

print_match_blocks_json() {
  set --
  while IFS= read -r file_path; do
    [ -n "$file_path" ] || continue
    [ -f "$file_path" ] || continue
    set -- "$@" "$file_path"
  done < "$readable_files_tmp"
  if [ "$#" -eq 0 ]; then set -- /dev/null; fi
  awk '
function esc(v){gsub(/\\/,"\\\\",v);gsub(/"/,"\\\"",v);gsub(/\t/,"\\t",v);gsub(/\r/,"\\r",v);gsub(/\n/,"\\n",v);return "\"" v "\""}
function trim(v){sub(/^[ \t]+/,"",v);sub(/[ \t]+$/, "", v);return v}
function flush(){if(inmatch){if(!first) printf ","; first=0; printf "{\"source\":%s,\"start_line\":%d,\"condition\":%s,\"body\":%s}", esc(source), start, esc(cond), esc(body)}}
BEGIN{print "["; first=1; inmatch=0}
FNR==1{flush(); source=FILENAME; inmatch=0; body=""}
{raw=$0; clean=raw; sub(/[ \t]*#.*/,"",clean); clean=trim(clean); split(clean,parts,/[^A-Za-z0-9]+/); key=tolower(parts[1]); if(key=="match"){flush(); inmatch=1; start=FNR; cond=clean; sub(/^[^ \t]+[ \t]*/,"",cond); body=""; next} if(inmatch){body=(body==""?raw:body "\n" raw)}}
END{flush(); print "]"}
' "$@"
}

print_effective_lines_json() {
  eff_index=0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    [ "$eff_index" -gt 0 ] && printf ','
    json_string "$line"
    eff_index=$((eff_index + 1))
  done < "$effective_tmp"
}

generated_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || printf '')
platform=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' || printf unknown)
sshd_bin=$(find_sshd 2>/dev/null || true)
installed=false
[ -n "$sshd_bin" ] && installed=true
config_path=$(first_existing_config)
version=
if [ -n "$sshd_bin" ]; then version=$($sshd_bin -V 2>&1 | sed -n '1p' || true); fi
service_name=
running=false
if command -v systemctl >/dev/null 2>&1; then
  for service in ssh sshd; do
    if systemctl status "$service.service" >/dev/null 2>&1 || systemctl list-unit-files "$service.service" >/dev/null 2>&1; then
      service_name=$service
      if systemctl is-active "$service.service" >/dev/null 2>&1; then running=true; fi
      break
    fi
  done
elif command -v rc-service >/dev/null 2>&1; then
  for service in sshd ssh; do
    if rc-service "$service" status >/dev/null 2>&1; then service_name=$service; running=true; break; fi
  done
elif command -v service >/dev/null 2>&1; then
  for service in ssh sshd; do
    if service "$service" status >/dev/null 2>&1; then service_name=$service; running=true; break; fi
  done
elif [ "$platform" = darwin ]; then
  service_name=com.openssh.sshd
  if launchctl print system/com.openssh.sshd >/dev/null 2>&1; then running=true; fi
fi

files_tmp=$(mktemp)
readable_files_tmp=$(mktemp)
effective_tmp=$(mktemp)
command_out=$(mktemp)
command_err=$(mktemp)
trap 'rm -f "$files_tmp" "$readable_files_tmp" "$effective_tmp" "$command_out" "$command_err" "$files_tmp.dedup"' EXIT
append_config_files

effective_available=false
effective_error=
if [ -n "$sshd_bin" ] && [ -f "$config_path" ]; then
  if run_maybe_root "$sshd_bin" -T -f "$config_path" > "$effective_tmp"; then
    effective_available=true
  else
    effective_error=$(sed -n '1,4p' "$command_err" 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]][[:space:]]*/ /g' || true)
    : > "$effective_tmp"
  fi
fi

printf '{"generated_at":'
json_string "$generated_at"
printf ',"platform":'
json_string "$platform"
printf ',"sshd":{"installed":%s,"running":%s,"service_name":' "$installed" "$running"
json_string "$service_name"
printf ',"version":'
json_string "$version"
printf ',"config_path":'
json_string "$config_path"
printf ',"effective_available":%s,"effective_error":' "$effective_available"
json_string "$effective_error"
printf '},"config_files":['
print_config_files_json
printf '],"config_file_details":['
print_config_file_details_json
printf '],"options":'
print_options_json
printf ',"trusted_user_ca_keys":['
print_trusted_ca_json
printf '],"match_blocks":'
print_match_blocks_json
printf ',"effective_lines":['
print_effective_lines_json
printf ']}'
printf '\n'
