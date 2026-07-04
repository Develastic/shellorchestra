#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
export LC_ALL=C
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

json_string() {
  if [ "$#" -eq 0 ] || [ -z "$1" ]; then printf '""'; return; fi
  printf '%s' "$1" | awk 'BEGIN { ORS = ""; printf "\"" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "\\r"); if (NR > 1) printf "\\n"; printf "%s", $0 } END { printf "\"" }'
}

run_lvm_readonly() {
  if [ "$(id -u)" -eq 0 ]; then
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
  "$@"
}

output_encoding=${SHELLORCHESTRA_DISKS_OUTPUT_ENCODING:-${disks_output_encoding:-}}
stream_format=${SHELLORCHESTRA_DISKS_STREAM_FORMAT:-${disks_stream_format:-json}}
case "$stream_format" in ''|'json') stream_format=json ;; 'row_events') ;; *) echo "Unsupported ShellOrchestra disks stream format: $stream_format" >&2; exit 64 ;; esac
case "$output_encoding" in ''|'none') output_encoding=none ;; 'auto'|'zstd'|'gzip') ;; *) echo "Unsupported ShellOrchestra disks output encoding: $output_encoding" >&2; exit 64 ;; esac

compress_json_stream() {
  case "$output_encoding" in
    zstd)
      if command -v zstd >/dev/null 2>&1; then zstd -3 -c; else gzip -1 -c; fi
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

os_name=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' || printf unknown)
generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf '')

lvm_available() {
  if command -v pvs >/dev/null 2>&1 || command -v vgs >/dev/null 2>&1 || command -v lvs >/dev/null 2>&1; then
    printf true
  else
    printf false
  fi
}

emit_json_payload() {
  printf '{"ok":true,"action":"list","platform":'; json_string "$os_name"; printf ',"generated_at":'; json_string "$generated_at"
  if command -v lsblk >/dev/null 2>&1; then
    printf ',"source":"lsblk+lvm","lsblk":'
    if ! lsblk -J -b -o NAME,TYPE,SIZE,FSAVAIL,FSTYPE,LABEL,UUID,MOUNTPOINT,MODEL,SERIAL,ROTA,RM 2>/dev/null; then
      printf '{"blockdevices":[]}'
    fi
    printf ',"lvm":{'
    printf '"available":'
    lvm_available
    printf ',"physical_volumes":'
    if command -v pvs >/dev/null 2>&1; then
      run_lvm_readonly pvs --reportformat json --units b --nosuffix --unbuffered --readonly -o pv_name,vg_name,pv_size,pv_free,pv_attr 2>/dev/null || printf '{"report":[{"pv":[]}]}'
    else
      printf '{"report":[{"pv":[]}]}'
    fi
    printf ',"volume_groups":'
    if command -v vgs >/dev/null 2>&1; then
      run_lvm_readonly vgs --reportformat json --units b --nosuffix --unbuffered --readonly -o vg_name,vg_size,vg_free,vg_attr,pv_count,lv_count 2>/dev/null || printf '{"report":[{"vg":[]}]}'
    else
      printf '{"report":[{"vg":[]}]}'
    fi
    printf ',"logical_volumes":'
    if command -v lvs >/dev/null 2>&1; then
      run_lvm_readonly lvs --reportformat json --units b --nosuffix --unbuffered --readonly -o lv_name,vg_name,lv_path,lv_size,lv_attr,origin,pool_lv,data_percent,metadata_percent 2>/dev/null || printf '{"report":[{"lv":[]}]}'
    else
      printf '{"report":[{"lv":[]}]}'
    fi
    printf '}'
  elif command -v diskutil >/dev/null 2>&1; then
    tmp_plist=$(mktemp)
    tmp_json=$(mktemp)
    if command -v plutil >/dev/null 2>&1 && diskutil list -plist > "$tmp_plist" 2>/dev/null && plutil -convert json -o "$tmp_json" "$tmp_plist" >/dev/null 2>&1 && [ -s "$tmp_json" ]; then
      printf ',"source":"diskutil-plist","diskutil":'
      cat "$tmp_json"
    else
      printf ',"source":"diskutil","missing_utilities":["plutil"],"raw_text":'
      json_string "$(diskutil list 2>/dev/null || true)"
    fi
    rm -f "$tmp_plist" "$tmp_json"
    printf ',"mounts_text":'
    json_string "$(df -k 2>/dev/null || true)"
  elif command -v geom >/dev/null 2>&1; then
    printf ',"source":"geom","raw_text":'
    json_string "$(geom disk list 2>/dev/null || geom disk status 2>/dev/null || true)"
    printf ',"mounts_text":'
    json_string "$(df -k 2>/dev/null || true)"
  else
    printf ',"source":"none","missing_utilities":'
    case "$os_name" in
      linux) printf '["lsblk"]' ;;
      darwin) printf '["diskutil","plutil"]' ;;
      freebsd|openbsd|netbsd|dragonfly) printf '["geom"]' ;;
      *) printf '["lsblk","diskutil","geom"]' ;;
    esac
    printf ',"raw_text":"ShellOrchestra could not find a supported disk inventory utility on this server."'
  fi
  printf '}\n'
}

emit_lsblk_row_events() {
  lsblk -P -b -o NAME,TYPE,SIZE,FSAVAIL,FSTYPE,LABEL,UUID,MOUNTPOINT,MODEL,ROTA,RM 2>/dev/null | awk '
    function json_string(value, escaped) { escaped=value; gsub(/\\/, "\\\\", escaped); gsub(/"/, "\\\"", escaped); gsub(/\t/, "\\t", escaped); gsub(/\r/, "\\r", escaped); gsub(/\n/, "\\n", escaped); return "\"" escaped "\"" }
    function json_number(value, trimmed) { trimmed=value; gsub(/^[ \t]+|[ \t]+$/, "", trimmed); if (trimmed ~ /^[0-9]+([.][0-9]+)?$/) return trimmed + 0; return 0 }
    function parse_pairs(line, i, key, value, ch) {
      delete fields; i=1;
      while (i <= length(line)) {
        while (i <= length(line) && substr(line, i, 1) == " ") i++;
        key="";
        while (i <= length(line)) { ch=substr(line, i, 1); if (ch == "=") { i++; break; } key=key ch; i++; }
        if (substr(line, i, 1) != "\"") break;
        i++; value="";
        while (i <= length(line)) {
          ch=substr(line, i, 1);
          if (ch == "\\" && i < length(line)) { value=value substr(line, i+1, 1); i += 2; continue; }
          if (ch == "\"") { i++; break; }
          value=value ch; i++;
        }
        if (key != "") fields[key]=value;
      }
    }
    {
      parse_pairs($0);
      status="";
      if (fields["RM"] == "1") status="removable"; else if (fields["ROTA"] == "1") status="rotational";
      printf "{\"event\":\"row\",\"data\":{\"kind\":\"disk\",\"item\":{\"id\":%s,\"level\":0,\"name\":%s,\"type\":%s,\"size\":%s,\"free\":%s,\"fs\":%s,\"label\":%s,\"uuid\":%s,\"mount\":%s,\"model\":%s,\"status\":%s}}}\n", json_string("linux-row-" NR "-" fields["NAME"]), json_string(fields["NAME"]), json_string(fields["TYPE"]), json_number(fields["SIZE"]), json_number(fields["FSAVAIL"]), json_string(fields["FSTYPE"]), json_string(fields["LABEL"]), json_string(fields["UUID"]), json_string(fields["MOUNTPOINT"]), json_string(fields["MODEL"]), json_string(status);
    }
  ' || true
}

emit_lvm_table_rows() {
  kind=$1
  shift
  run_lvm_readonly "$@" 2>/dev/null | awk -F '|' -v kind="$kind" '
    function trim(value) { gsub(/^[ \t]+|[ \t]+$/, "", value); return value }
    function json_string(value, escaped) { escaped=trim(value); gsub(/\\/, "\\\\", escaped); gsub(/"/, "\\\"", escaped); gsub(/\t/, "\\t", escaped); gsub(/\r/, "\\r", escaped); gsub(/\n/, "\\n", escaped); return "\"" escaped "\"" }
    function json_number(value, trimmed) { trimmed=trim(value); if (trimmed ~ /^[0-9]+([.][0-9]+)?$/) return trimmed + 0; return 0 }
    kind == "pv" && NF >= 5 { printf "{\"event\":\"row\",\"data\":{\"kind\":\"lvm\",\"item\":{\"id\":%s,\"kind\":\"pv\",\"name\":%s,\"group\":%s,\"path\":%s,\"size\":%s,\"free\":%s,\"attr\":%s,\"details\":\"Physical volume\"}}}\n", json_string("lvm-pv-" NR "-" $1), json_string($1), json_string($2), json_string($1), json_number($3), json_number($4), json_string($5) }
    kind == "vg" && NF >= 6 { details=trim($5) " LV · " trim($6) " PV"; printf "{\"event\":\"row\",\"data\":{\"kind\":\"lvm\",\"item\":{\"id\":%s,\"kind\":\"vg\",\"name\":%s,\"group\":\"\",\"path\":\"\",\"size\":%s,\"free\":%s,\"attr\":%s,\"details\":%s}}}\n", json_string("lvm-vg-" NR "-" $1), json_string($1), json_number($2), json_number($3), json_string($4), json_string(details) }
    kind == "lv" && NF >= 9 { details=""; if (trim($6) != "") details=details "origin " trim($6); if (trim($7) != "") details=details (details ? " · " : "") "pool " trim($7); if (trim($8) != "") details=details (details ? " · " : "") "data " trim($8) "%"; if (trim($9) != "") details=details (details ? " · " : "") "meta " trim($9) "%"; if (details == "") details="Logical volume"; printf "{\"event\":\"row\",\"data\":{\"kind\":\"lvm\",\"item\":{\"id\":%s,\"kind\":\"lv\",\"name\":%s,\"group\":%s,\"path\":%s,\"size\":%s,\"free\":0,\"attr\":%s,\"details\":%s}}}\n", json_string("lvm-lv-" NR "-" $2 "-" $1), json_string($1), json_string($2), json_string($3), json_number($4), json_string($5), json_string(details) }
  ' || true
}

emit_lvm_row_events() {
  if command -v pvs >/dev/null 2>&1; then
    emit_lvm_table_rows pv pvs --units b --nosuffix --unbuffered --readonly --noheadings --separator '|' -o pv_name,vg_name,pv_size,pv_free,pv_attr
  fi
  if command -v vgs >/dev/null 2>&1; then
    emit_lvm_table_rows vg vgs --units b --nosuffix --unbuffered --readonly --noheadings --separator '|' -o vg_name,vg_size,vg_free,vg_attr,lv_count,pv_count
  fi
  if command -v lvs >/dev/null 2>&1; then
    emit_lvm_table_rows lv lvs --units b --nosuffix --unbuffered --readonly --noheadings --separator '|' -o lv_name,vg_name,lv_path,lv_size,lv_attr,origin,pool_lv,data_percent,metadata_percent
  fi
}

emit_row_events() {
  if command -v lsblk >/dev/null 2>&1; then
    printf '{"event":"meta","data":{"ok":true,"action":"list","platform":'
    json_string "$os_name"
    printf ',"generated_at":'
    json_string "$generated_at"
    printf ',"source":"lsblk+lvm","lvm_available":'
    lvm_available
    printf '}}\n'
    emit_lsblk_row_events
    emit_lvm_row_events
    printf '{"event":"done","data":{"ok":true,"action":"list","platform":'
    json_string "$os_name"
    printf ',"generated_at":'
    json_string "$generated_at"
    printf ',"source":"lsblk+lvm","lvm_available":'
    lvm_available
    printf '}}\n'
    return
  fi
  printf '{"event":"meta","data":'
  emit_json_payload | tr -d '\n'
  printf '}\n'
  printf '{"event":"done","data":{"ok":true,"action":"list","platform":'
  json_string "$os_name"
  printf ',"generated_at":'
  json_string "$generated_at"
  printf '}}\n'
}

if [ "$stream_format" = row_events ]; then
  emit_row_events | compress_json_stream
else
  emit_json_payload | compress_json_stream
fi
