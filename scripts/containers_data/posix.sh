#!/bin/sh
# SPDX-FileCopyrightText: 2026 Mykola Rudenko
# SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
# ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
# Commercial distribution: Develastic, s. r. o.

set -eu
export LC_ALL=C

json_string() {
  awk 'BEGIN { value=ARGV[1]; ARGV[1]=""; gsub(/\\/,"\\\\",value); gsub(/"/,"\\\"",value); gsub(/\t/,"\\t",value); gsub(/\r/,"\\r",value); gsub(/\n/,"\\n",value); printf "\"%s\"", value }' "$1"
}

limit=${SHELLORCHESTRA_CONTAINERS_LIMIT:-200}
case "$limit" in ''|*[!0123456789]*) limit=200 ;; esac
[ "$limit" -lt 1 ] 2>/dev/null && limit=1
[ "$limit" -gt 1000 ] 2>/dev/null && limit=1000
query=${SHELLORCHESTRA_CONTAINERS_QUERY:-}
known_state_token=${SHELLORCHESTRA_CONTAINERS_KNOWN_STATE_TOKEN:-}
case "$known_state_token" in *[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:-]*) known_state_token= ;; esac
engine=${SHELLORCHESTRA_CONTAINER_ENGINE:-auto}
output_encoding=${SHELLORCHESTRA_CONTAINERS_OUTPUT_ENCODING:-}
stream_format=${SHELLORCHESTRA_CONTAINERS_STREAM_FORMAT:-json}
case "$output_encoding" in ''|'auto'|'zstd'|'gzip') ;; *) echo "Unsupported ShellOrchestra containers output encoding: $output_encoding" >&2; exit 64 ;; esac
case "$stream_format" in ''|'json') stream_format=json ;; 'row_events') ;; *) echo "Unsupported ShellOrchestra containers stream format: $stream_format" >&2; exit 64 ;; esac

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
        echo "zstd or gzip is required for compressed ShellOrchestra container data on this server." >&2
        exit 127
      fi
      ;;
    'zstd')
      if ! command -v zstd >/dev/null 2>&1; then
        echo "zstd is required for zstd-compressed ShellOrchestra container data on this server." >&2
        exit 127
      fi
      zstd -1 -q -c
      ;;
    'gzip')
      if ! command -v gzip >/dev/null 2>&1; then
        echo "gzip is required for gzip-compressed ShellOrchestra container data on this server." >&2
        exit 127
      fi
      gzip -1 -c
      ;;
  esac
}

if [ "$engine" = auto ] || [ -z "$engine" ]; then
  if command -v docker >/dev/null 2>&1; then engine=docker
  elif command -v podman >/dev/null 2>&1; then engine=podman
  else engine=none
  fi
fi
case "$engine" in docker|podman|none) ;; *) echo "Unsupported container engine: $engine" >&2; exit 64 ;; esac

rows_to_json() {
  awk -F '\t' -v limit="$limit" -v query="$query" -v stream_format="$stream_format" '
    function js(value, escaped){ escaped=value; gsub(/\\/,"\\\\",escaped); gsub(/"/,"\\\"",escaped); gsub(/\t/,"\\t",escaped); gsub(/\r/,"\\r",escaped); gsub(/\n/,"\\n",escaped); return "\"" escaped "\"" }
    function lower(value) { return tolower(value) }
    function emit_row(kind, object) {
      if (stream_format == "row_events") {
        printf "{\"event\":\"row\",\"data\":{\"kind\":%s,\"item\":%s}}\n", js(kind), object
      } else {
        if (count > 0) printf ","
        printf "%s", object
      }
      count++
    }
    count < limit {
      id=$1; image=$2; name=$3; state=$4; status=$5; ports=$6
      created_at=$7; running_for=$8; size=$9; command=$10; labels=$11; mounts=$12; networks=$13; restart_policy=$14
      haystack=lower(id " " image " " name " " state " " status " " ports " " command " " labels " " mounts " " networks)
      if (query != "" && index(haystack, lower(query)) == 0) next
      object = sprintf("{\"id\":%s,\"image\":%s,\"name\":%s,\"state\":%s,\"status\":%s,\"ports\":%s,\"created_at\":%s,\"running_for\":%s,\"size\":%s,\"command\":%s,\"labels\":%s,\"mounts\":%s,\"networks\":%s,\"restart_policy\":%s}", js(id), js(image), js(name), js(state), js(status), js(ports), js(created_at), js(running_for), js(size), js(command), js(labels), js(mounts), js(networks), js(restart_policy))
      emit_row("container", object)
    }
  '
}

images_to_json() {
  awk -F '\t' -v limit="$limit" -v query="$query" -v stream_format="$stream_format" '
    function js(value, escaped){ escaped=value; gsub(/\\/,"\\\\",escaped); gsub(/"/,"\\\"",escaped); gsub(/\t/,"\\t",escaped); gsub(/\r/,"\\r",escaped); gsub(/\n/,"\\n",escaped); return "\"" escaped "\"" }
    function lower(value) { return tolower(value) }
    function emit_row(kind, object) {
      if (stream_format == "row_events") {
        printf "{\"event\":\"row\",\"data\":{\"kind\":%s,\"item\":%s}}\n", js(kind), object
      } else {
        if (count > 0) printf ","
        printf "%s", object
      }
      count++
    }
    count < limit {
      repository=$1; tag=$2; id=$3; size=$4
      haystack=lower(repository " " tag " " id " " size)
      if (query != "" && index(haystack, lower(query)) == 0) next
      object = sprintf("{\"repository\":%s,\"tag\":%s,\"id\":%s,\"size\":%s}", js(repository), js(tag), js(id), js(size))
      emit_row("image", object)
    }
  '
}

volumes_to_json() {
  awk -F '\t' -v limit="$limit" -v query="$query" -v stream_format="$stream_format" '
    function js(value, escaped){ escaped=value; gsub(/\\/,"\\\\",escaped); gsub(/"/,"\\\"",escaped); gsub(/\t/,"\\t",escaped); gsub(/\r/,"\\r",escaped); gsub(/\n/,"\\n",escaped); return "\"" escaped "\"" }
    function lower(value) { return tolower(value) }
    function emit_row(kind, object) {
      if (stream_format == "row_events") {
        printf "{\"event\":\"row\",\"data\":{\"kind\":%s,\"item\":%s}}\n", js(kind), object
      } else {
        if (count > 0) printf ","
        printf "%s", object
      }
      count++
    }
    count < limit {
      driver=$1; name=$2; mount=$3
      haystack=lower(driver " " name " " mount)
      if (query != "" && index(haystack, lower(query)) == 0) next
      object = sprintf("{\"driver\":%s,\"name\":%s,\"mountpoint\":%s}", js(driver), js(name), js(mount))
      emit_row("volume", object)
    }
  '
}

networks_to_json() {
  awk -F '\t' -v limit="$limit" -v query="$query" -v stream_format="$stream_format" '
    function js(value, escaped){ escaped=value; gsub(/\\/,"\\\\",escaped); gsub(/"/,"\\\"",escaped); gsub(/\t/,"\\t",escaped); gsub(/\r/,"\\r",escaped); gsub(/\n/,"\\n",escaped); return "\"" escaped "\"" }
    function lower(value) { return tolower(value) }
    function emit_row(kind, object) {
      if (stream_format == "row_events") {
        printf "{\"event\":\"row\",\"data\":{\"kind\":%s,\"item\":%s}}\n", js(kind), object
      } else {
        if (count > 0) printf ","
        printf "%s", object
      }
      count++
    }
    count < limit {
      id=$1; name=$2; driver=$3; scope=$4
      haystack=lower(id " " name " " driver " " scope)
      if (query != "" && index(haystack, lower(query)) == 0) next
      object = sprintf("{\"id\":%s,\"name\":%s,\"driver\":%s,\"scope\":%s}", js(id), js(name), js(driver), js(scope))
      emit_row("network", object)
    }
  '
}

generated_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || printf '')
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/shellorchestra-containers.XXXXXX")
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT HUP INT TERM
errors_file="$tmp_dir/errors"
: > "$errors_file"

first_line() {
  sed -n '1p' "$1" 2>/dev/null | tr '\r\n\t' '   ' | cut -c 1-240
}

append_error() {
  msg=$1
  [ -n "$msg" ] && printf '%s\n' "$msg" >> "$errors_file"
}

engine_runner=direct
engine_available=true
run_engine() {
  case "$engine_runner" in
    sudo) sudo -n "$engine" "$@" ;;
    doas) doas -n "$engine" "$@" ;;
    *) "$engine" "$@" ;;
  esac
}

if [ "$engine" != none ]; then
  probe_err="$tmp_dir/engine-info.err"
  if run_engine info >/dev/null 2>"$probe_err"; then
    :
  elif command -v sudo >/dev/null 2>&1 && sudo -n "$engine" info >/dev/null 2>"$probe_err"; then
    engine_runner=sudo
  elif command -v doas >/dev/null 2>&1 && doas -n "$engine" info >/dev/null 2>"$probe_err"; then
    engine_runner=doas
  else
    engine_available=false
    append_error "$engine is installed, but ShellOrchestra cannot access it with this SSH user: $(first_line "$probe_err")"
  fi
fi

errors_to_json() {
  awk '
    function js(value, escaped){ escaped=value; gsub(/\\/,"\\\\",escaped); gsub(/"/,"\\\"",escaped); gsub(/\t/,"\\t",escaped); gsub(/\r/,"\\r",escaped); gsub(/\n/,"\\n",escaped); return "\"" escaped "\"" }
    NF && count < 12 { if (count > 0) printf ","; printf "%s", js($0); count++ }
  ' "$errors_file"
}

engine_error_value() {
  first_line "$errors_file"
}

containers_file="$tmp_dir/containers.tsv"
images_file="$tmp_dir/images.tsv"
volumes_file="$tmp_dir/volumes.tsv"
networks_file="$tmp_dir/networks.tsv"
: > "$containers_file"
: > "$images_file"
: > "$volumes_file"
: > "$networks_file"

if [ "$engine" != none ] && [ "$engine_available" = true ]; then
  err_file="$tmp_dir/containers.err"
  if run_engine ps -a --format '{{.ID}}\t{{.Image}}\t{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Ports}}\t{{.CreatedAt}}\t{{.RunningFor}}\t{{.Size}}\t{{.Command}}\t{{.Labels}}\t{{.Mounts}}\t{{.Networks}}\t{{.RestartPolicy}}' >"$containers_file" 2>"$err_file"; then
    :
  elif run_engine ps -a --format '{{.ID}}\t{{.Image}}\t{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Ports}}\t{{.CreatedAt}}\t{{.RunningFor}}\t{{.Size}}\t{{.Command}}\t{{.Labels}}\t{{.Mounts}}\t{{.Networks}}\t' >"$containers_file" 2>"$err_file"; then
    :
  elif run_engine ps -a --format '{{.ID}}\t{{.Image}}\t{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Ports}}' >"$containers_file" 2>"$err_file"; then
    :
  else
    : > "$containers_file"
    append_error "$engine ps failed: $(first_line "$err_file")"
  fi

  err_file="$tmp_dir/images.err"
  if ! run_engine images --format '{{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Size}}' >"$images_file" 2>"$err_file"; then
    : > "$images_file"
    append_error "$engine images failed: $(first_line "$err_file")"
  fi

  err_file="$tmp_dir/volumes.err"
  if ! run_engine volume ls --format '{{.Driver}}\t{{.Name}}\t{{.Mountpoint}}' >"$volumes_file" 2>"$err_file"; then
    : > "$volumes_file"
    append_error "$engine volume ls failed: $(first_line "$err_file")"
  fi

  err_file="$tmp_dir/networks.err"
  if ! run_engine network ls --format '{{.ID}}\t{{.Name}}\t{{.Driver}}\t{{.Scope}}' >"$networks_file" 2>"$err_file"; then
    : > "$networks_file"
    append_error "$engine network ls failed: $(first_line "$err_file")"
  fi
fi

container_state_token() {
  {
    printf 'engine=%s\nqueryless-v1\n' "$engine"
    printf '[errors]\n'
    cat "$errors_file"
    printf '\n[containers]\n'
    cat "$containers_file"
    printf '\n[images]\n'
    cat "$images_file"
    printf '\n[volumes]\n'
    cat "$volumes_file"
    printf '\n[networks]\n'
    cat "$networks_file"
  } | cksum | awk '{ printf "v1-containers-%s-%s", $1, $2 }'
}

state_token=$(container_state_token)

emit_metadata_fields() {
  printf '"generated_at":"%s","engine":' "$generated_at"
  json_string "$engine"
  printf ',"query":'
  json_string "$query"
  printf ',"state_token":'
  json_string "$state_token"
}

emit_payload() {
  if [ "$stream_format" = "row_events" ]; then
    printf '{"event":"meta","data":{'
    emit_metadata_fields
    if [ -z "$query" ] && [ -n "$known_state_token" ] && [ "$known_state_token" = "$state_token" ]; then
      printf ',"not_modified":true}}\n'
      printf '{"event":"done","data":{'
      emit_metadata_fields
      printf ',"not_modified":true,"errors":[],"engine_error":""}}\n'
      return
    fi
    printf ',"not_modified":false}}\n'
    rows_to_json < "$containers_file"
    images_to_json < "$images_file"
    volumes_to_json < "$volumes_file"
    networks_to_json < "$networks_file"
    printf '{"event":"done","data":{'
    emit_metadata_fields
    printf ',"not_modified":false,"errors":['
    errors_to_json
    printf '],"engine_error":'
    json_string "$(engine_error_value)"
    printf '}}\n'
    return
  fi

  printf '{'
  emit_metadata_fields
  if [ -z "$query" ] && [ -n "$known_state_token" ] && [ "$known_state_token" = "$state_token" ]; then
    printf ',"not_modified":true,"containers":[],"images":[],"volumes":[],"networks":[],"errors":[],"engine_error":""}\n'
    return
  fi
  printf ',"not_modified":false'
  printf ',"containers":['
  rows_to_json < "$containers_file"
  printf '],"images":['
  images_to_json < "$images_file"
  printf '],"volumes":['
  volumes_to_json < "$volumes_file"
  printf '],"networks":['
  networks_to_json < "$networks_file"
  printf '],"errors":['
  errors_to_json
  printf '],"engine_error":'
  json_string "$(engine_error_value)"
  printf '}\n'
}

emit_payload | compress_json_stream
